import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateDevelopmentConfig } from "../src/development/config.js";
import { createDevelopmentConfig } from "../src/development/generator.js";
import { initializeDevelopmentOs } from "../src/development/init.js";
import { buildPlan, inferImpactDomains, planDevelopmentRequest } from "../src/development/planner.js";
import { validateDevelopmentOs } from "../src/development/validation.js";
import { makeTempDirectory, writeJson } from "./helpers.js";

test("development configuration preserves unique canonical roles, gates, and executors", () => {
  const duplicateRole = config();
  duplicateRole.roles[14] = { ...structuredClone(duplicateRole.roles[0]), actorId: "actor-duplicate-role" };
  assert.match(validateDevelopmentConfig(duplicateRole).join("\n"), /unique canonical engineering roles/);

  const changedAuthority = config();
  changedAuthority.roles[0].may[0] = "silently change product scope";
  assert.match(validateDevelopmentConfig(changedAuthority).join("\n"), /canonical name, boundary, or authority contract/);

  const changedGate = config();
  changedGate.qualityGates.find((gate) => gate.id === "GATE-SECURITY").required = false;
  assert.match(validateDevelopmentConfig(changedGate).join("\n"), /GATE-SECURITY does not match the canonical/);

  const duplicateGate = config();
  duplicateGate.qualityGates[3] = structuredClone(duplicateGate.qualityGates[0]);
  assert.match(validateDevelopmentConfig(duplicateGate).join("\n"), /duplicate items|unique canonical quality-gate catalog/);

  const duplicateExecutor = config();
  duplicateExecutor.executors[14] = {
    ...structuredClone(duplicateExecutor.executors[0]),
    timeoutMs: duplicateExecutor.executors[0].timeoutMs + 1
  };
  assert.match(validateDevelopmentConfig(duplicateExecutor).join("\n"), /uniquely identified executor/);
});

test("planner fails closed by inferring sensitive impacts from every request narrative surface", () => {
  const request = developmentRequest("INFER-001");
  request.impacts = ["frontend"];
  request.acceptanceCriteria = [{
    id: "AC-01",
    statement: "The schema migration is reversible and its backup can be restored.",
    verification: "Run migration and restore tests."
  }];
  request.nonFunctionalRequirements = [{
    domain: "privacy",
    requirement: "Personal data retention follows the approved consent policy.",
    verification: "Inspect the retention and deletion evidence."
  }];
  request.constraints = ["DNS and network routing must support disaster recovery and failover."];

  const impacts = new Set(inferImpactDomains(request));
  for (const impact of ["frontend", "database", "privacy", "network", "resilience"]) {
    assert.ok(impacts.has(impact), `missing inferred ${impact} impact`);
  }

  const plan = buildPlan(request, config(), "a".repeat(64));
  const roles = new Set(plan.workstreams.map((workstream) => workstream.ownerRole));
  for (const role of ["ENG-03", "ENG-06", "ENG-08", "ENG-09", "ENG-11"]) {
    assert.ok(roles.has(role), `missing inferred ${role} workstream`);
  }
  for (const gate of ["GATE-DATABASE", "GATE-INFRA-NETWORK", "GATE-PRIVACY-COMPLIANCE", "GATE-RELIABILITY"]) {
    assert.ok(plan.qualityGates.includes(gate), `missing inferred ${gate}`);
  }
  assert.equal(plan.riskClass, "high");
});

test("validation rejects deterministic engineering-plan gate, workstream, and dependency tampering", async (t) => {
  const cases = [
    ["gate", (plan) => { plan.qualityGates = plan.qualityGates.filter((gate) => gate !== "GATE-SECURITY"); }],
    ["workstream", (plan) => { plan.workstreams[0].title = `${plan.workstreams[0].title} tampered`; }],
    ["dependency", (plan) => { plan.workstreams[1].dependencies = []; }]
  ];

  for (const [label, mutate] of cases) {
    await t.test(label, async (t) => {
      const root = await temporaryRoot(t, `development-plan-integrity-${label}-`);
      await initializeDevelopmentOs(root, { dryRun: false });
      const request = developmentRequest(`PLAN-${label.toUpperCase()}`);
      const requestFile = path.join(root, "request.json");
      await writeJson(requestFile, request);
      const { plan } = await planDevelopmentRequest(root, requestFile, { dryRun: false });
      const storedPlan = structuredClone(plan);
      mutate(storedPlan);
      await writeJson(path.join(root, ".development-os", "plans", `${plan.planId}.json`), storedPlan);

      const validation = await validateDevelopmentOs(root);
      assert.match(validation.errors.join("\n"), /does not match the deterministic plan/);
    });
  }
});

function config() {
  return structuredClone(createDevelopmentConfig("application"));
}

function developmentRequest(suffix) {
  return {
    schemaVersion: "1.0.0",
    requestId: `DEVREQ-${suffix}`,
    productTaskId: "TASK-RB-13-0001",
    deliveryTicketReference: "product/delivery-ticket.md",
    title: "Implement an approved application change",
    problem: "Users need an approved application behavior that is not implemented yet.",
    desiredOutcome: "The approved behavior is implemented and reproducibly verified.",
    acceptanceCriteria: [{
      id: "AC-01",
      statement: "The approved behavior works as specified.",
      verification: "Run the approved automated scenario."
    }],
    impacts: ["frontend"],
    constraints: [],
    nonFunctionalRequirements: [],
    writeBoundary: {
      repositories: ["application"],
      allowedPaths: ["src", "tests", "docs"],
      prohibitedPaths: [".env", "production-data"]
    },
    validation: {
      commands: ["npm test"],
      evidenceRequired: ["test report"]
    },
    approval: {
      status: "approved",
      actorId: "human-product-owner",
      decidedAt: "2026-08-02T00:00:00.000Z",
      reference: "APR-DEV-INTEGRITY"
    },
    source: {
      productOperationsRevision: "abcdef1234567890",
      exportedAt: "2026-08-02T00:01:00.000Z"
    }
  };
}

async function temporaryRoot(t, prefix) {
  const root = await makeTempDirectory(prefix);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
