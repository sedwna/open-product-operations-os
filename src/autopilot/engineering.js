import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseCsv, stringifyCsv } from "../csv.js";
import { planDevelopmentRequest } from "../development/planner.js";
import { exportDevelopmentRequest, importEngineeringResult } from "../development/product-sync.js";
import { completeDevelopmentResult } from "../development/result.js";
import { runEngineeringWorkstream, verifierWorkspaceDigest } from "../development/runner.js";
import { canonicalJson, contractDigest } from "../development/contracts.js";
import { loadDevelopmentConfig } from "../development/config.js";
import {
  loadEngineeringEvidenceAmendments, resolveEffectiveEngineeringRuns
} from "../development/amendment.js";
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
  {
    request, plan, requestDigest, developmentConfig, runs, branch, cycleId,
    implementationProof = null, now = new Date()
  }
) {
  const proof = implementationProof ?? await preflightEngineeringDelivery(
    applicationRoot,
    plan,
    runs,
    developmentConfig.policies,
    request.writeBoundary,
    request.source.applicationBaseRevision ?? null,
    request.requestId
  );
  const { changedComponents, implementationRevision } = proof;
  // The original autonomous runner leaves implementation changes in the working tree until close,
  // so close still seals those runs to one content digest. Host-delegated work is intentionally
  // committed and sealed one workstream at a time; rewriting those immutable results at close would
  // destroy their chain of custody. In that path ENG-15's verified commit is the delivery revision.
  const sealedRuns = proof.source === "working_tree"
    ? await sealWorkstreamRuns(applicationRoot, plan, runs, implementationRevision)
    : runs;
  const gateEvidence = await createGateEvidence(applicationRoot, plan, sealedRuns, implementationRevision, now);
  const amendmentEvidence = (proof.appliedAmendments ?? []).map((record) => ({
    path: record.storedAt,
    kind: "other",
    sha256: record.sha256,
    sourceRevision: implementationRevision,
    relevantWorkstreamIds: [record.workstreamId]
  }));
  const evidence = [...gateEvidence, ...amendmentEvidence];
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

/**
 * Resolve the implementation proof without writing anything.
 *
 * This is shared by close dry-run and apply so the preview cannot approve a clean committed
 * delivery that apply later rejects. Dirty-tree execution is the legacy autonomous path. A clean
 * tree is valid only when immutable completed runs name changed components and ENG-15 binds its
 * passing verdict to a real commit reachable from the current application revision.
 */
export async function preflightEngineeringDelivery(
  root,
  plan,
  runs,
  policies,
  requestBoundary = null,
  applicationBaseRevision = null,
  requestId = null
) {
  const verifierWorkstream = plan.workstreams.find((workstream) => workstream.ownerRole === "ENG-15");
  const verifierRun = verifierWorkstream ? runs.get(verifierWorkstream.id) : null;
  const amendments = await loadEngineeringEvidenceAmendments(root, plan.planId);
  const amendmentBindings = [];
  for (const { amendment, storedAt } of amendments) {
    const bytes = await fs.readFile(path.join(root, storedAt));
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    amendmentBindings.push({
      amendment,
      storedAt,
      sha256: digest,
      verificationReference: `${storedAt}#sha256=${digest}`
    });
  }
  if (amendments.length > 0) {
    if (!verifierRun || verifierRun.status !== "completed" || verifierRun.verificationDisposition !== "passed") {
      throw new Error("Engineering amendments require a completed passing ENG-15 run.");
    }
    const missingAmendments = amendmentBindings
      .filter(({ verificationReference }) => !(verifierRun.evidence ?? []).includes(verificationReference))
      .map(({ amendment }) => amendment.amendmentId);
    if (missingAmendments.length > 0) {
      throw new Error(
        `The passing ENG-15 run does not verify the content digest of engineering amendment(s): ${missingAmendments.join(", ")}.`
      );
    }
  }
  const { runs: effectiveRuns, applied } = resolveEffectiveEngineeringRuns(runs, amendments);
  const effectivePolicies = narrowDeliveryPolicies(policies, requestBoundary);
  const workingTreeComponents = await changedImplementationComponents(root);
  if (workingTreeComponents.length > 0) {
    if (amendments.length > 0) {
      throw new Error("Engineering amendments cannot close over an uncommitted working tree.");
    }
    if (!verifierRun || verifierRun.status !== "completed" || verifierRun.verificationDisposition !== "passed") {
      throw new Error("Uncommitted engineering work requires a completed passing ENG-15 run.");
    }
    const [workingTreeRevision, workingTreeHead] = await Promise.all([
      verifierWorkspaceDigest(root, policies.prohibitedPaths),
      runGit(root, ["rev-parse", "HEAD"]).then(({ stdout }) => stdout.trim())
    ]);
    if (verifierRun.implementationRevision !== workingTreeRevision) {
      throw new Error("The passing ENG-15 run does not bind the current workspace digest.");
    }
    if (!(verifierRun.evidence ?? []).includes(`git-head:${workingTreeHead}`)) {
      throw new Error("The passing ENG-15 run does not bind the current Git HEAD for working-tree verification.");
    }
    await assertImplementationBoundary(root, workingTreeComponents, effectivePolicies);
    return {
      source: "working_tree",
      changedComponents: workingTreeComponents,
      implementationRevision: workingTreeRevision,
      appliedAmendments: []
    };
  }

  const changedComponents = unique(
    [...effectiveRuns.values()].flatMap((run) => Array.isArray(run.changedComponents) ? run.changedComponents : [])
  ).filter((file) => !file.startsWith(".development-os/") && !file.startsWith("engineering/taskboard/"));
  if (changedComponents.length === 0) {
    throw new Error("Engineering completed every workstream without producing implementation changes.");
  }

  const canonicalRevisions = new Map();
  for (const [workstreamId, run] of effectiveRuns) {
    let canonical;
    try {
      canonical = (await runGit(root, ["rev-parse", "--verify", `${run.implementationRevision}^{commit}`])).stdout.trim();
    } catch {
      throw new Error(`Engineering workstream ${workstreamId} implementationRevision is not a Git commit.`);
    }
    if (run.implementationRevision !== canonical || !/^[a-f0-9]{40,64}$/.test(canonical)) {
      throw new Error(`Engineering workstream ${workstreamId} must name the full immutable commit object ID.`);
    }
    canonicalRevisions.set(workstreamId, canonical);
  }

  if (!verifierRun || verifierRun.status !== "completed" || verifierRun.verificationDisposition !== "passed") {
    throw new Error("Committed engineering work requires a completed passing ENG-15 run.");
  }
  const implementationRevision = canonicalRevisions.get(verifierWorkstream.id);
  for (const [workstreamId, revision] of canonicalRevisions) {
    try {
      await runGit(root, ["merge-base", "--is-ancestor", revision, implementationRevision]);
    } catch {
      throw new Error(
        `Engineering workstream ${workstreamId} revision is not an ancestor of the independently verified revision.`
      );
    }
  }

  const baseRevision = applicationBaseRevision
    ? await requireCanonicalAncestor(root, applicationBaseRevision, implementationRevision, "Application base revision")
    : await deriveOpeningReceiptBase(root, plan, requestId, implementationRevision);
  const actualChangedComponents = unique(
    (await runGit(root, [
      "diff", "--relative", "--name-only", "--no-renames", "-z", `${baseRevision}..${implementationRevision}`, "--", "."
    ])).stdout.split("\0").filter(Boolean)
  ).filter((file) => !file.startsWith(".development-os/") && !file.startsWith("engineering/taskboard/"));
  if (actualChangedComponents.length === 0) {
    throw new Error("The verified Git range contains no implementation changes.");
  }
  await assertImplementationBoundary(root, actualChangedComponents, effectivePolicies);
  const unreported = actualChangedComponents.filter((file) =>
    !changedComponents.some((component) => pathMatches(file, component))
  );
  if (unreported.length > 0) {
    throw new Error(`Engineering runs omit changed Git path(s): ${unreported.join(", ")}.`);
  }

  // `changedComponents` are application-root-relative because plans may target an application
  // nested inside a larger repository. Git object paths, unlike `git diff --relative`, are always
  // repository-root-relative, so preserve that prefix when proving a component existed at the
  // producer revision.
  const repositoryPrefix = (await runGit(root, ["rev-parse", "--show-prefix"]))
    .stdout.trim().replaceAll("\\", "/");
  for (const [workstreamId, run] of effectiveRuns) {
    for (const component of run.changedComponents ?? []) {
      const gitObjectPath = `${repositoryPrefix}${component}`;
      try {
        await runGit(root, ["cat-file", "-e", `${canonicalRevisions.get(workstreamId)}:${gitObjectPath}`]);
      } catch {
        throw new Error(
          `Engineering workstream ${run.workstreamId} names a changed component that does not exist at its implementation revision: ${component}.`
        );
      }
    }
  }

  try {
    await runGit(root, ["cat-file", "-e", `${implementationRevision}^{commit}`]);
    await runGit(root, ["merge-base", "--is-ancestor", implementationRevision, "HEAD"]);
  } catch {
    throw new Error(
      `The passing ENG-15 revision ${implementationRevision} is not a commit reachable from the current application revision.`
    );
  }
  const postVerificationPaths = unique(
    (await runGit(root, [
      "diff", "--relative", "--name-only", "--no-renames", "-z", `${implementationRevision}..HEAD`, "--", "."
    ])).stdout.split("\0").filter(Boolean)
  );
  const postVerificationImplementation = postVerificationPaths.filter((file) =>
    !file.startsWith(".development-os/") && !file.startsWith("engineering/taskboard/")
  );
  if (postVerificationImplementation.length > 0) {
    throw new Error(
      `Application paths changed after independent verification: ${postVerificationImplementation.join(", ")}.`
    );
  }
  const appliedAmendments = [];
  for (const { amendment, storedAt } of applied) {
    const binding = amendmentBindings.find((candidate) => candidate.storedAt === storedAt);
    appliedAmendments.push({
      amendmentId: amendment.amendmentId,
      storedAt,
      sha256: binding.sha256,
      workstreamId: amendment.workstreamId
    });
  }
  return {
    source: "sealed_runs",
    changedComponents: actualChangedComponents,
    implementationRevision,
    applicationBaseRevision: baseRevision,
    appliedAmendments
  };
}

async function requireCanonicalAncestor(root, value, targetRevision, label) {
  let canonical;
  try { canonical = (await runGit(root, ["rev-parse", "--verify", `${value}^{commit}`])).stdout.trim(); }
  catch { throw new Error(`${label} is not a Git commit.`); }
  if (value !== canonical || !/^[a-f0-9]{40,64}$/.test(canonical)) {
    throw new Error(`${label} must name the full immutable commit object ID.`);
  }
  try { await runGit(root, ["merge-base", "--is-ancestor", canonical, targetRevision]); }
  catch { throw new Error(`${label} is not an ancestor of the independently verified revision.`); }
  return canonical;
}

async function deriveOpeningReceiptBase(root, plan, requestId, targetRevision) {
  if (!requestId) {
    throw new Error("Legacy delivery has no recorded application base revision or trusted opening receipt.");
  }
  const matches = [];
  let additions;
  try {
    const repositoryPrefix = (await runGit(root, ["rev-parse", "--show-prefix"]))
      .stdout.trim().replaceAll("\\", "/");
    const output = (await runGit(root, [
      "log", "--full-history", "--no-renames", "--format=COMMIT:%H", "--name-only", "--diff-filter=A", "--", ".development-os/receipts"
    ])).stdout;
    additions = parseAddedPathsByCommit(output, repositoryPrefix);
  } catch {
    throw new Error("Legacy delivery has no recorded application base revision or trusted opening receipt.");
  }
  for (const { revision, storedAt, gitPath } of additions) {
    if (!storedAt.endsWith(".json")) continue;
    let receipt;
    try { receipt = JSON.parse((await runGit(root, ["show", `${revision}:${gitPath}`])).stdout); }
    catch { continue; }
    if (receipt.direction === "product_to_development"
      && receipt.contractType === "development_request"
      && receipt.contractId === requestId
      && receipt.contractDigest === plan.sourceDigest
      && receipt.storedAt === `.development-os/inbox/${requestId}.json`) {
      matches.push({ receipt, storedAt, gitPath, openingRevision: revision });
    }
  }
  if (matches.length !== 1) {
    throw new Error("Legacy delivery has no unique trusted opening receipt for its sealed request.");
  }
  const { receipt, storedAt, gitPath, openingRevision } = matches[0];
  let committedReceipt;
  let committedRequest;
  let parents;
  try {
    committedReceipt = JSON.parse((await runGit(root, ["show", `${openingRevision}:${gitPath}`])).stdout);
    committedRequest = JSON.parse((await runGit(root, [
      "show", `${openingRevision}:${repositoryPath(receipt.storedAt, gitPath, storedAt)}`
    ])).stdout);
    parents = (await runGit(root, ["show", "-s", "--format=%P", openingRevision])).stdout.trim().split(/\s+/).filter(Boolean);
  } catch {
    throw new Error("The trusted opening receipt cannot be read back with its sealed request.");
  }
  if (canonicalJson(committedReceipt) !== canonicalJson(receipt)
    || contractDigest(committedRequest) !== plan.sourceDigest
    || committedReceipt.contractDigest !== plan.sourceDigest
    || parents.length !== 1) {
    throw new Error("The trusted opening receipt does not bind one immutable request and one pre-engineering parent.");
  }
  await requireCanonicalAncestor(root, openingRevision, targetRevision, "Opening receipt revision");
  return requireCanonicalAncestor(root, parents[0], targetRevision, "Opening receipt application base revision");
}

function parseAddedPathsByCommit(output, repositoryPrefix = "") {
  const additions = [];
  let revision = null;
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("COMMIT:")) {
      revision = line.slice("COMMIT:".length);
      continue;
    }
    if (revision) {
      const gitPath = line.replaceAll("\\", "/");
      if (repositoryPrefix && !gitPath.startsWith(repositoryPrefix)) continue;
      additions.push({
        revision,
        gitPath,
        storedAt: repositoryPrefix ? gitPath.slice(repositoryPrefix.length) : gitPath
      });
    }
  }
  return additions;
}

