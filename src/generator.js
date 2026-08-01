import {
  CONFIG_FILE,
  GOVERNANCE_FILE,
  REGISTRY_FILE,
  SCHEMA_VERSION,
  TASKBOARD_COLUMNS,
  TASKBOARD_FILE
} from "./constants.js";
import { getCanonicalWorkbookSheets, readPackagedFile, readPackagedTemplate } from "./catalog.js";
import { parseCsv, stringifyCsv } from "./csv.js";

const GOVERNANCE_TEMPLATES = [
  ["governance/governance.md", "governance/governance.md"],
  ["governance/routing-rules.yaml", "governance/routing-rules.yaml"],
  ["governance/ownership-matrix.csv", "governance/ownership-matrix.csv"],
  ["governance/communication-protocol.md", "governance/communication-protocol.md"]
];

const SCHEMA_FILES = [
  "approval-store.schema.json",
  "agent-registry.schema.json",
  "board-task.schema.json",
  "development-run.schema.json",
  "development-os-config.schema.json",
  "development-request.schema.json",
  "development-sync-receipt.schema.json",
  "engineering-plan.schema.json",
  "engineering-result.schema.json",
  "engineering-workstream-run.schema.json",
  "evidence-receipt.schema.json",
  "handoff.schema.json",
  "intake-record.schema.json",
  "provider-catalog.schema.json",
  "provider-outbox-item.schema.json",
  "project-config.schema.json",
  "runtime-receipt.schema.json",
  "workbook-write-manifest.schema.json",
  "workbook-write-receipt.schema.json"
];

export function buildProjectFiles(config, { includeConfig = false } = {}) {
  const files = new Map();

  if (includeConfig) {
    files.set(CONFIG_FILE, formatJson(config));
  }
  files.set(
    "config/operating-model.yaml",
    readPackagedTemplate("config/operating-model.yaml")
  );
  files.set(
    "adapters/providers.json",
    readPackagedTemplate("adapters/providers.json")
  );

  files.set(REGISTRY_FILE, formatJson(buildRegistry(config)));
  files.set(GOVERNANCE_FILE, formatJson(buildGovernance(config)));
  files.set(TASKBOARD_FILE, buildTaskboard(config));

  for (const agent of config.agents) {
    files.set(`agents/roles/${agent.id}.md`, buildRolePackage(agent, config));
  }
  for (const [destination, source] of GOVERNANCE_TEMPLATES) {
    files.set(destination, readPackagedTemplate(source));
  }
  for (const schema of SCHEMA_FILES) {
    files.set(`schemas/${schema}`, readPackagedFile(`schemas/${schema}`));
  }

  files.set(
    "events/EVT-00000000-001-first-discovery.md",
    buildFirstDiscoveryEvent(config)
  );

  for (const [file, content] of buildWorkbookFiles(config)) {
    files.set(file, content);
  }

  for (const [name, adapter] of Object.entries(config.adapters)) {
    files.set(
      adapter.file,
      formatJson({
        schemaVersion: SCHEMA_VERSION,
        name,
        type: adapter.type,
        enabled: adapter.enabled,
        implementation: adapter.implementation ?? "not-configured",
        settings: adapter.settings ?? {}
      })
    );
  }

  return files;
}

export function buildWorkbookFiles(config) {
  const templates = new Map(
    getCanonicalWorkbookSheets().map((sheet) => [sheet.key, sheet.template])
  );
  return new Map(
    config.workbook.sheets.map((sheet) => {
      const template = templates.get(sheet.key);
      const rows = template ? parseCsv(template) : [sheet.columns];
      rows[0] = sheet.columns;
      return [sheet.file, buildInitialWorkbookContent(sheet, rows, config)];
    })
  );
}

export function buildRegistry(config) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedFrom: CONFIG_FILE,
    catalogAuthority: config.catalogAuthority,
    agents: config.agents
  };
}

export function buildGovernance(config) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedFrom: CONFIG_FILE,
    catalogAuthority: config.catalogAuthority,
    ownership: config.ownership,
    routing: config.routing,
    taskIds: config.taskIds,
    statuses: config.statuses,
    separation: config.separation,
    fieldAuthority: config.fieldAuthority
  };
}

function buildTaskboard(config) {
  const taskId = `${config.taskIds.prefix}-0001`;
  return stringifyCsv([
    TASKBOARD_COLUMNS,
    [
      taskId,
      "EVT-00000000-001",
      "Complete the first discovery record",
      "RB-03",
      actorFor(config, "RB-03"),
      "ready",
      "P2",
      "",
      "",
      "",
      "",
      "events/EVT-00000000-001-first-discovery.md",
      "",
      "",
      "RB-12",
      actorFor(config, "RB-12"),
      "",
      "",
      ""
    ]
  ]);
}

