import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertNoLinkTraversal, resolveInside, toPosixPath } from "../paths.js";
import { canonicalCatalog, readPackagedFile } from "../catalog.js";
import { validatePublishedSchema } from "../schema-validation.js";
import { assertNoCredentialMaterial } from "../runtime/security.js";
import { canonicalRecordKeys } from "../workbook-contract.js";
import { RECORD_ID_PATTERNS, STATUS_FIELDS } from "../validation.js";

const PRODUCT_RUN_ROOT = ".product-ops/runtime/autopilot/product-runs";
const PRODUCT_AGENT_RESULT_CONTRACT = JSON.parse(readPackagedFile("schemas/product-agent-run.schema.json"));

/**
 * The status field a tab carries and every value it accepts.
 *
 * Only the canonical-record vocabularies belong here. The result contract itself is already handed
 * over whole, so every enum it defines — impacts among them — is readable in the brief; adding a
 * second copy would create two statements of one fact and a way for them to disagree.
 *
 * A tab whose status is not enumerated returns nothing rather than an empty list, so the brief
 * distinguishes "this tab has no status" from "this tab has a status and I could not tell you it".
 */
function statusVocabulary(sheetKey) {
  const rule = STATUS_FIELDS[sheetKey];
  if (!rule) return {};
  const [field, family] = rule;
  const values = canonicalCatalog.statuses[family];
  return Array.isArray(values) ? { statusField: field, statusValues: values } : {};
}

export async function runProductAgent(
  root,
  config,
  task,
  { intake, priorRuns = [], cycleHistory = [], cycleId, applicationRoot = null, operationalArtifacts = null, execute, now = new Date() } = {}
) {
  // The performer is always supplied. There is no built-in one: work is done by whoever the host
  // delegates it to, and this function's job is the contract around that, not the doing.
  if (typeof execute !== "function") {
    throw new Error("A product agent run needs a performer; pass `execute`.");
  }
  const role = config.agents.find((candidate) => candidate.id === task.owner_role);
  if (!role) throw new Error(`Product task ${task.task_id} has no configured role ${task.owner_role}.`);
  if (role.id === config.separation.developmentRole) {
    throw new Error("The development adapter is executed by the cross-system orchestrator, not a product analysis agent.");
  }
  const absoluteRoot = path.resolve(root);
  const runDirectory = resolveInside(absoluteRoot, PRODUCT_RUN_ROOT, "Product agent run root");
  await assertNoLinkTraversal(absoluteRoot, runDirectory, "Product agent run root");
  await fs.mkdir(runDirectory, { recursive: true });
  const canonicalOutputFile = path.join(runDirectory, `${task.task_id}-result.json`);
  const sealedResult = await readCompletedResult(canonicalOutputFile, task, role);
  if (sealedResult) {
    return {
      result: sealedResult,
      inputFile: null,
      outputFile: path.relative(absoluteRoot, canonicalOutputFile).replaceAll("\\", "/")
    };
  }
  const attemptId = crypto.randomUUID();
  const attemptPrefix = `${task.task_id}-attempt-${attemptId}`;
  const inputFile = path.join(runDirectory, `${attemptPrefix}-input.json`);
  const attemptOutputFile = path.join(runDirectory, `${attemptPrefix}-result.json`);
  const payload = buildProductAgentRequest(config, task, role, {
    intake,
    priorRuns,
    cycleHistory,
    cycleId,
    applicationRoot,
    operationalArtifacts
  });
  assertNoCredentialMaterial("Product agent input", payload);
  await writeExclusiveOrEqual(inputFile, payload);
  const result = await execute({
    root: absoluteRoot,
    inputFile,
    outputFile: attemptOutputFile,
    task,
    role,
    applicationRoot,
    operationalArtifacts,
    now
  });
  validateSubmittedProductResult(result, task, role);
  const outputFile = result.status === "completed" ? canonicalOutputFile : attemptOutputFile;
  await writeExclusiveOrEqual(outputFile, result);
  return {
    result,
    inputFile: path.relative(absoluteRoot, inputFile).replaceAll("\\", "/"),
    outputFile: path.relative(absoluteRoot, outputFile).replaceAll("\\", "/")
  };
}

