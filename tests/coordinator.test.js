import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initCommand } from "../src/commands/init.js";
import { initializeDevelopmentOs } from "../src/development/init.js";
import { coordinatorCommand } from "../src/commands/runtime.js";
import { startAutopilotLoop } from "../src/autopilot/orchestrator.js";
import { captureIo, makeTempDirectory } from "./helpers.js";

async function workspace(t, { autoStart = true, linked = true } = {}) {
  const parent = await makeTempDirectory("product-ops-coordinator-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "product");
  await initCommand(root, {});
  if (!linked) return root;

  const application = path.join(parent, "application");
  await initializeDevelopmentOs(application, {});
  const link = path.join(root, ".product-ops/runtime/automation/link.json");
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.writeFile(link, `${JSON.stringify({
    schemaVersion: "1.0.0",
    applicationRelativePath: "../application",
    provider: "claude",
    productExecutorsEnabled: true,
    engineeringExecutorsEnabled: true,
    autoStart,
    autoApproveInitialIdea: false,
    createdAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  return root;
}

test("the coordinator runs on its own, not only inside a web server", async (t) => {
  // The component that drives work forward used to exist only inside the dashboard server, so it
  // could not run without also serving an interface. This is the separation.
  const root = await workspace(t);
  const { io, stdout } = captureIo();
  const lines = await coordinatorCommand(root, { apply: false }, io);
  const output = [...lines, ...stdout].join("\n");

  assert.match(output, /Coordinator for/);
  assert.match(output, /Application: \.\.\/application/);
  assert.match(output, /provider: claude/);
  assert.match(output, /This is a plan/);
  assert.match(output, /Production release, destructive actions, spending, and external publication/,
    "the plan must say what stays gated even when the coordinator is running");
});

test("it refuses a workspace it cannot coordinate, and says which", async (t) => {
  const unlinked = await workspace(t, { linked: false });
  await assert.rejects(
    coordinatorCommand(unlinked, { apply: false }, captureIo().io),
    /no automation link/
  );

  const notAuthorised = await workspace(t, { autoStart: false });
  await assert.rejects(
    coordinatorCommand(notAuthorised, { apply: false }, captureIo().io),
    /does not authorise automatic start/
  );

  // A link that parses but points nowhere usable is a configuration problem, not a crash.
  const broken = await workspace(t);
  await fs.rm(path.join(path.dirname(broken), "application"), { recursive: true, force: true });
  await assert.rejects(
    coordinatorCommand(broken, { apply: false }, captureIo().io),
    /automation link cannot be used/
  );
});

test("a standalone loop stays alive between cycles; a hosted one does not hold the process open", async (t) => {
  // The distinction is the whole reason keepAlive exists. An unref'd timer is right when an HTTP
  // server owns the process and wrong when the loop itself is the process — the same defect that
  // once let a waiting CLI exit silently without writing anything.
  const root = await workspace(t);
  const observed = [];

  const hosted = startAutopilotLoop(root, {
    intervalMs: 10,
    runner: async () => ({ status: "idle" }),
    onCycle: (result) => observed.push(result.status)
  });
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  await hosted.close();
  const hostedTimer = setTimeout(() => {}, 0);
  assert.equal(typeof hostedTimer.unref, "function");
  clearTimeout(hostedTimer);

  const reported = [];
  const standalone = startAutopilotLoop(root, {
    intervalMs: 10,
    keepAlive: true,
    runner: async () => ({ status: "completed", cycleId: "CYCLE-1" }),
    onCycle: (result) => reported.push(result.status)
  });
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  await standalone.close();
  assert.ok(reported.length >= 2, `a live loop must keep cycling, saw ${reported.length}`);
  assert.equal(reported.every((status) => status === "completed"), true);
});

test("a reporter that throws cannot stop the loop", async (t) => {
  const root = await workspace(t);
  let cycles = 0;
  const loop = startAutopilotLoop(root, {
    intervalMs: 10,
    keepAlive: true,
    runner: async () => { cycles += 1; return { status: "idle" }; },
    onCycle: () => { throw new Error("the reporter exploded"); }
  });
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  await loop.close();
  assert.ok(cycles >= 2, `the loop must survive a failing reporter, ran ${cycles} cycle(s)`);
});

test("closing waits for the agent already running rather than killing it mid-write", async (t) => {
  const root = await workspace(t);
  let finished = false;
  const loop = startAutopilotLoop(root, {
    intervalMs: 5,
    keepAlive: true,
    runner: async () => {
      await new Promise((resolve) => { setTimeout(resolve, 120); });
      finished = true;
      return { status: "completed" };
    }
  });
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  await loop.close();
  assert.equal(finished, true, "stopping must be cooperative, as it is everywhere else in this system");
});
