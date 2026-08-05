import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initCommand } from "../src/commands/init.js";
import { loadConfig } from "../src/config.js";
import { initializeDevelopmentOs } from "../src/development/init.js";
import { planDevelopmentRequest, WORKSTREAM_BOARD, WORKSTREAM_HEADERS } from "../src/development/planner.js";
import { loadDevelopmentConfig } from "../src/development/config.js";
import { contractDigest } from "../src/development/contracts.js";
import { completeDevelopmentResult } from "../src/development/result.js";
import { exportDevelopmentRequest, importEngineeringResult } from "../src/development/product-sync.js";
import { validateDevelopmentOs } from "../src/development/validation.js";
import { decideApproval, loadApprovals, requestApproval } from "../src/runtime/approvals.js";
import { runControlTower } from "../src/runtime/control-tower.js";
import { loadDashboardSnapshot } from "../src/runtime/dashboard.js";
import { ingestRecord } from "../src/runtime/intake.js";
import { loadTaskboard, replaceTaskboard } from "../src/runtime/taskboard.js";
import { createHandlers, createServerContext } from "../src/mcp/server.js";
import { parseCsv } from "../src/csv.js";
import { makeTempDirectory } from "./helpers.js";

/**
 * Two repositories, an approved contract crossing between them, and the engineering side becoming
 * visible to the product owner. This is the path the documentation describes, walked end to end.
 */
