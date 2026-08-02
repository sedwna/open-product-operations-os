import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertNoCredentialMaterial } from "../runtime/security.js";
import { validatePublishedSchema } from "../schema-validation.js";
import { captureCodexCommand, inspectCodexReadiness } from "../codex/readiness.js";
import { configureDevelopmentExecutors } from "../development/executor-setup.js";
import { initializeDevelopmentOs as initializeDevelopmentSystem } from "../development/init.js";
import { validateDevelopmentOs } from "../development/validation.js";
import { assertNoLinkTraversal } from "../paths.js";

const FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const ALLOWED_ENVIRONMENTS = new Set(["local", "test", "staging", "production"]);
const ALLOWED_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const APPLICATION_RESUME_MARKER = ".product-ops-onboarding.json";
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export const ONBOARDING_STEPS = Object.freeze([
  { id: "dependencies", label: "آماده‌سازی موتور" },
  { id: "codex", label: "بررسی موتور هوشمند کدکس" },
  { id: "operations", label: "ساخت فضای عملیات محصول" },
  { id: "configuration", label: "ثبت مشخصات محصول" },
  { id: "application", label: "آماده‌سازی مخزن کد" },
  { id: "development", label: "ساخت سامانهٔ عملیات توسعه" },
  { id: "idea", label: "ثبت ایدهٔ نخست" },
  { id: "cycle", label: "اجرای چرخهٔ نخست" },
  { id: "git", label: "راه‌اندازی تاریخچهٔ گیت" },
  { id: "validation", label: "اعتبارسنجی نهایی" }
]);

export function normalizeOnboardingRequest(input, { repoRoot } = {}) {
  if (!repoRoot) throw new Error("Onboarding requires the repository root.");
  const productName = boundedText(input.productName, "نام محصول", 2, 100);
  const vision = boundedText(input.vision, "چشم‌انداز", 10, 1200);
  const targetUsers = normalizeList(input.targetUsers, "کاربران هدف", 1, 12);
  const environments = normalizeList(input.environments, "محیط‌ها", 1, 4);
  if (environments.some((value) => !ALLOWED_ENVIRONMENTS.has(value))) {
    throw new Error("محیط انتخاب‌شده معتبر نیست.");
  }
  const humanAuthorityActorId = boundedText(
    input.humanAuthorityActorId || "human-product-owner",
    "شناسهٔ مالک انسانی",
    2,
    80
  );
  const workspaceParent = path.resolve(
    boundedText(input.workspaceParent || path.dirname(repoRoot), "مسیر فضای کاری", 1, 500)
  );
  if (workspaceParent === path.parse(workspaceParent).root) {
    throw new Error("فضای کاری نمی‌تواند ریشهٔ دیسک باشد.");
  }
  const operationsFolder = safeFolder(input.operationsFolder, "پوشهٔ عملیات محصول");
  const appMode = ["create", "existing", "skip"].includes(input.appMode)
    ? input.appMode
    : "create";
  const applicationFolder = appMode === "create"
    ? safeFolder(input.applicationFolder, "پوشهٔ کد محصول")
    : "";
  const existingApplicationPath = appMode === "existing"
    ? path.resolve(boundedText(input.existingApplicationPath, "مسیر کد موجود", 1, 500))
    : "";
  const operationsPath = childPath(workspaceParent, operationsFolder);
  const applicationPath = appMode === "create"
    ? childPath(workspaceParent, applicationFolder)
    : existingApplicationPath || null;
  if (applicationPath && samePath(operationsPath, applicationPath)) {
    throw new Error("پوشهٔ عملیات و پوشهٔ کد محصول باید از هم جدا باشند.");
  }
  const initializeDevelopmentOs = appMode === "create"
    || (appMode === "existing" && input.initializeDevelopmentOs === true);
  const automationMode = input.automationMode === "codex" ? "codex" : "manual";

  const ideaEnabled = Boolean(input.ideaEnabled && String(input.ideaTitle || "").trim());
  const priority = ALLOWED_PRIORITIES.has(input.ideaPriority) ? input.ideaPriority : "P2";
  const idea = ideaEnabled
    ? {
        type: "new_idea",
        title: boundedText(input.ideaTitle, "عنوان ایده", 3, 180),
        description: boundedText(input.ideaDescription, "شرح ایده", 10, 2400),
        source: boundedText(input.ideaSource || "راه‌اندازی یک‌کلیکی محلی", "منبع ایده", 2, 200),
        priority,
        autopilotAuthorized: automationMode === "codex"
      }
    : null;

  const normalized = {
    productName,
    vision,
    targetUsers,
    environments,
    humanAuthorityActorId,
    workspaceParent,
    operationsFolder,
    operationsPath,
    appMode,
    applicationFolder,
    applicationPath,
    initializeDevelopmentOs,
    automationMode,
    installCodexCli: automationMode === "codex" && input.installCodexCli !== false,
    authenticateCodex: automationMode === "codex" && input.authenticateCodex !== false,
    idea,
    installDependencies: input.installDependencies !== false,
    initializeGit: input.initializeGit !== false,
    createInitialCommit: input.createInitialCommit !== false,
    gitName: optionalText(input.gitName, 120),
    gitEmail: optionalText(input.gitEmail, 200),
    writableDashboard: Boolean(input.writableDashboard)
  };
  assertNoCredentialMaterial("Onboarding answers", normalized);
  return normalized;
}

