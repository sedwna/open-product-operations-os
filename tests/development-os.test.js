import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { stringifyCsv } from "../src/csv.js";
import { initCommand } from "../src/commands/init.js";
import { createDefaultConfig } from "../src/defaults.js";
import { exportDevelopmentRequest, importEngineeringResult } from "../src/development/product-sync.js";
import { contractDigest } from "../src/development/contracts.js";
import { initializeDevelopmentOs } from "../src/development/init.js";
import { planDevelopmentRequest } from "../src/development/planner.js";
import { completeDevelopmentResult } from "../src/development/result.js";
import { validateDevelopmentOs } from "../src/development/validation.js";
import { runEngineeringWorkstream } from "../src/development/runner.js";
import { buildDevelopmentDashboard } from "../src/development/dashboard.js";
import { TASKBOARD_COLUMNS } from "../src/constants.js";
import { main as developmentMain } from "../src/development-cli.js";
import { decideApproval, requestApproval } from "../src/runtime/approvals.js";
import { captureIo, makeTempDirectory, readJson, writeJson } from "./helpers.js";

test("development CLI initializes, validates, and rejects unrelated options", async (t) => {
  const root = await temporaryRoot(t, "development-cli-");
  const output = captureIo();
  assert.equal(await developmentMain(["init", root], output.io), 0);
  assert.equal(await developmentMain(["validate", root], output.io), 0);
  await assert.rejects(developmentMain(["status", root, "--force"], output.io), /does not accept --force/);
});

test("development OS initializes an independent 15-role engineering system", async (t) => {
  const root = await temporaryRoot(t, "development-init-");
  const preview = await initializeDevelopmentOs(root, { dryRun: true });
  assert.ok(preview.operations.some((operation) => operation.relativePath === "development-os.config.json"));
  await assert.rejects(fs.access(path.join(root, "development-os.config.json")));
  await initializeDevelopmentOs(root, { dryRun: false });
  const config = await readJson(path.join(root, "development-os.config.json"));
  assert.equal(config.roles.length, 15);
  assert.equal(config.roles.find((role) => role.id === "ENG-06").boundary, "database_storage");
  assert.ok(config.qualityGates.some((gate) => gate.id === "GATE-DATABASE"));
  const validation = await validateDevelopmentOs(root);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.contractCounts.requests, 0);
});

test("planner activates database, frontend, SEO, security, QA, docs, and independent verification", async (t) => {
  const root = await temporaryRoot(t, "development-plan-");
  await initializeDevelopmentOs(root, { dryRun: false });
  const request = developmentRequest();
  const requestFile = path.join(root, "request.json");
  await writeJson(requestFile, request);
  const preview = await planDevelopmentRequest(root, requestFile, { dryRun: true });
  const roles = new Set(preview.plan.workstreams.map((workstream) => workstream.ownerRole));
  for (const role of ["ENG-01", "ENG-02", "ENG-03", "ENG-06", "ENG-09", "ENG-10", "ENG-13", "ENG-14", "ENG-15"]) {
    assert.ok(roles.has(role), `missing ${role}`);
  }
  for (const gate of ["GATE-DATABASE", "GATE-ACCESSIBILITY", "GATE-SEO", "GATE-SECURITY", "GATE-INDEPENDENT-VERIFICATION"]) {
    assert.ok(preview.plan.qualityGates.includes(gate), `missing ${gate}`);
  }
  assert.equal(preview.plan.riskClass, "high");
  const workstreamId = new Map(preview.plan.workstreams.map((workstream) => [workstream.ownerRole, workstream.id]));
  const qa = preview.plan.workstreams.find((workstream) => workstream.ownerRole === "ENG-10");
  assert.ok(qa.dependencies.includes(workstreamId.get("ENG-03")));
  assert.ok(qa.dependencies.includes(workstreamId.get("ENG-06")));
  assert.ok(qa.dependencies.includes(workstreamId.get("ENG-09")));
  const independent = preview.plan.workstreams.find((workstream) => workstream.ownerRole === "ENG-15");
  assert.equal(independent.dependencies.length, preview.plan.workstreams.length - 1);
  await planDevelopmentRequest(root, requestFile, { dryRun: false });
  const validation = await validateDevelopmentOs(root);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.contractCounts, { requests: 1, plans: 1, results: 0, receipts: 1, runs: 0 });
});

