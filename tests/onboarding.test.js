import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { loadConfig } from "../src/config.js";
import { validateDevelopmentOs } from "../src/development/validation.js";
import { startOnboardingServer } from "../src/onboarding/server.js";
import {
  normalizeOnboardingRequest,
  ONBOARDING_STEPS,
  runOnboarding
} from "../src/onboarding/service.js";
import { renderOnboarding } from "../src/onboarding/view.js";
import { makeTempDirectory } from "./helpers.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function request(parent, overrides = {}) {
  return {
    workspaceParent: parent,
    operationsFolder: "sample-product-ops",
    applicationFolder: "sample-product-app",
    appMode: "create",
    productName: "محصول نمونه",
    vision: "کمک به کاربران نمونه برای انجام یک جریان روشن و قابل سنجش.",
    targetUsers: ["مدیر محصول", "کاربر نمونه"],
    environments: ["local", "test", "staging"],
    humanAuthorityActorId: "human-product-owner",
    ideaEnabled: true,
    ideaTitle: "تنظیم گزارش هفتگی",
    ideaDescription: "کاربر بتواند روز دریافت گزارش هفتگی را خودش انتخاب کند.",
    ideaSource: "راه‌اندازی محلی مصنوعی",
    ideaPriority: "P2",
    installDependencies: false,
    initializeGit: true,
    createInitialCommit: true,
    gitName: "Synthetic Onboarding",
    gitEmail: "onboarding@example.invalid",
    writableDashboard: true,
    ...overrides
  };
}