export async function inspectOnboardingEnvironment(repoRoot) {
  const [gitVersion, gitName, gitEmail, codex] = await Promise.all([
    captureOptional("git", ["--version"]),
    captureOptional("git", ["config", "--global", "user.name"]),
    captureOptional("git", ["config", "--global", "user.email"]),
    inspectCodexReadiness({ cwd: repoRoot })
  ]);
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    repoRoot,
    suggestedWorkspaceParent: path.dirname(repoRoot),
    gitAvailable: Boolean(gitVersion),
    gitVersion,
    gitName,
    gitEmail,
    codex
  };
}

export async function runOnboarding(request, {
  repoRoot,
  onProgress = () => {},
  skipDependencyInstall = false,
  inspectCodex = inspectCodexReadiness,
  executeCodex = captureCodexCommand,
  configureExecutors = configureDevelopmentExecutors
} = {}) {
  const answers = normalizeOnboardingRequest(request, { repoRoot });
  await fs.mkdir(answers.workspaceParent, { recursive: true });
  await assertNoLinkTraversal(
    answers.workspaceParent,
    answers.operationsPath,
    "Product Operations destination"
  );
  await assertSafeDestination(answers.operationsPath, "فضای عملیات محصول", "product-ops.config.json");
  let applicationIdentity = null;
  if (answers.appMode === "create") {
    await assertNoLinkTraversal(
      answers.workspaceParent,
      answers.applicationPath,
      "Application destination"
    );
    const resumable = await assertSafeDestination(
      answers.applicationPath,
      "پوشهٔ کد محصول",
      APPLICATION_RESUME_MARKER
    );
    await fs.mkdir(answers.applicationPath, { recursive: true });
    if (resumable) {
      await validateApplicationResumeMarker(answers.applicationPath);
    } else {
      await writeIfMissing(
        path.join(answers.applicationPath, APPLICATION_RESUME_MARKER),
        `${JSON.stringify({
          schemaVersion: "1.0.0",
          createdBy: "open-product-operations-os",
          sessionId: crypto.randomUUID(),
          expectedPath: path.resolve(answers.applicationPath)
        }, null, 2)}\n`
      );
    }
    applicationIdentity = await captureDirectoryIdentity(answers.applicationPath);
  } else if (answers.appMode === "existing") {
    const stat = await fs.lstat(answers.applicationPath).catch(() => null);
    if (!stat?.isDirectory()) throw new Error("پوشهٔ کد موجود پیدا نشد.");
    if (stat.isSymbolicLink()) throw new Error("پوشهٔ کد موجود نمی‌تواند پیوند نمادین باشد.");
    applicationIdentity = await captureDirectoryIdentity(answers.applicationPath);
  }

  const report = {
    schemaVersion: "1.0.0",
    startedAt: new Date().toISOString(),
    operationsPath: answers.operationsPath,
    applicationPath: answers.applicationPath,
    ideaRecorded: false,
    initialCycleApplied: false,
    development: {
      requested: answers.initializeDevelopmentOs,
      initialized: false,
      validated: false,
      status: answers.appMode === "skip" ? "skipped-no-application" : "pending",
      executorsConfigured: false,
      executorsEnabled: false
    },
    automation: {
      mode: answers.automationMode,
      provider: answers.automationMode === "codex" ? "codex" : null,
      status: answers.automationMode === "codex" ? "checking" : "manual",
      codex: null,
      continuousOrchestrator: false
    },
    git: { operations: "skipped", application: "skipped" }
  };

  let codexReadiness = null;

  await step(onProgress, "dependencies", async (log) => {
    if (skipDependencyInstall || !answers.installDependencies) {
      log("نصب وابستگی‌ها از تنظیمات این اجرا عبور داده شد.");
      return;
    }
    log("در حال نصب دقیق وابستگی‌های قفل‌شده…");
    await runNpm(["ci"], { cwd: repoRoot, onLine: log });
  });

  await step(onProgress, "operations", async (log) => {
    const configPath = path.join(answers.operationsPath, "product-ops.config.json");
    if (await exists(configPath)) {
      log("فضای عملیات موجود است؛ ادامهٔ ایمن انجام می‌شود.");
      return;
    }
    await runCli(repoRoot, ["init", answers.operationsPath, "--dry-run"], log);
    await runCli(repoRoot, ["init", answers.operationsPath], log);
  });

  await step(onProgress, "configuration", async (log) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "product-ops-onboarding-"));
    try {
      const answersFile = path.join(temporary, "answers.json");
      await fs.writeFile(answersFile, `${JSON.stringify({
        name: answers.productName,
        vision: answers.vision,
        targetUsers: answers.targetUsers,
        environments: answers.environments,
        humanAuthorityActorId: answers.humanAuthorityActorId
      }, null, 2)}\n`, "utf8");
      await runCli(repoRoot, ["configure", answers.operationsPath, "--answers", answersFile], log);
      await runCli(repoRoot, ["configure", answers.operationsPath, "--answers", answersFile, "--apply"], log);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });

  await step(onProgress, "application", async (log) => {
    if (answers.appMode === "skip") {
      log("ساخت مخزن کد برای بعد نگه داشته شد.");
      return;
    }
    await assertDirectoryIdentity(answers.applicationPath, applicationIdentity);
    if (answers.appMode === "existing") {
      log(`مخزن کد موجود انتخاب شد: ${answers.applicationPath}`);
      return;
    }
    await fs.mkdir(answers.applicationPath, { recursive: true });
    await writeIfMissing(
      path.join(answers.applicationPath, "README.md"),
      `# ${answers.productName}\n\nApplication source for ${answers.productName}.\n`
    );
    await writeIfMissing(
      path.join(answers.applicationPath, ".gitignore"),
      "node_modules/\n.env\n.env.*\n!.env.example\ndist/\nbuild/\ncoverage/\n.DS_Store\n"
        + `${APPLICATION_RESUME_MARKER}\n`
    );
    log("پوشهٔ کد محصول با فایل‌های پایه ساخته شد.");
  });

  await step(onProgress, "codex", async (log) => {
    if (answers.automationMode !== "codex") {
      report.automation.status = "manual";
      log("ساخت خودکار انتخاب نشده است؛ اتصال کدکس تغییری نمی‌کند.");
      return;
    }
    codexReadiness = await inspectCodex({ cwd: repoRoot });
    log(codexReadiness.message);
    if (!codexReadiness.executableUsable && answers.installCodexCli) {
      log("در حال نصب رسمی ابزار خط فرمان کدکس از بستهٔ منتشرشدهٔ اوپن‌ای‌آی…");
      await runNpm(["install", "--global", "@openai/codex"], { cwd: repoRoot, onLine: log });
      codexReadiness = await inspectCodex({ cwd: repoRoot });
      log(codexReadiness.message);
    }
    if (codexReadiness.status === "login-required" && answers.authenticateCodex) {
      log("مرورگر برای ورود امن به کدکس باز می‌شود؛ اطلاعات ورود در پروژه ذخیره نخواهد شد.");
      const login = await executeCodex(codexReadiness.executable, ["login"], {
        cwd: repoRoot,
        timeoutMs: 10 * 60 * 1000
      });
      if (!login.ok) throw new Error(`ورود کدکس کامل نشد: ${login.error || login.stderr || "وضعیت نامشخص"}`);
      codexReadiness = await inspectCodex({ cwd: repoRoot });
      log(codexReadiness.message);
    }
    report.automation.codex = publicCodexReadiness(codexReadiness);
    if (!codexReadiness.canAutomate) {
      throw new Error(`حالت ساخت خودکار بدون کدکس آماده شروع نمی‌شود: ${codexReadiness.message}`);
    }
    report.automation.status = "provider-ready";
    log("ورود معتبر تأیید شد. نوع اشتراک از خط فرمان قابل خواندن نیست و دسترسی عملی هنگام نخستین اجرای واقعی سنجیده می‌شود.");
  });

  await step(onProgress, "development", async (log) => {
    if (!answers.applicationPath) {
      report.development.status = "skipped-no-application";
      log("راه‌اندازی سامانهٔ توسعه تا زمان معرفی مخزن کد به تعویق افتاد.");
      return;
    }
    if (!answers.initializeDevelopmentOs) {
      report.development.status = "skipped-existing-application";
      log("مخزن کد موجود بدون درخواست صریح برای راه‌اندازی سامانهٔ توسعه دست‌نخورده ماند.");
      return;
    }
    await assertDirectoryIdentity(answers.applicationPath, applicationIdentity);
    const preview = await initializeDevelopmentSystem(answers.applicationPath, { dryRun: true });
    preview.lines.forEach(log);
    const initialized = await initializeDevelopmentSystem(answers.applicationPath, { dryRun: false });
    initialized.lines.forEach(log);
    report.development.initialized = true;
    const validation = await validateDevelopmentOs(answers.applicationPath);
    if (validation.errors.length > 0) {
      throw new Error(`اعتبارسنجی سامانهٔ توسعه ناموفق بود: ${validation.errors.join("؛ ")}`);
    }
    validation.warnings.forEach((warning) => log(`هشدار سامانهٔ توسعه: ${warning}`));
    report.development.validated = true;
    report.development.status = "ready";
    log(`سامانهٔ عملیات توسعه با ${validation.checkedFiles} فایل مدیریت‌شده آماده و معتبر است.`);
    if (answers.automationMode === "codex") {
      const configured = await configureExecutors(answers.applicationPath, {
        provider: "codex",
        role: "all",
        enable: true,
        dryRun: false,
        resolveCommand: async () => codexReadiness.executable
      });
      report.development.executorsConfigured = true;
      report.development.executorsEnabled = configured.enabled;
      report.automation.status = "executors-ready";
      log(`${configured.selectedRoles.length} نقش مهندسی به اجراگر کدکس متصل و فعال شدند.`);
    }
  });

  await step(onProgress, "idea", async (log) => {
    if (!answers.idea) {
      log("ایدهٔ نخست برای بعد نگه داشته شد.");
      return;
    }
    const intakeDirectory = path.join(answers.operationsPath, "product-intake");
    await fs.mkdir(intakeDirectory, { recursive: true });
    const ideaFile = path.join(intakeDirectory, "first-idea.json");
    await writeIfMissing(ideaFile, `${JSON.stringify(answers.idea, null, 2)}\n`);
    await runCli(repoRoot, ["intake", answers.operationsPath, "--file", ideaFile], log);
    await runCli(repoRoot, ["intake", answers.operationsPath, "--file", ideaFile, "--apply"], log);
    report.ideaRecorded = true;
  });

  await step(onProgress, "cycle", async (log) => {
    if (!answers.idea) {
      log("چرخهٔ نخست پس از ثبت اولین ایده اجرا خواهد شد.");
      return;
    }
    await runCli(repoRoot, ["operate", answers.operationsPath], log);
    await runCli(repoRoot, ["operate", answers.operationsPath, "--apply"], log);
    report.initialCycleApplied = true;
  });

  if (answers.operationsPath) {
    const automationDirectory = path.join(answers.operationsPath, ".product-ops", "runtime", "automation");
    const automationStatus = buildAutomationStatus(report);
    const automationErrors = validatePublishedSchema("automation-status.schema.json", automationStatus);
    if (automationErrors.length > 0) {
      throw new Error(`وضعیت خودکارسازی معتبر نیست: ${automationErrors.join("؛ ")}`);
    }
    await fs.mkdir(automationDirectory, { recursive: true });
    await fs.writeFile(
      path.join(automationDirectory, "status.json"),
      `${JSON.stringify(automationStatus, null, 2)}\n`,
      "utf8"
    );
    if (answers.automationMode === "codex" && answers.applicationPath && report.development.executorsEnabled) {
      const link = {
        schemaVersion: "1.0.0",
        applicationRelativePath: path.relative(answers.operationsPath, answers.applicationPath).replaceAll("\\", "/"),
        provider: "codex",
        productExecutorsEnabled: true,
        engineeringExecutorsEnabled: true,
        autoStart: true,
        autoApproveInitialIdea: true,
        createdAt: new Date().toISOString()
      };
      const linkErrors = validatePublishedSchema("automation-link.schema.json", link);
      if (linkErrors.length) throw new Error(`پیوند خودکارسازی معتبر نیست: ${linkErrors.join("؛ ")}`);
      await fs.writeFile(path.join(automationDirectory, "link.json"), `${JSON.stringify(link, null, 2)}\n`, "utf8");
    }
  }

  await step(onProgress, "git", async (log) => {
    if (!answers.initializeGit) {
      log("راه‌اندازی گیت از تنظیمات این اجرا عبور داده شد.");
      return;
    }
    report.git.operations = await initializeGitRepository(answers.operationsPath, answers, log);
    if (answers.appMode === "create") {
      await assertDirectoryIdentity(answers.applicationPath, applicationIdentity);
      report.git.application = await initializeGitRepository(answers.applicationPath, answers, log);
    } else if (answers.appMode === "existing") {
      report.git.application = answers.initializeDevelopmentOs ? "existing-git-untouched" : "existing-untouched";
      log(answers.initializeDevelopmentOs
        ? "فایل‌های سامانهٔ توسعه ساخته شدند، اما وضعیت گیت مخزن موجود دست‌کاری نشد."
        : "مخزن کد موجود بدون تغییر در فایل‌ها یا وضعیت گیت متصل شد.");
    }
  });

  await step(onProgress, "validation", async (log) => {
    await runCli(repoRoot, ["validate", answers.operationsPath], log);
  });

  report.completedAt = new Date().toISOString();
  report.dashboardWritable = answers.writableDashboard;
  report.productName = answers.productName;
  if (answers.appMode === "create") {
    await assertDirectoryIdentity(answers.applicationPath, applicationIdentity);
    await fs.rm(path.join(answers.applicationPath, APPLICATION_RESUME_MARKER), { force: true });
  }
  return report;
}