test("planner rejects paths outside the configured engineering write boundary", async (t) => {
  const root = await temporaryRoot(t, "development-boundary-");
  await initializeDevelopmentOs(root, { dryRun: false });
  const request = developmentRequest();
  request.writeBoundary.allowedPaths = ["../outside"];
  const requestFile = path.join(root, "unsafe-request.json");
  await writeJson(requestFile, request);
  await assert.rejects(
    planDevelopmentRequest(root, requestFile, { dryRun: false }),
    /must stay inside the project directory/
  );
});

test("completed engineering results require every planned gate and a distinct verifier", async (t) => {
  const root = await temporaryRoot(t, "development-result-");
  await initializeDevelopmentOs(root, { dryRun: false });
  const request = developmentRequest();
  const requestFile = path.join(root, "request.json");
  await writeJson(requestFile, request);
  const { plan, digest } = await planDevelopmentRequest(root, requestFile, { dryRun: false });
  const config = await readJson(path.join(root, "development-os.config.json"));
  const result = await engineeringResult(root, request, plan, digest, config);
  const resultFile = path.join(root, "result.json");
  const badRunDigest = structuredClone(result);
  badRunDigest.workstreamRuns[0].runDigest = "0".repeat(64);
  await writeJson(resultFile, badRunDigest);
  await assert.rejects(
    completeDevelopmentResult(root, resultFile, { dryRun: false }),
    /run WS-01 mismatches runDigest/
  );
  const badEvidenceDigest = structuredClone(result);
  badEvidenceDigest.evidence[0].sha256 = "0".repeat(64);
  await writeJson(resultFile, badEvidenceDigest);
  await assert.rejects(
    completeDevelopmentResult(root, resultFile, { dryRun: false }),
    /evidence digest mismatch/
  );
  const escapedEvidence = structuredClone(result);
  escapedEvidence.evidence[0].path = ".development-os/evidence/../../package.json";
  escapedEvidence.gateResults.forEach((gate) => {
    gate.evidenceReferences = [escapedEvidence.evidence[0].path];
  });
  escapedEvidence.verification.evidenceReferences = [escapedEvidence.evidence[0].path];
  await writeJson(resultFile, escapedEvidence);
  await assert.rejects(
    completeDevelopmentResult(root, resultFile, { dryRun: false }),
    /Engineering result is invalid|outside the managed evidence boundary/
  );
  await writeJson(resultFile, result);
  await completeDevelopmentResult(root, resultFile, { dryRun: false });
  const validation = await validateDevelopmentOs(root);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.contractCounts, { requests: 1, plans: 1, results: 1, receipts: 2, runs: plan.workstreams.length });

  result.verification.verifierActorId = result.producerActorId;
  const invalidFile = path.join(root, "invalid-result.json");
  await writeJson(invalidFile, result);
  await assert.rejects(
    completeDevelopmentResult(root, invalidFile, { dryRun: false }),
    /producer and verifier actors must be distinct/
  );
});