/** Validate a submitted result against the same contract as a provider run, without writing. */
export function validateSubmittedProductResult(result, task, role) {
  const errors = validatePublishedSchema("product-agent-run.schema.json", result);
  if (errors.length) throw new Error(`Product agent result is invalid:\n- ${errors.join("\n- ")}`);
  const mismatches = [];
  if (result.taskId !== task.task_id) mismatches.push("taskId");
  if (result.eventId !== task.event_id) mismatches.push("eventId");
  if (result.roleId !== role.id) mismatches.push("roleId");
  if (result.producerActorId !== role.actorId) mismatches.push("producerActorId");
  if (mismatches.length) throw new Error(`Product agent result mismatches dispatched ${mismatches.join(", ")}.`);
  if (result.decisionProposal) {
    if (!new Set(["RB-02", "RB-05"]).has(role.id)) {
      throw new Error("Only the product decision-brief or issue-lifecycle role may prepare a decisionProposal for the product owner.");
    }
    if (result.decisionProposal.recommendedOption
        && !result.decisionProposal.options.includes(result.decisionProposal.recommendedOption)) {
      throw new Error("decisionProposal.recommendedOption must be one of decisionProposal.options.");
    }
    const unknownImpactOptions = Object.keys(result.decisionProposal.optionImpacts ?? {})
      .filter((option) => !result.decisionProposal.options.includes(option));
    if (unknownImpactOptions.length > 0) {
      throw new Error(`decisionProposal.optionImpacts names options that were not offered: ${unknownImpactOptions.join(", ")}.`);
    }
  }
  assertNoCredentialMaterial("Product agent result", result);
}

/**
 * The brief a performer needs to carry out one product task, whatever performs it.
 *
 * It is written to a file for the record and returned to the coordinator, which hands it to whoever
 * performs the work. One definition means a team's boundary cannot mean one thing here and
 * something else wherever the work is actually done.
 */
export function buildProductAgentRequest(
  config,
  task,
  role,
  { intake, priorRuns = [], cycleHistory = [], cycleId, applicationRoot = null, operationalArtifacts = null } = {}
) {
  const ownedSheets = config.workbook.sheets.filter((sheet) => sheet.owner === role.id);
  return {
    schemaVersion: "1.0.0",
    cycleId,
    // Forward slashes even on Windows. This path is read by whoever performs the work — a subagent,
    // a shell, a tool call — and a backslash survives none of that reliably: it is an escape
    // character almost everywhere it lands, so `D:\Projects\app` arrives as `D:Projectsapp`. Node,
    // Git and PowerShell all accept the forward-slash form, and it cannot be silently eaten.
    linkedApplication: applicationRoot ? { root: toPosixPath(path.resolve(applicationRoot)) } : null,
    operationalArtifacts,
    project: config.project,
    task,
    role: {
      id: role.id,
      actorId: role.actorId,
      name: role.name,
      purpose: role.role,
      responsibilities: role.responsibilities,
      prohibitedActions: role.prohibitedActions
    },
    intake,
    cycleHistory: cycleHistory.slice(-3),
    priorRuns: priorRuns.map(compactPriorRun),
    // The return path validates against this exact schema. Giving performers only its filename made
    // ordinary nested fields guesswork, so valid observations bounced at submit time even though
    // the card had never shown the shape it required.
    resultContract: PRODUCT_AGENT_RESULT_CONTRACT,
    policy: {
      preserveHumanProductAuthority: true,
      noDirectRepositoryWrites: true,
      noProductionActions: true,
      noCredentialMaterial: true,
      evidenceBeforeClaims: true,
      qualificationThreshold: "Ask the owner only when the answer changes a material product choice, risk acceptance, irreversible action, sensitive access, or final acceptance. Read canonical state first; mechanical choices are not human questions.",
      discoveryStopRule: "Stop when remaining uncertainty cannot change the next decision or safe reversible action. Record the unknown and a trigger for reopening instead of forcing completeness.",
      smallestCompleteOutcome: "Produce only the smallest complete result inside this role and task. Do not expand adjacent scope or create speculative artifacts.",
      // A retrieval that failed is a fact about the attempt, not about the world. Recording "no
      // performance budget is documented" because one fetch returned an error puts a false absence
      // into the record, and every document downstream then reasons from a gap that was never
      // there — which is exactly what happened the first time a real product ran through this.
      retryBeforeRecordingAbsence: true
    },
    reporting: {
      proportionalDeliveryRule: "Match analysis and evidence depth to current impact. Low-risk reversible work should stay focused; cross-boundary work needs integration and rollback proof; sensitive, production, high-risk, or irreversible work receives specialist gates and human authority. Scope, truthfulness, credentials, evidence, and independence never weaken.",
      complexityRule: "Recommend new process, abstraction, dependency, service, store, queue, extension point, gate, or artifact only when a present requirement or observed risk needs it. Check for no-build, repository reuse, standard or native capability, and installed capability before proposing a local build. Name the simpler alternative considered, why it is insufficient now, the ongoing cost, and the removal or expansion trigger. Hypothetical future reuse is not evidence.",
      absenceRule: "A source you could not reach is not a source that says nothing. Retry a failed retrieval at least once before recording anything as absent, and if it still fails, record the failure — what you tried and what it returned — rather than the absence.",
      // This role's charter has always said it defines write boundaries. Until now there was no
      // field to put one in, so the delivery inherited the whole application policy — thirteen
      // directories for work that needed five.
      ...(role.id === "RB-06"
        ? { writeBoundaryRule: "Set writeBoundary.allowedPaths to the directories this delivery actually needs. It may only narrow what the application already allows, never widen it, and naming a path outside that policy is refused rather than ignored. Leaving it unset hands the whole policy to engineering." }
        : {}),
      ...(["RB-02", "RB-05"].includes(role.id)
        ? { decisionProposalRule: `${role.id === "RB-05" ? "When an issue is left at needs_decision" : "When the owner must choose a product direction"}, return decisionProposal with the exact question and mutually exclusive options they should see. Include optionImpacts for every option; if recommending one, include recommendationRationale. This role prepares the choice and never records the owner's decision.` }
        : {}),
      // Analysis that never reaches the record is analysis nobody can find later. A role that owns
      // a tab is the only role that can put rows in it, and its card is the moment to do so.
      ...(ownedSheets.length > 0
        ? {
            canonicalRecordRule: `This role owns ${ownedSheets.map((sheet) => sheet.key).join(", ")}. Put what you produced into canonicalRecords as rows on those tabs — one entry per row, with the tab's own key field in "key" and the rest in "fields". Writing a tab you do not own, a column that does not exist, a protected field, or an identifier that does not match the tab's pattern is refused, and the card does not complete.`,
            // The identifier pattern travels with the tab. Leaving it out meant a producer learned it
            // by having a finished record rejected, which spends a whole round trip teaching
            // something the brief already knew.
            ownedRecords: ownedSheets.map((sheet) => ({
              sheet: sheet.key,
              keyFields: canonicalRecordKeys(sheet.key),
              identifierPattern: RECORD_ID_PATTERNS[sheet.key]?.source ?? null,
              columns: sheet.columns,
              // The identifier pattern was carried here first and the closed vocabularies were not,
              // so a producer still learned a status value by having a finished record refused —
              // the same round trip, one field over. A refusal that names nothing acceptable is a
              // worse teacher than a brief that says the set up front.
              ...statusVocabulary(sheet.key)
            }))
          }
        : {})
    }
  };
}