function repositoryPath(relativePath, gitPath, storedAt) {
  return `${gitPath.slice(0, gitPath.length - storedAt.length)}${relativePath}`;
}

function narrowDeliveryPolicies(policies, requestBoundary) {
  if (!requestBoundary) return policies;
  const outerAllowed = policies.allowedPaths ?? [];
  for (const requested of requestBoundary.allowedPaths ?? []) {
    if (!outerAllowed.some((allowed) => pathMatches(requested, allowed))) {
      throw new Error(`The sealed request path ${requested} exceeds the application write policy.`);
    }
  }
  return {
    allowedPaths: [...(requestBoundary.allowedPaths ?? [])],
    prohibitedPaths: unique([
      ...(policies.prohibitedPaths ?? []),
      ...(requestBoundary.prohibitedPaths ?? [])
    ])
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
 * Owner decisions recorded after the delivery contract was sealed.
 *
 * A sealed run is immutable, which is right — it is what a role claimed at a moment, and rewriting
 * it would destroy the record. But it means a correction the owner makes afterwards never reaches
 * the contract that crosses. On the first real product this left an acceptance criterion requiring
 * two browsers after the owner had narrowed it to one: the implementers were told the correction in
 * their briefs, and independent verification, which reads the contract, would have failed the work
 * against a requirement that had been withdrawn.
 *
 * So the decisions travel with the contract as constraints. They are stated as corrections, with
 * their decision identifier, so the engineering side can see both what the contract says and what
 * the owner said after it — and so a verifier reading only the contract is not the last to know.
 */
async function decisionsAfterContract(productRoot, productConfig, contract, eventId) {
  const sheet = productConfig.workbook.sheets.find((candidate) => candidate.key === "decision_log");
  if (!sheet || !contract?.completedAt) return [];
  let rows;
  try {
    rows = parseCsv(await fs.readFile(path.join(productRoot, sheet.file), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const [header, ...records] = rows;
  if (!header) return [];
  const column = (name) => header.indexOf(name);
  const sealedAt = Date.parse(contract.completedAt);
  const corrections = [];
  for (const row of records) {
    if (row[column("event_id")] !== eventId) continue;
    const decidedAt = Date.parse(row[column("decided_at")] ?? "");
    if (!Number.isFinite(decidedAt) || decidedAt <= sealedAt) continue;
    const parts = [
      `Owner decision ${row[column("decision_id")]}, recorded after this contract was sealed`,
      row[column("title")],
      row[column("selected_option")] ? `Chosen: ${row[column("selected_option")]}` : "",
      row[column("conditions")] ? `Conditions: ${row[column("conditions")]}` : ""
    ].filter(Boolean);
    corrections.push(clip(parts.join(" — "), 400));
  }
  return corrections;
}

/**
 * What this delivery actually touches.
 *
 * The delivery contract's declaration governs; the other cards contribute only when it declared
 * nothing. A delivery that names no domain at all still needs somewhere to start, so it gets the
 * two every change has — the work itself and the record of it — and the planner widens from there
 * by reading the contract's own words.
 */
/**
 * Where this delivery may write.
 *
 * The application's policy is the outer bound and a delivery can only ever narrow it. Until now it
 * could not even do that: the exported contract took the application's whole allowed list, so a
 * browser game that needed five directories was handed thirteen — including `database`,
 * `migrations` and `infrastructure`. The coordinator's answer was to tell each subagent to stay
 * inside five anyway, which is a request, not a boundary: nothing enforced it and the closing check
 * would have accepted writes to all thirteen.
 *
 * A path the delivery names that the application does not allow is refused rather than quietly
 * dropped. Asking for somewhere you may not write is a disagreement worth surfacing, not a typo to
 * absorb.
 */
function narrowedAllowedPaths(contract, developmentConfig, approval) {
  const policy = developmentConfig.policies.allowedPaths;
  const declared = contract?.writeBoundary?.allowedPaths ?? [];
  // A delivery contract is immutable once sealed, but the owner may discover at the crossing that
  // its least-privilege boundary omitted a path the approved work genuinely needs. Rewriting the
  // sealed run would erase history; silently inheriting the wider application policy would erase
  // least privilege. An exact, attributed condition on the development-export approval is the
  // amendment: it travels with the request and is still bounded by the application's own policy.
  const additions = (approval?.conditions ?? []).flatMap((condition) => {
    const match = String(condition).match(/^write-boundary-addition:\s*(.+)$/i);
    return match ? [match[1].trim()] : [];
  });
  const requested = unique([...declared, ...additions]);
  if (requested.length === 0) return policy;
  // Nesting matters in one direction only. A delivery asking for `src/admin` where the policy allows
  // `src` is narrowing, which is the whole point of letting it declare a boundary — exact string
  // matching refused that. One asking for `prisma` where the policy allows `prisma/schema.prisma` is
  // widening, and is still refused. The test is whether each requested path sits inside something
  // the policy already permits.
  const within = (candidate) => policy.some((allowed) => candidate === allowed || candidate.startsWith(`${allowed}/`));
  const outside = requested.filter((candidate) => !within(candidate));
  if (outside.length > 0) {
    throw new Error(
      `The delivery contract asks to write in ${outside.join(", ")}, which the application's own write policy does not allow. `
      + `The policy permits ${policy.join(", ")}. A delivery may narrow that policy and never widen it; `
      + "name the narrower paths it actually needs, or change the application policy deliberately."
    );
  }
  return requested;
}

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
  const corrections = await decisionsAfterContract(productRoot, productConfig, contract, task.event_id);
  const constraints = unique([
    ...corrections,
    ...(approval.conditions ?? []).map((condition) => `Owner condition on development export: ${condition}`),
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
  const [revision, applicationBaseRevision] = await Promise.all([
    gitRevision(productRoot),
    gitRevision(applicationRoot)
  ]);
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
      allowedPaths: narrowedAllowedPaths(contract, developmentConfig, approval),
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
    source: { productOperationsRevision: revision, applicationBaseRevision, exportedAt: now.toISOString() }
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

/**
 * The application's own files must be clean before a cycle branches. Its own files, not the whole
 * worktree: a product workspace that shares a Git root with the application — which the setup allows
 * even though the two are meant to have separate histories — writes a control-plane receipt on every
 * scheduling pass, so a whole-worktree check could never pass. It failed on files that engineering
 * will never touch, and reported it as the application being dirty.
 */
async function assertCleanGit(root) {
  const status = (await runGit(root, ["status", "--porcelain", "--", "."])).stdout.trim();
  if (!status) return;
  const files = status.split("\n").map((line) => line.slice(3)).filter(Boolean);
  throw new Error(
    `The application repository has uncommitted changes in ${files.length} file(s) and a cycle branches from a clean tree: ${files.slice(0, 5).join(", ")}`
    + (files.length > 5 ? `, and ${files.length - 5} more.` : ".")
  );
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