test("specialist execution is disabled by default, shell-free, attributed, and visible in the RTL dashboard", async (t) => {
  const root = await temporaryRoot(t, "development-executor-");
  await initializeDevelopmentOs(root, { dryRun: false });
  const request = developmentRequest("EXECUTOR-001");
  const requestFile = path.join(root, "request.json");
  await writeJson(requestFile, request);
  const { plan } = await planDevelopmentRequest(root, requestFile, { dryRun: false });
  await assert.rejects(
    runEngineeringWorkstream(root, plan.planId, "WS-01", { dryRun: true }),
    /Executor for ENG-01 is disabled/
  );
  const configPath = path.join(root, "development-os.config.json");
  const config = await readJson(configPath);
  const executor = config.executors.find((candidate) => candidate.roleId === "ENG-01");
  const tool = path.join(root, "synthetic-engineering-executor.mjs");
  executor.enabled = true;
  executor.executable = process.execPath;
  executor.arguments = [tool, "{inputFile}"];
  await writeJson(configPath, config);
  await fs.writeFile(tool, `import fs from "node:fs";\nconst input=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));\nprocess.stdout.write(JSON.stringify({schemaVersion:"1.0.0",planId:input.planId,workstreamId:input.workstream.id,ownerRole:input.workstream.ownerRole,producerActorId:"actor-eng-01",status:"completed",implementationRevision:"abcdef1234567890",changedComponents:["docs"],commands:["synthetic-check"],evidence:["evidence/synthetic.json"],knownRisks:[],completedAt:"2026-08-01T03:00:00.000Z"}));\n`);
  const preview = await runEngineeringWorkstream(root, plan.planId, "WS-01", { dryRun: true });
  assert.equal(preview.payload.policy.isolation, "external-required");
  const executed = await runEngineeringWorkstream(root, plan.planId, "WS-01", { dryRun: false });
  assert.equal(executed.result.status, "completed");
  const dashboard = await buildDevelopmentDashboard(root, { dryRun: false });
  const html = await fs.readFile(path.join(root, dashboard.output), "utf8");
  assert.match(html, /برج کنترل مهندسی/);
  assert.match(html, /ENG-06/);
  const validation = await validateDevelopmentOs(root);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.contractCounts.runs, 1);
});

test("failed engineering attempts are retained without poisoning a safe retry", async (t) => {
  const root = await temporaryRoot(t, "development-executor-retry-");
  await initializeDevelopmentOs(root, { dryRun: false });
  const requestFile = path.join(root, "request.json");
  await writeJson(requestFile, developmentRequest("EXECUTOR-RETRY-001"));
  const { plan } = await planDevelopmentRequest(root, requestFile, { dryRun: false });
  const configPath = path.join(root, "development-os.config.json");
  const config = await readJson(configPath);
  const executor = config.executors.find((candidate) => candidate.roleId === "ENG-01");
  const tool = path.join(root, "retryable-engineering-executor.mjs");
  executor.enabled = true;
  executor.executable = process.execPath;
  executor.arguments = [tool, "{inputFile}"];
  await writeJson(configPath, config);
  const script = (status) => `import fs from "node:fs";\nconst input=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));\nprocess.stdout.write(JSON.stringify({schemaVersion:"1.0.0",planId:input.planId,workstreamId:input.workstream.id,ownerRole:input.workstream.ownerRole,producerActorId:"actor-eng-01",status:${JSON.stringify(status)},implementationRevision:"pending",changedComponents:[],commands:["synthetic-check"],evidence:["synthetic retry evidence"],knownRisks:[],completedAt:"2026-08-01T03:00:00.000Z"}));\n`;
  await fs.writeFile(tool, script("failed"));
  const failed = await runEngineeringWorkstream(root, plan.planId, "WS-01", { dryRun: false });
  assert.equal(failed.result.status, "failed");
  assert.match(failed.resultFile, /-attempt-[a-f0-9-]+-result\.json$/);
  await assert.rejects(fs.access(path.join(root, ".development-os", "runs", `${plan.planId}-WS-01-result.json`)));
  await fs.writeFile(tool, script("completed"));
  const completed = await runEngineeringWorkstream(root, plan.planId, "WS-01", { dryRun: false });
  assert.equal(completed.result.status, "completed");
  assert.equal(completed.resultFile, `.development-os/runs/${plan.planId}-WS-01-result.json`);
});

