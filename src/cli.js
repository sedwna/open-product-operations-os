#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { generateWorkbookCommand } from "./commands/generate-workbook.js";
import { initCommand } from "./commands/init.js";
import { initSuiteCommand, validateSuiteCommand } from "./commands/init-suite.js";
import { linkCommand } from "./commands/link.js";
import { validateCommand } from "./commands/validate.js";
import {
  approvalsCommand,
  configureCommand,
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
  providerSyncCommand
} from "./commands/runtime.js";

const HELP = `Product Operations OS CLI

Usage:
  product-ops init-suite <target> [--dry-run] [--force] [--no-git] [--provider <codex|claude>]
  product-ops validate-suite <target>
  product-ops init <target> [--dry-run] [--force] [--no-git]
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
  product-ops decide <target> --request <id> --decision <approved|rejected> --actor <id> [--rationale <text> | --rationale-file <utf8-file>] [--apply]
  product-ops provider-queue <target> --file <json-file> [--apply]
  product-ops provider-sync <target> --provider <name> [--apply]
  product-ops metrics <target> [--output <file>] [--apply]
  product-ops configure <target> --answers <json-file> [--apply]
  product-ops migrate <target> [--apply]

Commands:
  init-suite         Create the standard GitHub repository with product/ and development/ roots.
  validate-suite     Validate both operating systems and their internal contract link.
  init               Create only a Product Operations workspace (legacy/advanced use).
  validate           Check config, ownership, routing, tasks, files, and secrets.
  link               Point a Product root at the Development root it operates.
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
  metrics            Export operational metrics.
  configure          Apply a validated wizard answer file.
  migrate            Plan or apply operating-model migrations.

Options:
  --dry-run  Report planned writes without changing files.
  --force    Refresh replaceable scaffold; preserve operational CSV rows.
  --apply    Apply a runtime action; runtime commands default to dry-run.
  --no-git   Do not start a Git history. Exporting to engineering then has no revision to stamp.
  --rationale-file  Read the owner's reasoning from a UTF-8 file instead of an argument. Use this
                    for any non-ASCII text: a console whose code page is not UTF-8 mangles it on
                    the way in, and the record then keeps a corrupted version of what they said.
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
    if (command === "init-suite") {
      lines = await initSuiteCommand(target, options);
    } else if (command === "validate-suite") {
      lines = await validateSuiteCommand(target);
    } else if (command === "init") {
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
    } else if (command === "metrics") {
      lines = await metricsCommand(target, options);
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
  const flags = new Set(["--dry-run", "--force", "--apply", "--execute-development", "--no-git"]);
  const values = new Set(["--task", "--file", "--request", "--decision", "--actor", "--rationale", "--provider", "--output", "--answers", "--application", "--rationale-file"]);
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
    "init-suite": ["dryRun", "force", "noGit", "provider"],
    "validate-suite": [],
    init: ["dryRun", "force", "noGit"],
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
    decide: [...runtime, "request", "decision", "actor", "rationale", "rationaleFile"],
    "provider-queue": [...runtime, "file"],
    "provider-sync": [...runtime, "provider"],
    metrics: [...runtime, "output"],
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
