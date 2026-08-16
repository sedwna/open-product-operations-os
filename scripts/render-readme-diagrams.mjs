import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(root, ".github", "diagrams");
const outputDirectory = path.join(root, ".github", "assets", "diagrams");
const sourceFiles = (await fs.readdir(sourceDirectory))
  .filter((file) => file.endsWith(".mmd"))
  .sort();

await fs.mkdir(outputDirectory, { recursive: true });

for (const sourceFile of sourceFiles) {
  const code = await fs.readFile(path.join(sourceDirectory, sourceFile), "utf8");
  const state = {
    code,
    mermaid: JSON.stringify({ theme: "default" }),
    updateDiagram: true
  };
  const encoded = deflateSync(JSON.stringify(state)).toString("base64url");
  const response = await fetch(
    `https://mermaid.ink/svg/pako:${encoded}?bgColor=!white`,
    { signal: AbortSignal.timeout(60_000) }
  );
  const svg = await response.text();
  if (!response.ok) {
    throw new Error(
      `Mermaid renderer returned HTTP ${response.status} for ${sourceFile}: ${svg.slice(0, 300)}`
    );
  }
  if (!/<svg[\s>]/i.test(svg) || /syntax error|parse error/i.test(svg)) {
    throw new Error(`Mermaid renderer did not return a valid diagram for ${sourceFile}.`);
  }
  const outputFile = sourceFile.replace(/\.mmd$/, ".svg");
  await fs.writeFile(path.join(outputDirectory, outputFile), svg, "utf8");
  console.log(`Rendered ${sourceFile} -> ${outputFile}`);
}