async function step(onProgress, id, operation) {
  onProgress({ id, status: "running", message: "شروع شد" });
  try {
    await operation((message) => onProgress({ id, status: "running", message }));
    onProgress({ id, status: "completed", message: "انجام شد" });
  } catch (error) {
    onProgress({ id, status: "failed", message: safeError(error) });
    throw error;
  }
}

async function initializeGitRepository(target, answers, log) {
  if (!await exists(path.join(target, ".git"))) {
    try {
      await runCommand("git", ["init", "-b", "main"], { cwd: target, onLine: log });
    } catch {
      await runCommand("git", ["init"], { cwd: target, onLine: log });
      await runCommand("git", ["branch", "-M", "main"], { cwd: target, onLine: log });
    }
  } else {
    log("مخزن گیت از قبل وجود دارد.");
  }
  await runCommand("git", ["add", "--all"], { cwd: target, onLine: log });
  if (!answers.createInitialCommit) return "staged";
  const gitName = answers.gitName || await captureOptional("git", ["config", "user.name"], target);
  const gitEmail = answers.gitEmail || await captureOptional("git", ["config", "user.email"], target);
  if (!gitName || !gitEmail) {
    log("نام یا ایمیل گیت تنظیم نیست؛ فایل‌ها آماده و مرحله‌بندی شدند ولی تعهد ساخته نشد.");
    return "staged";
  }
  const hasHead = Boolean(await captureOptional("git", ["rev-parse", "--verify", "HEAD"], target));
  if (hasHead) {
    log("مخزن دارای تاریخچه است؛ تعهد خودکار تازه‌ای ساخته نشد.");
    return "existing";
  }
  await runCommand("git", [
    "-c", `user.name=${gitName}`,
    "-c", `user.email=${gitEmail}`,
    "commit", "-m", "chore: initialize product workspace"
  ], { cwd: target, onLine: log });
  return "committed";
}

