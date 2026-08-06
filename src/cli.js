#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { generateWorkbookCommand } from "./commands/generate-workbook.js";
import { initCommand } from "./commands/init.js";
import { linkCommand } from "./commands/link.js";
import { validateCommand } from "./commands/validate.js";
import {
  approvalsCommand,
  configureCommand,
  dashboardCommand,
  decideCommand,
  developmentCommand,
  developmentExportCommand,
  developmentImportCommand,
  intakeCommand,
  metricsCommand,
  migrateCommand,
  coordinatorCommand,
  operateCommand,
  providerQueueCommand,
  providerSyncCommand,
  setupCommand
} from "./commands/runtime.js";

const HELP = `Product Operations OS CLI

Usage:
  product-ops init <target> [--dry-run] [--force]
  product-ops validate <target>
  product-ops link <target> --application <path> [--provider <codex|claude>] [--apply]
  product-ops generate-workbook <target> [--dry-run] [--force]
  product-ops operate <target> [--apply] [--execute-development]
  product-ops coordinator <target> [--apply]
  product-ops development <target> --task <task-id> [--apply]
  product-ops development-export <target> --task <task-id> --file <request-json> [--apply]
  product-ops development-import <target> --file <result-json> [--apply]
  product-ops intake <target> --file <json-file> [--apply]
  product-ops approvals <target>
  product-ops decide <target> --request <id> --decision <approved|rejected> --actor <id> [--apply]
  product-ops provider-queue <target> --file <json-file> [--apply]
  product-ops provider-sync <target> --provider <name> [--apply]
  product-ops dashboard <target> [--output <file>] [--apply]
  product-ops dashboard <target> --serve [--port <number>] [--apply]
  product-ops metrics <target> [--output <file>] [--apply]
  product-ops setup <target> [--output <file>] [--apply]
  product-ops configure <target> --answers <json-file> [--apply]
  product-ops migrate <target> [--apply]

Commands:
  init               Create a project config and generated operating artifacts.
  validate           Check config, ownership, routing, tasks, files, and secrets.
  link               Point this workspace at the application repository it operates.
  generate-workbook  Generate CSV workbook templates from the project config.
  operate            Plan or execute one control-plane scheduling cycle.
  coordinator        Run the autonomous coordinator until stopped.
  development        Dispatch one eligible RB-13 task to a configured command agent.
  development-export Export an approved, versioned Product-to-Development contract.
  development-import Import an independently verified Development-to-Product result.
  intake             Normalize and deduplicate an idea, finding, incident, or request.
  approvals          List durable human approval requests.
  decide             Record an attributed human approval or rejection.
  provider-queue     Queue a bounded external-provider operation.
  provider-sync      Plan or apply queued provider operations.
  dashboard          Generate or serve the local interactive right-to-left dashboard.
  metrics            Export operational metrics.
  setup              Generate the local configuration wizard.
  configure          Apply a validated wizard answer file.
  migrate            Plan or apply operating-model migrations.

Options:
  --dry-run  Report planned writes without changing files.
  --force    Refresh replaceable scaffold; preserve operational CSV rows.
  --apply    Apply a runtime action; runtime commands default to dry-run.
  -h, --help Show this help.
`;

export async function run(argv, io = console) {
  try {
    const { command, target, options, help } = parseArguments(argv);

    if (help) {
      io.log(HELP);
      return 0;
    }

    let lines;
    if (command === "init") {
      lines = await initCommand(target, options);
    } else if (command === "validate") {
      if (options.dryRun || options.force) {
        throw new Error("validate does not accept --dry-run or --force.");
      }
      lines = await validateCommand(target);
    } else if (command === "link") {
      lines = await linkCommand(target, options);
    } else if (command === "generate-workbook") {
      lines = await generateWorkbookCommand(target, options);
    } else if (command === "operate") {
      lines = await operateCommand(target, options);
    } else if (command === "coordinator") {
      lines = await coordinatorCommand(target, options, io);
    } else if (command === "development") {
      lines = await developmentCommand(target, options);
    } else if (command === "development-export") {
      lines = await developmentExportCommand(target, options);
    } else if (command === "development-import") {
      lines = await developmentImportCommand(target, options);
    } else if (command === "intake") {
      lines = await intakeCommand(target, options);
    } else if (command === "approvals") {
      lines = await approvalsCommand(target, options);
    } else if (command === "decide") {
      lines = await decideCommand(target, options);
    } else if (command === "provider-queue") {
      lines = await providerQueueCommand(target, options);
    } else if (command === "provider-sync") {
      lines = await providerSyncCommand(target, options);
    } else if (command === "dashboard") {
      lines = await dashboardCommand(target, options);
    } else if (command === "metrics") {
      lines = await metricsCommand(target, options);
    } else if (command === "setup") {
      lines = await setupCommand(target, options);
    } else if (command === "configure") {
      lines = await configureCommand(target, options);
    } else if (command === "migrate") {
      lines = await migrateCommand(target, options);
    } else {
      throw new Error(`Unknown command "${command}".`);
    }

    for (const line of lines) {
      io.log(line);
    }
    return 0;
  } catch (error) {
    io.error(error.message);
    return 1;
  }
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }

  const options = {};
  const providedOptions = new Set();
  const positional = [];
  const flags = new Set(["--dry-run", "--force", "--apply", "--execute-development", "--serve"]);
  const values = new Set(["--task", "--file", "--request", "--decision", "--actor", "--rationale", "--provider", "--output", "--answers", "--port", "--application"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flags.has(argument)) {
      const name = toOptionName(argument);
      options[name] = true;
      providedOptions.add(name);
    } else if (values.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Option "${argument}" requires a value.`);
      const name = toOptionName(argument);
      options[name] = value;
      providedOptions.add(name);
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option "${argument}".`);
    } else {
      positional.push(argument);
    }
  }
  options.dryRun ??= false;
  options.force ??= false;
  options.apply ??= false;
  options.executeDevelopment ??= false;
  options.serve ??= false;
  if (options.apply && options.dryRun) throw new Error("--apply and --dry-run cannot be used together.");
  if (positional.length !== 2) {
    throw new Error("Expected a command and target. Use --help for usage.");
  }
  validateCommandOptions(positional[0], providedOptions);

  return {
    command: positional[0],
    target: positional[1],
    options,
    help: false
  };
}

function toOptionName(argument) {
  return argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function validateCommandOptions(command, provided) {
  const runtime = ["dryRun", "apply"];
  const allowed = {
    init: ["dryRun", "force"],
    validate: [],
    link: ["apply", "application", "provider"],
    "generate-workbook": ["dryRun", "force"],
    operate: [...runtime, "executeDevelopment"],
    coordinator: runtime,
    development: [...runtime, "task"],
    "development-export": [...runtime, "task", "file"],
    "development-import": [...runtime, "file"],
    intake: [...runtime, "file"],
    approvals: [],
    decide: [...runtime, "request", "decision", "actor", "rationale"],
    "provider-queue": [...runtime, "file"],
    "provider-sync": [...runtime, "provider"],
    dashboard: [...runtime, "output", "serve", "port"],
    metrics: [...runtime, "output"],
    setup: [...runtime, "output"],
    configure: [...runtime, "answers"],
    migrate: runtime
  }[command];
  if (!allowed) return;
  const rejected = [...provided].find((name) => !allowed.includes(name));
  if (rejected) throw new Error(`Command "${command}" does not accept --${rejected.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.`);
}

async function isEntryPoint() {
  if (!process.argv[1]) {
    return false;
  }

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
  process.exitCode = await run(process.argv.slice(2));
}
