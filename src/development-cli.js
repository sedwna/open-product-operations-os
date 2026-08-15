#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { initializeDevelopmentOs } from "./development/init.js";
import { planDevelopmentRequest } from "./development/planner.js";
import { completeDevelopmentResult } from "./development/result.js";
import { validateDevelopmentOs } from "./development/validation.js";
import { runEngineeringWorkstream } from "./development/runner.js";
import { configureDevelopmentExecutors, doctorDevelopmentExecutors } from "./development/executor-setup.js";
import { recordEngineeringEvidenceAmendment } from "./development/amendment.js";

const HELP = `Open Development Operations OS CLI

Usage:
  development-os init <target> [--dry-run] [--force]
  development-os validate <target>
  development-os plan <target> --request <json-file> [--apply]
  development-os complete <target> --result <json-file> [--apply]
  development-os execute <target> --plan <plan-id> --workstream <workstream-id> [--apply]
  development-os amend <target> --amendment <json-file> [--apply]
  development-os executor-setup <target> --provider <codex|claude|command> --role <ENG-01|all> [options] [--enable] [--apply]
  development-os executor-doctor <target> [--role <ENG-01|all>]
  development-os status <target>

Commands:
  init      Create the independent engineering operating model in an application repository.
  validate  Validate governance, roles, gates, contracts, digests, evidence boundaries, and secrets.
  plan      Import one product-approved request and create a multi-discipline engineering plan.
  complete  Validate an independently verified engineering result and prepare it for Product Operations.
  execute   Dispatch one dependency-ready workstream through its disabled-by-default specialist executor.
  amend     Append a digest-guarded correction to immutable engineering evidence; ENG-15 must verify it.
  executor-setup  Safely configure disabled-by-default Codex or command executors; activation requires --enable and a passing doctor.
  executor-doctor Read-only executor, schema, path, environment, and isolation diagnostics.
  status    Report synchronized request, plan, result, and receipt counts.

Safety:
  plan and complete are dry-run by default. Add --apply only after reviewing the exact contract.
  executor-setup is dry-run by default. --enable never activates an executor unless doctor passes.
  External isolation is still required: use a dedicated container, VM, or isolated hosted worker.
  Product authority and engineering authority remain separate and synchronize through versioned contracts.
`;

export async function main(argv = process.argv.slice(2), io = console) {
  const parsed = parse(argv);
  if (parsed.help) { io.log(HELP); return 0; }
  if (!parsed.command || !parsed.target) throw new Error("A command and target are required. Use --help for usage.");
  validateOptions(parsed);
  const target = path.resolve(parsed.target);
  if (parsed.command === "init") {
    const result = await initializeDevelopmentOs(target, { dryRun: parsed.dryRun, force: parsed.force });
    result.lines.forEach((line) => io.log(line));
    return 0;
  }
  if (parsed.command === "validate") {
    const result = await validateDevelopmentOs(target);
    if (result.errors.length) throw new Error(`Development OS validation failed:\n- ${result.errors.join("\n- ")}`);
    io.log(`Development OS validation passed for ${target}.`);
    io.log(`Checked ${result.checkedFiles} managed file(s).`);
    result.warnings.forEach((warning) => io.log(`Warning: ${warning}`));
    return 0;
  }
  if (parsed.command === "plan") {
    if (!parsed.request) throw new Error("plan requires --request <json-file>.");
    const result = await planDevelopmentRequest(target, path.resolve(parsed.request), { dryRun: !parsed.apply });
    io.log(`${result.dryRun ? "Planned" : "Stored"} ${result.plan.planId} for ${result.request.requestId}.`);
    io.log(`Risk: ${result.plan.riskClass}; workstreams: ${result.plan.workstreams.length}; gates: ${result.plan.qualityGates.length}.`);
    io.log(`Source digest: ${result.digest}.`);
    return 0;
  }
  if (parsed.command === "complete") {
    if (!parsed.result) throw new Error("complete requires --result <json-file>.");
    const result = await completeDevelopmentResult(target, path.resolve(parsed.result), { dryRun: !parsed.apply });
    io.log(`${result.dryRun ? "Validated" : "Stored"} ${result.result.resultId} for Product Operations synchronization.`);
    io.log(`Result digest: ${result.digest}.`);
    return 0;
  }
  if (parsed.command === "execute") {
    if (!parsed.plan || !parsed.workstream) throw new Error("execute requires --plan <plan-id> and --workstream <workstream-id>.");
    const result = await runEngineeringWorkstream(target, parsed.plan, parsed.workstream, { dryRun: !parsed.apply });
    io.log(`${result.dryRun ? "Planned" : "Completed"} specialist run ${result.runId}.`);
    io.log(`Input: ${result.inputFile}; result: ${result.resultFile}.`);
    return 0;
  }
  if (parsed.command === "amend") {
    if (!parsed.amendment) throw new Error("amend requires --amendment <json-file>.");
    const input = JSON.parse(await fs.readFile(path.resolve(parsed.amendment), "utf8"));
    const result = await recordEngineeringEvidenceAmendment(target, input, { dryRun: !parsed.apply });
    io.log(`${result.dryRun ? "Planned" : "Stored"} ${result.amendment.amendmentId} for ${result.amendment.workstreamId}.`);
    io.log(`Target digest: ${result.amendment.target.artifactSha256}; verification: ENG-15 required.`);
    return 0;
  }
  if (parsed.command === "executor-setup") {
    if (!parsed.provider) throw new Error("executor-setup requires --provider <codex|claude|command>.");
    if (!parsed.role) throw new Error("executor-setup requires --role <ENG-01|all>.");
    const result = await configureDevelopmentExecutors(target, {
      provider: parsed.provider,
      role: parsed.role ?? "all",
      executable: parsed.executable,
      arguments: parsed.arguments ?? [],
      workingDirectory: parsed.workingDirectory ?? ".",
      timeoutMs: parsed.timeoutMs ?? 1800000,
      enable: parsed.enable,
      dryRun: parsed.dryRun || !parsed.apply
    });
    io.log(`${result.dryRun ? "Planned" : "Stored"} ${result.provider} executor configuration for ${result.selectedRoles.join(", ")}.`);
    io.log(`Executors will be ${result.enabled ? "enabled after passing doctor" : "configured but disabled"}.`);
    result.doctor.errors.forEach((error) => io.log(`Doctor error: ${error}`));
    io.log(`Warning: ${result.warning}`);
    return 0;
  }
  if (parsed.command === "executor-doctor") {
    const result = await doctorDevelopmentExecutors(target, { role: parsed.role ?? "all" });
    result.checks.forEach((check) => io.log(`Pass: ${check}`));
    result.warnings.forEach((warning) => io.log(`Warning: ${warning}`));
    if (!result.ok) throw new Error(`Executor doctor failed:\n- ${result.errors.join("\n- ")}`);
    io.log(`Executor doctor passed for ${result.checkedRoles.join(", ")}; no files were changed.`);
    return 0;
  }
  if (parsed.command === "status") {
    const result = await validateDevelopmentOs(target);
    if (result.errors.length) throw new Error(`Development OS validation failed:\n- ${result.errors.join("\n- ")}`);
    io.log(`Requests: ${result.contractCounts.requests}; plans: ${result.contractCounts.plans}; specialist runs: ${result.contractCounts.runs}; results: ${result.contractCounts.results}; receipts: ${result.contractCounts.receipts}.`);
    return 0;
  }
  throw new Error(`Unknown development command "${parsed.command}".`);
}

