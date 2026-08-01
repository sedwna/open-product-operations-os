import fs from "node:fs/promises";
import { queueProviderItem, syncProvider } from "../adapters/provider-sync.js";
import { loadConfig, validateConfig, validateConfigRelationships } from "../config.js";
import { decideApproval, loadApprovals } from "../runtime/approvals.js";
import { configureProject } from "../runtime/configure.js";
import { runControlTower } from "../runtime/control-tower.js";
import { buildDashboard, exportMetrics } from "../runtime/dashboard.js";
import { runDevelopmentTask } from "../runtime/development-runner.js";
import { ingestRecord } from "../runtime/intake.js";
import { migrateProject } from "../runtime/migrations.js";
import { buildSetupWizard } from "../runtime/setup-wizard.js";

export async function operateCommand(target, options) {
  const config = await validatedConfig(target);
  const receipt = await runControlTower(target, config, {
    dryRun: runtimeDryRun(options),
    executeDevelopment: options.executeDevelopment
  });
  return [
    `${receipt.dryRun ? "Planned" : "Executed"} control-plane run ${receipt.runId}.`,
    `Actions: ${receipt.actions.length}.`,
    ...receipt.actions.map((action) => `  ${action.type}: ${action.taskId ?? action.intakeId ?? "n/a"}`)
  ];
}

export async function developmentCommand(target, options) {
  if (!options.task) throw new Error("development requires --task <task-id>.");
  const config = await validatedConfig(target);
  const result = await runDevelopmentTask(target, config, options.task, { dryRun: runtimeDryRun(options) });
  return [
    `${result.dryRun ? "Planned" : "Completed"} development execution for ${options.task}.`,
    `Input: ${result.inputFile}.`,
    `Result: ${result.resultFile}.`
  ];
}

export async function intakeCommand(target, options) {
  if (!options.file) throw new Error("intake requires --file <json-file>.");
  const input = JSON.parse(await fs.readFile(options.file, "utf8"));
  const result = await ingestRecord(target, input, { dryRun: runtimeDryRun(options) });
  return [
    `${result.dryRun ? "Planned" : "Recorded"} intake ${result.record.intakeId}.`,
    `Event: ${result.record.eventId}.`,
    `Disposition: ${result.record.status}.`
  ];
}

export async function approvalsCommand(target) {
  const store = await loadApprovals(target);
  return [
    `Approval requests: ${store.requests.length}.`,
    ...store.requests.map((request) => `  ${request.requestId}: ${request.status} (${request.taskId} / ${request.gate})`)
  ];
}

export async function decideCommand(target, options) {
  for (const key of ["request", "decision", "actor"]) {
    if (!options[key]) throw new Error(`decide requires --${key} <value>.`);
  }
  const config = await validatedConfig(target);
  const result = await decideApproval(target, config, {
    requestId: options.request,
    decision: options.decision,
    actorId: options.actor,
    rationale: options.rationale ?? ""
  }, { dryRun: runtimeDryRun(options) });
  return [`${result.dryRun ? "Planned" : "Recorded"} ${result.request.status} disposition for ${result.request.requestId}.`];
}

export async function providerQueueCommand(target, options) {
  if (!options.file) throw new Error("provider-queue requires --file <json-file>.");
  const item = JSON.parse(await fs.readFile(options.file, "utf8"));
  const result = await queueProviderItem(target, item, { dryRun: runtimeDryRun(options) });
  return [`${result.dryRun ? "Planned" : "Queued"} provider item ${result.item.id} for ${result.item.provider}.`];
}

export async function providerSyncCommand(target, options) {
  if (!options.provider) throw new Error("provider-sync requires --provider <name>.");
  const result = await syncProvider(target, options.provider, { dryRun: runtimeDryRun(options) });
  return [
    `${result.dryRun ? "Planned" : "Completed"} provider sync for ${options.provider}.`,
    `Requests: ${(result.plannedRequests ?? result.receipts).length}.`
  ];
}

export async function dashboardCommand(target, options) {
  const result = await buildDashboard(target, { dryRun: runtimeDryRun(options), output: options.output });
  return [`${result.dryRun ? "Planned" : "Generated"} dashboard at ${result.output} (${result.bytes} bytes).`];
}

export async function metricsCommand(target, options) {
  const result = await exportMetrics(target, { dryRun: runtimeDryRun(options), output: options.output });
  return [
    `${result.dryRun ? "Planned" : "Exported"} metrics at ${result.output}.`,
    `Tasks: ${result.metrics.totals.tasks}; completed: ${result.metrics.totals.completed}; blocked: ${result.metrics.totals.blocked}.`
  ];
}

export async function setupCommand(target, options) {
  const result = await buildSetupWizard(target, { dryRun: runtimeDryRun(options), output: options.output });
  return [`${result.dryRun ? "Planned" : "Generated"} setup wizard at ${result.output} (${result.bytes} bytes).`];
}

export async function configureCommand(target, options) {
  if (!options.answers) throw new Error("configure requires --answers <json-file>.");
  const config = await validatedConfig(target);
  const result = await configureProject(target, config, options.answers, { dryRun: runtimeDryRun(options) });
  return [`${result.dryRun ? "Planned" : "Applied"} project configuration with ${result.operations.length} scaffold operation(s).`];
}

export async function migrateCommand(target, options) {
  const config = await loadConfig(target);
  const result = await migrateProject(target, config, { dryRun: runtimeDryRun(options) });
  return [
    `${result.dryRun ? "Planned" : "Applied"} migration ${result.fromVersion} -> ${result.toVersion}.`,
    `Changes: ${result.changes.length === 0 ? "none" : result.changes.join(", ")}.`
  ];
}

async function validatedConfig(target) {
  const config = await loadConfig(target);
  const schemaErrors = validateConfig(config);
  const errors = [...schemaErrors, ...(schemaErrors.length === 0 ? validateConfigRelationships(config) : [])];
  if (errors.length > 0) throw new Error(`Project configuration is invalid:\n- ${errors.join("\n- ")}`);
  return config;
}

function runtimeDryRun(options) {
  return options.apply !== true;
}
