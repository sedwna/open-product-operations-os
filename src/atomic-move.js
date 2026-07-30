import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertNoLinkTraversal } from "./paths.js";

export async function moveFileNoOverwrite(
  root,
  source,
  destination,
  label,
  { expectedContent, moveObserver = async () => {} } = {}
) {
  if (typeof moveObserver !== "function") {
    throw new Error("moveObserver must be a function when provided.");
  }

  let anchorPath;
  let anchorLinked = false;
  let destinationLinked = false;
  let sourceUnlinked = false;
  let sourceRestored = false;
  let sourceHandle;
  let sourceBefore;
  let sourceBytes;
  try {
    await assertNoLinkTraversal(root, source, `${label} source`);
    await assertNoLinkTraversal(root, destination, `${label} destination`);
    sourceHandle = await fs.open(source, "r");
    sourceBefore = await sourceHandle.stat({ bigint: true });
    assertReliableRegularFile(sourceBefore, `${label} source`);
    assertLinkCount(
      sourceBefore,
      1n,
      `${label} source is already hard-linked; refusing an ambiguous move.`
    );

    sourceBytes = await sourceHandle.readFile();
    const sourceAfterRead = await sourceHandle.stat({ bigint: true });
    assertSameFile(sourceBefore, sourceAfterRead, `${label} source changed while read.`);
    assertLinkCount(sourceAfterRead, 1n, `${label} source changed while read.`);
    assertSize(sourceAfterRead, sourceBytes, `${label} source changed while read.`);
    if (
      expectedContent !== undefined &&
      !sourceBytes.equals(toBuffer(expectedContent))
    ) {
      throw new Error(`${label} source bytes do not match the expected content.`);
    }

    const sourcePathBeforeAnchor = await fs.lstat(source, { bigint: true });
    assertSameFile(
      sourceBefore,
      sourcePathBeforeAnchor,
      `${label} source path changed before safety-anchor installation.`
    );
    assertLinkCount(
      sourcePathBeforeAnchor,
      1n,
      `${label} source link count changed before safety-anchor installation.`
    );

    anchorPath = privateAnchorPath(source);
    await assertNoLinkTraversal(root, anchorPath, `${label} safety anchor`);
    await fs.link(source, anchorPath);
    anchorLinked = true;
    await validateLinkedPaths(root, {
      paths: [
        [source, "source"],
        [anchorPath, "safety anchor"]
      ],
      expectedStat: sourceBefore,
      expectedBytes: sourceBytes,
      expectedLinks: 2n,
      label
    });

    await fs.link(source, destination);
    destinationLinked = true;
    await validateLinkedPaths(root, {
      paths: [
        [source, "source"],
        [anchorPath, "safety anchor"],
        [destination, "destination"]
      ],
      expectedStat: sourceBefore,
      expectedBytes: sourceBytes,
      expectedLinks: 3n,
      label
    });

    const handleLinked = await sourceHandle.stat({ bigint: true });
    assertReliableRegularFile(handleLinked, `${label} open source`);
    assertSameFile(
      sourceBefore,
      handleLinked,
      `${label} open source does not identify the installed hard links.`
    );
    assertLinkCount(
      handleLinked,
      3n,
      `${label} open source has an ambiguous link count after installation.`
    );
    assertSize(
      handleLinked,
      sourceBytes,
      `${label} open source size changed after installation.`
    );

    await moveObserver({
      phase: "before-source-unlink-validation",
      source,
      destination,
      label,
      anchorPath
    });

    await sourceHandle.close();
    sourceHandle = undefined;
    await validateLinkedPaths(root, {
      paths: [
        [source, "source"],
        [anchorPath, "safety anchor"],
        [destination, "destination"]
      ],
      expectedStat: sourceBefore,
      expectedBytes: sourceBytes,
      expectedLinks: 3n,
      label,
      phase: "before source unlink"
    });

    const finalPreUnlinkStats = await readLinkedStats([
      [source, "source"],
      [anchorPath, "safety anchor"],
      [destination, "destination"]
    ]);
    validateStats(
      finalPreUnlinkStats,
      sourceBefore,
      sourceBytes,
      3n,
      label,
      "before verified source unlink"
    );
    await moveObserver({
      phase: "after-final-pre-unlink-validation",
      source,
      destination,
      label,
      anchorPath
    });

    await fs.unlink(source);
    sourceUnlinked = true;
    await moveObserver({
      phase: "after-source-unlink-before-commit-validation",
      source,
      destination,
      label,
      anchorPath
    });

    await validateLinkedPaths(root, {
      paths: [
        [anchorPath, "safety anchor"],
        [destination, "destination"]
      ],
      expectedStat: sourceBefore,
      expectedBytes: sourceBytes,
      expectedLinks: 2n,
      label
    });
    const committedStats = await readLinkedStats([
      [anchorPath, "safety anchor"],
      [destination, "destination"]
    ]);
    validateStats(
      committedStats,
      sourceBefore,
      sourceBytes,
      2n,
      label,
      "after source unlink"
    );

    await moveObserver({
      phase: "before-safety-anchor-cleanup",
      source,
      destination,
      label,
      anchorPath
    });
    try {
      await fs.unlink(anchorPath);
      anchorLinked = false;
    } catch (error) {
      throw new Error(
        `${label} commit was verified, but safety-anchor cleanup failed at "${anchorPath}".`,
        { cause: error }
      );
    }
    return { bytes: sourceBytes };
  } catch (error) {
    if (sourceUnlinked && anchorLinked) {
      const restoration = await restoreSourceFromAnchor(root, {
        anchorPath,
        source,
        expectedStat: sourceBefore,
        expectedBytes: sourceBytes,
        label
      });
      sourceRestored = restoration.sourceRestored;
      if (sourceRestored) {
        sourceUnlinked = false;
      }
      throw retainedAnchorError(error, {
        anchorPath,
        source,
        destinationLinked,
        sourceUnlinked,
        sourceRestored,
        restorationError: restoration.error,
        label
      });
    }

    if (anchorLinked) {
      try {
        await fs.unlink(anchorPath);
        anchorLinked = false;
      } catch (cleanupError) {
        throw retainedAnchorError(error, {
          anchorPath,
          source,
          destinationLinked,
          sourceUnlinked,
          sourceRestored,
          restorationError: cleanupError,
          label
        });
      }
    }

    const moveError =
      error.code === "EEXIST"
        ? Object.assign(
            new Error(
              `${label} destination already exists; atomic no-overwrite move refused to replace it.`,
              { cause: error }
            ),
            { code: "EEXIST" }
          )
        : error;
    annotateMoveError(moveError, {
      destinationLinked,
      sourceUnlinked,
      sourceRestored,
      anchorPath: null
    });
    throw moveError;
  } finally {
    await sourceHandle?.close();
  }
}

