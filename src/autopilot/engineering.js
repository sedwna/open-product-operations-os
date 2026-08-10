import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stringifyCsv } from "../csv.js";
import { planDevelopmentRequest } from "../development/planner.js";
import { exportDevelopmentRequest, importEngineeringResult } from "../development/product-sync.js";
import { completeDevelopmentResult } from "../development/result.js";
import { runEngineeringWorkstream } from "../development/runner.js";
import { contractDigest } from "../development/contracts.js";
import { loadDevelopmentConfig } from "../development/config.js";
import { decideApproval, loadApprovals, requestApproval } from "../runtime/approvals.js";
import { validatePublishedSchema } from "../schema-validation.js";
import { QUALITY_GATES } from "../development/catalog.js";
import { readJsonOptional, runGit, safeId, writeJson } from "./shared.js";

const ALL_IMPACTS = [
  "architecture", "frontend", "accessibility", "backend", "api", "integration", "mobile", "desktop",
  "database", "storage", "cache", "messaging", "search", "data", "ai", "analytics", "security",
  "privacy", "identity", "compliance", "network", "infrastructure", "devops", "sre", "observability",
  "performance", "resilience", "cost", "seo", "documentation"
];

/**
 * A delivery crossing into engineering, in three phases.
 *
 * It used to be one function that opened the crossing, ran every workstream itself, and closed it
 * again. That only works when the performer is a CLI this process starts. When the performer is a
 * subagent the host already has, the middle cannot be a loop in here — the host has to be able to
 * take one workstream, do it, and come back. So the crossing is now `openDelivery`, whatever
 * performs the work, and `closeDelivery`.
 *
 * The phases are the same code the single function ran, in the same order, with the same checks.
 * What changed is that the middle is no longer required to be ours.
 */
export async function runEngineeringDelivery(
  productRoot,
  applicationRoot,
  productConfig,
  task,
  { intake, productRuns, cycleId, autoApprove, now = new Date(), executeWorkstream = runEngineeringWorkstream } = {}
) {
  const opened = await openEngineeringDelivery(productRoot, applicationRoot, productConfig, task, {
    intake, productRuns, cycleId, autoApprove, now
  });
  if (opened.status !== "open") return opened;

  const { plan, developmentConfig, runs } = opened;
  for (const workstream of dependencyOrderedWorkstreams(plan.workstreams)) {
    if (runs.has(workstream.id)) continue;
    await writeEngineeringTaskboard(applicationRoot, plan, runs, { active: workstream.id });
    const execution = await executeWorkstream(applicationRoot, plan.planId, workstream.id, { dryRun: false });
    if (execution.result?.status !== "completed") {
      await writeEngineeringTaskboard(applicationRoot, plan, runs, { failed: workstream.id });
      throw new Error(`Engineering workstream ${workstream.id} stopped with ${execution.result?.status ?? "no result"}.`);
    }
    runs.set(workstream.id, execution.result);
    await writeEngineeringTaskboard(applicationRoot, plan, runs);
  }

  return closeEngineeringDelivery(productRoot, applicationRoot, {
    request: opened.request,
    plan,
    requestDigest: opened.requestDigest,
    developmentConfig,
    runs,
    branch: opened.branch,
    cycleId,
    now
  });
}

/**
 * Open the crossing: settle the approval, build the contract, export it, plan it.
 *
 * Returns `waiting_for_human` when the gate is not settled — the crossing is the owner's decision
 * and this never makes it on their behalf. Returns `implementation_complete` when a completed
 * result is already sitting in the outbox, which is how an interrupted delivery resumes instead of
 * repeating itself.
 */