function buildRolePackage(agent, config) {
  const verifierRole =
    agent.id === config.separation.independentVerifierRole
      ? config.separation.verificationOfVerifierRole ?? "RB-08"
      : config.separation.independentVerifierRole;
  return `# ${agent.id} — ${agent.name}

Source catalog: \`${config.catalogAuthority}\`
Generated snapshot: \`config/operating-model.yaml\`

Assigned actor: \`${agent.actorId}\`

## Purpose

${agent.role}

## May

${agent.responsibilities.map((item) => `- ${item}`).join("\n")}

## Must not

${agent.prohibitedActions.map((item) => `- ${item}`).join("\n")}

This role cannot certify its own material claims. The independent verifier is \`${
    verifierRole
  }\`, assigned to \`${actorFor(config, verifierRole)}\`.
`;
}

function buildFirstDiscoveryEvent(config) {
  return `# EVT-00000000-001 — First discovery event

- Status: \`draft\`
- Coordinator: \`RB-01 / ${actorFor(config, "RB-01")}\`
- Discovery owner: \`RB-03 / ${actorFor(config, "RB-03")}\`
- Independent verifier: \`RB-12 / ${actorFor(config, "RB-12")}\`
- Project: \`${config.project.name}\`

## Question

What user problem and measurable outcome should this project validate first?

## Required next artifact

Complete the corresponding Discovery workbook row, link source evidence, and route any product
direction decision to the human product owner. This bootstrap event is not evidence of completed
research or approval.
`;
}

function buildInitialWorkbookContent(sheet, templateRows, config) {
  const headers = templateRows[0] ?? sheet.columns;
  if (sheet.key === "role_registry") {
    const roleIndex = headers.indexOf("role_key");
    const actorIndex = headers.indexOf("assigned_actor_id");
    return stringifyCsv([
      headers,
      ...templateRows.slice(1).map((row) => {
        const generated = [...row];
        generated[actorIndex] = actorFor(config, row[roleIndex]);
        return generated;
      })
    ]);
  }
  if (sheet.key === "events") {
    return stringifyCsv([
      headers,
      rowFor(headers, {
        event_id: "EVT-00000000-001",
        event_type: "new_idea",
        title: "First discovery event",
        status: "draft",
        priority: "P2",
        risk: "low",
        coordinator_role: "RB-01",
        coordinator_actor_id: actorFor(config, "RB-01"),
        semantic_owner_roles: "RB-03",
        writer_role: "RB-10",
        verifier_role: "RB-12",
        producer_actor_id: actorFor(config, "RB-03"),
        verifier_actor_id: actorFor(config, "RB-12"),
        affected_systems: "git",
        evidence_requirements: "source references and limitations"
      })
    ]);
  }
  if (sheet.key === "taskboard") {
    const taskRows = parseCsv(buildTaskboard(config));
    return stringifyCsv(taskRows);
  }
  if (sheet.key === "idea_inbox") {
    return stringifyCsv([
      headers,
      rowFor(headers, {
        idea_id: "IDEA-00000000-001",
        event_id: "EVT-00000000-001",
        problem_or_opportunity: "Define the first user problem to investigate",
        target_user: config.project.targetUsers[0],
        expected_outcome: config.project.vision,
        source_reference: "events/EVT-00000000-001-first-discovery.md",
        status: "discovery",
        priority: "P2",
        triage_owner_role: "RB-02",
        discovery_id: "DSC-00000000-001"
      })
    ]);
  }
  if (sheet.key === "discovery") {
    return stringifyCsv([
      headers,
      rowFor(headers, {
        discovery_id: "DSC-00000000-001",
        event_id: "EVT-00000000-001",
        idea_id: "IDEA-00000000-001",
        status: "draft",
        owner_role: "RB-03",
        owner_actor_id: actorFor(config, "RB-03"),
        question: "What user problem and measurable outcome should be validated first?",
        method: "To be selected",
        limitations: "No research has been executed yet",
        producer_actor_id: actorFor(config, "RB-03"),
        verifier_actor_id: actorFor(config, "RB-12")
      })
    ]);
  }
  return stringifyCsv(templateRows);
}

function rowFor(headers, values) {
  return headers.map((header) => values[header] ?? "");
}

function actorFor(config, role) {
  return config.agents.find((agent) => agent.id === role)?.actorId ?? "";
}

export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
