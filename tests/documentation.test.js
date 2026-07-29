import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("repository-relative Markdown links resolve", async () => {
  const markdownFiles = await findMarkdown(root);
  const missing = [];
  for (const file of markdownFiles) {
    const text = await fs.readFile(file, "utf8");
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0].trim();
      if (
        target === "" ||
        /^[a-z][a-z0-9+.-]*:/i.test(target) ||
        target.startsWith("#")
      ) {
        continue;
      }
      const decoded = decodeURIComponent(target);
      try {
        await fs.access(path.resolve(path.dirname(file), decoded));
      } catch {
        missing.push(`${path.relative(root, file)} -> ${target}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

async function findMarkdown(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) {
      continue;
    }
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findMarkdown(location)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(location);
    }
  }
  return found;
}