async function runCli(repoRoot, args, onLine) {
  await runCommand(process.execPath, [path.join(repoRoot, "src", "cli.js"), ...args], {
    cwd: repoRoot,
    onLine
  });
}

async function runNpm(args, options) {
  const npmCliCandidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(Boolean);
  for (const candidate of npmCliCandidates) {
    if (await exists(candidate)) {
      await runCommand(process.execPath, [candidate, ...args], options);
      return;
    }
  }
  if (process.platform === "win32") {
    await runCommand("cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...args], options);
    return;
  }
  await runCommand("npm", args, options);
}

export async function runCommand(executable, args, { cwd, onLine = () => {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: minimalEnvironment()
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`فرایند پس از ${Math.round(timeoutMs / 1000)} ثانیه متوقف شد.`));
    }, timeoutMs);
    const consume = (chunk, channel) => {
      const text = chunk.toString("utf8");
      const current = channel === "stdout" ? stdout : stderr;
      if (Buffer.byteLength(current, "utf8") + chunk.length > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        finish(new Error(`خروجی ${channel} از سقف ایمن یک مگابایت عبور کرد.`));
        return;
      }
      if (channel === "stdout") stdout = current + text;
      else stderr = current + text;
      for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        onLine(line.slice(0, 600));
      }
    };
    child.stdout.on("data", (chunk) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk) => consume(chunk, "stderr"));
    child.once("error", (error) => {
      finish(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(
        `فرایند با وضعیت ${code ?? signal ?? "unknown"} پایان یافت. ${stderr || stdout}`.trim()
      ));
    });
  });
}

