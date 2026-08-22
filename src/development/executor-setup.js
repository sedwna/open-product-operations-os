import fs from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { applyWrites, planWrites } from "../file-writer.js";
import { assertNoLinkTraversal, resolveInside } from "../paths.js";
import { assertNoCredentialMaterial } from "../runtime/security.js";
import { DEVELOPMENT_CONFIG_FILE } from "./catalog.js";
import { loadDevelopmentConfig, validateDevelopmentConfig } from "./config.js";

const WORKSTREAM_SCHEMA = "engineering/schemas/engineering-workstream-run.schema.json";
const CODEX_EXECUTABLE = "codex";
const CLAUDE_EXECUTABLE = "claude";
const DEFAULT_TIMEOUT_MS = 1_800_000;
const CODEX_SESSION_ENVIRONMENT = Object.freeze([
  "APPDATA", "CODEX_HOME", "HOME", "LOCALAPPDATA", "USERPROFILE"
]);
const CLAUDE_SESSION_ENVIRONMENT = Object.freeze([
  "APPDATA", "CLAUDE_CONFIG_DIR", "HOME", "LOCALAPPDATA", "USERPROFILE"
]);
const SAFE_ENVIRONMENT_NAMES = new Set([
  "CI", "LANG", "LC_ALL", "NO_COLOR", "TZ", ...CODEX_SESSION_ENVIRONMENT,
  ...CLAUDE_SESSION_ENVIRONMENT
]);

export const EXECUTOR_ISOLATION_WARNING =
  "external-required is a contract, not a host sandbox: run every executor in a dedicated container, VM, or isolated hosted worker; do not grant production credentials.";

