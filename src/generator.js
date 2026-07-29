import { CONFIG_FILE, GOVERNANCE_FILE, REGISTRY_FILE, SCHEMA_VERSION, TASKBOARD_COLUMNS, TASKBOARD_FILE } from "./constants.js";
import { stringifyCsv } from "./csv.js";

export function buildProjectFiles(config, { includeConfig = false } = {}) {
  const files = new Map();

  if (includeConfig) {
    files.set(CONFIG_FILE, formatJson(config));
  }

  files.set(REGISTRY_FILE, formatJson(buildRegistry(config)));
  files.set(GOVERNANCE_FILE, formatJson(buildGovernance(config)));
  files.set(TASKBOARD_FILE, buildTaskboard(config));

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
        implementation: "not-configured",
        settings: {}
      })
    );
  }

  return files;
}

export function buildWorkbookFiles(config) {
  return new Map(
    config.workbook.sheets.map((sheet) => [
      sheet.file,
      stringifyCsv([sheet.columns])
    ])
  );
}

export function buildRegistry(config) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedFrom: CONFIG_FILE,
    agents: config.agents
  };
}

export function buildGovernance(config) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedFrom: CONFIG_FILE,
    ownership: config.ownership,
    routing: config.routing,
    taskIds: config.taskIds,
    statuses: config.statuses
  };
}

function buildTaskboard(config) {
  const initialRoute = config.routing[0];
  const initialStatus = config.statuses.find((status) => !status.terminal);
  const firstTaskId = `${config.taskIds.prefix}-0001`;

  return stringifyCsv([
    TASKBOARD_COLUMNS,
    [
      firstTaskId,
      "Complete product context and review generated governance",
      initialRoute.owner,
      initialStatus.id,
      initialRoute.event,
      "",
      "",
      ""
    ]
  ]);
}

export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
