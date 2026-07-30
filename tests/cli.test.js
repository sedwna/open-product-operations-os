import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { moveFileNoOverwrite } from "../src/atomic-move.js";
import { CONFIG_FILE } from "../src/constants.js";
import { run } from "../src/cli.js";
import {
  applyWrites,
  planWrites,
  summarizeWrites
} from "../src/file-writer.js";
import { captureIo, makeTempDirectory, readJson, writeJson } from "./helpers.js";

test("init creates the canonical 13-role, 23-tab project and validate accepts it", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "sample-product");
  const output = captureIo();

  assert.equal(await run(["init", target], output.io), 0);
  assert.equal(await run(["validate", target], output.io), 0);

  const config = await readJson(path.join(target, CONFIG_FILE));
  assert.equal(config.project.id, "sample-product");
  assert.equal(config.taskIds.prefix, "SP");
  assert.equal(config.agents.length, 13);
  assert.equal(config.workbook.sheets.length, 23);

  for (const agent of config.agents) {
    await fs.access(path.join(target, "agents", "roles", `${agent.id}.md`));
  }
  for (const sheet of config.workbook.sheets) {
    await fs.access(path.join(target, sheet.file));
  }
  await fs.access(
    path.join(target, "events", "EVT-00000000-001-first-discovery.md")
  );
  await fs.access(path.join(target, "config", "operating-model.yaml"));
  const discovery = await fs.readFile(
    path.join(target, "workbook", "08-discovery.csv"),
    "utf8"
  );
  assert.match(discovery, /DSC-00000000-001/);
  assert.match(output.stdout.join("\n"), /Validation passed/);
});

test("init dry-run reports the complete project without creating the target", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "dry-run-product");
  const output = captureIo();

  assert.equal(await run(["init", target, "--dry-run"], output.io), 0);
  await assert.rejects(fs.access(target), { code: "ENOENT" });
  assert.match(output.stdout.join("\n"), /Dry run: would write 56 file\(s\)/);
});

test("init derives valid task prefixes for short and numeric folder names", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const output = captureIo();

  for (const folderName of ["x", "123-product"]) {
    const target = path.join(parent, folderName);
    assert.equal(await run(["init", target], output.io), 0);
    assert.equal(await run(["validate", target], output.io), 0);
    const config = await readJson(path.join(target, CONFIG_FILE));
    assert.match(config.taskIds.prefix, /^[A-Z][A-Z0-9]{1,7}$/);
  }
});

test("generate-workbook adds a bounded extension sheet and honors dry-run", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "workbook-product");
  const configPath = path.join(target, CONFIG_FILE);
  const output = captureIo();

  assert.equal(await run(["init", target], output.io), 0);
  const config = await readJson(configPath);
  config.workbook.sheets.push({
    key: "risk_register",
    name: "Risk Register",
    file: "workbook/risk-register.csv",
    owner: "RB-08",
    columns: ["risk_id", "description", "owner", "disposition"]
  });
  config.ownership.push({ artifact: "risk_register", owner: "RB-08" });
  await writeJson(configPath, config);

  assert.equal(
    await run(["generate-workbook", target, "--dry-run"], output.io),
    0
  );
  await assert.rejects(fs.access(path.join(target, "workbook/risk-register.csv")), {
    code: "ENOENT"
  });

  assert.equal(await run(["generate-workbook", target], output.io), 0);
  assert.equal(
    await fs.readFile(path.join(target, "workbook/risk-register.csv"), "utf8"),
    "risk_id,description,owner,disposition\n"
  );
  assert.equal(await run(["init", target, "--force"], output.io), 0);
  assert.equal(await run(["validate", target], output.io), 0);
});

test("generate-workbook --force preserves operational rows", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "protected-product");
  const workbook = path.join(target, "workbook", "10-issues.csv");
  const output = captureIo();

  assert.equal(await run(["init", target], output.io), 0);
  await fs.appendFile(
    workbook,
    "ISS-20990101-999,EVT-20990101-999,Operational canary,open,P2,low,,,,,,,,,,,,RB-05,actor-rb-05,,\n"
  );

  assert.equal(await run(["generate-workbook", target], output.io), 1);
  assert.match(output.stderr.at(-1), /Refusing to overwrite/);
  assert.match(await fs.readFile(workbook, "utf8"), /ISS-20990101-999/);

  assert.equal(await run(["generate-workbook", target, "--force"], output.io), 0);
  assert.match(await fs.readFile(workbook, "utf8"), /ISS-20990101-999/);
  assert.equal(await run(["validate", target], output.io), 0);
});

test("init rejects symlink or junction traversal before any escaped write", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "linked-product");
  const outside = path.join(parent, "outside");
  await fs.mkdir(target);
  await fs.mkdir(outside);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(outside, path.join(target, "workbook"), linkType);
  const output = captureIo();

  assert.equal(await run(["init", target], output.io), 1);
  assert.match(output.stderr.at(-1), /symbolic link, junction, or reparse point/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("init rejects a target root that is itself a symlink or junction", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const realParent = path.join(parent, "real-parent");
  const linkedParent = path.join(parent, "linked-parent");
  await fs.mkdir(realParent);
  await fs.symlink(
    realParent,
    linkedParent,
    process.platform === "win32" ? "junction" : "dir"
  );
  const output = captureIo();

  assert.equal(
    await run(["init", linkedParent], output.io),
    1
  );
  assert.match(output.stderr.at(-1), /symbolic link, junction, or reparse point/);
  assert.deepEqual(await fs.readdir(realParent), []);
});

