import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { surveyApplication } from "../src/adoption/survey.js";
import { validatePublishedSchema } from "../src/schema-validation.js";
import { makeTempDirectory } from "./helpers.js";

/** A small but realistic application: source, tests, docs, config, dependencies, and noise. */
async function application(t, extra = {}) {
  const parent = await makeTempDirectory("product-ops-adopt-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "app");
  const files = {
    "package.json": JSON.stringify({ name: "pinedesk", dependencies: { express: "4.0.0" }, devDependencies: { jest: "29.0.0" } }),
    "README.md": "# PineDesk\n\nA desk booking tool for hybrid teams.\n",
    "docs/architecture.md": "# Architecture\n\nOne service, one database.\n",
    "src/index.js": "// TODO: retire the legacy booking path\nexport function main() { return 1; }\n",
    "src/booking.js": "export function book() { return true; }\n",
    "src/legacy/seats.js": "// FIXME: seat map assumes one floor\nexport const seats = [];\n",
    "tests/booking.test.js": "test('books', () => {});\n",
    "config/settings.yaml": "port: 8080\n",
    "data/seed.csv": "id,name\n1,a\n",
    ".eslintrc.json": "{}",
    "node_modules/express/index.js": "module.exports = {};",
    "dist/bundle.js": "/* built */",
    "assets/logo.png": "PNG binary-ish",
    "package-lock.json": JSON.stringify({ lockfileVersion: 3 }),
    ...extra
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  }
  return root;
}

test("the survey accounts for every path it found", async (t) => {
  const root = await application(t);
  const survey = await surveyApplication(root);

  assert.equal(validatePublishedSchema("adoption-survey.schema.json", survey).length, 0);
  assert.equal(
    survey.coverage.examinedPaths + survey.coverage.excludedPaths,
    survey.coverage.totalPaths,
    "a path that is neither read nor excluded is a part of the product nobody adopted"
  );
  assert.equal(survey.coverage.complete, true);
  assert.ok(survey.coverage.examinedPaths > 0);
});

test("what cannot be read is excluded by name, never silently", async (t) => {
  const root = await application(t);
  const survey = await surveyApplication(root);
  const reasons = survey.coverage.exclusionsByReason;

  assert.ok(reasons.dependency >= 1, "vendored dependencies must be excluded as dependencies");
  assert.ok(reasons.build_output >= 1, "build output must be excluded as build output");
  assert.ok(reasons.binary_asset >= 1, "binaries must be excluded as binary assets");
  assert.ok(reasons.generated >= 1, "lockfiles must be excluded as generated");
  for (const count of Object.values(reasons)) assert.ok(count > 0);
});

test("truncation is reported as incomplete rather than passed off as a full reading", async (t) => {
  const root = await application(t);
  const survey = await surveyApplication(root, { maxPaths: 3 });

  assert.equal(survey.coverage.truncated, true);
  assert.equal(survey.coverage.complete, false, "a survey that stopped early must never claim completeness");
});

test("every path to be read is assigned to a boundary that must read it", async (t) => {
  const root = await application(t);
  const survey = await surveyApplication(root);

  const assigned = new Set(survey.assignments.flatMap((assignment) => assignment.paths));
  const listedTotal = survey.assignments.reduce((total, assignment) => total + assignment.pathCount, 0);
  assert.ok(listedTotal >= survey.coverage.examinedPaths, "assignments must cover at least every examined path");
  assert.ok(assigned.has("README.md"), "documentation must reach the boundary that reads meaning");
  assert.ok(assigned.has("src/booking.js"), "source must reach a boundary");
  assert.ok(assigned.has("config/settings.yaml"), "configuration must reach the boundary that reads risk");

  for (const assignment of survey.assignments) {
    assert.match(assignment.roleId, /^RB-(?:0[1-9]|1[0-3])$/);
    assert.ok(assignment.question.length >= 10, "a boundary must be given a question, not just a pile of paths");
  }
});

test("the survey locates unfinished work without interpreting it", async (t) => {
  const root = await application(t);
  const survey = await surveyApplication(root);

  const kinds = survey.signals.markers.map((marker) => marker.kind);
  assert.ok(kinds.includes("TODO"));
  assert.ok(kinds.includes("FIXME"));
  for (const marker of survey.signals.markers) {
    assert.ok(marker.line >= 1);
    assert.ok(marker.path.length > 0);
    // The record is the located text. A survey that graded severity would be deciding product
    // priority, which is not its job.
    assert.equal(typeof marker.text, "string");
  }
});

test("the stack is read from manifests rather than guessed", async (t) => {
  const root = await application(t);
  const survey = await surveyApplication(root);

  const node = survey.stacks.find((stack) => stack.manifest === "package.json");
  assert.equal(node.ecosystem, "javascript");
  assert.equal(node.name, "pinedesk");
  assert.equal(node.declaredDependencies, 2);
  assert.ok(survey.languages.javascript >= 3);
});

test("a malformed manifest is a finding, not a failure", async (t) => {
  const root = await application(t, { "package.json": "{ not json" });
  const survey = await surveyApplication(root);

  const node = survey.stacks.find((stack) => stack.manifest === "package.json");
  assert.equal(node.ecosystem, "javascript", "the stack still exists even when its manifest does not parse");
  assert.equal(node.name, null);
  assert.equal(survey.coverage.complete, true);
});

test("a symbolic link is counted but never followed out of the repository", async (t) => {
  const root = await application(t);
  const target = path.join(path.dirname(root), "outside");
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "secret-notes.md"), "outside the repository", "utf8");
  try {
    await fs.symlink(target, path.join(root, "linked"), "junction");
  } catch {
    t.skip("this filesystem does not permit creating links");
    return;
  }

  const survey = await surveyApplication(root);
  assert.equal(survey.coverage.complete, true);
  assert.ok(
    !survey.assignments.flatMap((assignment) => assignment.paths).some((value) => value.includes("secret-notes")),
    "following a link would pull files from outside the repository into the product record"
  );
});

test("an unreadable application root is refused rather than surveyed as empty", async (t) => {
  const parent = await makeTempDirectory("product-ops-adopt-missing-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  await assert.rejects(
    surveyApplication(path.join(parent, "nothing-here")),
    /not a readable directory/
  );
});

test("the survey is deterministic for an unchanged repository", async (t) => {
  const root = await application(t);
  const now = new Date("2026-08-06T00:00:00.000Z");
  const first = await surveyApplication(root, { now });
  const second = await surveyApplication(root, { now });
  assert.deepEqual(first, second, "two readings of the same repository must not disagree");
});