export async function openEngineeringDelivery(
  productRoot,
  applicationRoot,
  productConfig,
  task,
  { intake, productRuns, cycleId, autoApprove = false, now = new Date() } = {}
) {
  const branch = await prepareCycleBranch(applicationRoot, cycleId);
  const approval = await ensureDevelopmentApproval(productRoot, productConfig, task, {
    autoApprove,
    now,
    context: describeCrossing(intake, productRuns)
  });
  if (approval.status !== "approved") {
    return { status: "waiting_for_human", approval };
  }
  const developmentConfig = await loadDevelopmentConfig(applicationRoot);
  let request = await buildDevelopmentRequest(productRoot, developmentConfig, productConfig, task, {
    applicationRoot,
    intake,
    productRuns,
    approval,
    cycleId,
    now
  });
  const requestDirectory = path.join(productRoot, ".product-ops", "runtime", "autopilot", "requests");
  await fs.mkdir(requestDirectory, { recursive: true });
  const requestFile = path.join(requestDirectory, `${request.requestId}.json`);
  const reuse = await reuseExportedDevelopmentRequest(productRoot, applicationRoot, request);
  request = reuse.request;
  await writeJson(requestFile, request);
  const resumed = await resumeCompletedDelivery(productRoot, applicationRoot, developmentConfig, request, branch);
  if (resumed) return resumed;
  const exported = await exportDevelopmentRequest(productRoot, productConfig, task.task_id, requestFile, {
    dryRun: false,
    supersede: reuse.superseded
  });
  const exportedFile = path.join(productRoot, exported.receipt.storedAt);
  const planned = await planDevelopmentRequest(applicationRoot, exportedFile, { dryRun: false });
  await writeEngineeringTaskboard(applicationRoot, planned.plan, new Map());

  // A run already on disk is work that was done and sealed. Repeating it would discard evidence and
  // produce a second claim about the same thing.
  const runs = new Map();
  for (const workstream of planned.plan.workstreams) {
    const previous = await loadExistingWorkstreamRun(applicationRoot, planned.plan, workstream, developmentConfig);
    if (previous) runs.set(workstream.id, previous);
  }
  await writeEngineeringTaskboard(applicationRoot, planned.plan, runs);

  return {
    status: "open",
    approval,
    request,
    superseded: reuse.superseded,
    requestDigest: planned.digest,
    plan: planned.plan,
    developmentConfig,
    runs,
    branch
  };
}

/**
 * Close the crossing: prove something was built, seal the runs, gather gate evidence, and bring the
 * result back across as a product record.
 *
 * The proof is not optional and does not depend on who performed the work. A delivery that reports
 * every workstream complete and changed nothing is not a delivery.
 */
export async function closeEngineeringDelivery(
  productRoot,
  applicationRoot,
  { request, plan, requestDigest, developmentConfig, runs, branch, cycleId, now = new Date() }
) {
  const changedComponents = await changedImplementationComponents(applicationRoot);
  if (changedComponents.length === 0) {
    throw new Error("Engineering completed every workstream without producing implementation changes.");
  }
  await assertImplementationBoundary(applicationRoot, changedComponents, developmentConfig.policies);
  const implementationRevision = await implementationDigest(applicationRoot, changedComponents);
  const sealedRuns = await sealWorkstreamRuns(applicationRoot, plan, runs, implementationRevision);
  const evidence = await createGateEvidence(applicationRoot, plan, sealedRuns, implementationRevision, now);
  const result = buildEngineeringResult({
    request,
    plan,
    requestDigest,
    config: developmentConfig,
    sealedRuns,
    evidence,
    implementationRevision,
    changedComponents,
    branch,
    now
  });
  const resultDraft = path.join(applicationRoot, ".development-os", "runs", `${result.resultId}-draft.json`);
  await writeJson(resultDraft, result);
  const completed = await completeDevelopmentResult(applicationRoot, resultDraft, { dryRun: false });
  await commitCycle(applicationRoot, cycleId);
  const resultFile = path.join(applicationRoot, completed.receipt.storedAt);
  const imported = await importEngineeringResult(productRoot, resultFile, { dryRun: false });
  const productEvidenceRefs = await syncEngineeringEvidence(productRoot, applicationRoot, imported.result);
  return {
    status: "implementation_complete",
    request,
    plan,
    result: imported.result,
    productReceipt: imported.receipt,
    branch,
    changedComponents,
    productEvidenceRefs
  };
}