function parse(argv) {
  const result = { command: null, target: null, help: false, dryRun: false, force: false, apply: false, enable: false, arguments: [], provided: new Set() };
  const values = [...argv];
  while (values.length) {
    const value = values.shift();
    if (["-h", "--help"].includes(value)) { result.help = true; continue; }
    if (value === "--dry-run") { result.dryRun = true; result.provided.add("dryRun"); continue; }
    if (value === "--force") { result.force = true; result.provided.add("force"); continue; }
    if (value === "--apply") { result.apply = true; result.provided.add("apply"); continue; }
    if (value === "--enable") { result.enable = true; result.provided.add("enable"); continue; }
    if (value.startsWith("--argument=")) {
      const argument = value.slice("--argument=".length);
      if (!argument) throw new Error("--argument requires a value.");
      result.arguments.push(argument);
      result.provided.add("arguments");
      continue;
    }
    if (["--request", "--result", "--plan", "--workstream", "--amendment", "--output", "--provider", "--role", "--executable", "--argument", "--working-directory", "--timeout-ms"].includes(value)) {
      const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const next = values.shift();
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value.`);
      if (key === "argument") result.arguments.push(next);
      else result[key] = next;
      result.provided.add(key === "argument" ? "arguments" : key);
      continue;
    }
    if (value.startsWith("--")) throw new Error(`Unknown option "${value}".`);
    if (!result.command) result.command = value;
    else if (!result.target) result.target = value;
    else throw new Error(`Unexpected argument "${value}".`);
  }
  return result;
}

function validateOptions(parsed) {
  if (parsed.apply && parsed.dryRun) throw new Error("--apply and --dry-run cannot be used together.");
  const allowed = {
    init: ["dryRun", "force"],
    validate: [],
    plan: ["request", "apply"],
    complete: ["result", "apply"],
    execute: ["plan", "workstream", "apply"],
    amend: ["amendment", "apply"],
    "executor-setup": ["provider", "role", "executable", "arguments", "workingDirectory", "timeoutMs", "enable", "apply", "dryRun"],
    "executor-doctor": ["role"],
    status: []
  }[parsed.command];
  if (!allowed) return;
  const rejected = [...parsed.provided].find((name) => !allowed.includes(name));
  if (rejected) throw new Error(`Command "${parsed.command}" does not accept --${rejected.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.`);
}

async function isEntryPoint() {
  if (!process.argv[1]) return false;
  const invokedPath = path.resolve(process.argv[1]);
  const modulePath = path.resolve(fileURLToPath(import.meta.url));
  try {
    const [invokedRealPath, moduleRealPath] = await Promise.all([
      fs.realpath(invokedPath),
      fs.realpath(modulePath)
    ]);
    return invokedRealPath === moduleRealPath;
  } catch {
    return invokedPath === modulePath;
  }
}

if (await isEntryPoint()) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
