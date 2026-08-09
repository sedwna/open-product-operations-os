import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initCommand } from "../src/commands/init.js";
import { linkCommand } from "../src/commands/link.js";
import { initializeDevelopmentOs } from "../src/development/init.js";
import { planDevelopmentRequest } from "../src/development/planner.js";
import { loadDevelopmentConfig } from "../src/development/config.js";
import { createHandlers, createServerContext } from "../src/mcp/server.js";
import { makeTempDirectory } from "./helpers.js";

/**
 * The engineering half of host-delegated execution.
 *
 * Product work was inverted first and engineering was left spawning a configured CLI, so a product
 * could reach an approved delivery contract and stop dead because no executable was installed.
 * These prove the mirror path works and refuses the same things the spawned path refuses.
 */

const call = (handlers, name, args = {}) => handlers["tools/call"]({ name, arguments: args });

async function linkedWorkspace(t, { withPlan = true } = {}) {
  const parent = await makeTempDirectory("product-ops-eng-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const product = path.join(parent, "ops");
  const application = path.join(parent, "app");
  await initCommand(product, {});
  await fs.mkdir(application, { recursive: true });
  await initializeDevelopmentOs(application, { dryRun: false });
  await linkCommand(product, { application, apply: true });

  if (withPlan) {
    const requestFile = path.join(application, "request.json");
    await fs.writeFile(requestFile, `${JSON.stringify(developmentRequest(), null, 2)}\n`, "utf8");
    await planDevelopmentRequest(application, requestFile, { dryRun: false });
  }

  const context = await createServerContext({ project: product, allowWrites: true });
  const handlers = createHandlers(context, { version: "test" });
  handlers.initialize({ protocolVersion: "2026-07-28", capabilities: {} });
  return { product, application, handlers };
}

test("engineering work is not offered before a plan exists", async (t) => {
  const { handlers } = await linkedWorkspace(t, { withPlan: false });
  const result = (await call(handlers, "product_ops_next_engineering_work")).structuredContent;
  assert.equal(result.available, false);
  assert.equal(result.reason, "no_plan");
});

test("a planned workstream is handed out as a bounded brief", async (t) => {
  const { application, handlers } = await linkedWorkspace(t);
  const claim = (await call(handlers, "product_ops_next_engineering_work")).structuredContent;

  assert.equal(claim.available, true);
  assert.equal(claim.claimToken.length, 32);
  assert.equal(path.resolve(claim.applicationRoot), path.resolve(application));
  assert.notEqual(claim.team, claim.ownerRole, "the brief names a team, not a contract identifier");
  assert.ok(claim.writeBoundary, "engineering may only write where the contract says");
  assert.ok(claim.policy.prohibitedPaths.length > 0, "the paths that are never application code must travel with the brief");
  // ENG-15 reproduces the others' claims; there is nothing to reproduce first.
  assert.notEqual(claim.ownerRole, "ENG-15");
});

test("a submitted result passes the same contract a spawned executor would", async (t) => {
  const { application, handlers } = await linkedWorkspace(t);
  const claim = (await call(handlers, "product_ops_next_engineering_work")).structuredContent;
  const config = await loadDevelopmentConfig(application);
  const actor = config.roles.find((role) => role.id === claim.ownerRole).actorId;

  const result = {
    schemaVersion: "1.0.0",
    planId: claim.planId,
    workstreamId: claim.workstreamId,
    ownerRole: claim.ownerRole,
    producerActorId: actor,
    status: "completed",
    verificationDisposition: "not_applicable",
    implementationRevision: "abcdef1234567890",
    changedComponents: ["src"],
    commands: ["node --test"],
    evidence: ["evidence/run.json"],
    knownRisks: [],
    completedAt: "2026-08-09T12:00:00.000Z"
  };

  const planned = await call(handlers, "product_ops_submit_engineering_work", {
    workstreamId: claim.workstreamId, claimToken: claim.claimToken, result
  });
  assert.equal(planned.structuredContent.applied, false, "submitting must plan by default");

  const applied = await call(handlers, "product_ops_submit_engineering_work", {
    workstreamId: claim.workstreamId, claimToken: claim.claimToken, result, apply: true
  });
  assert.equal(applied.structuredContent.applied, true);
  assert.equal(applied.structuredContent.sealed, true);
  const stored = JSON.parse(await fs.readFile(path.join(application, applied.structuredContent.resultFile), "utf8"));
  assert.equal(stored.workstreamId, claim.workstreamId);
});

test("only ENG-15 may issue a verification disposition", async (t) => {
  const { application, handlers } = await linkedWorkspace(t);
  const claim = (await call(handlers, "product_ops_next_engineering_work")).structuredContent;
  const config = await loadDevelopmentConfig(application);

  // Claiming a passed verification from a role that does not hold it is how a producer would come
  // to certify its own work — the rule the whole model rests on.
  const overreach = await call(handlers, "product_ops_submit_engineering_work", {
    workstreamId: claim.workstreamId,
    claimToken: claim.claimToken,
    apply: true,
    result: {
      schemaVersion: "1.0.0",
      planId: claim.planId,
      workstreamId: claim.workstreamId,
      ownerRole: claim.ownerRole,
      producerActorId: config.roles.find((role) => role.id === claim.ownerRole).actorId,
      status: "completed",
      verificationDisposition: "passed",
      implementationRevision: "abcdef1234567890",
      changedComponents: ["src"],
      commands: ["node --test"],
      evidence: ["evidence/run.json"],
      knownRisks: [],
      completedAt: "2026-08-09T12:00:00.000Z"
    }
  });
  assert.equal(overreach.isError, true);
  assert.match(JSON.stringify(overreach), /verificationDisposition|refused/i);
});

test("engineering work cannot be returned without having been taken", async (t) => {
  const { application, handlers } = await linkedWorkspace(t);
  const claim = (await call(handlers, "product_ops_next_engineering_work")).structuredContent;
  const config = await loadDevelopmentConfig(application);

  const forged = await call(handlers, "product_ops_submit_engineering_work", {
    workstreamId: claim.workstreamId,
    claimToken: "0".repeat(32),
    apply: true,
    result: {
      schemaVersion: "1.0.0",
      planId: claim.planId,
      workstreamId: claim.workstreamId,
      ownerRole: claim.ownerRole,
      producerActorId: config.roles.find((role) => role.id === claim.ownerRole).actorId,
      status: "completed",
      verificationDisposition: "not_applicable",
      implementationRevision: "abcdef1234567890",
      changedComponents: ["src"],
      commands: ["node --test"],
      evidence: ["evidence/run.json"],
      knownRisks: [],
      completedAt: "2026-08-09T12:00:00.000Z"
    }
  });
  assert.equal(forged.isError, true);
  assert.match(JSON.stringify(forged), /claim/i);
});

test("a read-only server offers no engineering execution path", async (t) => {
  const parent = await makeTempDirectory("product-ops-eng-ro-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const product = path.join(parent, "ops");
  await initCommand(product, {});
  const context = await createServerContext({ project: product, allowWrites: false });
  const handlers = createHandlers(context, { version: "test" });
  handlers.initialize({ protocolVersion: "2026-07-28", capabilities: {} });

  const names = handlers["tools/list"]().tools.map((tool) => tool.name);
  assert.ok(!names.includes("product_ops_next_engineering_work"));
  assert.ok(!names.includes("product_ops_submit_engineering_work"));
});

/** An approved delivery contract the planner accepts, as the development suite states it. */
function developmentRequest(suffix = "MCP-ENGINEERING-001") {
  return {
    schemaVersion: "1.0.0",
    requestId: `DEVREQ-${suffix}`,
    productTaskId: "TASK-RB-13-0001",
    deliveryTicketReference: "product/delivery-ticket.md",
    title: "Deliver a searchable public catalog",
    problem: "Users cannot discover or efficiently search the public product catalog.",
    desiredOutcome: "Users find indexable catalog entries with predictable response times.",
    acceptanceCriteria: [
      { id: "AC-01", statement: "Catalog entries are searchable and paginated.", verification: "Run API and browser scenarios." },
      { id: "AC-02", statement: "Public pages expose valid canonical metadata.", verification: "Run technical SEO audit." }
    ],
    impacts: ["architecture", "frontend", "accessibility", "backend", "api", "database", "search", "security", "performance", "seo", "documentation"],
    constraints: ["No production data in tests", "Migration must be reversible"],
    nonFunctionalRequirements: [
      { domain: "performance", requirement: "Search p95 remains below the approved budget.", verification: "Execute a reproducible load scenario." },
      { domain: "database", requirement: "Migration supports rollback and restore.", verification: "Run migration and recovery in test." }
    ],
    writeBoundary: {
      repositories: ["application"],
      allowedPaths: ["src", "tests", "database", "migrations", "docs"],
      prohibitedPaths: [".env", "production-data"]
    },
    validation: {
      commands: ["npm test", "npm run audit"],
      evidenceRequired: ["test report", "migration proof", "SEO audit"]
    },
    approval: {
      status: "approved",
      actorId: "human-product-owner",
      decidedAt: "2026-08-01T00:00:00.000Z",
      reference: "APR-DEV-001"
    },
    source: {
      productOperationsRevision: "abcdef1234567890",
      exportedAt: "2026-08-01T00:01:00.000Z"
    }
  };
}