async function validateLinkedPaths(
  root,
  {
    paths,
    expectedStat,
    expectedBytes,
    expectedLinks,
    label,
    phase = "during linked-path validation"
  }
) {
  for (const [file, subject] of paths) {
    await assertNoLinkTraversal(root, file, `${label} ${subject}`);
  }
  const stats = await readLinkedStats(paths);
  validateStats(
    stats,
    expectedStat,
    expectedBytes,
    expectedLinks,
    label,
    phase
  );
  const bytes = await Promise.all(paths.map(([file]) => fs.readFile(file)));
  if (bytes.some((value) => !value.equals(expectedBytes))) {
    throw new Error(
      `${label} byte validation was ambiguous; original filesystem links were retained.`
    );
  }
}

async function readLinkedStats(paths) {
  return Promise.all(
    paths.map(async ([file, subject]) => [
      await fs.lstat(file, { bigint: true }),
      subject
    ])
  );
}

function validateStats(
  stats,
  expectedStat,
  expectedBytes,
  expectedLinks,
  label,
  phase
) {
  for (const [stat, subject] of stats) {
    assertReliableRegularFile(stat, `${label} ${subject}`);
    assertSameFile(
      expectedStat,
      stat,
      `${label} ${subject} identity changed ${phase}.`
    );
    assertLinkCount(
      stat,
      expectedLinks,
      `${label} ${subject} has an ambiguous link count ${phase}.`
    );
    assertSize(
      stat,
      expectedBytes,
      `${label} ${subject} size changed ${phase}.`
    );
  }
}

