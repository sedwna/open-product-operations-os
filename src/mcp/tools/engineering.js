import fs from "node:fs/promises";
import path from "node:path";
import { runEngineeringWorkstream, submittedWorkstreamResult } from "../../development/runner.js";
import { loadDevelopmentConfig } from "../../development/config.js";
import { readAutomationLink } from "../../autopilot/state.js";
import { describeTeam } from "../app/teams.js";
import { ToolFailure } from "../authority.js";
import { untrusted } from "../untrusted.js";

/**
 * The engineering half of host-delegated execution.
 *
 * The product half was inverted first: the host asks for work, delegates it to a subagent, and
 * returns the result. Engineering was left on the older model, where a configured CLI is spawned to
 * do the work — so a product could be driven all the way to an approved delivery contract and then
 * stop, because no executable was installed. Two halves of one system running on two execution
 * models, and the half that mattered depended on exactly the provider machinery the other half had
 * retired.
 *
 * These are the mirror of `next_work` and `submit_work`, pointed at the linked application. The
 * boundary between the two repositories is unchanged: it was never the executor, it is the hashed
 * contract, and that still governs what crosses.
 */

export async function nextEngineeringWork(context) {
  const application = await linkedApplication(context.root);
  const { plan, planId } = await findActivePlan(application);
  if (!plan) {
    return {
      structuredContent: { available: false, reason: "no_plan" },
      text: "No engineering plan exists yet. A plan appears once an approved delivery contract is exported across the boundary; until then engineering has nothing to carry."
    };
  }

  const completed = await completedWorkstreams(application, planId);
  const ready = plan.workstreams.filter((workstream) =>
    !completed.has(workstream.id)
    && (workstream.dependencies ?? []).every((dependency) => completed.has(dependency)));

  if (ready.length === 0) {
    const remaining = plan.workstreams.filter((workstream) => !completed.has(workstream.id));
    return {
      structuredContent: {
        available: false,
        reason: remaining.length === 0 ? "all_complete" : "awaiting_dependencies",
        planId,
        remaining: remaining.length
      },
      text: remaining.length === 0
        ? `Every workstream in ${planId} is complete. The sealed result returns to the product side for quality, verification and readiness.`
        : `${remaining.length} workstream(s) remain in ${planId}, each waiting on one that has not finished. Nothing is ready to hand out.`
    };
  }

  // Independent verification goes last on purpose: ENG-15 reproduces the others' claims, and there
  // is nothing to reproduce until they have made them.
  const workstream = ready.find((candidate) => candidate.ownerRole !== "ENG-15") ?? ready[0];
  const preview = await runEngineeringWorkstream(application, planId, workstream.id, {
    dryRun: true,
    execute: submittedWorkstreamResult(null)
  });
  const config = await loadDevelopmentConfig(application);
  const team = describeTeam(workstream.ownerRole, "engineering");

  return {
    structuredContent: {
      available: true,
      claimToken: context.claimToken({
        task_id: workstream.id,
        event_id: planId,
        owner_role: workstream.ownerRole,
        status: workstream.status ?? "ready"
      }),
      applicationRoot: application,
      planId,
      workstreamId: workstream.id,
      team: team.name,
      teamFocus: team.focus,
      ownerRole: workstream.ownerRole,
      producerActorId: config.roles.find((role) => role.id === workstream.ownerRole)?.actorId ?? null,
      title: untrusted(workstream.title, { source: "engineering-plan", id: workstream.id }),
      writeBoundary: preview.payload.writeBoundary,
      policy: preview.payload.policy,
      brief: preview.payload
    },
    text: [
      `Next engineering work: ${workstream.id} — ${team.name}, in ${application}.`,
      `That team's job is ${team.focus}.`,
      "",
      "Delegate this to a subagent working in the application repository. It may write only inside the contract's writeBoundary; the prohibited paths in the policy are refused outright, and the engineering operating model's own files are never application code.",
      workstream.ownerRole === "ENG-15"
        ? "This is independent verification: reproduce the material claims and change nothing. The repository is hashed before and after, and any modification voids the verification."
        : "Only ENG-15 issues a verification disposition; set yours to not_applicable.",
      "Return the result through product_ops_submit_engineering_work with this claimToken."
    ].join("\n")
  };
}