export function dependencyOrderedWorkstreams(workstreams) {
  const byId = new Map(workstreams.map((workstream) => [workstream.id, workstream]));
  if (byId.size !== workstreams.length) throw new Error("Engineering workstreams must have unique IDs.");
  for (const workstream of workstreams) {
    for (const dependency of workstream.dependencies ?? []) {
      if (!byId.has(dependency)) throw new Error(`Engineering workstream ${workstream.id} depends on unknown ${dependency}.`);
    }
  }
  const ordered = [];
  const completed = new Set();
  while (ordered.length < workstreams.length) {
    const ready = workstreams.find((workstream) => !completed.has(workstream.id)
      && (workstream.dependencies ?? []).every((dependency) => completed.has(dependency)));
    if (!ready) throw new Error("Engineering workstream dependency graph contains a cycle.");
    ordered.push(ready);
    completed.add(ready.id);
  }
  return ordered;
}

/**
 * Whether a contract already in the outbox still stands.
 *
 * This compared identity — task, title, problem, approval — and on a match returned the stored
 * contract, so a contract whose *contents* were wrong could never be corrected. The identity of a
 * delivery does not change when its acceptance criteria are fixed, which is exactly the case where
 * replacing it matters: an export defect was found before anyone built against it, and the stored
 * copy silently won over the corrected one.
 *
 * The rule that actually matters is not whether the contract changed but whether anything has been
 * built against it. A contract nobody has answered yet is a draft in flight. Once a workstream has
 * been sealed, its evidence is tied to that contract's digest, and replacing it would leave sealed
 * work certifying a document that no longer exists.
 */
async function reuseExportedDevelopmentRequest(productRoot, applicationRoot, candidate) {
  const exportedFile = path.join(
    productRoot,
    ".product-ops", "runtime", "development", "contracts", "outbox",
    `${candidate.requestId}.json`
  );
  const exported = await readJsonOptional(exportedFile);
  if (!exported) return { request: candidate, superseded: false };
  const errors = validatePublishedSchema("development-request.schema.json", exported);
  if (errors.length) {
    throw new Error(`Previously exported development request is invalid:\n- ${errors.join("\n- ")}`);
  }
  const identityMatches = exported.requestId === candidate.requestId
    && exported.productTaskId === candidate.productTaskId
    && exported.approval?.reference === candidate.approval?.reference
    && exported.approval?.actorId === candidate.approval?.actorId
    && JSON.stringify(exported.writeBoundary?.repositories) === JSON.stringify(candidate.writeBoundary?.repositories);
  if (!identityMatches) {
    throw new Error(`Development request ${candidate.requestId} was already exported for a different task, product, or approval.`);
  }
  if (contractDigest(exported) === contractDigest(candidate)) {
    return { request: exported, superseded: false };
  }
  const sealed = await sealedWorkstreamIds(applicationRoot, candidate.requestId);
  if (sealed.length > 0) {
    throw new Error(
      `Development request ${candidate.requestId} was already exported with different contents, and ${sealed.length} workstream(s) have been sealed against it (${sealed.join(", ")}). `
      + "Their evidence certifies the exported contract, so it cannot be replaced underneath them. Raise a new delivery for the corrected contract."
    );
  }
  return { request: candidate, superseded: true };
}

/** Workstreams whose sealed result already answers this contract. */
async function sealedWorkstreamIds(applicationRoot, requestId) {
  const planId = `ENGPLAN-${requestId.replace(/^DEVREQ-/, "")}`;
  const directory = path.join(applicationRoot, ".development-os", "runs");
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const sealed = [];
  for (const name of entries) {
    if (!name.startsWith(`${planId}-`) || !name.endsWith("-result.json") || name.includes("-attempt-")) continue;
    const result = await readJsonOptional(path.join(directory, name));
    if (result?.status === "completed" && result.workstreamId) sealed.push(result.workstreamId);
  }
  return sealed;
}

async function ensureDevelopmentApproval(root, config, task, { autoApprove, now, context }) {
  const store = await loadApprovals(root);
  let approval = store.requests.find((candidate) => candidate.taskId === task.task_id && candidate.gate === "development-export");
  if (!approval) {
    approval = (await requestApproval(root, {
      taskId: task.task_id,
      gate: "development-export",
      question: `Authorize bounded development for ${task.task_id}?`,
      context,
      recommendedOption: "approved",
      risks: ["Production release and destructive operations remain separately gated."]
    }, { dryRun: false, now })).request;
  }
  if (approval.status === "pending" && autoApprove) {
    approval = (await decideApproval(root, config, {
      requestId: approval.requestId,
      decision: "approved",
      actorId: config.project.humanAuthorityActorId,
      rationale: "The owner explicitly authorized the initial autonomous idea-to-implementation cycle when the workspace was set up."
    }, { dryRun: false, now })).request;
  }
  return approval;
}