export async function configureDevelopmentExecutors(
  root,
  {
    provider,
    role = "all",
    executable,
    arguments: commandArguments = [],
    workingDirectory = ".",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    enable = false,
    dryRun = true,
    resolveCommand = resolveExecutable
  } = {}
) {
  const absoluteRoot = path.resolve(root);
  const config = await loadDevelopmentConfig(absoluteRoot);
  const currentErrors = validateDevelopmentConfig(config);
  if (currentErrors.length) {
    throw new Error(`Development configuration is invalid:\n- ${currentErrors.join("\n- ")}`);
  }
  validateSetupOptions({ provider, role, executable, commandArguments, workingDirectory, timeoutMs });
  const selected = selectExecutors(config, role);

  for (const executor of selected) {
    const actorId = config.roles.find((candidate) => candidate.id === executor.roleId)?.actorId;
    const preset = provider === "codex"
      ? codexPreset(actorId, executor.roleId)
      : provider === "claude"
        ? claudePreset(actorId, executor.roleId)
        : commandPreset(executable, commandArguments);
    Object.assign(executor, {
      enabled: false,
      implementation: "command-runner",
      executable: preset.executable,
      arguments: preset.arguments,
      workingDirectory,
      timeoutMs: Number(timeoutMs),
      environmentAllowlist: preset.environmentAllowlist,
      isolation: "external-required"
    });
  }

  assertNoCredentialMaterial("Development executor configuration", config);
  const proposedErrors = validateDevelopmentConfig(config);
  if (proposedErrors.length) {
    throw new Error(`Proposed development configuration is invalid:\n- ${proposedErrors.join("\n- ")}`);
  }

  const doctor = await doctorDevelopmentExecutors(absoluteRoot, {
    role,
    config,
    resolveCommand
  });
  if (enable && !doctor.ok) {
    throw new Error(`Executor doctor failed; refusing activation:\n- ${doctor.errors.join("\n- ")}`);
  }
  if (enable) selected.forEach((executor) => { executor.enabled = true; });

  const operations = await planWrites(
    absoluteRoot,
    new Map([[DEVELOPMENT_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`]]),
    { force: true }
  );
  if (!dryRun) await applyWrites(absoluteRoot, operations);
  return {
    dryRun,
    provider,
    role,
    enabled: enable,
    selectedRoles: selected.map((executor) => executor.roleId),
    doctor,
    operations,
    warning: EXECUTOR_ISOLATION_WARNING
  };
}

export async function doctorDevelopmentExecutors(
  root,
  { role = "all", config: suppliedConfig, resolveCommand = resolveExecutable } = {}
) {
  const absoluteRoot = path.resolve(root);
  const config = suppliedConfig ?? await loadDevelopmentConfig(absoluteRoot);
  const errors = validateDevelopmentConfig(config).map((error) => `Configuration: ${error}`);
  const checks = [];
  let selected = [];
  try {
    selected = selectExecutors(config, role);
  } catch (error) {
    errors.push(error.message);
  }
  try {
    assertNoCredentialMaterial("Development executor configuration", config);
    checks.push("configuration contains no credential material");
  } catch (error) {
    errors.push(error.message);
  }

  for (const executor of selected) {
    const prefix = executor.roleId;
    if (executor.implementation !== "command-runner") {
      errors.push(`${prefix}: implementation must remain command-runner.`);
    }
    if (executor.isolation !== "external-required") {
      errors.push(`${prefix}: isolation must remain external-required.`);
    }
    const unsafeEnvironment = executor.environmentAllowlist.filter((name) => !SAFE_ENVIRONMENT_NAMES.has(name));
    if (unsafeEnvironment.length) {
      errors.push(`${prefix}: environment allowlist is not minimal (${unsafeEnvironment.join(", ")}).`);
    }
    if (!executor.executable?.trim()) {
      errors.push(`${prefix}: executable is not configured.`);
      continue;
    }
    if (isShellExecutable(executor.executable)) {
      errors.push(`${prefix}: shell interpreters are not accepted as executor commands.`);
      continue;
    }
    let workingDirectory;
    try {
      workingDirectory = resolveInside(absoluteRoot, executor.workingDirectory, `${prefix} working directory`);
      await assertNoLinkTraversal(absoluteRoot, workingDirectory, `${prefix} working directory`);
      const stat = await fs.stat(workingDirectory);
      if (!stat.isDirectory()) throw new Error(`${prefix}: working directory is not a directory.`);
      checks.push(`${prefix}: working directory is readable and contained`);
    } catch (error) {
      errors.push(`${prefix}: ${error.message}`);
      continue;
    }
    try {
      const resolved = await resolveCommand(executor.executable, { cwd: workingDirectory });
      checks.push(`${prefix}: executable resolved to ${resolved}`);
    } catch (error) {
      errors.push(`${prefix}: ${error.message}`);
    }
    if (!executor.arguments.some((argument) => argument.includes("{inputFile}"))) {
      errors.push(`${prefix}: arguments must pass {inputFile} to the executor.`);
    }
    if (looksLikeCodexPreset(executor)) {
      await checkCodexPreset(absoluteRoot, executor, errors, checks);
    }
    if (looksLikeClaudePreset(executor)) {
      await checkClaudePreset(absoluteRoot, executor, errors, checks);
    }
  }

  return {
    ok: errors.length === 0,
    role,
    checkedRoles: selected.map((executor) => executor.roleId),
    checks,
    errors,
    warnings: [EXECUTOR_ISOLATION_WARNING],
    readOnly: true
  };
}

function validateSetupOptions({ provider, role, executable, commandArguments, workingDirectory, timeoutMs }) {
  if (!["codex", "claude", "command"].includes(provider)) {
    throw new Error('Executor provider must be "codex", "claude", or "command".');
  }
  if (role !== "all" && !/^ENG-(?:0[1-9]|1[0-5])$/.test(role)) {
    throw new Error('Executor role must be "all" or a canonical role from ENG-01 through ENG-15.');
  }
  if (provider === "command" && (!executable || executable.trim() === "")) {
    throw new Error("The command provider requires --executable.");
  }
    if (provider === "command" && isShellExecutable(executable)) {
      throw new Error("The command provider cannot use a shell interpreter as its executable.");
    }
    if (provider === "command" && /\.(?:cmd|bat)$/i.test(executable)) {
      throw new Error("The command provider cannot use Windows batch executables; choose a native executable or a direct Node script.");
    }
  if (["codex", "claude"].includes(provider) && (executable !== undefined || commandArguments.length > 0)) {
    throw new Error(`The ${provider === "codex" ? "Codex" : "Claude"} provider owns its executable and arguments; do not pass command overrides.`);
  }
  if (!Array.isArray(commandArguments) || commandArguments.some((argument) => typeof argument !== "string")) {
    throw new Error("Executor arguments must be strings.");
  }
  if (provider === "command" && !commandArguments.some((argument) => argument.includes("{inputFile}"))) {
    throw new Error('The command provider requires at least one --argument containing "{inputFile}".');
  }
  if (typeof workingDirectory !== "string" || workingDirectory.trim() === "") {
    throw new Error("Executor working directory must be a non-empty project-relative path.");
  }
  const parsedTimeout = Number(timeoutMs);
  if (!Number.isInteger(parsedTimeout) || parsedTimeout < 1000 || parsedTimeout > 86_400_000) {
    throw new Error("Executor timeout must be an integer from 1000 through 86400000 milliseconds.");
  }
}

function selectExecutors(config, role) {
  if (role === "all") return config.executors;
  if (!/^ENG-(?:0[1-9]|1[0-5])$/.test(role)) {
    throw new Error('Executor role must be "all" or a canonical role from ENG-01 through ENG-15.');
  }
  const executor = config.executors.find((candidate) => candidate.roleId === role);
  if (!executor) throw new Error(`Unknown engineering role "${role}".`);
  return [executor];
}

function codexPreset(actorId, roleId) {
  if (!actorId) throw new Error("The selected Codex executor role has no producer actor.");
  const verifier = roleId === "ENG-15";
  const prompt = [
    "Read the JSON workstream input at {inputFile}.",
    "Implement only the assigned workstream in the current repository and obey its writeBoundary and policy.",
    "Run relevant verification and return only one JSON object conforming to engineering-workstream-run.schema.json.",
    `Set producerActorId exactly to ${JSON.stringify(actorId)}; copy planId, workstreamId, and ownerRole from the input.`,
    "Report only commands and evidence you actually produced.",
    "Do not create or switch Git branches and do not create commits; the orchestrator owns Git history.",
    verifier
      ? "Copy input.verificationBinding.workspaceDigest exactly to implementationRevision and include git-head:<input.verificationBinding.headRevision> in evidence; these bind the read-only verdict to both workspace bytes and Git HEAD."
      : "Set implementationRevision to pending; the orchestrator seals it to the verified content digest after all workstreams finish.",
    verifier ? "Act as an independent read-only verifier: do not edit files, reproduce relevant checks, inspect tracked and untracked implementation files, and return blocked or failed if material claims are not supported. On Windows, run Node test files with node --test tests\\*.test.js rather than passing the tests directory." : "Make only changes that are necessary for the assigned engineering boundary.",
    "Do not deploy to production, use production credentials, or perform destructive database operations."
  ].join(" ");
  return {
    executable: CODEX_EXECUTABLE,
    environmentAllowlist: [...CODEX_SESSION_ENVIRONMENT],
    arguments: [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--sandbox",
      verifier ? "read-only" : "workspace-write",
      "--output-schema",
      `{projectRoot}/${WORKSTREAM_SCHEMA}`,
      "--output-last-message",
      "{rawOutputFile}",
      prompt
    ]
  };
}

function claudePreset(actorId, roleId) {
  if (!actorId) throw new Error("The selected Claude executor role has no producer actor.");
  const verifier = roleId === "ENG-15";
  const prompt = [
    "Read the JSON workstream input at {inputFile}.",
    "Implement only the assigned workstream in the current repository and obey its writeBoundary and policy.",
    "Return a result conforming to engineering-workstream-run.schema.json.",
    `Set producerActorId exactly to ${JSON.stringify(actorId)}; copy planId, workstreamId, and ownerRole from the input.`,
    "Report only commands and evidence you actually produced.",
    "Do not create or switch Git branches and do not create commits; the orchestrator owns Git history.",
    verifier
      ? "Copy input.verificationBinding.workspaceDigest exactly to implementationRevision and include git-head:<input.verificationBinding.headRevision> in evidence; these bind the read-only verdict to both workspace bytes and Git HEAD."
      : "Set implementationRevision to pending; the orchestrator seals it to the verified content digest after all workstreams finish.",
    verifier ? "Act as an independent read-only verifier: do not edit files, reproduce relevant checks, inspect tracked and untracked implementation files, and return blocked or failed if material claims are not supported. On Windows, run Node test files with node --test tests\\*.test.js rather than passing the tests directory." : "Make only changes that are necessary for the assigned engineering boundary.",
    "Do not deploy to production, use production credentials, or perform destructive database operations."
  ].join(" ");
  return {
    executable: CLAUDE_EXECUTABLE,
    environmentAllowlist: [...CLAUDE_SESSION_ENVIRONMENT],
    arguments: [
      "--bare",
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      "{providerSchemaJson}",
      "--no-session-persistence",
      "--permission-mode",
      verifier ? "dontAsk" : "acceptEdits",
      "--tools",
      verifier ? "Read,Glob,Grep,Bash" : "Read,Glob,Grep,Edit,Write,Bash",
      "--allowedTools",
      verifier
        ? "Read,Glob,Grep,Bash(git status *),Bash(git diff *),Bash(node --test *),Bash(npm test *),Bash(npm run *)"
        : "Read,Glob,Grep,Edit,Write,Bash"
    ]
  };
}

function commandPreset(executable, commandArguments) {
  return { executable, arguments: [...commandArguments], environmentAllowlist: [] };
}

function isShellExecutable(executable = "") {
  const name = path.basename(executable).toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "");
  return new Set(["bash", "cmd", "cscript", "dash", "fish", "ksh", "powershell", "pwsh", "sh", "wscript", "zsh"]).has(name);
}

function looksLikeCodexPreset(executor) {
  const executable = path.basename(executor.executable).toLowerCase();
  return ["codex", "codex.exe", "codex.cmd"].includes(executable)
    && executor.arguments[0] === "exec";
}

function looksLikeClaudePreset(executor) {
  const executable = path.basename(executor.executable).toLowerCase();
  return ["claude", "claude.exe", "claude.cmd"].includes(executable)
    && executor.arguments.includes("--json-schema");
}

async function checkCodexPreset(root, executor, errors, checks) {
  const expectedSandbox = executor.roleId === "ENG-15" ? "read-only" : "workspace-write";
  const expectedPrefix = ["exec", "--ephemeral", "--ignore-user-config", "--sandbox", expectedSandbox, "--output-schema"];
  if (!expectedPrefix.every((value, index) => executor.arguments[index] === value)) {
    errors.push(`${executor.roleId}: Codex preset must use the role-appropriate Codex sandbox and output schema.`);
    return;
  }
  if (executor.arguments[6] !== `{projectRoot}/${WORKSTREAM_SCHEMA}`) {
    errors.push(`${executor.roleId}: Codex output schema must reference the packaged engineering workstream schema.`);
  }
  if (executor.arguments[7] !== "--output-last-message" || executor.arguments[8] !== "{rawOutputFile}") {
    errors.push(`${executor.roleId}: Codex preset must persist the final structured result separately from progress output.`);
  }
  const prompt = executor.arguments[9] ?? "";
  if (!prompt.includes("{inputFile}") || !prompt.includes("engineering-workstream-run.schema.json")) {
    errors.push(`${executor.roleId}: Codex prompt must read {inputFile} and require the engineering workstream result contract.`);
  }
  try {
    const schemaPath = resolveInside(root, WORKSTREAM_SCHEMA, `${executor.roleId} output schema`);
    await assertNoLinkTraversal(root, schemaPath, `${executor.roleId} output schema`);
    const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
    if (schema.title !== "Engineering Workstream Run") {
      throw new Error("unexpected schema title");
    }
    checks.push(`${executor.roleId}: Codex output schema is readable`);
  } catch (error) {
    errors.push(`${executor.roleId}: Codex output schema is unavailable or invalid (${error.message}).`);
  }
}

async function checkClaudePreset(root, executor, errors, checks) {
  const verifier = executor.roleId === "ENG-15";
  const expectedMode = verifier ? "dontAsk" : "acceptEdits";
  const required = ["--bare", "-p", "--output-format", "json", "--json-schema", "{providerSchemaJson}", "--no-session-persistence", "--permission-mode", expectedMode];
  if (!required.every((value) => executor.arguments.includes(value))) {
    errors.push(`${executor.roleId}: Claude preset must use bare non-persistent print mode, structured output, and the role-appropriate permission mode.`);
  }
  const prompt = executor.arguments[executor.arguments.indexOf("-p") + 1] ?? "";
  if (!prompt.includes("{inputFile}") || !prompt.includes("engineering-workstream-run.schema.json")) {
    errors.push(`${executor.roleId}: Claude prompt must read {inputFile} and require the engineering workstream result contract.`);
  }
  const allowedTools = executor.arguments[executor.arguments.indexOf("--allowedTools") + 1] ?? "";
  if (verifier && /\b(?:Edit|Write)\b/.test(allowedTools)) {
    errors.push(`${executor.roleId}: Claude verifier must not receive editing tools.`);
  }
  try {
    const schemaPath = resolveInside(root, WORKSTREAM_SCHEMA, `${executor.roleId} output schema`);
    await assertNoLinkTraversal(root, schemaPath, `${executor.roleId} output schema`);
    const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
    if (schema.title !== "Engineering Workstream Run") throw new Error("unexpected schema title");
    checks.push(`${executor.roleId}: Claude structured-output schema is readable`);
  } catch (error) {
    errors.push(`${executor.roleId}: Claude structured-output schema is unavailable or invalid (${error.message}).`);
  }
}

export async function resolveExecutable(executable, { cwd = process.cwd(), environment = process.env } = {}) {
  const candidates = executableCandidates(executable, cwd, environment);
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue searching without executing the candidate.
    }
  }
  throw new Error(`executable "${executable}" was not found without invoking it.`);
}

function executableCandidates(executable, cwd, environment) {
  const extensions = process.platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const withExtensions = (base) => {
    if (path.extname(base) || extensions.length === 1 && extensions[0] === "") return [base];
    const nativeCandidates = [...extensions.map((extension) => `${base}${extension.toLowerCase()}`), ...extensions.map((extension) => `${base}${extension.toUpperCase()}`)];
    return process.platform === "win32" ? [...nativeCandidates, base] : [base, ...nativeCandidates];
  };
  if (path.isAbsolute(executable)) return withExtensions(executable);
  if (executable.includes("/") || executable.includes("\\")) {
    return withExtensions(path.resolve(cwd, executable));
  }
  const searchPath = environment.PATH ?? environment.Path ?? "";
  return searchPath.split(path.delimiter).filter(Boolean).flatMap((directory) => withExtensions(path.join(directory, executable)));
}