function minimalEnvironment() {
  const allowed = [
    "PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC",
    "TEMP", "TMP", "TMPDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME", "LANG", "LC_ALL"
  ];
  return Object.fromEntries(allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

async function captureOptional(executable, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, env: minimalEnvironment() });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.once("error", () => resolve(""));
    child.once("exit", (code) => resolve(code === 0 ? output.trim() : ""));
  });
}

async function assertSafeDestination(target, label, resumableMarker) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(`${label} نمی‌تواند پیوند نمادین باشد.`);
  if (!stat.isDirectory()) throw new Error(`${label} یک پوشه نیست.`);
  if (await exists(path.join(target, resumableMarker))) return true;
  const entries = await fs.readdir(target);
  if (entries.length > 0) throw new Error(`${label} از قبل وجود دارد و خالی نیست؛ مسیر دیگری انتخاب کنید.`);
  return false;
}

function publicCodexReadiness(value) {
  if (!value) return null;
  return {
    status: value.status,
    installed: value.installed,
    executableUsable: value.executableUsable,
    authenticated: value.authenticated,
    authenticationMode: value.authenticationMode,
    version: value.version,
    entitlementVerified: false,
    canAutomate: value.canAutomate,
    message: value.message
  };
}

function buildAutomationStatus(report) {
  const enabled = report.automation.mode === "codex" && report.development.executorsEnabled;
  return {
    schemaVersion: "1.0.0",
    updatedAt: new Date().toISOString(),
    mode: report.automation.mode,
    provider: report.automation.provider,
    status: enabled ? "executors-ready" : report.automation.status,
    codex: report.automation.codex,
    productCycle: report.initialCycleApplied ? "initialized" : "waiting-for-idea",
    developmentSystem: report.development.status,
    executorsEnabled: report.development.executorsEnabled,
    continuousOrchestrator: enabled,
    currentCapability: enabled
      ? "چرخهٔ پیوستهٔ محصول و توسعه فعال است؛ ایده‌های مجاز خودکار تحلیل، پیاده‌سازی، راستی‌آزمایی و گزارش می‌شوند."
      : "چرخهٔ خودکار فعال نیست.",
    nextCapability: enabled ? "ثبت بازخورد بعدی و آغاز خودکار چرخهٔ اصلاح" : "اتصال کدکس و فعال‌سازی اجراگرها"
  };
}