test("Product Operations and Development OS synchronize independently through digested contracts", async (t) => {
  const productRoot = await temporaryRoot(t, "product-sync-");
  const developmentRoot = await temporaryRoot(t, "engineering-sync-");
  await initCommand(productRoot, { dryRun: false, force: false });
  await initializeDevelopmentOs(developmentRoot, { dryRun: false });
  const productConfig = createDefaultConfig(productRoot);
  const request = developmentRequest("SYNC-0001");
  request.productTaskId = `${productConfig.taskIds.prefix}-9001`;
  const developmentActor = productConfig.agents.find((agent) => agent.id === "RB-13").actorId;
  const verifierActor = productConfig.agents.find((agent) => agent.id === "RB-12").actorId;
  await fs.writeFile(path.join(productRoot, "taskboard/tasks.csv"), stringifyCsv([
    TASKBOARD_COLUMNS,
    [request.productTaskId, "EVT-SYNC-001", "Implement approved synchronized delivery", "RB-13", developmentActor, "ready", "P1", "", "", "", "", request.deliveryTicketReference, "", "", "RB-12", verifierActor, "", "", ""]
  ]));
  const requestFile = path.join(productRoot, "request.json");
  await writeJson(requestFile, request);
  await assert.rejects(
    exportDevelopmentRequest(productRoot, productConfig, request.productTaskId, requestFile, { dryRun: false }),
    /approval reference does not resolve/
  );
  const pendingApproval = await requestApproval(productRoot, {
    taskId: request.productTaskId,
    gate: "development-export",
    question: "Authorize this approved product request for engineering export?",
    context: request.title
  }, { dryRun: false, now: new Date("2026-08-01T00:00:00.000Z") });
  const approved = await decideApproval(productRoot, productConfig, {
    requestId: pendingApproval.request.requestId,
    decision: "approved",
    actorId: productConfig.project.humanAuthorityActorId,
    rationale: "Synthetic approval for the synchronized engineering test."
  }, { dryRun: false, now: new Date("2026-08-01T00:00:30.000Z") });
  request.approval.reference = approved.request.requestId;
  request.approval.actorId = approved.request.decidedByActorId;
  request.approval.decidedAt = approved.request.decidedAt;
  await writeJson(requestFile, request);
  await exportDevelopmentRequest(productRoot, productConfig, request.productTaskId, requestFile, { dryRun: false });

  const exported = path.join(productRoot, ".product-ops/runtime/development/contracts/outbox", `${request.requestId}.json`);
  const { plan, digest } = await planDevelopmentRequest(developmentRoot, exported, { dryRun: false });
  const developmentConfig = await readJson(path.join(developmentRoot, "development-os.config.json"));
  const result = await engineeringResult(developmentRoot, request, plan, digest, developmentConfig);
  const resultFile = path.join(developmentRoot, "result.json");
  await writeJson(resultFile, result);
  const completed = await completeDevelopmentResult(developmentRoot, resultFile, { dryRun: false });
  const outboxResult = path.join(developmentRoot, completed.receipt.storedAt);
  const unreceiptedTransfer = path.join(productRoot, "unreceipted-result.json");
  await fs.copyFile(outboxResult, unreceiptedTransfer);
  await assert.rejects(
    importEngineeringResult(productRoot, unreceiptedTransfer, { dryRun: false }),
    /Development source receipt is not valid JSON/
  );
  await importEngineeringResult(productRoot, outboxResult, { dryRun: false });
  const imported = await readJson(path.join(productRoot, ".product-ops/runtime/development/contracts/inbox", `${result.resultId}.json`));
  assert.equal(imported.productTaskId, request.productTaskId);
  assert.equal(imported.sourceDigest, contractDigest(request));
});

function developmentRequest(suffix = "DATABASE-SEO-001") {
  return {
    schemaVersion: "1.0.0",
    requestId: `DEVREQ-${suffix}`,
    productTaskId: "TASK-RB-13-0001",
    deliveryTicketReference: "product/delivery-ticket.md",
    title: "Deliver a searchable public catalog",
    problem: "Users cannot discover or efficiently search the public product catalog.",
    desiredOutcome: "Users find indexable catalog entries with predictable response times.",
    acceptanceCriteria: [
      { id: "AC-01", statement: "Catalog entries are searchable and paginated.", verification: "Run API and browser scenarios." },
      { id: "AC-02", statement: "Public pages expose valid canonical metadata.", verification: "Run technical SEO audit." }
    ],
    impacts: ["architecture", "frontend", "accessibility", "backend", "api", "database", "search", "security", "performance", "seo", "documentation"],
    constraints: ["No production data in tests", "Migration must be reversible"],
    nonFunctionalRequirements: [
      { domain: "performance", requirement: "Search p95 remains below the approved budget.", verification: "Execute a reproducible load scenario." },
      { domain: "database", requirement: "Migration supports rollback and restore.", verification: "Run migration and recovery in test." }
    ],
    writeBoundary: {
      repositories: ["application"],
      allowedPaths: ["src", "tests", "database", "migrations", "docs"],
      prohibitedPaths: [".env", "production-data"]
    },
    validation: {
      commands: ["npm test", "npm run audit"],
      evidenceRequired: ["test report", "migration proof", "SEO audit"]
    },
    approval: {
      status: "approved",
      actorId: "human-product-owner",
      decidedAt: "2026-08-01T00:00:00.000Z",
      reference: "APR-DEV-001"
    },
    source: {
      productOperationsRevision: "abcdef1234567890",
      exportedAt: "2026-08-01T00:01:00.000Z"
    }
  };
}

