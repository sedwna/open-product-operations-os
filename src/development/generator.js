import path from "node:path";
import { readPackagedFile } from "../catalog.js";
import {
  DEVELOPMENT_CONFIG_FILE,
  DEVELOPMENT_SCHEMA_VERSION,
  ENGINEERING_ROLES,
  QUALITY_GATES
} from "./catalog.js";

const PUBLISHED_SCHEMAS = [
  "development-os-config.schema.json",
  "development-request.schema.json",
  "engineering-plan.schema.json",
  "engineering-result.schema.json",
  "engineering-workstream-run.schema.json",
  "development-sync-receipt.schema.json"
];

export function createDevelopmentConfig(target) {
  const name = path.basename(path.resolve(target)) || "application";
  return {
    schemaVersion: DEVELOPMENT_SCHEMA_VERSION,
    system: "open-development-operations-os",
    project: {
      id: projectId(name),
      name: displayName(name),
      environments: ["local", "test", "staging", "production"]
    },
    roles: ENGINEERING_ROLES,
    qualityGates: QUALITY_GATES,
    executors: ENGINEERING_ROLES.map((role) => ({
      roleId: role.id,
      enabled: false,
      implementation: "command-runner",
      executable: "",
      arguments: [],
      workingDirectory: ".",
      timeoutMs: 1800000,
      environmentAllowlist: [],
      isolation: "external-required"
    })),
    sync: {
      mode: "versioned-contracts",
      inbox: ".development-os/inbox",
      outbox: ".development-os/outbox",
      receipts: ".development-os/receipts",
      requireSourceDigest: true
    },
    policies: {
      defaultDryRun: true,
      requireIndependentVerification: true,
      requireThreatModelForHighRisk: true,
      requireHumanProductionApproval: true,
      allowedPaths: ["src", "app", "apps", "packages", "services", "tests", "docs", "database", "migrations", "infrastructure", ".github"],
      prohibitedPaths: [".git", "node_modules", ".env", "secrets", "production-data"]
    }
  };
}

export function buildDevelopmentFiles(config, { includeConfig = false } = {}) {
  const files = new Map();
  if (includeConfig) files.set(DEVELOPMENT_CONFIG_FILE, json(config));
  files.set("DEVELOPMENT.md", developmentReadme(config));
  files.set("engineering/governance/charter.md", engineeringCharter());
  files.set("engineering/governance/roles.json", json({ schemaVersion: DEVELOPMENT_SCHEMA_VERSION, roles: config.roles }));
  files.set("engineering/quality/gates.json", json({ schemaVersion: DEVELOPMENT_SCHEMA_VERSION, gates: config.qualityGates }));
  files.set("engineering/taskboard/workstreams.csv", "workstream_id,request_id,owner_role,domain,title,status,dependency_ids,evidence_refs,updated_at\n");
  files.set("engineering/architecture/system-context.md", systemContextTemplate());
  files.set("engineering/architecture/decisions/ADR-000-template.md", adrTemplate());
  files.set("engineering/security/threat-model.md", threatModelTemplate());
  files.set("engineering/reliability/service-levels.md", serviceLevelTemplate());
  files.set("engineering/database/database-readiness.md", databaseTemplate());
  files.set("engineering/seo/technical-seo-readiness.md", seoTemplate());
  files.set("engineering/standards/frontend.md", standard("Frontend and accessibility", ["semantic structure and progressive enhancement", "WCAG-oriented keyboard, focus, contrast, and assistive-technology checks", "design tokens and component contracts", "browser support, rendering, localization, RTL, and performance budgets"]));
  files.set("engineering/standards/backend-api.md", standard("Backend, API, and integration", ["explicit API and event contracts", "authentication, authorization, rate limits, idempotency, and compatibility", "timeouts, retries, circuit breaking, and failure semantics", "bounded transactions and observable errors"]));
  files.set("engineering/standards/data-ai.md", standard("Data, analytics, and AI", ["data lineage and classification", "quality checks and reproducible transformations", "model evaluation, provenance, drift, and human oversight", "privacy-aware analytics contracts"]));
  files.set("engineering/standards/platform-network.md", standard("Platform, cloud, and network", ["infrastructure as code and least privilege", "network segmentation, DNS, TLS, CDN, queues, and capacity", "environment parity and immutable artifacts", "cost budgets, rollback, backup, and disaster recovery"]));
  files.set("engineering/standards/security.md", standard("Security, privacy, and supply chain", ["threat modeling and abuse cases", "identity, access, secret management, and secure defaults", "dependency pinning, provenance, SBOM, and vulnerability handling", "privacy, retention, auditability, and compliance evidence"]));
  files.set("engineering/standards/testing.md", standard("Quality engineering", ["unit, contract, integration, end-to-end, accessibility, security, and resilience coverage", "deterministic fixtures with no production data", "reproducible commands and machine-readable evidence", "independent verification for material claims"]));
  files.set("engineering/standards/delivery.md", standard("Build, CI/CD, and release", ["reproducible builds and locked dependencies", "protected review and required quality gates", "artifact signing or integrity records", "progressive delivery, rollback, and human production authorization"]));
  files.set("engineering/standards/observability.md", standard("SRE, observability, and performance", ["service objectives and error budgets", "structured logs, metrics, traces, and actionable alerts", "load, latency, capacity, resilience, and recovery testing", "incident runbooks and post-incident learning"]));
  files.set(".development-os/inbox/README.md", queueReadme("Product-approved development requests enter here."));
  files.set(".development-os/plans/README.md", queueReadme("Deterministic multi-discipline engineering plans are stored here."));
  files.set(".development-os/outbox/README.md", queueReadme("Independently verified engineering results leave here."));
  files.set(".development-os/receipts/README.md", queueReadme("Content-addressed synchronization receipts are stored here."));
  files.set(".development-os/evidence/README.md", queueReadme("Reproducible, non-secret engineering evidence is indexed here."));
  files.set(".development-os/runs/README.md", queueReadme("Bounded specialist execution inputs and factual outputs are stored here."));
  for (const schema of PUBLISHED_SCHEMAS) {
    files.set(`engineering/schemas/${schema}`, readPackagedFile(`schemas/${schema}`));
  }
  return files;
}

