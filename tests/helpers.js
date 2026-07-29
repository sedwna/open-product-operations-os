import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function makeTempDirectory(name = "product-ops-test-") {
  return fs.mkdtemp(path.join(os.tmpdir(), name));
}

export function captureIo() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    io: {
      log(value) {
        stdout.push(String(value));
      },
      error(value) {
        stderr.push(String(value));
      }
    }
  };
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
