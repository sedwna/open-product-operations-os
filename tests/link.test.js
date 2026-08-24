import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initCommand } from "../src/commands/init.js";
import { linkCommand } from "../src/commands/link.js";
import { initializeDevelopmentOs } from "../src/development/init.js";
import { readAutomationLink } from "../src/autopilot/state.js";
import { makeTempDirectory } from "./helpers.js";

/**
 * Nothing else creates the automation link, and adoption, the coordinator, and the engineering half
 * of the panel all depend on it. When the onboarding wizard was retired the link went with it, and
 * a workspace had no way to say which repository it operated — found by running the product rather
 * than by reading it.
 */
async function workspaces(t, { withDevelopmentOs = true } = {}) {
  const parent = await makeTempDirectory("product-ops-link-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const product = path.join(parent, "ops");
  const application = path.join(parent, "app");
  await initCommand(product, {});
  await fs.mkdir(application, { recursive: true });
  await fs.writeFile(path.join(application, "README.md"), "# App\n", "utf8");
  if (withDevelopmentOs) await initializeDevelopmentOs(application, { dryRun: false });
  return { product, application };
}

test("linking plans first and writes only when told to", async (t) => {
  const { product, application } = await workspaces(t);

  const planned = await linkCommand(product, { application });
  assert.match(planned.join("\n"), /Planned link/);
  assert.equal(await readAutomationLink(product).catch(() => null), null, "planning must write nothing");

  const applied = await linkCommand(product, { application, apply: true });
  assert.match(applied.join("\n"), /Linked/);
  const link = await readAutomationLink(product);
  assert.equal(path.resolve(link.applicationRoot), path.resolve(application));
});

test("naming a repository is not authorising work inside it", async (t) => {
  const { product, application } = await workspaces(t);
  await linkCommand(product, { application, apply: true });
  const link = await readAutomationLink(product);

  assert.equal(link.productExecutorsEnabled, false);
  assert.equal(link.engineeringExecutorsEnabled, false);
  assert.equal(link.autoStart, false);
  assert.equal(link.autoApproveInitialIdea, false);
});

test("relinking preserves authorisations rather than silently resetting them", async (t) => {
  const { product, application } = await workspaces(t);
  await linkCommand(product, { application, apply: true });

  const { writeAutomationLink } = await import("../src/autopilot/state.js");
  const first = await readAutomationLink(product);
  // applicationRoot is derived on read, not part of the stored contract.
  const { applicationRoot, ...stored } = first;
  assert.ok(applicationRoot);
  await writeAutomationLink(product, { ...stored, autoStart: true, productExecutorsEnabled: true });

  await linkCommand(product, { application, apply: true });
  const relinked = await readAutomationLink(product);
  assert.equal(relinked.autoStart, true, "re-pointing at a moved repository must not revoke what the owner granted");
  assert.equal(relinked.productExecutorsEnabled, true);
  assert.equal(relinked.createdAt, first.createdAt, "the original link date is history, not something to overwrite");
});

test("relinking after the old application moved still preserves the stored contract", async (t) => {
  const { product, application } = await workspaces(t);
  await linkCommand(product, { application, apply: true });

  const { writeAutomationLink } = await import("../src/autopilot/state.js");
  const first = await readAutomationLink(product);
  const { applicationRoot, ...stored } = first;
  assert.ok(applicationRoot);
  await writeAutomationLink(product, { ...stored, autoStart: true, engineeringExecutorsEnabled: true });

  const moved = `${application}-moved`;
  await fs.rename(application, moved);
  await linkCommand(product, { application: moved, apply: true });

  const relinked = await readAutomationLink(product);
  assert.equal(relinked.applicationRelativePath, "../app-moved");
  assert.equal(relinked.autoStart, true);
  assert.equal(relinked.engineeringExecutorsEnabled, true);
  assert.equal(relinked.createdAt, first.createdAt);
});

test("an application without the engineering namespace is refused with the reason", async (t) => {
  const { product, application } = await workspaces(t, { withDevelopmentOs: false });
  await assert.rejects(
    linkCommand(product, { application, apply: true }),
    /development-os init/
  );
});

test("a workspace cannot be linked to itself", async (t) => {
  const { product } = await workspaces(t);
  await assert.rejects(
    linkCommand(product, { application: product, apply: true }),
    /Development root must be separate from the Product Operations root/
  );
});

test("a missing application path is refused before anything is written", async (t) => {
  const { product, application } = await workspaces(t);
  await assert.rejects(
    linkCommand(product, { application: path.join(application, "nowhere"), apply: true }),
    /No application repository/
  );
  assert.equal(await readAutomationLink(product).catch(() => null), null);
});
