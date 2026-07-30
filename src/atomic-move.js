import fs from "node:fs/promises";
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
  let destinationLinked = false;
  let sourceUnlinked = false;
  let sourceHandle;
  try {
    await assertNoLinkTraversal(root, source, `${label} source`);
    await assertNoLinkTraversal(root, destination, `${label} destination`);
    sourceHandle = await fs.open(source, "r");
    const sourceBefore = await sourceHandle.stat({ bigint: true });
    assertReliableRegularFile(sourceBefore, `${label} source`);
    if (sourceBefore.nlink !== 1n) {
      throw new Error(
        `${label} source is hard-linked (${sourceBefore.nlink} links); refusing an ambiguous move.`
      );
    }

    const sourceBytes = await sourceHandle.readFile();
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

    const sourcePathBeforeLink = await fs.lstat(source, { bigint: true });
    assertSameFile(
      sourceBefore,
      sourcePathBeforeLink,
      `${label} source path changed before link installation.`
    );
    assertLinkCount(
      sourcePathBeforeLink,
      1n,
      `${label} source link count changed before link installation.`
    );

    await fs.link(source, destination);
    destinationLinked = true;

    await assertNoLinkTraversal(root, source, `${label} source`);
    await assertNoLinkTraversal(root, destination, `${label} destination`);
    const [sourceLinked, destinationLinkedStat, handleLinked] = await Promise.all([
      fs.lstat(source, { bigint: true }),
      fs.lstat(destination, { bigint: true }),
      sourceHandle.stat({ bigint: true })
    ]);
    for (const [stat, subject] of [
      [sourceLinked, "source"],
      [destinationLinkedStat, "destination"],
      [handleLinked, "open source"]
    ]) {
      assertReliableRegularFile(stat, `${label} ${subject}`);
      assertSameFile(
        sourceBefore,
        stat,
        `${label} ${subject} does not identify the installed hard link.`
      );
      assertLinkCount(
        stat,
        2n,
        `${label} ${subject} has an ambiguous link count after installation.`
      );
      assertSize(
        stat,
        sourceBytes,
        `${label} ${subject} size changed after installation.`
      );
    }

    const [linkedSourceBytes, linkedDestinationBytes] = await Promise.all([
      fs.readFile(source),
      fs.readFile(destination)
    ]);
    if (
      !linkedSourceBytes.equals(sourceBytes) ||
      !linkedDestinationBytes.equals(sourceBytes)
    ) {
      throw new Error(
        `${label} byte validation was ambiguous after link installation; both paths were retained.`
      );
    }

    await moveObserver({
      phase: "before-source-unlink-validation",
      source,
      destination,
      label
    });

    await sourceHandle.close();
    sourceHandle = undefined;
    await assertNoLinkTraversal(root, source, `${label} source`);
    await assertNoLinkTraversal(root, destination, `${label} destination`);
    const [sourceBeforeUnlink, destinationBeforeUnlink] = await Promise.all([
      fs.lstat(source, { bigint: true }),
      fs.lstat(destination, { bigint: true })
    ]);
    for (const [stat, subject] of [
      [sourceBeforeUnlink, "source"],
      [destinationBeforeUnlink, "destination"]
    ]) {
      assertReliableRegularFile(stat, `${label} ${subject}`);
      assertSameFile(
        sourceBefore,
        stat,
        `${label} ${subject} identity changed before source unlink.`
      );
      assertLinkCount(
        stat,
        2n,
        `${label} ${subject} has an ambiguous link count before source unlink.`
      );
      assertSize(
        stat,
        sourceBytes,
        `${label} ${subject} size changed before source unlink.`
      );
    }

    const [finalSourceBytes, finalDestinationBytes] = await Promise.all([
      fs.readFile(source),
      fs.readFile(destination)
    ]);
    if (
      !finalSourceBytes.equals(sourceBytes) ||
      !finalDestinationBytes.equals(sourceBytes)
    ) {
      throw new Error(
        `${label} bytes changed before source unlink; the original source was retained.`
      );
    }

    const [sourceImmediatelyBeforeUnlink, destinationImmediatelyBeforeUnlink] =
      await Promise.all([
        fs.lstat(source, { bigint: true }),
        fs.lstat(destination, { bigint: true })
      ]);
    for (const [stat, subject] of [
      [sourceImmediatelyBeforeUnlink, "source"],
      [destinationImmediatelyBeforeUnlink, "destination"]
    ]) {
      assertSameFile(
        sourceBefore,
        stat,
        `${label} ${subject} identity changed before verified unlink.`
      );
      assertLinkCount(
        stat,
        2n,
        `${label} ${subject} link count changed before verified unlink.`
      );
      assertSize(
        stat,
        sourceBytes,
        `${label} ${subject} size changed before verified unlink.`
      );
    }

    await fs.unlink(source);
    sourceUnlinked = true;
    return { bytes: sourceBytes };
  } catch (error) {
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
    moveError.destinationLinked = destinationLinked;
    moveError.sourceUnlinked = sourceUnlinked;
    throw moveError;
  } finally {
    await sourceHandle?.close();
  }
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
