import fs from "node:fs/promises";
import path from "node:path";
import { assertNoLinkTraversal, toPosixPath } from "../paths.js";
import { validatePublishedSchema } from "../schema-validation.js";
import { assertNoCredentialMaterial } from "../runtime/security.js";
import { runGit } from "../autopilot/shared.js";
import { DEVELOPMENT_NAMESPACE } from "../development/catalog.js";

/**
 * Read an existing application repository mechanically, before anyone interprets it.
 *
 * The survey deliberately draws no conclusions. It says what is there, what it could not read and
 * why, and which boundary owns reading what. Interpretation — what this product is, who it serves,
 * what is wrong with it — belongs to the teams, because a machine guessing at product meaning and
 * a person deciding it must never become the same record.
 *
 * The property that matters is coverage. Adopting a repository "completely" is only a real claim if
 * every path is accounted for, so each one is either assigned to a boundary or excluded for a named
 * reason, and `coverage.complete` is false the moment that stops adding up.
 */

const EXCLUDED_DIRECTORIES = new Map([
  ["node_modules", "dependency"],
  ["vendor", "vendored"],
  ["bower_components", "dependency"],
  [".git", "version_control"],
  [".hg", "version_control"],
  [".svn", "version_control"],
  ["dist", "build_output"],
  ["build", "build_output"],
  ["out", "build_output"],
  ["target", "build_output"],
  [".next", "build_output"],
  [".nuxt", "build_output"],
  ["__pycache__", "build_output"],
  [".venv", "dependency"],
  ["venv", "dependency"],
  [".gradle", "build_output"],
  [".tox", "build_output"],
  ["coverage", "generated"],
  [".product-ops", "generated"]
]);

/**
 * This operating model's own scaffolding, skipped at the repository root.
 *
 * Adopting a repository means reading the product. A team asked to interpret the boundaries we
 * wrote into it a minute earlier would be reading our furniture and reporting it as findings —
 * and the deeper the reading, the more confidently wrong the result.
 */
const OWN_SCAFFOLDING = new Set(DEVELOPMENT_NAMESPACE);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".svg",
  ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar", ".jar", ".war",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm", ".class", ".pyc",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".wav", ".mov", ".avi", ".webm",
  ".db", ".sqlite", ".sqlite3"
]);

const GENERATED_FILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "poetry.lock", "Pipfile.lock", "Cargo.lock", "composer.lock", "Gemfile.lock", "go.sum"
]);