/**
 * The run that authored the delivery contract.
 *
 * Everything the engineering side is asked to build comes from this one card. The others are how
 * the product got here — an idea screened, research done, issues raised — and they are context, not
 * contract.
 */
function deliveryContractRun(productRuns) {
  return productRuns.find((run) => run.roleId === "RB-06") ?? null;
}

/**
 * What this delivery actually touches.
 *
 * The delivery contract's declaration governs; the other cards contribute only when it declared
 * nothing. A delivery that names no domain at all still needs somewhere to start, so it gets the
 * two every change has — the work itself and the record of it — and the planner widens from there
 * by reading the contract's own words.
 */
const MINIMUM_IMPACTS = ["architecture", "documentation"];

function scopedImpacts(contract, productRuns) {
  const declared = contract?.impacts?.length
    ? contract.impacts
    : productRuns.flatMap((run) => run.impacts ?? []);
  const scoped = unique(declared).filter((impact) => ALL_IMPACTS.includes(impact));
  return scoped.length > 0 ? scoped : [...MINIMUM_IMPACTS];
}

async function buildDevelopmentRequest(productRoot, developmentConfig, productConfig, task, { applicationRoot, intake, productRuns, approval, cycleId, now }) {
  const contract = deliveryContractRun(productRuns);
  // The contract's own criteria are the contract. This used to flat-map every run in board order and
  // keep the first thirty, so on any real product the earliest cards — idea triage, discovery —
  // filled every slot with criteria about reviewing documents, and the delivery contract's actual
  // criteria were cut off below them. Fifteen engineering teams were then asked to satisfy
  // acceptance criteria that had nothing to do with what was being built.
  const source = contract?.acceptanceCriteria?.length ? [contract] : productRuns;
  const acceptance = uniqueObjects(source.flatMap((run) => run.acceptanceCriteria ?? []), (item) => `${item.statement}\0${item.verification}`)
    .slice(0, 30)
    .map((item, index) => ({ id: `AC-${String(index + 1).padStart(2, "0")}`, ...item }));
  if (acceptance.length === 0) {
    acceptance.push({ id: "AC-01", statement: "The approved product outcome is implemented and demonstrable.", verification: "Run the repository validation and an end-to-end product scenario." });
  }
  const recommendations = [...(contract?.recommendations ?? []), ...productRuns.flatMap((run) => run.recommendations ?? [])];
  const constraints = unique([
    ...productRuns.flatMap((run) => run.constraints ?? []).filter(isProductConstraint),
    "No production credentials or production-derived customer data",
    "Production deployment requires a separate attributed human approval",
    "Database and infrastructure changes must be reversible"
  ]);
  const nonFunctionalRequirements = uniqueObjects([
    ...productRuns.flatMap((run) => run.nonFunctionalRequirements ?? []),
    { domain: "security", requirement: "Apply least privilege, secure defaults, and secret-free source control.", verification: "Run security and secret scans and record evidence." },
    { domain: "database", requirement: "Any persistent-data change is reversible and has backup, restore, and rollback evidence.", verification: "Exercise migration and recovery outside production." },
    { domain: "performance", requirement: "Define and verify practical latency and resource budgets for affected paths.", verification: "Run reproducible performance checks." },
    { domain: "accessibility", requirement: "User-facing paths support keyboard and assistive technology.", verification: "Run automated and manual accessibility scenarios." },
    { domain: "reliability", requirement: "Failures are observable, recoverable, and bounded.", verification: "Verify telemetry, retry, timeout, and recovery behavior." },
    { domain: "seo", requirement: "Public web surfaces preserve crawlability, metadata, structured data, and web-vitals hygiene.", verification: "Run a technical SEO audit when applicable." }
  ], (item) => `${item.domain}\0${item.requirement}`).slice(0, 30);
  const revision = await gitRevision(productRoot);
  return {
    schemaVersion: "1.0.0",
    requestId: `DEVREQ-${safeId(cycleId)}`,
    productTaskId: task.task_id,
    deliveryTicketReference: `.product-ops/runtime/autopilot/product-runs/${findRoleTask(productRuns, "RB-06") ?? task.task_id}-result.json`,
    title: intake.title,
    problem: intake.description,
    desiredOutcome: recommendations[0] ?? contract?.summary ?? productRuns.at(-1)?.summary ?? `Deliver the approved outcome for ${intake.title}.`,
    acceptanceCriteria: acceptance,
    // Every request used to declare all thirty impact domains, unconditionally — the product's own
    // declared impacts were appended to a list that already contained everything, so they changed
    // nothing. The planner turns impacts into workstreams, so a browser game was dispatched to all
    // fifteen engineering teams including database, infrastructure and messaging. What a delivery
    // touches is a claim the product side makes; if it made none, a minimum is assumed and the
    // planner still widens it from the contract's own text.
    impacts: scopedImpacts(contract, productRuns),
    constraints,
    nonFunctionalRequirements,
    writeBoundary: {
      repositories: [developmentConfig.project.id],
      allowedPaths: developmentConfig.policies.allowedPaths,
      prohibitedPaths: developmentConfig.policies.prohibitedPaths
    },
    validation: {
      commands: await validationCommands(applicationRoot),
      evidenceRequired: ["implementation diff", "automated tests", "security review", "independent verification", "database and SEO evidence when applicable"]
    },
    approval: {
      status: "approved",
      actorId: productConfig.project.humanAuthorityActorId,
      decidedAt: approval.decidedAt,
      reference: approval.requestId
    },
    source: { productOperationsRevision: revision, exportedAt: now.toISOString() }
  };
}

