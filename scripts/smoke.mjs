import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const parent = await fs.mkdtemp(path.join(os.tmpdir(), "product-ops-smoke-"));
const target = path.join(parent, "smoke-project");
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const cli = path.join(repositoryRoot, "src/cli.js");
const execute = promisify(execFile);

try {
  await execute(process.execPath, [cli, "init", target]);
  await execute(process.execPath, [cli, "validate", target]);
  await execute(process.execPath, [cli, "generate-workbook", target]);
} finally {
  await fs.rm(parent, { recursive: true, force: true });
}