export async function submitEngineeringWork(context, args = {}) {
  if (args.apply === true && context.allowWrites !== true) {
    throw new ToolFailure("APPLY_NOT_AUTHORIZED", "This server was started without write authorisation.");
  }
  const application = await linkedApplication(context.root);
  const { plan, planId } = await findActivePlan(application);
  if (!plan) throw new ToolFailure("NOT_FOUND", "No engineering plan exists to submit against.");

  const workstream = plan.workstreams.find((candidate) => candidate.id === args.workstreamId);
  if (!workstream) throw new ToolFailure("NOT_FOUND", `No workstream ${args.workstreamId} in ${planId}.`);

  if (!context.verifyClaimToken({
    task_id: workstream.id,
    event_id: planId,
    owner_role: workstream.ownerRole,
    status: workstream.status ?? "ready"
  }, args.claimToken)) {
    throw new ToolFailure("CLAIM_INVALID", "That claim token does not match this workstream. Take the work with product_ops_next_engineering_work and submit against what it hands out.");
  }

  const team = describeTeam(workstream.ownerRole, "engineering");
  if (args.apply !== true) {
    return {
      structuredContent: { applied: false, planId, workstreamId: workstream.id, team: team.name, status: args.result?.status ?? null },
      text: `Planned: would record a ${args.result?.status ?? "?"} result for ${workstream.id} as ${team.name}. Nothing was written; call again with apply true to record it.`
    };
  }

  let recorded;
  try {
    recorded = await runEngineeringWorkstream(application, planId, workstream.id, {
      dryRun: false,
      execute: submittedWorkstreamResult(args.result)
    });
  } catch (error) {
    throw new ToolFailure("RESULT_REJECTED", `The submitted engineering result was refused: ${error.message}`);
  }

  return {
    structuredContent: {
      applied: true,
      planId,
      workstreamId: workstream.id,
      team: team.name,
      ownerRole: workstream.ownerRole,
      status: recorded.result.status,
      verificationDisposition: recorded.result.verificationDisposition,
      resultFile: recorded.resultFile,
      sealed: recorded.result.status === "completed"
    },
    text: recorded.result.status === "completed"
      ? `Recorded and sealed ${workstream.id} for ${team.name}. Call product_ops_next_engineering_work for the next one.`
      : `Recorded a ${recorded.result.status} result for ${workstream.id} (${team.name}). It is not sealed, so the work can be attempted again.`
  };
}

async function linkedApplication(root) {
  let link;
  try {
    link = await readAutomationLink(root);
  } catch (error) {
    throw new ToolFailure("NO_LINKED_APPLICATION", `This workspace has no usable application repository: ${error.message}`);
  }
  if (!link?.applicationRoot) {
    throw new ToolFailure("NO_LINKED_APPLICATION", "This workspace has no linked application, so there is no engineering side to carry work.");
  }
  return path.resolve(link.applicationRoot);
}

/** The most recent plan on disk. One request is in flight at a time by design. */
async function findActivePlan(application) {
  const directory = path.join(application, ".development-os", "plans");
  let entries;
  try {
    entries = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return { plan: null, planId: null };
    throw error;
  }
  if (entries.length === 0) return { plan: null, planId: null };
  const planId = entries.at(-1).replace(/\.json$/, "");
  const plan = JSON.parse(await fs.readFile(path.join(directory, entries.at(-1)), "utf8"));
  return { plan, planId };
}

/** A workstream counts as complete only when its sealed result says so. */
async function completedWorkstreams(application, planId) {
  const directory = path.join(application, ".development-os", "runs");
  const done = new Set();
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return done;
    throw error;
  }
  for (const name of entries) {
    if (!name.startsWith(`${planId}-`) || !name.endsWith("-result.json") || name.includes("-attempt-")) continue;
    try {
      const result = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
      if (result.status === "completed" && result.workstreamId) done.add(result.workstreamId);
    } catch {
      // An unreadable or half-written run is not evidence of completion.
    }
  }
  return done;
}