async function connect(t, { link = true } = {}) {
  const parent = await makeTempDirectory("product-ops-connect-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const product = path.join(parent, "digest-ops");
  const application = path.join(parent, "digest-app");
  await initCommand(product, {});
  await initializeDevelopmentOs(application, {});

  const config = await loadConfig(product);
  await ingestRecord(product, {
    type: "user_finding",
    title: "Digest link opens the wrong workspace",
    description: "Following the weekly digest from a second workspace lands on the first one.",
    source: "reported by two accounts"
  }, { dryRun: false });
  await runControlTower(product, config, { dryRun: false });

  // The boundary can only be crossed once everything upstream of it is finished.
  const board = await loadTaskboard(product);
  const bridge = board.records.find((task) => task.owner_role === "RB-13");
  const position = (task) => Number(task.task_id.split("-").pop());
  await replaceTaskboard(product, board.headers, board.records.map((task) => {
    if (task.task_id === bridge.task_id) return { ...task, status: "ready" };
    if (task.event_id === bridge.event_id && position(task) < position(bridge)) return { ...task, status: "done" };
    return task;
  }), { dryRun: false });

  await requestApproval(product, {
    taskId: bridge.task_id, gate: "development-export", question: "Hand this to engineering?"
  }, { dryRun: false });
  const gate = (await loadApprovals(product)).requests.find((item) => item.taskId === bridge.task_id);
  const decided = await decideApproval(product, config, {
    requestId: gate.requestId, decision: "approved",
    actorId: config.project.humanAuthorityActorId,
    rationale: "Two accounts hit it; the fix is contained to link resolution."
  }, { dryRun: false });

  const requestFile = path.join(parent, "request.json");
  const request = {
    schemaVersion: "1.0.0",
    requestId: "DEVREQ-20260805-001",
    productTaskId: bridge.task_id,
    deliveryTicketReference: "TKT-20260805-001",
    title: "Resolve digest links against the originating workspace",
    problem: "A digest link resolves against the active workspace rather than the one that produced it.",
    desiredOutcome: "Following a digest link always lands in the workspace the digest came from.",
    acceptanceCriteria: [
      { id: "AC-01", statement: "A link opened elsewhere lands in the originating workspace.", verification: "browser test" },
      { id: "AC-02", statement: "Existing links continue to resolve.", verification: "regression suite" }
    ],
    impacts: ["frontend", "backend", "security"],
    constraints: ["No change to the public link format."],
    nonFunctionalRequirements: [
      { domain: "security", requirement: "Membership is still checked on resolution.", verification: "authorisation test" }
    ],
    writeBoundary: { repositories: ["digest-app"], allowedPaths: ["src", "tests"], prohibitedPaths: ["infra"] },
    validation: { commands: ["npm test"], evidenceRequired: ["test output"] },
    approval: {
      status: "approved", reference: gate.requestId,
      actorId: config.project.humanAuthorityActorId, decidedAt: decided.request.decidedAt
    },
    source: { productOperationsRevision: "working-tree", exportedAt: new Date().toISOString() }
  };
  await fs.writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");

  if (link) {
    const file = path.join(product, ".product-ops/runtime/automation/link.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({
      schemaVersion: "1.0.0",
      applicationRelativePath: path.relative(product, application).replaceAll("\\", "/"),
      provider: "claude",
      productExecutorsEnabled: true,
      engineeringExecutorsEnabled: true,
      autoStart: false,
      autoApproveInitialIdea: false,
      createdAt: new Date().toISOString()
    }, null, 2)}\n`, "utf8");
  }
  return { product, application, config, bridge, requestFile, request };
}

/**
 * Everything engineering must produce before a result can cross back: content-addressed evidence at
 * an exact revision, a sealed run for every planned workstream, passing gates, and a disposition
 * from an actor who did not produce the work.
 */
async function completeEngineering(application, plan, request, { revision = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" } = {}) {
  const devConfig = await loadDevelopmentConfig(application);
  const actorFor = (role) => devConfig.roles.find((entry) => entry.id === role).actorId;
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };

  const body = "PASS tests/digest-link.test.js\n  resolves against the originating workspace\n";
  const evidencePath = ".development-os/evidence/test-output.txt";
  await fs.mkdir(path.join(application, ".development-os/evidence"), { recursive: true });
  await fs.writeFile(path.join(application, evidencePath), body, "utf8");
  const evidence = [{
    path: evidencePath,
    kind: "test",
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    sourceRevision: revision
  }];

  const workstreamRuns = [];
  for (const workstream of plan.workstreams) {
    const run = {
      schemaVersion: "1.0.0",
      planId: plan.planId,
      workstreamId: workstream.id,
      ownerRole: workstream.ownerRole,
      producerActorId: actorFor(workstream.ownerRole),
      status: "completed",
      ...(workstream.ownerRole === "ENG-15" ? { verificationDisposition: "passed" } : {}),
      implementationRevision: revision,
      changedComponents: ["src/digest/link-resolver.js"],
      commands: ["npm test"],
      evidence: [evidencePath],
      knownRisks: [],
      completedAt: new Date().toISOString()
    };
    await write(path.join(application, ".development-os/runs", `${plan.planId}-${workstream.id}-result.json`), run);
    workstreamRuns.push({ workstreamId: workstream.id, runDigest: contractDigest(run) });
  }

  return {
    schemaVersion: "1.0.0",
    resultId: "ENGRESULT-20260805-001",
    requestId: request.requestId,
    productTaskId: request.productTaskId,
    planId: plan.planId,
    planDigest: contractDigest(plan),
    sourceDigest: contractDigest(request),
    implementationRevision: revision,
    status: "implementation_complete",
    implementationReferences: ["digest-app@a1b2c3d"],
    changedComponents: ["src/digest/link-resolver.js", "tests/digest-link.test.js"],
    workstreamRuns,
    gateResults: plan.qualityGates.map((gateId) => ({ gateId, status: "passed", evidenceReferences: [evidencePath] })),
    evidence,
    knownRisks: ["Links created before the fix still carry the old workspace hint."],
    producerActorId: actorFor("ENG-01"),
    verification: {
      verifierActorId: actorFor("ENG-15"),
      disposition: "verified",
      verifiedAt: new Date().toISOString(),
      evidenceReferences: [evidencePath]
    },
    completedAt: new Date().toISOString()
  };
}

async function boardRows(application) {
  const rows = parseCsv(await fs.readFile(path.join(application, WORKSTREAM_BOARD), "utf8"));
  return { headers: rows[0], records: rows.slice(1).filter((row) => row[0]) };
}

test("an approved contract crosses the boundary with a digest and a receipt", async (t) => {
  const { product, config, bridge, requestFile } = await connect(t);
  const exported = await exportDevelopmentRequest(product, config, bridge.task_id, requestFile, { dryRun: false });
  assert.equal(exported.digest.length, 64);
  assert.equal(exported.receipt.direction, "product_to_development");
  assert.equal(exported.receipt.contractDigest, exported.digest);
});

test("planning puts the workstreams it creates on the engineering board", async (t) => {
  // A plan that produced work nobody could see was the defect: the board is the canonical record of
  // what engineering is carrying, and the documented planning path left it empty.
  const { application, requestFile } = await connect(t);
  const planned = await planDevelopmentRequest(application, requestFile, { dryRun: false });
  assert.ok(planned.plan.workstreams.length > 1);

  const { headers, records } = await boardRows(application);
  assert.deepEqual(headers, [...WORKSTREAM_HEADERS]);
  assert.equal(records.length, planned.plan.workstreams.length, "every planned workstream reaches the board");

  const roles = records.map((row) => row[2]);
  assert.ok(roles.includes("ENG-15"), "independent verification is always among them");
  assert.equal(records.every((row) => row[1] === planned.plan.requestId), true, "each row names its request");
  assert.equal((await validateDevelopmentOs(application)).errors.length, 0, "and the application still validates");
});

test("planning does not write the board until it is applied", async (t) => {
  const { application, requestFile } = await connect(t);
  await planDevelopmentRequest(application, requestFile, { dryRun: true });
  assert.equal((await boardRows(application)).records.length, 0, "a dry run must leave the board alone");
});

test("re-planning replaces a request's rows instead of duplicating them", async (t) => {
  const { application, requestFile } = await connect(t);
  const first = await planDevelopmentRequest(application, requestFile, { dryRun: false });
  const again = await planDevelopmentRequest(application, requestFile, { dryRun: false });
  assert.equal(again.digest, first.digest, "the same contract plans identically");

  const { records } = await boardRows(application);
  assert.equal(records.length, first.plan.workstreams.length, "planning twice must not double the board");
  assert.equal(new Set(records.map((row) => row[0])).size, records.length, "and must not repeat a workstream id");
});

test("the product owner sees the engineering teams once an application is linked", async (t) => {
  const { product, application, requestFile } = await connect(t);
  await planDevelopmentRequest(application, requestFile, { dryRun: false });

  // The coordinator records the application root only after it has run. A workspace that planned
  // through the CLI has a link and no coordinator, and the engineering side must still be visible.
  const snapshot = await loadDashboardSnapshot(product);
  assert.equal(snapshot.autopilot.state.applicationRoot, null, "no cycle has run");
  assert.ok(snapshot.autopilot.engineering, "the engineering side is found through the link");

  const context = await createServerContext({ project: product });
  const handlers = createHandlers(context, { version: "test" });
  handlers.initialize({ protocolVersion: "2026-07-28", capabilities: {} });
  const panel = (await handlers["tools/call"]({ name: "product_ops_panel", arguments: {} })).structuredContent;

  assert.equal(panel.teams.product.length, 13);
  assert.ok(panel.teams.engineering.length > 1, `expected several engineering teams, got ${panel.teams.engineering.length}`);
  assert.equal(panel.teams.engineering.every((team) => team.name !== team.id), true, "named, not coded");
  assert.equal(panel.teams.engineering.every((team) => team.side === "engineering"), true);
  assert.ok(panel.teams.engineering.some((team) => team.id === "ENG-15"), "including independent verification");
});

test("a verified result crosses back with its digest and evidence intact", async (t) => {
  const { product, application, config, bridge, requestFile, request } = await connect(t);
  await exportDevelopmentRequest(product, config, bridge.task_id, requestFile, { dryRun: false });
  const { plan } = await planDevelopmentRequest(application, requestFile, { dryRun: false });

  const result = await completeEngineering(application, plan, request);
  const resultFile = path.join(path.dirname(product), "result.json");
  await fs.writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  const sealed = await completeDevelopmentResult(application, resultFile, { dryRun: false });
  assert.equal(sealed.receipt.direction, "development_to_product");
  assert.equal(sealed.receipt.contractDigest, sealed.digest);

  // The importer wants the sealed result and its receipt together, which is what the outbox holds.
  const devConfig = await loadDevelopmentConfig(application);
  const outbox = path.join(application, devConfig.sync.outbox);
  await fs.copyFile(path.join(outbox, `${result.resultId}.json`), resultFile);
  await fs.copyFile(path.join(outbox, `${result.resultId}.receipt.json`), `${resultFile.slice(0, -5)}.receipt.json`);

  const imported = await importEngineeringResult(product, resultFile, { dryRun: false });
  assert.equal(imported.result.resultId, result.resultId);
  assert.equal(imported.digest, sealed.digest, "the digest must survive the crossing unchanged");

  const stored = await fs.readdir(path.join(product, ".product-ops/runtime/development/contracts/inbox"));
  assert.ok(stored.includes(`${result.resultId}.json`), "the verified result lands in the product boundary");
});

test("a result that its own producer signed off cannot cross back", async (t) => {
  // The invariant the whole return path exists to protect: nobody certifies their own work.
  const { product, application, config, bridge, requestFile, request } = await connect(t);
  await exportDevelopmentRequest(product, config, bridge.task_id, requestFile, { dryRun: false });
  const { plan } = await planDevelopmentRequest(application, requestFile, { dryRun: false });

  const result = await completeEngineering(application, plan, request);
  const devConfig = await loadDevelopmentConfig(application);
  const verifier = devConfig.roles.find((role) => role.id === "ENG-15").actorId;
  const selfCertified = { ...result, producerActorId: verifier };

  const resultFile = path.join(path.dirname(product), "self-certified.json");
  await fs.writeFile(resultFile, `${JSON.stringify(selfCertified, null, 2)}\n`, "utf8");
  await assert.rejects(
    completeDevelopmentResult(application, resultFile, { dryRun: false }),
    /producer and verifier actors must be distinct/
  );
});

test("an unverified result cannot claim a completed implementation", async (t) => {
  const { product, application, config, bridge, requestFile, request } = await connect(t);
  await exportDevelopmentRequest(product, config, bridge.task_id, requestFile, { dryRun: false });
  const { plan } = await planDevelopmentRequest(application, requestFile, { dryRun: false });

  const result = await completeEngineering(application, plan, request);
  const unverified = { ...result, verification: { ...result.verification, disposition: "changes_requested" } };
  const resultFile = path.join(path.dirname(product), "unverified.json");
  await fs.writeFile(resultFile, `${JSON.stringify(unverified, null, 2)}\n`, "utf8");
  await assert.rejects(
    completeDevelopmentResult(application, resultFile, { dryRun: false }),
    /requires an independent verified disposition/
  );
});

test("evidence that does not match its recorded digest is refused", async (t) => {
  const { product, application, config, bridge, requestFile, request } = await connect(t);
  await exportDevelopmentRequest(product, config, bridge.task_id, requestFile, { dryRun: false });
  const { plan } = await planDevelopmentRequest(application, requestFile, { dryRun: false });

  const result = await completeEngineering(application, plan, request);
  // The artifact is edited after its digest was taken, which is exactly what tampering looks like.
  await fs.writeFile(path.join(application, result.evidence[0].path), "PASS (edited afterwards)\n", "utf8");

  const resultFile = path.join(path.dirname(product), "tampered.json");
  await fs.writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await assert.rejects(
    completeDevelopmentResult(application, resultFile, { dryRun: false }),
    /evidence digest mismatch/
  );
});

test("an unlinked workspace says so rather than inventing an engineering side", async (t) => {
  const { product, application, requestFile } = await connect(t, { link: false });
  await planDevelopmentRequest(application, requestFile, { dryRun: false });

  const snapshot = await loadDashboardSnapshot(product);
  assert.equal(snapshot.autopilot.engineering, null, "work exists, but this workspace is not linked to it");

  const context = await createServerContext({ project: product });
  const handlers = createHandlers(context, { version: "test" });
  handlers.initialize({ protocolVersion: "2026-07-28", capabilities: {} });
  const panel = (await handlers["tools/call"]({ name: "product_ops_panel", arguments: {} })).structuredContent;
  assert.deepEqual(panel.teams.engineering, []);
});