export async function createGateEvidence(root, plan, runs, implementationRevision, now) {
  const evidence = [];
  const directory = path.join(root, ".development-os", "evidence");
  await fs.mkdir(directory, { recursive: true });
  for (const gateId of plan.qualityGates) {
    const gate = QUALITY_GATES.find((candidate) => candidate.id === gateId);
    if (!gate) throw new Error(`Engineering plan references unknown quality gate ${gateId}.`);
    const relevantRuns = [...runs.values()].filter((run) =>
      run.ownerRole === gate.ownerRole || (gateId !== "GATE-INDEPENDENT-VERIFICATION" && run.ownerRole === "ENG-15")
    );
    if (!relevantRuns.some((run) => run.ownerRole === gate.ownerRole)) {
      throw new Error(`Quality gate ${gateId} has no completed owner workstream from ${gate.ownerRole}.`);
    }
    const relevantWorkstreamIds = relevantRuns.map((run) => run.workstreamId);
    const relative = `.development-os/evidence/${gateId}.json`;
    const gateEvidence = {
      schemaVersion: "1.0.0",
      gateId,
      planId: plan.planId,
      implementationRevision,
      relevantWorkstreamIds,
      workstreamRuns: relevantRuns.map((run) => ({
        workstreamId: run.workstreamId,
        ownerRole: run.ownerRole,
        status: run.status,
        verificationDisposition: run.verificationDisposition,
        commands: run.commands,
        evidence: run.evidence,
        knownRisks: run.knownRisks
      })),
      generatedAt: now.toISOString()
    };
    const errors = validatePublishedSchema("engineering-gate-evidence.schema.json", gateEvidence);
    if (errors.length) throw new Error(`Quality-gate evidence ${gateId} is invalid:\n- ${errors.join("\n- ")}`);
    const content = `${JSON.stringify(gateEvidence, null, 2)}\n`;
    await fs.writeFile(path.join(root, relative), content, "utf8");
    evidence.push({ path: relative, kind: evidenceKind(gateId), sha256: sha256(content), sourceRevision: implementationRevision, relevantWorkstreamIds });
  }
  return evidence;
}

