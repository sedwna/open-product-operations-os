#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateWorkbookCommand } from "./commands/generate-workbook.js";
import { initCommand } from "./commands/init.js";
import { validateCommand } from "./commands/validate.js";

const HELP = `Product Operations OS CLI

Usage:
  product-ops init <target> [--dry-run] [--force]
  product-ops validate <target>
  product-ops generate-workbook <target> [--dry-run] [--force]

Commands:
  init               Create a project config and generated operating artifacts.
  validate           Check config, ownership, routing, tasks, files, and secrets.
  generate-workbook  Generate CSV workbook templates from the project config.

Options:
  --dry-run  Report planned writes without changing files.
  --force    Refresh replaceable scaffold; preserve operational CSV rows.
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
    } else if (command === "generate-workbook") {
      lines = await generateWorkbookCommand(target, options);
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

  const options = {
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force")
  };
  const positional = argv.filter(
    (argument) => !["--dry-run", "--force"].includes(argument)
  );
  const unknownOptions = positional.filter((argument) => argument.startsWith("-"));

  if (unknownOptions.length > 0) {
    throw new Error(`Unknown option "${unknownOptions[0]}".`);
  }
  if (positional.length !== 2) {
    throw new Error("Expected a command and target. Use --help for usage.");
  }

  return {
    command: positional[0],
    target: positional[1],
    options,
    help: false
  };
}

const isEntryPoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  process.exitCode = await run(process.argv.slice(2));
}