async function validateApplicationResumeMarker(applicationPath) {
  const markerPath = path.join(applicationPath, APPLICATION_RESUME_MARKER);
  const stat = await fs.lstat(markerPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
    throw new Error("نشانگر ادامهٔ راه‌اندازی معتبر نیست.");
  }
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    throw new Error("نشانگر ادامهٔ راه‌اندازی قابل خواندن نیست.");
  }
  if (
    marker?.schemaVersion !== "1.0.0"
    || marker?.createdBy !== "open-product-operations-os"
    || typeof marker?.sessionId !== "string"
    || !/^[0-9a-f-]{36}$/i.test(marker.sessionId)
    || !samePath(marker?.expectedPath || "", applicationPath)
  ) {
    throw new Error("نشانگر ادامهٔ راه‌اندازی با این مقصد مطابقت ندارد.");
  }
}

async function captureDirectoryIdentity(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("مقصد برنامه باید یک پوشهٔ واقعی باشد.");
  }
  return {
    device: stat.dev,
    inode: stat.ino,
    realPath: await fs.realpath(directory)
  };
}

async function assertDirectoryIdentity(directory, expected) {
  if (!expected) throw new Error("هویت مقصد برنامه ثبت نشده است.");
  const actual = await captureDirectoryIdentity(directory);
  if (
    actual.device !== expected.device
    || actual.inode !== expected.inode
    || !samePath(actual.realPath, expected.realPath)
  ) {
    throw new Error("مقصد برنامه در طول راه‌اندازی تغییر کرده است؛ عملیات متوقف شد.");
  }
}