async function restoreSourceFromAnchor(
  root,
  { anchorPath, source, expectedStat, expectedBytes, label }
) {
  let sourceRestored = false;
  try {
    await assertNoLinkTraversal(root, anchorPath, `${label} safety anchor`);
    await assertNoLinkTraversal(root, source, `${label} recovery source`);
    await fs.link(anchorPath, source);
    sourceRestored = true;
    for (const [file, subject] of [
      [anchorPath, "safety anchor"],
      [source, "restored source"]
    ]) {
      await assertNoLinkTraversal(root, file, `${label} ${subject}`);
      const stat = await fs.lstat(file, { bigint: true });
      assertReliableRegularFile(stat, `${label} ${subject}`);
      assertSameFile(
        expectedStat,
        stat,
        `${label} ${subject} does not identify the original source.`
      );
      if (stat.nlink < 2n) {
        throw new Error(`${label} ${subject} has an unsafe recovery link count.`);
      }
      assertSize(
        stat,
        expectedBytes,
        `${label} ${subject} size changed during source restoration.`
      );
      if (!(await fs.readFile(file)).equals(expectedBytes)) {
        throw new Error(`${label} ${subject} bytes changed during restoration.`);
      }
    }
    return { sourceRestored: true };
  } catch (error) {
    return { sourceRestored, error };
  }
}

function retainedAnchorError(
  error,
  {
    anchorPath,
    source,
    destinationLinked,
    sourceUnlinked,
    sourceRestored,
    restorationError,
    label
  }
) {
  const restoration = sourceRestored
    ? `The original source was restored at "${source}".`
    : `Source restoration did not complete: ${
        restorationError?.message ?? "unknown restoration error"
      }.`;
  const retained = new Error(
    `${error.message} ${restoration} Safety anchor retained at "${anchorPath}".`,
    { cause: error }
  );
  retained.code = "EATOMICANCHOR";
  annotateMoveError(retained, {
    destinationLinked,
    sourceUnlinked,
    sourceRestored,
    anchorPath
  });
  retained.label = label;
  return retained;
}

function annotateMoveError(
  error,
  { destinationLinked, sourceUnlinked, sourceRestored, anchorPath }
) {
  error.destinationLinked = destinationLinked;
  error.sourceUnlinked = sourceUnlinked;
  error.sourceRestored = sourceRestored;
  error.moveCommitted = false;
  if (anchorPath) {
    error.safetyAnchorPath = anchorPath;
  }
}

function privateAnchorPath(source) {
  return path.join(
    path.dirname(source),
    `.safety-link.${crypto.randomUUID()}.${path.basename(source)}.tmp`
  );
}

function assertReliableRegularFile(stat, label) {
  if (!stat.isFile()) {
    throw new Error(`${label} is not a regular file.`);
  }
  if (
    typeof stat.dev !== "bigint" ||
    typeof stat.ino !== "bigint" ||
    typeof stat.nlink !== "bigint" ||
    stat.ino <= 0n ||
    stat.nlink < 1n
  ) {
    throw new Error(`${label} does not expose reliable file identity and link metadata.`);
  }
}

function assertSameFile(expected, actual, message) {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(message);
  }
}

function assertLinkCount(stat, expected, message) {
  if (stat.nlink !== expected) {
    throw new Error(message);
  }
}

function assertSize(stat, bytes, message) {
  if (stat.size !== BigInt(bytes.length)) {
    throw new Error(message);
  }
}

function toBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
}