export function buildEngineeringResult({ request, plan, requestDigest, config, sealedRuns, evidence, implementationRevision, changedComponents, branch, now }) {
  const verifier = config.roles.find((role) => role.id === "ENG-15");
  const coordinator = config.roles.find((role) => role.id === "ENG-01");
  const verificationEvidence = evidence.find((item) => item.path.includes("GATE-INDEPENDENT-VERIFICATION"))?.path;
  const verifierRun = [...sealedRuns.values()].find((run) => run.ownerRole === "ENG-15");
  if (!verifierRun || verifierRun.status !== "completed" || verifierRun.verificationDisposition !== "passed") {
    throw new Error("Engineering delivery cannot be marked verified without an explicit passing ENG-15 disposition.");
  }
  return {
    schemaVersion: "1.0.0",
    resultId: `ENGRESULT-${request.requestId.replace(/^DEVREQ-/, "")}`,
    requestId: request.requestId,
    productTaskId: request.productTaskId,
    planId: plan.planId,
    planDigest: contractDigest(plan),
    sourceDigest: requestDigest,
    implementationRevision,
    status: "implementation_complete",
    implementationReferences: [`branch:${branch}`, `content-digest:${implementationRevision}`],
    changedComponents,
    workstreamRuns: plan.workstreams.map((workstream) => ({ workstreamId: workstream.id, runDigest: contractDigest(sealedRuns.get(workstream.id)) })),
    gateResults: plan.qualityGates.map((gateId) => ({ gateId, status: "passed", evidenceReferences: [`.development-os/evidence/${gateId}.json`] })),
    evidence,
    deploymentReferences: [],
    knownRisks: unique([...sealedRuns.values()].flatMap((run) => run.knownRisks ?? [])),
    producerActorId: coordinator.actorId,
    verification: {
      verifierActorId: verifier.actorId,
      disposition: "verified",
      verifiedAt: now.toISOString(),
      evidenceReferences: [verificationEvidence]
    },
    completedAt: now.toISOString()
  };
}

async function sealWorkstreamRuns(root, plan, runs, implementationRevision) {
  const sealed = new Map();
  for (const workstream of plan.workstreams) {
    const run = { ...runs.get(workstream.id), implementationRevision };
    const file = path.join(root, ".development-os", "runs", `${plan.planId}-${workstream.id}-result.json`);
    await writeJson(file, run);
    sealed.set(workstream.id, run);
  }
  return sealed;
}

async function writeEngineeringTaskboard(root, plan, runs, { active = null, failed = null } = {}) {
  const rows = [["workstream_id", "request_id", "owner_role", "domain", "title", "status", "dependency_ids", "evidence_refs", "updated_at"]];
  const now = new Date().toISOString();
  for (const workstream of plan.workstreams) {
    const status = failed === workstream.id ? "failed" : runs.has(workstream.id) ? "completed" : active === workstream.id ? "in_progress" : "ready";
    rows.push([workstream.id, plan.requestId, workstream.ownerRole, workstream.domain, workstream.title, status, workstream.dependencies.join("|"), (runs.get(workstream.id)?.evidence ?? []).join("|"), now]);
  }
  await fs.writeFile(path.join(root, "engineering", "taskboard", "workstreams.csv"), stringifyCsv(rows), "utf8");
}

async function changedImplementationComponents(root) {
  const status = (await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  const records = status.split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const state = record.slice(0, 2);
    const file = record.slice(3);
    if (state.includes("R") || state.includes("C")) index += 1;
    files.push(file.replaceAll("\\", "/"));
  }
  return unique(files.filter((file) => !file.startsWith(".development-os/") && !file.startsWith("engineering/taskboard/")));
}

async function assertImplementationBoundary(root, files, policies) {
  const violations = [];
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
    const prohibited = policies.prohibitedPaths.some((candidate) => pathMatches(normalized, candidate));
    const allowed = policies.allowedPaths.some((candidate) => pathMatches(normalized, candidate));
    const stat = await fs.lstat(path.join(root, normalized)).catch(() => null);
    if (prohibited || !allowed || stat?.isSymbolicLink()) violations.push(normalized);
  }
  if (violations.length) {
    throw new Error(`Engineering changes escaped the approved write boundary: ${violations.join(", ")}`);
  }
}

function pathMatches(file, boundary) {
  const normalized = String(boundary).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  return file === normalized || file.startsWith(`${normalized}/`);
}

