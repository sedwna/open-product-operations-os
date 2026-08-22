import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDevelopmentFiles, createDevelopmentConfig } from "../src/development/generator.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("proportional delivery is present in both human and generated operating contracts", async () => {
  const [agents, readme, start, governance, policy] = await Promise.all([
    fs.readFile(path.join(root, "AGENTS.md"), "utf8"),
    fs.readFile(path.join(root, "README.md"), "utf8"),
    fs.readFile(path.join(root, "START-HERE.md"), "utf8"),
    fs.readFile(path.join(root, "templates/governance/governance.md"), "utf8"),
    fs.readFile(path.join(root, "docs/architecture/proportional-delivery.md"), "utf8")
  ]);

  for (const source of [agents, readme, policy]) {
    assert.match(source, /overqualif/i);
    assert.match(source, /overengineer/i);
  }
  assert.match(start, /proportional-delivery policy/i);
  assert.match(governance, /Stop discovery when remaining uncertainty cannot change the next decision/);
  assert.match(policy, /smallest complete, reversible (?:change|implementation)/i);
  assert.match(policy, /No build:[\s\S]*Reuse:[\s\S]*Standard or native:[\s\S]*Installed capability:[\s\S]*Local implementation:/i);
  assert.match(policy, /shared root cause/i);
  assert.match(policy, /known ceiling,[\s\S]*observable trigger/i);
  assert.match(policy, /Non-trivial logic leaves the smallest runnable check/i);
  assert.match(policy, /Ponytail agentic benchmark/i);

  const config = createDevelopmentConfig(path.join(root, "sample-application"));
  const files = buildDevelopmentFiles(config, { includeConfig: true });
  assert.match(files.get("DEVELOPMENT.md"), /approved outcome is the stop condition/i);
  assert.match(files.get("DEVELOPMENT.md"), /no build, repository reuse, standard-library or native-platform capability/i);
  assert.match(files.get("engineering/governance/charter.md"), /Reproduce the claimed gap before editing/);
  assert.match(files.get("engineering/governance/charter.md"), /inspect every caller and fix the shared root cause/i);
  assert.match(files.get("engineering/governance/charter.md"), /known ceiling and observable upgrade trigger/i);
  assert.match(files.get("engineering/governance/charter.md"), /Hypothetical|speculative flexibility/);
});

test("product, delivery, task, and validation templates carry the proportional stop checks", async () => {
  const expected = new Map([
    ["templates/product/decision-brief.md", /Why a human answer is required now/],
    ["templates/product/discovery-note.md", /Trigger that would reopen discovery/],
    ["templates/product/delivery-ticket.md", /Earliest viable solution rung/],
    ["templates/operations/task-card.md", /Existing capability and affected-flow evidence/],
    ["templates/validation/validation-plan.md", /Quality-floor checks/]
  ]);
  for (const [relative, pattern] of expected) {
    assert.match(await fs.readFile(path.join(root, relative), "utf8"), pattern, relative);
  }
});