const MANIFESTS = new Map([
  ["package.json", "javascript"],
  ["deno.json", "javascript"],
  ["requirements.txt", "python"],
  ["pyproject.toml", "python"],
  ["setup.py", "python"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["pom.xml", "java"],
  ["build.gradle", "java"],
  ["build.gradle.kts", "java"],
  ["composer.json", "php"],
  ["Gemfile", "ruby"],
  ["pubspec.yaml", "dart"],
  ["mix.exs", "elixir"]
]);

const LANGUAGE_BY_EXTENSION = new Map([
  [".js", "javascript"], [".mjs", "javascript"], [".cjs", "javascript"], [".jsx", "javascript"],
  [".ts", "typescript"], [".tsx", "typescript"],
  [".py", "python"], [".rb", "ruby"], [".go", "go"], [".rs", "rust"],
  [".java", "java"], [".kt", "kotlin"], [".swift", "swift"], [".m", "objective-c"],
  [".cs", "csharp"], [".php", "php"], [".ex", "elixir"], [".exs", "elixir"],
  [".c", "c"], [".h", "c"], [".cc", "cpp"], [".cpp", "cpp"], [".hpp", "cpp"],
  [".dart", "dart"], [".scala", "scala"], [".sh", "shell"], [".sql", "sql"],
  [".html", "markup"], [".css", "styles"], [".scss", "styles"], [".vue", "javascript"], [".svelte", "javascript"]
]);

const MARKER_PATTERN = /\b(TODO|FIXME|HACK|XXX|DEPRECATED)\b[:\s-]{0,3}(.{0,200})/;

const MAX_PATHS = 20_000;
const MAX_MARKER_BYTES = 512 * 1024;
const MAX_LISTED_PATHS = 400;

export async function surveyApplication(applicationRoot, { now = new Date(), maxPaths = MAX_PATHS } = {}) {
  const root = path.resolve(applicationRoot);
  await assertNoLinkTraversal(path.dirname(root), root, "Application root");
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Application root is not a readable directory: ${applicationRoot}`);

  const walked = await walk(root, maxPaths);
  const examined = walked.files.filter((file) => file.disposition === "examined");
  const excluded = walked.files.filter((file) => file.disposition !== "examined");

  const survey = {
    schemaVersion: "1.0.0",
    applicationRoot: toPosixPath(root),
    surveyedAt: now.toISOString(),
    revision: await headRevision(root),
    coverage: {
      totalPaths: walked.files.length,
      examinedPaths: examined.length,
      excludedPaths: excluded.length,
      truncated: walked.truncated,
      // The whole point of the survey. If this is ever false the caller must not describe the
      // repository as fully read, whatever else the survey contains.
      complete: !walked.truncated && examined.length + excluded.length === walked.files.length,
      exclusionsByReason: countBy(excluded, (file) => file.disposition)
    },
    stacks: await readStacks(root, examined),
    languages: countBy(examined.filter((file) => file.language), (file) => file.language),
    entryPoints: list(examined.filter((file) => file.kind === "entry")),
    documentation: list(examined.filter((file) => file.kind === "documentation")),
    tests: list(examined.filter((file) => file.kind === "test")),
    configuration: list(examined.filter((file) => file.kind === "configuration")),
    signals: {
      markers: await collectMarkers(root, examined),
      churn: await collectChurn(root),
      history: await collectHistory(root)
    },
    assignments: assign(examined)
  };

  // A repository is exactly the kind of place a secret gets committed by accident. Refusing here
  // keeps one out of the product records rather than discovering it after it is canonical.
  assertNoCredentialMaterial("Adoption survey", survey);
  const errors = validatePublishedSchema("adoption-survey.schema.json", survey);
  if (errors.length) throw new Error(`Adoption survey is invalid:\n- ${errors.join("\n- ")}`);
  return survey;
}

/**
 * Assign every examined path to the boundary whose job it is to interpret it.
 *
 * Assignment is what makes adoption complete: a path nobody was asked to read is a part of the
 * product nobody adopted. Each boundary is given the question it should answer, not an answer.
 */
function assign(examined) {
  const groups = [
    {
      roleId: "RB-03",
      question: "What is this product, who is it for, and what does its own documentation claim it does? Record what is stated, what is contradicted by the code, and what is simply absent.",
      match: (file) => file.kind === "documentation"
    },
    {
      roleId: "RB-04",
      question: "What domains, user roles, capabilities, and journeys does this codebase actually implement? Derive them from entry points and routes rather than from what the documentation wishes were true.",
      match: (file) => file.kind === "entry" || file.kind === "source"
    },
    {
      roleId: "RB-05",
      question: "What is already known to be wrong or unfinished here? Every marker, every disabled test, every path the history keeps returning to. Record each as an observation with its source, not as an accepted issue.",
      match: (file) => file.kind === "test" || file.kind === "source"
    },
    {
      roleId: "RB-08",
      question: "Where is the risk concentrated — configuration, data handling, external boundaries, and anything the tests do not reach? State the assumption behind each concern.",
      match: (file) => file.kind === "configuration" || file.kind === "data"
    }
  ];

  const assignments = groups
    .map((group) => {
      const paths = examined.filter(group.match).map((file) => file.path).sort();
      return {
        roleId: group.roleId,
        question: group.question,
        paths: paths.slice(0, MAX_LISTED_PATHS),
        pathCount: paths.length,
        truncated: paths.length > MAX_LISTED_PATHS
      };
    })
    .filter((assignment) => assignment.pathCount > 0);

  // Anything the groups above did not claim still belongs to someone. Experience owns the residue
  // rather than letting it fall out of the adoption silently.
  const residue = examined
    .filter((file) => !groups.some((group) => group.match(file)))
    .map((file) => file.path)
    .sort();
  if (residue.length > 0) {
    const existing = assignments.find((assignment) => assignment.roleId === "RB-04");
    if (existing) {
      const merged = [...new Set([...existing.paths, ...residue])].sort();
      existing.paths = merged.slice(0, MAX_LISTED_PATHS);
      existing.pathCount += residue.length;
      existing.truncated = existing.pathCount > existing.paths.length;
    } else {
      assignments.push({
        roleId: "RB-04",
        question: "What are these remaining parts of the repository, and do they belong to the product's behaviour or to its scaffolding?",
        paths: residue.slice(0, MAX_LISTED_PATHS),
        pathCount: residue.length,
        truncated: residue.length > MAX_LISTED_PATHS
      });
    }
  }

  if (assignments.length === 0) {
    assignments.push({
      roleId: "RB-03",
      question: "This repository contains nothing readable to adopt. Confirm with the owner whether the right path was given before anything else is recorded.",
      paths: [],
      pathCount: 0,
      truncated: false
    });
  }
  return assignments;
}

async function walk(root, maxPaths) {
  const files = [];
  let truncated = false;
  const queue = [root];

  while (queue.length > 0) {
    const directory = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      files.push({ path: relative(root, directory), disposition: "unreadable" });
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= maxPaths) {
        truncated = true;
        return { files, truncated };
      }
      const absolute = path.join(directory, entry.name);
      if (directory === root && OWN_SCAFFOLDING.has(entry.name)) {
        files.push({ path: relative(root, absolute), disposition: "generated" });
        continue;
      }
      if (entry.isSymbolicLink()) {
        // Following a link can leave the repository entirely, and a link's target is surveyed on its
        // own terms if it lives inside. Recording it keeps the count honest without following it.
        files.push({ path: relative(root, absolute), disposition: "vendored" });
        continue;
      }
      if (entry.isDirectory()) {
        const reason = EXCLUDED_DIRECTORIES.get(entry.name);
        if (reason) {
          files.push({ path: relative(root, absolute), disposition: reason });
          continue;
        }
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(await classify(root, absolute, entry.name));
    }
  }
  return { files, truncated };
}

async function classify(root, absolute, name) {
  const relativePath = relative(root, absolute);
  const extension = path.extname(name).toLowerCase();

  if (GENERATED_FILES.has(name)) return { path: relativePath, disposition: "generated" };
  if (BINARY_EXTENSIONS.has(extension)) return { path: relativePath, disposition: "binary_asset" };

  let size = 0;
  try {
    size = (await fs.stat(absolute)).size;
  } catch {
    return { path: relativePath, disposition: "unreadable" };
  }
  if (size > 2 * 1024 * 1024) return { path: relativePath, disposition: "oversized" };

  return {
    path: relativePath,
    disposition: "examined",
    size,
    language: LANGUAGE_BY_EXTENSION.get(extension) ?? null,
    kind: kindOf(relativePath, name, extension)
  };
}

function kindOf(relativePath, name, extension) {
  const lower = relativePath.toLowerCase();
  if (/(^|\/)(readme|changelog|contributing|architecture|docs?)/.test(lower) && [".md", ".mdx", ".rst", ".txt", ".adoc"].includes(extension)) {
    return "documentation";
  }
  if ([".md", ".mdx", ".rst", ".adoc"].includes(extension)) return "documentation";
  if (/(^|\/)(tests?|spec|__tests__|e2e)(\/|$)/.test(lower) || /\.(test|spec)\.[a-z]+$/.test(lower)) return "test";
  if (looksLikeConfiguration(name)) return "configuration";
  if ([".json", ".yaml", ".yml", ".toml", ".ini", ".env"].includes(extension)) return "configuration";
  if ([".csv", ".tsv", ".xml", ".graphql", ".proto"].includes(extension)) return "data";
  if (/(^|\/)(index|main|app|server|cli|entry)\.[a-z]+$/.test(lower)) return "entry";
  if (LANGUAGE_BY_EXTENSION.has(extension)) return "source";
  return "data";
}

/**
 * Named shapes rather than a loose pattern. Matching "rc" anywhere in a filename classified
 * ordinary source — `src.js` among them — as configuration, which then sent it to the boundary that
 * reads risk instead of the one that reads behaviour.
 */
function looksLikeConfiguration(name) {
  const lower = name.toLowerCase();
  if (MANIFESTS.has(name)) return true;
  if (lower.startsWith(".") && /(rc|config)(\.[a-z]+)?$/.test(lower)) return true;
  return /\.config\.[a-z]+$/.test(lower);
}

async function readStacks(root, examined) {
  const stacks = [];
  for (const file of examined) {
    const name = path.posix.basename(file.path);
    const ecosystem = MANIFESTS.get(name);
    if (!ecosystem) continue;
    const stack = { manifest: file.path, ecosystem, name: null, declaredDependencies: 0 };
    if (name === "package.json") {
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(root, file.path), "utf8"));
        stack.name = typeof manifest.name === "string" ? manifest.name.slice(0, 200) : null;
        stack.declaredDependencies =
          Object.keys(manifest.dependencies ?? {}).length + Object.keys(manifest.devDependencies ?? {}).length;
      } catch {
        // An unreadable or malformed manifest is a finding for the teams, not a reason to abandon
        // the survey. It still counts as a stack that exists.
      }
    }
    stacks.push(stack);
    if (stacks.length >= 40) break;
  }
  return stacks;
}

async function collectMarkers(root, examined) {
  const markers = [];
  for (const file of examined) {
    if (markers.length >= 500) break;
    if (!["source", "entry", "test", "configuration"].includes(file.kind)) continue;
    if (file.size > MAX_MARKER_BYTES) continue;
    let content;
    try {
      content = await fs.readFile(path.join(root, file.path), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length && markers.length < 500; index += 1) {
      const match = MARKER_PATTERN.exec(lines[index]);
      if (!match) continue;
      markers.push({
        path: file.path,
        line: index + 1,
        kind: match[1],
        text: match[2].trim().slice(0, 400) || match[1]
      });
    }
  }
  return markers;
}

async function collectChurn(root) {
  const result = await runGit(root, ["log", "--name-only", "--pretty=format:", "-n", "400"]).catch(() => null);
  if (!result) return [];
  const counts = new Map();
  for (const line of result.stdout.split("\n")) {
    const value = line.trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, commits]) => commits > 1)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 50)
    .map(([value, commits]) => ({ path: value.slice(0, 400), commits }));
}

async function collectHistory(root) {
  const count = await runGit(root, ["rev-list", "--count", "HEAD"]).catch(() => null);
  if (!count) return null;
  const first = await runGit(root, ["log", "--reverse", "--format=%aI", "--max-count=1"]).catch(() => null);
  const last = await runGit(root, ["log", "--format=%aI", "--max-count=1"]).catch(() => null);
  const authors = await runGit(root, ["shortlog", "--summary", "--numbered", "--email", "HEAD"]).catch(() => null);
  return {
    commits: Number.parseInt(count.stdout.trim(), 10) || 0,
    firstCommitAt: first?.stdout.trim().split("\n")[0] || null,
    lastCommitAt: last?.stdout.trim().split("\n")[0] || null,
    contributors: authors ? authors.stdout.trim().split("\n").filter(Boolean).length : 0
  };
}

async function headRevision(root) {
  const result = await runGit(root, ["rev-parse", "HEAD"]).catch(() => null);
  return result ? result.stdout.trim().slice(0, 80) : null;
}

function list(files) {
  return files.map((file) => file.path).sort().slice(0, MAX_LISTED_PATHS);
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    const value = key(item);
    if (value) counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function relative(root, absolute) {
  return toPosixPath(path.relative(root, absolute)) || ".";
}
