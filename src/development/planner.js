import path from "node:path";
import { applyWrites, planWrites } from "../file-writer.js";
import { ALWAYS_REQUIRED_ROLES, IMPACT_ROLE_MAP } from "./catalog.js";
import { assertRequestBoundary, contractDigest, json, readContract, safeContractId } from "./contracts.js";
import { loadDevelopmentConfig, validateDevelopmentConfig } from "./config.js";

export async function planDevelopmentRequest(root, requestFile, { dryRun = true } = {}) {
  const config = await loadDevelopmentConfig(root);
  const configErrors = validateDevelopmentConfig(config);
  if (configErrors.length) throw new Error(`Development configuration is invalid:\n- ${configErrors.join("\n- ")}`);
  const request = await readContract(requestFile, "development-request.schema.json", "Development request");
  assertRequestBoundary(request, config);
  const digest = contractDigest(request);
  const plan = buildPlan(request, config, digest);
  const suffix = safeContractId(request.requestId.replace(/^DEVREQ-/, ""), "Request ID");
  const requestPath = `${config.sync.inbox}/${request.requestId}.json`;
  const planPath = `.development-os/plans/${plan.planId}.json`;
  const receipt = {
    schemaVersion: "1.0.0",
    receiptId: `SYNC-IN-${suffix}`,
    direction: "product_to_development",
    contractType: "development_request",
    contractId: request.requestId,
    contractDigest: digest,
    sourceRevision: request.source.productOperationsRevision,
    storedAt: requestPath,
    createdAt: request.source.exportedAt
  };
  const files = new Map([
    [requestPath, json(request)],
    [planPath, json(plan)],
    [`${config.sync.receipts}/${receipt.receiptId}.json`, json(receipt)]
  ]);
  const operations = await planWrites(path.resolve(root), files, {});
  if (!dryRun) await applyWrites(path.resolve(root), operations);
  return { dryRun, request, digest, plan, receipt, operations };
}

export function buildPlan(request, config, digest) {
  const selectedRoles = new Set(ALWAYS_REQUIRED_ROLES);
  for (const impact of request.impacts) selectedRoles.add(IMPACT_ROLE_MAP[impact]);
  selectedRoles.delete(undefined);
  const orderedRoles = config.roles.map((role) => role.id).filter((id) => selectedRoles.has(id));
  const workstreamIdByRole = new Map(orderedRoles.map((roleId, index) => [roleId, `WS-${String(index + 1).padStart(2, "0")}`]));
  const implementationRoles = orderedRoles.filter((roleId) => !["ENG-01", "ENG-02", "ENG-09", "ENG-10", "ENG-14", "ENG-15"].includes(roleId));
  const workstreams = orderedRoles.map((roleId, index) => {
    const role = config.roles.find((candidate) => candidate.id === roleId);
    const id = `WS-${String(index + 1).padStart(2, "0")}`;
    const architecture = workstreamIdByRole.get("ENG-02");
    const implementation = implementationRoles.map((candidate) => workstreamIdByRole.get(candidate));
    const dependencies = roleId === "ENG-01" ? []
      : roleId === "ENG-02" ? [workstreamIdByRole.get("ENG-01")]
      : roleId === "ENG-09" ? [architecture, ...implementation]
      : roleId === "ENG-10" ? [...implementation, workstreamIdByRole.get("ENG-09")]
      : roleId === "ENG-14" ? [architecture, ...implementation]
      : roleId === "ENG-15" ? orderedRoles.filter((candidate) => candidate !== "ENG-15").map((candidate) => workstreamIdByRole.get(candidate))
      : [architecture];
    return {
      id,
      ownerRole: roleId,
      domain: role.boundary,
      title: `${role.name}: ${request.title}`,
      dependencies: [...new Set(dependencies.filter((dependency) => dependency !== id))],
      deliverables: deliverablesFor(roleId, request),
      requiredEvidence: evidenceFor(roleId),
      status: "ready"
    };
  });
  const selectedGates = config.qualityGates.filter((gate) => gate.required || gateApplies(gate.id, request.impacts));
  return {
    schemaVersion: "1.0.0",
    planId: `ENGPLAN-${request.requestId.replace(/^DEVREQ-/, "")}`,
    requestId: request.requestId,
    sourceDigest: digest,
    status: "planned",
    riskClass: classifyRisk(request),
    workstreams,
    qualityGates: selectedGates.map((gate) => gate.id),
    architectureDecisions: ["engineering/architecture/decisions/ADR-000-template.md"],
    createdAt: request.source.exportedAt
  };
}

function classifyRisk(request) {
  const text = JSON.stringify(request).toLowerCase();
  if (/critical|irreversible|safety[- ]critical/.test(text)) return "critical";
  if (request.impacts.some((impact) => ["database", "storage", "security", "privacy", "identity", "compliance", "infrastructure", "network", "messaging", "resilience"].includes(impact)) || text.includes("production")) return "high";
  if (request.impacts.some((impact) => ["backend", "api", "integration", "data", "ai", "devops", "performance"].includes(impact))) return "medium";
  return "low";
}

function gateApplies(gateId, impacts) {
  const map = {
    "GATE-DATABASE": ["database", "storage", "cache", "search"],
    "GATE-API-COMPATIBILITY": ["backend", "api", "integration", "messaging"],
    "GATE-INFRA-NETWORK": ["network", "infrastructure", "devops", "cost", "messaging"],
    "GATE-PRIVACY-COMPLIANCE": ["privacy", "compliance", "identity", "data", "ai"],
    "GATE-ACCESSIBILITY": ["frontend", "accessibility", "mobile", "desktop"],
    "GATE-PERFORMANCE": ["frontend", "backend", "api", "database", "performance"],
    "GATE-RELIABILITY": ["sre", "observability", "resilience", "infrastructure", "database", "messaging"],
    "GATE-SEO": ["seo"]
  };
  return (map[gateId] ?? []).some((impact) => impacts.includes(impact));
}

function deliverablesFor(roleId, request) {
  const common = [`Traceability to ${request.requestId}`, "Implementation or review notes", "Known risks and limitations"];
  const specialized = {
    "ENG-01": ["Owned workstream sequence", "Dependency and blocker register"],
    "ENG-02": ["System impact analysis", "Architecture decision records"],
    "ENG-06": ["Data model and migration plan", "Backup, restore, rollback, index, and capacity plan"],
    "ENG-09": ["Threat model and security/privacy review", "Supply-chain review"],
    "ENG-10": ["Automated validation implementation", "Regression evidence"],
    "ENG-11": ["Service objectives and telemetry plan", "Performance and recovery evidence"],
    "ENG-13": ["Technical SEO assessment", "Crawl, metadata, structured-data, and web-vitals evidence"],
    "ENG-14": ["Updated architecture and operating documentation", "Runbook or migration guidance"],
    "ENG-15": ["Independent reproduction record", "Verification disposition"]
  };
  return [...(specialized[roleId] ?? ["Domain implementation or review output"]), ...common];
}

function evidenceFor(roleId) {
  if (roleId === "ENG-15") return ["canonical revision", "reproduction commands", "independent evidence references"];
  return ["canonical revision", "commands and environment", "machine-readable or inspectable result"];
}