test("init canonicalizes a pre-existing alias outside the selected target root", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const realParent = path.join(parent, "real-parent");
  const linkedParent = path.join(parent, "linked-parent");
  await fs.mkdir(realParent);
  await fs.symlink(
    realParent,
    linkedParent,
    process.platform === "win32" ? "junction" : "dir"
  );
  const target = path.join(linkedParent, "new-product");
  const output = captureIo();

  assert.equal(await run(["init", target], output.io), 0);
  assert.equal(await run(["validate", target], output.io), 0);
  await fs.access(path.join(realParent, "new-product", CONFIG_FILE));
});

test("unknown CLI options fail cleanly", async () => {
  const output = captureIo();
  assert.equal(await run(["init", "target", "--mystery"], output.io), 1);
  assert.match(output.stderr[0], /Unknown option/);
});

test("init --force preserves valid operational configuration and extensions", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "preserved-config");
  const configPath = path.join(target, CONFIG_FILE);
  const output = captureIo();

  assert.equal(await run(["init", target], output.io), 0);
  const config = await readJson(configPath);
  config.project.vision = "A human-authored operational vision.";
  config.project.environments = ["local", "test"];
  config.project.humanAuthorityActorId = "human-authority-custom";
  config.agents[0].actorId = "custom-coordinator-actor";
  config.workbook.sheets.push({
    key: "risk_register",
    name: "Risk Register",
    file: "workbook/risk-register.csv",
    owner: "RB-08",
    columns: ["risk_id", "description", "owner", "disposition"]
  });
  config.ownership.push({ artifact: "risk_register", owner: "RB-08" });
  await writeJson(configPath, config);
  const configBytes = await fs.readFile(configPath);

  assert.equal(await run(["init", target, "--force"], output.io), 0);
  assert.deepEqual(await fs.readFile(configPath), configBytes);
  assert.deepEqual(await readJson(configPath), config);
  await fs.access(path.join(target, "workbook", "risk-register.csv"));
});

test("init refuses existing hard-linked scaffold without modifying its peer", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "hardlink-product");
  const output = captureIo();
  assert.equal(await run(["init", target], output.io), 0);

  const generated = path.join(target, "agents", "registry.json");
  const outside = path.join(parent, "outside-registry.json");
  await fs.copyFile(generated, outside);
  await fs.rm(generated);
  try {
    await fs.link(outside, generated);
  } catch (error) {
    if (["EPERM", "ENOTSUP", "EACCES"].includes(error.code)) {
      t.skip(`hard links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const before = await fs.readFile(outside, "utf8");

  assert.equal(await run(["init", target, "--force"], output.io), 1);
  assert.match(output.stderr.at(-1), /hard-linked/);
  assert.equal(await fs.readFile(outside, "utf8"), before);
});

test("initializer refuses a hard-link swap instead of replacing it", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "atomic-hardlink-race");
  const destination = path.join(target, "scaffold.txt");
  const outside = path.join(parent, "outside.txt");
  await fs.mkdir(target);
  await fs.writeFile(destination, "old scaffold\n");
  await fs.writeFile(outside, "outside bytes must survive\n");
  const hardLinkProbe = path.join(target, "hard-link-probe.txt");
  try {
    await fs.link(outside, hardLinkProbe);
    await fs.rm(hardLinkProbe);
  } catch (error) {
    if (["EPERM", "ENOTSUP", "EACCES"].includes(error.code)) {
      t.skip(`hard links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const operations = await planWrites(
    target,
    new Map([["scaffold.txt", "new scaffold\n"]]),
    { force: true }
  );
  let injected = false;

  await assert.rejects(
    applyWrites(target, operations, {
      transactionObserver: async ({ phase, relativePath }) => {
        assert.equal(phase, "before-atomic-replace");
        assert.equal(relativePath, "scaffold.txt");
        await fs.rm(destination);
        await fs.link(outside, destination);
        injected = true;
      }
    }),
    /hard-linked/
  );

  assert.equal(injected, true);
  assert.equal(await fs.readFile(destination, "utf8"), "outside bytes must survive\n");
  assert.equal(await fs.readFile(outside, "utf8"), "outside bytes must survive\n");
  assert.ok((await fs.lstat(destination)).nlink >= 2);
});

test("initializer refuses to overwrite a destination created after planning", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "atomic-create-race");
  const destination = path.join(target, "scaffold.txt");
  await fs.mkdir(target);
  const operations = await planWrites(
    target,
    new Map([["scaffold.txt", "new scaffold\n"]]),
    { force: true }
  );

  await assert.rejects(
    applyWrites(target, operations, {
      transactionObserver: async ({ phase }) => {
        if (phase === "before-atomic-replace") {
          await fs.writeFile(destination, "concurrent create\n", {
            encoding: "utf8",
            flag: "wx"
          });
        }
      }
    }),
    /created or recreated concurrently/
  );
  assert.equal(await fs.readFile(destination, "utf8"), "concurrent create\n");
});

