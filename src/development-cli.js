#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeDevelopmentOs } from "./development/init.js";
import { planDevelopmentRequest } from "./development/planner.js";
import { completeDevelopmentResult } from "./development/result.js";
import { validateDevelopmentOs } from "./development/validation.js";
import { runEngineeringWorkstream } from "./development/runner.js";
import { buildDevelopmentDashboard } from "./development/dashboard.js";

const HELP = `Open Development Operations OS CLI

Usage:
  development-os init <target> [--dry-run] [--force]
  development-os validate <target>
  development-os plan <target> --request <json-file> [--apply]
  development-os complete <target> --result <json-file> [--apply]
  development-os execute <target> --plan <plan-id> --workstream <workstream-id> [--apply]
  development-os dashboard <target> [--output <html-file>] [--apply]
  development-os status <target>

Commands:
  init      Create the independent engineering operating model in an application repository.
  validate  Validate governance, roles, gates, contracts, digests, evidence boundaries, and secrets.
  plan      Import one product-approved request and create a multi-discipline engineering plan.
  complete  Validate an independently verified engineering result and prepare it for Product Operations.
  execute   Dispatch one dependency-ready workstream through its disabled-by-default specialist executor.
  dashboard Generate a local Persian RTL engineering control-tower snapshot.
  status    Report synchronized request, plan, result, and receipt counts.

Safety:
  plan and complete are dry-run by default. Add --apply only after reviewing the exact contract.
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
  if (parsed.command === "dashboard") {
    const result = await buildDevelopmentDashboard(target, { dryRun: !parsed.apply, output: parsed.output });
    io.log(`${result.dryRun ? "Planned" : "Generated"} engineering dashboard at ${result.output} (${result.bytes} bytes).`);
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
  const result = { command: null, target: null, help: false, dryRun: false, force: false, apply: false, provided: new Set() };
  const values = [...argv];
  while (values.length) {
    const value = values.shift();
    if (["-h", "--help"].includes(value)) { result.help = true; continue; }
    if (value === "--dry-run") { result.dryRun = true; result.provided.add("dryRun"); continue; }
    if (value === "--force") { result.force = true; result.provided.add("force"); continue; }
    if (value === "--apply") { result.apply = true; result.provided.add("apply"); continue; }
    if (["--request", "--result", "--plan", "--workstream", "--output"].includes(value)) {
      const key = value.slice(2);
      const next = values.shift();
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value.`);
      result[key] = next;
      result.provided.add(key);
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
    dashboard: ["output", "apply"],
    status: []
  }[parsed.command];
  if (!allowed) return;
  const rejected = [...parsed.provided].find((name) => !allowed.includes(name));
  if (rejected) throw new Error(`Command "${parsed.command}" does not accept --${rejected.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.`);
}

const executed = path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url));
if (executed) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