export const DEVELOPMENT_REQUIRED_FILES = [
  DEVELOPMENT_CONFIG_FILE,
  "DEVELOPMENT.md",
  "engineering/governance/charter.md",
  "engineering/governance/roles.json",
  "engineering/quality/gates.json",
  "engineering/taskboard/workstreams.csv",
  "engineering/architecture/system-context.md",
  "engineering/architecture/decisions/ADR-000-template.md",
  "engineering/security/threat-model.md",
  "engineering/reliability/service-levels.md",
  "engineering/database/database-readiness.md",
  "engineering/seo/technical-seo-readiness.md",
  ...PUBLISHED_SCHEMAS.map((schema) => `engineering/schemas/${schema}`)
];

function developmentReadme(config) {
  return `# Open Development Operations OS\n\nThis repository owns implementation, technical architecture, engineering evidence, and environment state for **${config.project.name}**. Product Operations owns product intent, priority, acceptance criteria, and human acceptance.\n\n## Contract flow\n\n\`\`\`text\napproved product request -> content-addressed intake -> multi-discipline engineering plan -> implementation -> quality gates -> independent engineering verification -> result contract -> product validation\n\`\`\`\n\nNo private chat or mutable ticket field replaces a versioned contract. Development cannot change product scope, and Product Operations cannot invent engineering completion.\n`;
}

function engineeringCharter() {
  return `# Engineering charter\n\n## Authority\n\nEngineering owns implementation method, code, technical architecture, database and infrastructure design, engineering evidence, and factual environment state. Product Operations owns product meaning, priority, acceptance criteria, and final user-visible acceptance. Production changes require attributed human authorization.\n\n## Separation\n\nEvery material implementation claim needs reproducible producer evidence and a distinct ENG-15 verifier. Security, database, reliability, and release owners cannot silently waive their gates.\n\n## Delivery rules\n\n- Plan before applying.\n- Keep writes inside the declared repository and path boundary.\n- Never place credentials or production-derived data in contracts or evidence.\n- Preserve request digests and canonical revisions across every handoff.\n- Prefer reversible migrations and progressive delivery.\n- Treat missing evidence as blocked, never passed.\n`;
}

function systemContextTemplate() {
  return `# System context\n\n## Actors and external systems\n\nDocument users, operators, external providers, trust boundaries, data classes, and ownership.\n\n## Containers and components\n\nRecord runtime responsibilities, interfaces, persistence, queues, caches, search, identity, and failure boundaries.\n\n## Cross-cutting qualities\n\nCapture security, privacy, accessibility, performance, reliability, observability, scalability, cost, SEO, localization, and maintainability decisions.\n`;
}

function adrTemplate() {
  return `# ADR-000: Decision title\n\n- Status: proposed\n- Request: <DEVREQ-ID>\n- Owner: ENG-02\n- Independent verifier: ENG-15\n\n## Context\n\n## Options considered\n\n## Decision\n\n## Consequences and trade-offs\n\n## Migration, rollback, and evidence\n`;
}

function threatModelTemplate() {
  return `# Threat model\n\n## Scope and trust boundaries\n\n## Assets and data classification\n\n## Identities, privileges, and abuse cases\n\n## Threats\n\nCover spoofing, tampering, repudiation, disclosure, denial of service, privilege escalation, supply-chain compromise, unsafe AI behavior, and business-logic abuse.\n\n## Mitigations, residual risk, and verification\n`;
}

function serviceLevelTemplate() {
  return `# Service levels and recovery\n\nDefine availability and latency indicators, objectives, error budgets, capacity assumptions, telemetry, alerts, incident ownership, backup objectives, recovery objectives, failover, and disaster-recovery exercises. Production claims require observed evidence.\n`;
}

function databaseTemplate() {
  return `# Database and storage readiness\n\nReview data model and ownership, consistency and transaction boundaries, indexes and query plans, concurrency, migrations, compatibility, retention, encryption, access control, audit logging, cache invalidation, search indexing, backups, restore tests, replication, failover, recovery objectives, capacity, and cost.\n\nEvery destructive or irreversible operation requires explicit authorization and a tested rollback or recovery path.\n`;
}

function seoTemplate() {
  return `# Technical SEO readiness\n\nWhen the change affects a public web surface, review status codes, canonical URLs, robots controls, sitemaps, rendering, metadata, structured data, internal links, pagination, localization, redirects, crawl budget, accessibility, mobile behavior, and Core Web Vitals. Record measurements; never promise ranking outcomes.\n`;
}

function standard(title, controls) {
  return `# ${title}\n\nRequired considerations:\n\n${controls.map((control) => `- ${control}`).join("\n")}\n\nApplicable work must record commands, environment, revision, evidence, limitations, and remaining risk.\n`;
}

function queueReadme(description) {
  return `# Contract directory\n\n${description}\n\nFiles are append-only by identity. Corrections use a new version or superseding contract; they do not rewrite historical claims.\n`;
}

function projectId(value) {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "application";
}

function displayName(value) {
  const words = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.length ? words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ") : "Application";
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