test("initializer preserves a concurrently recreated destination and quarantined original", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "atomic-recreate-race");
  const destination = path.join(target, "scaffold.txt");
  await fs.mkdir(target);
  await fs.writeFile(destination, "old scaffold\n");
  const operations = await planWrites(
    target,
    new Map([["scaffold.txt", "new scaffold\n"]]),
    { force: true }
  );

  await assert.rejects(
    applyWrites(target, operations, {
      transactionObserver: async ({ phase }) => {
        if (phase === "after-target-quarantine-verified") {
          await fs.writeFile(destination, "concurrent recreate\n", {
            encoding: "utf8",
            flag: "wx"
          });
        }
      }
    }),
    /created or recreated concurrently.*Recoverable prior bytes were retained/
  );

  assert.equal(await fs.readFile(destination, "utf8"), "concurrent recreate\n");
  const retained = (await fs.readdir(target)).filter((name) =>
    /^\.scaffold\.txt\..+\.before\.tmp$/.test(name)
  );
  assert.equal(retained.length, 1);
  assert.equal(
    await fs.readFile(path.join(target, retained[0]), "utf8"),
    "old scaffold\n"
  );
});

test("force init cannot overwrite a quarantine artifact created after the final absence check", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "atomic-quarantine-race");
  const destination = path.join(target, "scaffold.txt");
  await fs.mkdir(target);
  await fs.writeFile(destination, "old scaffold\n");
  const operations = await planWrites(
    target,
    new Map([["scaffold.txt", "new scaffold\n"]]),
    { force: true }
  );
  const successSummary = [];
  let quarantinePath;

  await assert.rejects(
    (async () => {
      await applyWrites(target, operations, {
        transactionObserver: async (event) => {
          if (event.phase === "before-target-quarantine-move") {
            quarantinePath = event.quarantinePath;
            await fs.writeFile(quarantinePath, "concurrent quarantine\n", {
              encoding: "utf8",
              flag: "wx"
            });
          }
        }
      });
      successSummary.push(...summarizeWrites(target, operations, false));
    })(),
    /quarantine destination already exists.*no-overwrite move refused/
  );

  assert.equal(await fs.readFile(destination, "utf8"), "old scaffold\n");
  assert.equal(
    await fs.readFile(quarantinePath, "utf8"),
    "concurrent quarantine\n"
  );
  assert.deepEqual(successSummary, []);
});

test("initializer recovery cannot overwrite a displaced artifact created after the final absence check", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "atomic-displaced-race");
  const destination = path.join(target, "scaffold.txt");
  await fs.mkdir(target);
  await fs.writeFile(destination, "old scaffold\n");
  const operations = await planWrites(
    target,
    new Map([["scaffold.txt", "new scaffold\n"]]),
    { force: true }
  );
  const successSummary = [];
  let quarantinePath;
  let displacedPath;

  await assert.rejects(
    (async () => {
      await applyWrites(target, operations, {
        transactionObserver: async (event) => {
          if (event.phase === "after-target-installed") {
            quarantinePath = event.quarantinePath;
            throw new Error("injected post-install failure");
          }
          if (event.phase === "before-displaced-recovery-move") {
            displacedPath = event.displacedPath;
            await fs.writeFile(displacedPath, "concurrent displaced\n", {
              encoding: "utf8",
              flag: "wx"
            });
          }
        }
      });
      successSummary.push(...summarizeWrites(target, operations, false));
    })(),
    /automatic recovery also failed; recoverable artifacts were retained/
  );

  assert.equal(await fs.readFile(destination, "utf8"), "new scaffold\n");
  assert.equal(await fs.readFile(quarantinePath, "utf8"), "old scaffold\n");
  assert.equal(
    await fs.readFile(displacedPath, "utf8"),
    "concurrent displaced\n"
  );
  assert.deepEqual(successSummary, []);
});

test("atomic move retains its source when the destination is replaced before final validation", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "source.tmp");
  const destination = path.join(parent, "destination.txt");
  await fs.writeFile(source, "original source bytes\n");

  await assert.rejects(
    moveFileNoOverwrite(parent, source, destination, "Race probe", {
      expectedContent: "original source bytes\n",
      moveObserver: async ({ phase }) => {
        if (phase === "before-source-unlink-validation") {
          await fs.unlink(destination);
          await fs.writeFile(destination, "concurrent destination bytes\n", {
            encoding: "utf8",
            flag: "wx"
          });
        }
      }
    }),
    /before source unlink/
  );

  assert.equal(await fs.readFile(source, "utf8"), "original source bytes\n");
  assert.equal(
    await fs.readFile(destination, "utf8"),
    "concurrent destination bytes\n"
  );
  assert.equal((await fs.lstat(source)).nlink, 1);
  assert.equal((await fs.lstat(destination)).nlink, 1);
});
