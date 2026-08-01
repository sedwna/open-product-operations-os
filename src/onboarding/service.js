import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertNoCredentialMaterial } from "../runtime/security.js";

const FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const ALLOWED_ENVIRONMENTS = new Set(["local", "test", "staging", "production"]);
const ALLOWED_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const APPLICATION_RESUME_MARKER = ".product-ops-onboarding.json";

export const ONBOARDING_STEPS = Object.freeze([
  { id: "dependencies", label: "آماده‌سازی موتور" },
  { id: "operations", label: "ساخت فضای عملیات محصول" },
  { id: "configuration", label: "ثبت مشخصات محصول" },
  { id: "application", label: "آماده‌سازی مخزن کد" },
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

  const ideaEnabled = Boolean(input.ideaEnabled && String(input.ideaTitle || "").trim());
  const priority = ALLOWED_PRIORITIES.has(input.ideaPriority) ? input.ideaPriority : "P2";
  const idea = ideaEnabled
    ? {
        type: "new_idea",
        title: boundedText(input.ideaTitle, "عنوان ایده", 3, 180),
        description: boundedText(input.ideaDescription, "شرح ایده", 10, 2400),
        source: boundedText(input.ideaSource || "راه‌اندازی یک‌کلیکی محلی", "منبع ایده", 2, 200),
        priority
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
    idea,
    installDependencies: input.installDependencies !== false,
    initializeGit: input.initializeGit !== false,
    createInitialCommit: input.createInitialCommit !== false,
    gitName: optionalText(input.gitName, 120),
    gitEmail: optionalText(input.gitEmail, 200),
    writableDashboard: input.writableDashboard !== false
  };
  assertNoCredentialMaterial("Onboarding answers", normalized);
  return normalized;
}

export async function inspectOnboardingEnvironment(repoRoot) {
  const [gitVersion, gitName, gitEmail] = await Promise.all([
    captureOptional("git", ["--version"]),
    captureOptional("git", ["config", "--global", "user.name"]),
    captureOptional("git", ["config", "--global", "user.email"])
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
    gitEmail
  };
}

export async function runOnboarding(request, {
  repoRoot,
  onProgress = () => {},
  skipDependencyInstall = false
} = {}) {
  const answers = normalizeOnboardingRequest(request, { repoRoot });
  await fs.mkdir(answers.workspaceParent, { recursive: true });
  await assertSafeDestination(answers.operationsPath, "فضای عملیات محصول", "product-ops.config.json");
  if (answers.appMode === "create") {
    await assertSafeDestination(answers.applicationPath, "پوشهٔ کد محصول", APPLICATION_RESUME_MARKER);
    await fs.mkdir(answers.applicationPath, { recursive: true });
    await writeIfMissing(
      path.join(answers.applicationPath, APPLICATION_RESUME_MARKER),
      `${JSON.stringify({ schemaVersion: "1.0.0", createdBy: "open-product-operations-os" }, null, 2)}\n`
    );
  } else if (answers.appMode === "existing") {
    const stat = await fs.stat(answers.applicationPath).catch(() => null);
    if (!stat?.isDirectory()) throw new Error("پوشهٔ کد موجود پیدا نشد.");
  }

  const report = {
    schemaVersion: "1.0.0",
    startedAt: new Date().toISOString(),
    operationsPath: answers.operationsPath,
    applicationPath: answers.applicationPath,
    ideaRecorded: false,
    initialCycleApplied: false,
    git: { operations: "skipped", application: "skipped" }
  };

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

  await step(onProgress, "git", async (log) => {
    if (!answers.initializeGit) {
      log("راه‌اندازی گیت از تنظیمات این اجرا عبور داده شد.");
      return;
    }
    report.git.operations = await initializeGitRepository(answers.operationsPath, answers, log);
    if (answers.appMode === "create") {
      report.git.application = await initializeGitRepository(answers.applicationPath, answers, log);
    } else if (answers.appMode === "existing") {
      report.git.application = "existing-untouched";
      log("مخزن کد موجود بدون تغییر در فایل‌ها یا وضعیت گیت متصل شد.");
    }
  });

  await step(onProgress, "validation", async (log) => {
    await runCli(repoRoot, ["validate", answers.operationsPath], log);
  });

  report.completedAt = new Date().toISOString();
  report.dashboardWritable = answers.writableDashboard;
  report.productName = answers.productName;
  if (answers.appMode === "create") {
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
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`فرایند پس از ${Math.round(timeoutMs / 1000)} ثانیه متوقف شد.`));
    }, timeoutMs);
    const consume = (chunk, channel) => {
      const text = chunk.toString("utf8");
      if (channel === "stdout") stdout += text;
      else stderr += text;
      for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        onLine(line.slice(0, 600));
      }
    };
    child.stdout.on("data", (chunk) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk) => consume(chunk, "stderr"));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(
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
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error(`${label} یک پوشه نیست.`);
  if (await exists(path.join(target, resumableMarker))) return;
  const entries = await fs.readdir(target);
  if (entries.length > 0) throw new Error(`${label} از قبل وجود دارد و خالی نیست؛ مسیر دیگری انتخاب کنید.`);
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