/**
 * Perform a task with a result the caller already has.
 *
 * A coordinator whose subagent has done the work submits the result through `runProductAgent` with
 * this performer, so the submission passes the same schema validation, the same dispatch-identity
 * check, the same credential scan, and the same sealing as every other run. Delegating gains a
 * performer, not an exemption.
 */
export function submittedResultExecutor(result) {
  return async () => result;
}


async function writeExclusiveOrEqual(file, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fs.writeFile(file, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.readFile(file, "utf8");
    if (existing !== content) throw new Error(`Autopilot artifact already exists with different content: ${file}`);
  }
}

function compactPriorRun(run) {
  return {
    taskId: run.taskId,
    roleId: run.roleId,
    status: run.status,
    summary: run.summary,
    findings: run.findings.slice(0, 12),
    recommendations: run.recommendations.slice(0, 12),
    acceptanceCriteria: run.acceptanceCriteria.slice(0, 20),
    impacts: run.impacts,
    constraints: run.constraints.slice(0, 12),
    nonFunctionalRequirements: run.nonFunctionalRequirements.slice(0, 20),
    evidence: run.evidence.slice(0, 20),
    knownRisks: run.knownRisks.slice(0, 12)
  };
}

async function readCompletedResult(file, task, role) {
  let result;
  try {
    result = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Sealed product agent result is unreadable: ${file}: ${error.message}`);
  }
  if (result.status !== "completed") return null;
  const errors = validatePublishedSchema("product-agent-run.schema.json", result);
  if (errors.length) throw new Error(`Sealed product agent result is invalid:\n- ${errors.join("\n- ")}`);
  const matches = result.taskId === task.task_id && result.eventId === task.event_id &&
    result.roleId === role.id && result.producerActorId === role.actorId;
  if (!matches) throw new Error(`Sealed product agent result does not match dispatched task ${task.task_id}.`);
  assertNoCredentialMaterial("Sealed product agent result", result);
  return result;
}