test("onboarding request creates contained sibling workspace paths and rejects unsafe input", async (t) => {
  const parent = await makeTempDirectory("product-ops-onboarding-normalize-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const normalized = normalizeOnboardingRequest(request(parent), { repoRoot: repositoryRoot });
  assert.equal(normalized.operationsPath, path.join(parent, "sample-product-ops"));
  assert.equal(normalized.applicationPath, path.join(parent, "sample-product-app"));
  assert.deepEqual(normalized.environments, ["local", "test", "staging"]);
  assert.equal(normalized.initializeDevelopmentOs, true, "new applications always receive Development OS");
  const safeDefaults = normalizeOnboardingRequest(request(parent, {
    initializeDevelopmentOs: false,
    writableDashboard: undefined
  }), { repoRoot: repositoryRoot });
  assert.equal(safeDefaults.initializeDevelopmentOs, true);
  assert.equal(safeDefaults.writableDashboard, false, "the local dashboard is read-only by default");
  const existingOptOut = normalizeOnboardingRequest(request(parent, {
    appMode: "existing",
    existingApplicationPath: path.join(parent, "existing-app"),
    initializeDevelopmentOs: false
  }), { repoRoot: repositoryRoot });
  assert.equal(existingOptOut.initializeDevelopmentOs, false);
  const existingOptIn = normalizeOnboardingRequest(request(parent, {
    appMode: "existing",
    existingApplicationPath: path.join(parent, "existing-app"),
    initializeDevelopmentOs: true
  }), { repoRoot: repositoryRoot });
  assert.equal(existingOptIn.initializeDevelopmentOs, true);
  assert.throws(
    () => normalizeOnboardingRequest(request(parent, { operationsFolder: "../escape" }), { repoRoot: repositoryRoot }),
    /پوشه/
  );
  assert.throws(
    () => normalizeOnboardingRequest(request(parent, { workspaceParent: path.parse(parent).root }), { repoRoot: repositoryRoot }),
    /ریشه/
  );
  assert.throws(
    () => normalizeOnboardingRequest(request(parent, { vision: "api_key=very-secret-credential-value" }), { repoRoot: repositoryRoot }),
    /credential material/
  );
  assert.throws(
    () => normalizeOnboardingRequest(request(parent, { applicationFolder: "sample-product-ops" }), { repoRoot: repositoryRoot }),
    /جدا/
  );
});

test("onboarding service creates operations, app, first cycle, and independent Git histories", async (t) => {
  const parent = await makeTempDirectory("product-ops-onboarding-flow-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const updates = [];
  const result = await runOnboarding(request(parent), {
    repoRoot: repositoryRoot,
    skipDependencyInstall: true,
    onProgress: (update) => updates.push(update)
  });
  assert.equal(result.ideaRecorded, true);
  assert.equal(result.initialCycleApplied, true);
  assert.deepEqual(result.development, {
    requested: true,
    initialized: true,
    validated: true,
    status: "ready",
    executorsConfigured: false,
    executorsEnabled: false
  });
  assert.equal(result.git.operations, "committed");
  assert.equal(result.git.application, "committed");
  const config = await loadConfig(result.operationsPath);
  assert.equal(config.project.name, "محصول نمونه");
  assert.ok(await fs.readFile(path.join(result.applicationPath, "README.md"), "utf8"));
  assert.ok(await fs.readFile(path.join(result.applicationPath, "development-os.config.json"), "utf8"));
  assert.equal((await validateDevelopmentOs(result.applicationPath)).errors.length, 0);
  await assert.rejects(fs.access(path.join(result.applicationPath, ".product-ops-onboarding.json")));
  assert.ok(await fs.readFile(path.join(result.operationsPath, "product-intake", "first-idea.json"), "utf8"));
  const intakeStore = JSON.parse(await fs.readFile(
    path.join(result.operationsPath, ".product-ops", "runtime", "intake.json"),
    "utf8"
  ));
  assert.equal(intakeStore.records.length, 1, "the wizard must record the first idea exactly once");
  assert.equal(intakeStore.records[0].title, request(parent).ideaTitle);
  assert.equal(intakeStore.records[0].status, "accepted");
  assert.equal(await gitHead(result.operationsPath), true);
  assert.equal(await gitHead(result.applicationPath), true);
  for (const step of ONBOARDING_STEPS) {
    assert.ok(updates.some((update) => update.id === step.id && update.status === "completed"), step.id);
  }
});

test("onboarding Codex automation activates engineering executors only after readiness passes", async (t) => {
  const parent = await makeTempDirectory("product-ops-onboarding-codex-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const readiness = {
    provider: "codex",
    status: "ready",
    installed: true,
    executable: path.join(parent, "codex"),
    version: "codex 1.2.3",
    executableUsable: true,
    authenticated: true,
    authenticationMode: "chatgpt",
    entitlementVerified: false,
    canAutomate: true,
    message: "کدکس آماده است.",
    diagnostic: ""
  };
  const result = await runOnboarding(request(parent, {
    automationMode: "codex",
    installCodexCli: false,
    authenticateCodex: false,
    ideaEnabled: false,
    initializeGit: false,
    createInitialCommit: false
  }), {
    repoRoot: repositoryRoot,
    skipDependencyInstall: true,
    inspectCodex: async () => readiness
  });

  assert.equal(result.automation.status, "executors-ready");
  assert.equal(result.development.executorsConfigured, true);
  assert.equal(result.development.executorsEnabled, true);
  const developmentConfig = JSON.parse(await fs.readFile(
    path.join(result.applicationPath, "development-os.config.json"),
    "utf8"
  ));
  assert.equal(developmentConfig.executors.length, 15);
  assert.ok(developmentConfig.executors.every((executor) => executor.enabled));
  const automation = JSON.parse(await fs.readFile(
    path.join(result.operationsPath, ".product-ops", "runtime", "automation", "status.json"),
    "utf8"
  ));
  assert.equal(automation.status, "executors-ready");
  assert.equal(automation.continuousOrchestrator, true);
  assert.match(automation.currentCapability, /چرخهٔ پیوسته/);
  const automationLink = JSON.parse(await fs.readFile(
    path.join(result.operationsPath, ".product-ops", "runtime", "automation", "link.json"),
    "utf8"
  ));
  assert.equal(automationLink.autoStart, true);
  assert.equal(automationLink.productExecutorsEnabled, true);
  assert.equal(automationLink.engineeringExecutorsEnabled, true);
  assert.doesNotMatch(JSON.stringify(automation), /api[_-]?key|password|secret/i);
});

test("onboarding never treats an existing Git repository as a new application or stages existing code", async (t) => {
  const parent = await makeTempDirectory("product-ops-onboarding-existing-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const existing = path.join(parent, "existing-app");
  await fs.mkdir(path.join(existing, ".git"), { recursive: true });
  await fs.writeFile(path.join(existing, "user-file.txt"), "owned by user\n", "utf8");
  await assert.rejects(
    runOnboarding(request(parent, { applicationFolder: "existing-app" }), {
      repoRoot: repositoryRoot,
      skipDependencyInstall: true
    }),
    /خالی نیست/
  );

  await fs.rm(path.join(existing, ".git"), { recursive: true, force: true });
  const result = await runOnboarding(request(parent, {
    operationsFolder: "existing-link-ops",
    appMode: "existing",
    existingApplicationPath: existing,
    ideaEnabled: false,
    initializeGit: true
  }), {
    repoRoot: repositoryRoot,
    skipDependencyInstall: true
  });
  assert.equal(result.git.application, "existing-untouched");
  assert.equal(result.development.status, "skipped-existing-application");
  assert.equal(await fs.readFile(path.join(existing, "user-file.txt"), "utf8"), "owned by user\n");
  await assert.rejects(fs.access(path.join(existing, "development-os.config.json")));
  await assert.rejects(fs.access(path.join(existing, ".git")));
});

test("onboarding rejects a forged resume marker instead of adopting an existing directory", async (t) => {
  const parent = await makeTempDirectory("product-ops-onboarding-forged-resume-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const application = path.join(parent, "sample-product-app");
  await fs.mkdir(application, { recursive: true });
  await fs.writeFile(
    path.join(application, ".product-ops-onboarding.json"),
    `${JSON.stringify({ schemaVersion: "1.0.0", createdBy: "open-product-operations-os" })}\n`,
    "utf8"
  );

  await assert.rejects(
    runOnboarding(request(parent), {
      repoRoot: repositoryRoot,
      skipDependencyInstall: true
    }),
    /نشانگر ادامه/
  );
  await assert.rejects(fs.access(path.join(application, "README.md")));
});

test("onboarding initializes Development OS in an existing application only after explicit opt-in", async (t) => {
  const parent = await makeTempDirectory("product-ops-onboarding-existing-development-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const existing = path.join(parent, "existing-app");
  await fs.mkdir(existing, { recursive: true });
  await fs.writeFile(path.join(existing, "user-file.txt"), "owned by user\n", "utf8");
  runGit(existing, ["init", "-b", "main"]);
  runGit(existing, ["add", "user-file.txt"]);
  runGit(existing, [
    "-c", "user.name=Synthetic Existing Owner",
    "-c", "user.email=existing@example.invalid",
    "commit", "-m", "test: preserve existing application"
  ]);
  const headBefore = runGit(existing, ["rev-parse", "HEAD"]).stdout.trim();

  const result = await runOnboarding(request(parent, {
    appMode: "existing",
    existingApplicationPath: existing,
    initializeDevelopmentOs: true,
    ideaEnabled: false,
    initializeGit: true
  }), {
    repoRoot: repositoryRoot,
    skipDependencyInstall: true
  });

  assert.equal(result.development.status, "ready");
  assert.equal(result.development.initialized, true);
  assert.equal(result.development.validated, true);
  assert.equal(result.git.application, "existing-git-untouched");
  assert.equal(await fs.readFile(path.join(existing, "user-file.txt"), "utf8"), "owned by user\n");
  assert.equal((await validateDevelopmentOs(existing)).errors.length, 0);
  assert.equal(runGit(existing, ["rev-parse", "HEAD"]).stdout.trim(), headBefore);
  assert.equal(runGit(existing, ["diff", "--cached", "--name-only"]).stdout.trim(), "");
});

test("onboarding server is loopback-only, CSRF guarded, and completes a graphical session", async (t) => {
  const parent = await makeTempDirectory("product-ops-onboarding-server-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  await assert.rejects(
    startOnboardingServer(repositoryRoot, { host: "0.0.0.0", openBrowser: false }),
    /loopback/
  );
  const onboarding = await startOnboardingServer(repositoryRoot, {
    openBrowser: false,
    skipDependencyInstall: true,
    closeAfterCompletion: false,
    dashboardLauncher: async () => "http://127.0.0.1:49999"
  });
  t.after(() => onboarding.close().catch(() => {}));
  const page = await fetch(onboarding.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /nonce-/);
  assert.doesNotMatch(page.headers.get("content-security-policy"), /script-src[^;]*unsafe-inline/);
  const html = await page.text();
  assert.match(html, /dir="rtl"/);
  assert.match(html, /راه‌اندازی یک‌کلیکی/);
  assert.match(html, /prefers-reduced-motion/);

  const withoutToken = await fetch(`${onboarding.url}/api/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request(parent))
  });
  assert.equal(withoutToken.status, 403);

  const invalid = await fetch(`${onboarding.url}/api/apply`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-product-ops-csrf": onboarding.csrfToken
    },
    body: JSON.stringify(request(parent, { applicationFolder: "sample-product-ops" }))
  });
  assert.equal(invalid.status, 422);
  assert.match((await invalid.json()).error, /جدا/);
  assert.equal(onboarding.job.status, "idle", "invalid answers must not start or poison the job");

  const accepted = await fetch(`${onboarding.url}/api/apply`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-product-ops-csrf": onboarding.csrfToken
    },
    body: JSON.stringify(request(parent, {
      appMode: "skip",
      ideaEnabled: false,
      initializeGit: false,
      createInitialCommit: false,
      writableDashboard: false
    }))
  });
  assert.equal(accepted.status, 202);
  const status = await waitForJob(onboarding.url, onboarding.csrfToken);
  assert.equal(status.status, "completed", status.error);
  assert.equal(status.dashboardUrl, "http://127.0.0.1:49999");
});

test("onboarding view escapes embedded values and launcher artifacts are integrity checked", async () => {
  const html = renderOnboarding({
    csrfToken: "csrf-value",
    nonce: "nonce-value",
    preflight: { suggestedWorkspaceParent: "</script><script>alert(1)</script>" }
  });
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.match(html, /\\u003c\/script\\u003e/);
  assert.match(html, /name="initializeDevelopmentOs"/);
  assert.match(html, /name="writableDashboard" checked/);
  assert.match(html, /id="form-error" role="alert"/);
  assert.match(html, /id="retry"/);
  const browserScript = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(browserScript, "generated browser script is present");
  assert.doesNotThrow(() => new vm.Script(browserScript), "generated browser script parses");

  const executable = await fs.readFile(path.join(repositoryRoot, "launchers", "windows", "OpenProductOS.exe"));
  const checksumText = await fs.readFile(path.join(repositoryRoot, "launchers", "windows", "OpenProductOS.exe.sha256"), "utf8");
  assert.equal(crypto.createHash("sha256").update(executable).digest("hex"), checksumText.trim().split(/\s+/)[0]);
  const powershell = await fs.readFile(path.join(repositoryRoot, "launchers", "windows", "OpenProductOS.ps1"), "utf8");
  const posix = await fs.readFile(path.join(repositoryRoot, "launchers", "common", "bootstrap-node.sh"), "utf8");
  assert.match(powershell, /Get-FileHash/);
  assert.match(powershell, /latest-v22\.x/);
  assert.match(posix, /sha256sum|shasum/);
  assert.match(posix, /latest-v22\.x/);
});

async function waitForJob(url, csrfToken) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 45_000) {
    const response = await fetch(`${url}/api/status`, { headers: { "x-product-ops-csrf": csrfToken } });
    const value = await response.json();
    if (["completed", "failed"].includes(value.status)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Onboarding test timed out.");
}

async function gitHead(cwd) {
  return spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd, encoding: "utf8" }).status === 0;
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}