async function implementationDigest(root, files) {
  const hash = crypto.createHash("sha256");
  for (const relative of [...files].sort()) {
    const file = path.join(root, relative);
    const stat = await fs.lstat(file).catch(() => null);
    hash.update(relative).update("\0");
    if (stat?.isFile() && !stat.isSymbolicLink()) hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * The branch a cycle's work lives on, derivable without touching the repository. Closing a delivery
 * needs the name after the work is done, when the tree is no longer clean and switching would be
 * both unnecessary and unsafe.
 */
export function cycleBranch(cycleId) {
  return `codex/${safeId(cycleId).toLowerCase()}`;
}

async function prepareCycleBranch(root, cycleId) {
  const branch = cycleBranch(cycleId);
  const current = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
  if (current === branch) return branch;
  await assertCleanGit(root);
  const exists = (await runGit(root, ["branch", "--list", branch])).stdout.trim() !== "";
  await runGit(root, exists ? ["switch", branch] : ["switch", "-c", branch]);
  return branch;
}

async function commitCycle(root, cycleId) {
  await runGit(root, ["add", "--all"]);
  const staged = (await runGit(root, ["diff", "--cached", "--name-only"])).stdout.trim();
  if (!staged) return null;
  await runGit(root, [
    "-c", "user.name=OpenProduct Autopilot",
    "-c", "user.email=autopilot@users.noreply.github.com",
    "commit", "-m", `feat: implement autonomous cycle ${safeId(cycleId)}`
  ]);
  return gitRevision(root);
}

async function assertCleanGit(root) {
  const status = (await runGit(root, ["status", "--porcelain"])).stdout.trim();
  if (status) throw new Error("Autopilot requires a clean application Git worktree before starting a cycle.");
}

async function gitRevision(root) {
  return (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
}

async function resumeCompletedDelivery(productRoot, applicationRoot, config, request, branch) {
  const resultId = `ENGRESULT-${request.requestId.replace(/^DEVREQ-/, "")}`;
  const resultFile = path.join(applicationRoot, config.sync.outbox, `${resultId}.json`);
  const result = await readJsonOptional(resultFile);
  if (!result) return null;
  const imported = await importEngineeringResult(productRoot, resultFile, { dryRun: false });
  const productEvidenceRefs = await syncEngineeringEvidence(productRoot, applicationRoot, imported.result);
  return {
    status: "implementation_complete",
    request,
    plan: null,
    result: imported.result,
    productReceipt: imported.receipt,
    branch,
    changedComponents: result.changedComponents,
    productEvidenceRefs
  };
}

async function syncEngineeringEvidence(productRoot, applicationRoot, result) {
  const relativeRoot = `.product-ops/runtime/development/contracts/evidence/${safeId(result.resultId)}`;
  const targetRoot = path.join(productRoot, relativeRoot);
  await fs.mkdir(targetRoot, { recursive: true });
  const references = [];
  for (const artifact of result.evidence) {
    const source = path.resolve(applicationRoot, artifact.path);
    const evidenceRoot = path.resolve(applicationRoot, ".development-os", "evidence");
    if (!isInside(evidenceRoot, source)) throw new Error(`Engineering evidence escaped its source boundary: ${artifact.path}`);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Engineering evidence is not a safe regular file: ${artifact.path}`);
    const bytes = await fs.readFile(source);
    if (sha256(bytes) !== artifact.sha256) throw new Error(`Engineering evidence changed before product synchronization: ${artifact.path}`);
    const target = path.join(targetRoot, `${artifact.sha256}-${path.basename(artifact.path)}`);
    await writeBytesExclusiveOrEqual(target, bytes);
    references.push(path.relative(productRoot, target).replaceAll("\\", "/"));
  }
  const packageFile = path.join(targetRoot, "engineering-result.json");
  await writeJson(packageFile, result);
  references.push(path.relative(productRoot, packageFile).replaceAll("\\", "/"));
  return references;
}

async function writeBytesExclusiveOrEqual(file, bytes) {
  try { await fs.writeFile(file, bytes, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.readFile(file);
    if (!existing.equals(bytes)) throw new Error(`Synchronized evidence already exists with different bytes: ${file}`);
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function loadExistingWorkstreamRun(root, plan, workstream, config) {
  const file = path.join(root, ".development-os", "runs", `${plan.planId}-${workstream.id}-result.json`);
  const result = await readJsonOptional(file);
  if (!result) return null;
  const errors = validatePublishedSchema("engineering-workstream-run.schema.json", result);
  const actor = config.roles.find((role) => role.id === workstream.ownerRole)?.actorId;
  if (errors.length || result.planId !== plan.planId || result.workstreamId !== workstream.id || result.ownerRole !== workstream.ownerRole || result.producerActorId !== actor || result.status !== "completed") {
    throw new Error(`Stored engineering run ${workstream.id} is invalid and cannot be resumed safely.`);
  }
  return result;
}

async function validationCommands(applicationRoot) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(applicationRoot, "package.json"), "utf8"));
    const commands = [];
    if (pkg.scripts?.test) commands.push("npm test");
    if (pkg.scripts?.check) commands.push("npm run check");
    if (pkg.scripts?.lint) commands.push("npm run lint");
    return commands.length ? commands : ["git diff --check"];
  } catch { return ["git diff --check"]; }
}

/**
 * What the owner is being asked to authorise.
 *
 * This used to be every prior run's summary joined together and cut at eight thousand characters
 * from the front. On a real product that meant the gate opened by quoting whichever card happened to
 * run first — idea triage — and the delivery contract, the only thing this decision is actually
 * about, was somewhere below the cut. The owner was asked to approve a crossing while reading the
 * history that led to it.
 *
 * A gate should state its own decision. This names what would travel, how much of it there is, and
 * what approving does and does not authorise, in that order.
 */
function describeCrossing(intake, runs) {
  const contract = runs.find((run) => run.roleId === "RB-06");
  const validation = runs.find((run) => run.roleId === "RB-07");
  const criteria = uniqueObjects(
    runs.flatMap((run) => run.acceptanceCriteria ?? []),
    (item) => `${item.statement}\0${item.verification}`
  ).length;

  const lines = [];
  if (intake?.title) lines.push(`What this delivers: ${intake.title}.`);
  if (contract?.summary) lines.push(`The delivery contract says: ${clip(contract.summary, 1200)}`);
  else lines.push("No delivery contract has been authored for this event yet, so what crosses would be assembled from whatever the product side has produced so far.");
  lines.push(`${Math.min(criteria, 30)} acceptance criterion(s) travel with it${criteria > 30 ? ` (${criteria} exist; the contract carries the first 30)` : ""}.`);
  if (validation?.summary) lines.push(`Validation design: ${clip(validation.summary, 600)}`);
  lines.push("Approving sends this contract to the engineering repository and lets implementation begin there. It does not authorise a production release, a destructive operation, or any write outside the contract's boundary — each of those is gated separately.");
  lines.push("Rejecting leaves the product side intact and stops only the crossing.");
  return clip(lines.join("\n"), 8000);
}

function clip(value, limit) {
  const text = String(value ?? "").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function findRoleTask(runs, roleId) {
  return runs.find((run) => run.roleId === roleId)?.taskId;
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }
function uniqueObjects(values, key) { const seen = new Set(); return values.filter((value) => { const id = key(value); if (seen.has(id)) return false; seen.add(id); return true; }); }
function isProductConstraint(value) {
  const normalized = String(value ?? "").normalize("NFKC").toLowerCase();
  if (/\brb-\d{2}\b/.test(normalized)) return false;
  if (/no (?:direct )?repository (?:edit|edits|write|writes)/.test(normalized)) return false;
  if (/for this run/.test(normalized) && /(implementation|qa|verification|credential|repository)/.test(normalized)) return false;
  if (/no user research/.test(normalized) && /(evidence|evidenced|available|supplied)/.test(normalized)) return false;
  return true;
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function evidenceKind(gateId) {
  if (gateId.includes("ARCHITECTURE")) return "architecture";
  if (gateId.includes("SECURITY") || gateId.includes("SUPPLY")) return "security";
  if (gateId.includes("DATABASE")) return "database";
  if (gateId.includes("API")) return "api";
  if (gateId.includes("INFRA")) return "infrastructure";
  if (gateId.includes("PRIVACY")) return "privacy";
  if (gateId.includes("ACCESSIBILITY")) return "accessibility";
  if (gateId.includes("PERFORMANCE")) return "performance";
  if (gateId.includes("RELIABILITY")) return "reliability";
  if (gateId.includes("SEO")) return "seo";
  if (gateId.includes("DOCUMENTATION")) return "documentation";
  if (gateId.includes("VERIFICATION")) return "verification";
  if (gateId.includes("TEST")) return "test";
  return "review";
}