async function engineeringResult(root, request, plan, digest, config) {
  const implementationRevision = "1234567890abcdef";
  const evidence = [];
  for (const gateId of plan.qualityGates) {
    const relative = `.development-os/evidence/${gateId}.json`;
    const content = `${JSON.stringify({ gateId, planId: plan.planId, implementationRevision })}\n`;
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
    evidence.push({
      path: relative,
      kind: evidenceKind(gateId),
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      sourceRevision: implementationRevision
    });
  }
  const workstreamRuns = [];
  for (const workstream of plan.workstreams) {
    const run = {
      schemaVersion: "1.0.0",
      planId: plan.planId,
      workstreamId: workstream.id,
      ownerRole: workstream.ownerRole,
      producerActorId: config.roles.find((role) => role.id === workstream.ownerRole).actorId,
      status: "completed",
      implementationRevision,
      changedComponents: ["src/catalog"],
      commands: ["synthetic verification"],
      evidence: evidence.map((artifact) => artifact.path),
      knownRisks: [],
      completedAt: "2026-08-01T02:00:00.000Z"
    };
    await writeJson(path.join(root, ".development-os", "runs", `${plan.planId}-${workstream.id}-result.json`), run);
    workstreamRuns.push({ workstreamId: workstream.id, runDigest: contractDigest(run) });
  }
  return {
    schemaVersion: "1.0.0",
    resultId: `ENGRESULT-${request.requestId.replace(/^DEVREQ-/, "")}`,
    requestId: request.requestId,
    productTaskId: request.productTaskId,
    planId: plan.planId,
    planDigest: contractDigest(plan),
    sourceDigest: digest,
    implementationRevision,
    status: "implementation_complete",
    implementationReferences: ["commit:1234567890abcdef"],
    changedComponents: ["src/catalog", "database/migrations/001"],
    workstreamRuns,
    gateResults: plan.qualityGates.map((gateId) => ({ gateId, status: "passed", evidenceReferences: [`.development-os/evidence/${gateId}.json`] })),
    evidence,
    deploymentReferences: [],
    knownRisks: ["Production rollout remains separately authorized."],
    producerActorId: config.roles.find((role) => role.id === "ENG-01").actorId,
    verification: {
      verifierActorId: config.roles.find((role) => role.id === "ENG-15").actorId,
      disposition: "verified",
      verifiedAt: "2026-08-01T02:00:00.000Z",
      evidenceReferences: [`.development-os/evidence/GATE-INDEPENDENT-VERIFICATION.json`]
    },
    completedAt: "2026-08-01T02:01:00.000Z"
  };
}

function evidenceKind(gateId) {
  const kinds = {
    "GATE-ARCHITECTURE": "architecture",
    "GATE-CODE-REVIEW": "review",
    "GATE-AUTOMATED-TESTS": "test",
    "GATE-SECURITY": "security",
    "GATE-SUPPLY-CHAIN": "security",
    "GATE-DATABASE": "database",
    "GATE-API-COMPATIBILITY": "api",
    "GATE-INFRA-NETWORK": "infrastructure",
    "GATE-PRIVACY-COMPLIANCE": "privacy",
    "GATE-ACCESSIBILITY": "accessibility",
    "GATE-PERFORMANCE": "performance",
    "GATE-RELIABILITY": "reliability",
    "GATE-SEO": "seo",
    "GATE-DOCUMENTATION": "documentation",
    "GATE-INDEPENDENT-VERIFICATION": "verification"
  };
  return kinds[gateId] ?? "other";
}

async function temporaryRoot(t, prefix) {
  const root = await makeTempDirectory(prefix);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