async function writeIfMissing(file, content) {
  try {
    await fs.writeFile(file, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

function childPath(parent, folder) {
  const target = path.resolve(parent, folder);
  const relative = path.relative(parent, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("مسیر پوشه باید داخل فضای کاری انتخاب‌شده باشد.");
  }
  return target;
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function safeFolder(value, label) {
  const folder = boundedText(value, label, 2, 64);
  if (!FOLDER_PATTERN.test(folder) || WINDOWS_RESERVED.test(folder) || folder === "." || folder === "..") {
    throw new Error(`${label} باید فقط از حروف انگلیسی، عدد، خط تیره، زیرخط یا نقطه ساخته شود.`);
  }
  return folder;
}

function normalizeList(value, label, minimum, maximum) {
  const values = (Array.isArray(value) ? value : String(value || "").split(","))
    .map((item) => String(item).trim())
    .filter(Boolean);
  const unique = [...new Set(values)];
  if (unique.length < minimum || unique.length > maximum) {
    throw new Error(`${label} باید بین ${minimum} تا ${maximum} مورد داشته باشد.`);
  }
  return unique.map((item) => boundedText(item, label, 1, 160));
}

function boundedText(value, label, minimum, maximum) {
  const text = String(value ?? "").trim();
  if (text.length < minimum || text.length > maximum) {
    throw new Error(`${label} باید بین ${minimum} تا ${maximum} نویسه باشد.`);
  }
  return text;
}

function optionalText(value, maximum) {
  const text = String(value ?? "").trim();
  if (text.length > maximum) throw new Error("یکی از مقدارهای اختیاری بیش از حد بلند است.");
  return text;
}

function safeError(error) {
  return String(error?.message || "راه‌اندازی ناموفق بود.").replace(/[\r\n]+/g, " ").slice(0, 1000);
}

async function exists(target) {
  return fs.access(target).then(() => true, () => false);
}
