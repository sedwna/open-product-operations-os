#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startOnboardingServer } from "../src/onboarding/server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const noOpen = process.argv.includes("--no-open");
const checkOnly = process.argv.includes("--check");

try {
  const onboarding = await startOnboardingServer(repoRoot, { openBrowser: !noOpen && !checkOnly });
  process.stdout.write(`Open Product Operations OS onboarding: ${onboarding.url}\n`);
  if (checkOnly) {
    await onboarding.close();
    process.stdout.write("One-click onboarding dependency and server check passed.\n");
    process.exitCode = 0;
  } else {
    process.stdout.write("Keep this process running until the dashboard opens.\n");
  }
} catch (error) {
  process.stderr.write(`Onboarding failed safely: ${error.message}\n`);
  process.exitCode = 1;
}
