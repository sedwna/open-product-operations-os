import path from "node:path";
import { surveyApplication } from "../../adoption/survey.js";
import { readAutomationLink } from "../../autopilot/state.js";
import { describeTeam } from "../app/teams.js";
import { ToolFailure } from "../authority.js";
import { untrusted } from "../untrusted.js";

/**
 * Adopting a repository that already exists.
 *
 * Two things have to stay apart here. Surveying is mechanical and happens now: what is in the
 * repository, what could not be read and why, and which boundary owns reading what. Interpreting is
 * product work and happens through the teams, one bounded brief at a time.
 *
 * Collapsing them would put a machine's guess about what a product is into the same records that
 * hold what its owner decided, and nothing downstream could tell the two apart again.
 *
 * The surface takes no path argument, for the same reason no tool here does: an application root
 * that came from record text could send the survey anywhere on the filesystem. The linked
 * application is the only repository this can read.
 */
export async function adopt(context) {
  const link = await linkedApplication(context.root);
  if (!link) {
    throw new ToolFailure(
      "NO_LINKED_APPLICATION",
      "This workspace has no linked application, so there is no existing repository to adopt. Link one with `development-os init` and an automation link first, or start from an idea instead."
    );
  }

  let survey;
  try {
    survey = await surveyApplication(link);
  } catch (error) {
    throw new ToolFailure("SURVEY_FAILED", `The application repository could not be surveyed: ${error.message}`);
  }

  const teams = survey.assignments.map((assignment) => {
    const team = describeTeam(assignment.roleId, "product");
    return {
      roleId: assignment.roleId,
      team: team.name,
      question: assignment.question,
      pathCount: assignment.pathCount,
      truncated: assignment.truncated === true
    };
  });

  const structuredContent = {
    applicationRoot: survey.applicationRoot,
    revision: survey.revision,
    coverage: survey.coverage,
    stacks: survey.stacks.map((stack) => ({
      ecosystem: stack.ecosystem,
      manifest: stack.manifest,
      name: untrusted(stack.name, { source: "application-manifest", id: stack.manifest }),
      declaredDependencies: stack.declaredDependencies
    })),
    languages: survey.languages,
    counts: {
      entryPoints: survey.entryPoints.length,
      documentation: survey.documentation.length,
      tests: survey.tests.length,
      configuration: survey.configuration.length,
      markers: survey.signals.markers.length
    },
    history: survey.signals.history,
    churn: survey.signals.churn.slice(0, 10),
    teams,
    survey
  };

  return { structuredContent, text: narrate(survey, teams) };
}

function narrate(survey, teams) {
  const lines = [];
  const { coverage } = survey;

  lines.push(
    coverage.complete
      ? `Surveyed the linked application: ${coverage.totalPaths} paths, all accounted for — ${coverage.examinedPaths} to read and ${coverage.excludedPaths} excluded.`
      : `Surveyed the linked application, but the account does not add up: ${coverage.examinedPaths} to read and ${coverage.excludedPaths} excluded of ${coverage.totalPaths} found${coverage.truncated ? ", and the walk hit its path ceiling" : ""}. Do not describe this repository as fully adopted.`
  );

  const exclusions = Object.entries(coverage.exclusionsByReason).sort((left, right) => right[1] - left[1]);
  if (exclusions.length > 0) {
    lines.push(`Excluded: ${exclusions.map(([reason, count]) => `${reason.replaceAll("_", " ")} ×${count}`).join(", ")}.`);
  }
  if (survey.stacks.length > 0) {
    lines.push(`Stacks: ${[...new Set(survey.stacks.map((stack) => stack.ecosystem))].join(", ")}.`);
  }
  if (survey.signals.history) {
    lines.push(`History: ${survey.signals.history.commits} commits from ${survey.signals.history.contributors} contributor(s), last on ${survey.signals.history.lastCommitAt ?? "an unknown date"}.`);
  }
  if (survey.signals.markers.length > 0) {
    lines.push(`${survey.signals.markers.length} in-code marker(s) of unfinished work were located. They are recorded verbatim and interpreted by nobody yet.`);
  }

  lines.push("");
  lines.push("Every path to be read is assigned to a boundary. Work through them with product_ops_next_work — none of this is adopted until the team that owns it has read it:");
  for (const entry of teams) {
    lines.push(`  · ${entry.team} — ${entry.pathCount} path(s)${entry.truncated ? " (more than are listed; the boundary still owns all of them)" : ""}`);
  }

  lines.push("");
  lines.push("What each team returns is an observation carrying its source, not an accepted product claim. Nothing here becomes what the product *is* until the owner accepts it through a decision.");
  return lines.join("\n");
}

async function linkedApplication(root) {
  try {
    const link = await readAutomationLink(root);
    const applicationRoot = link?.applicationRoot;
    return typeof applicationRoot === "string" && applicationRoot.length > 0 ? path.resolve(applicationRoot) : null;
  } catch {
    return null;
  }
}
