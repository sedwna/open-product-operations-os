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
  const impacts = inferImpactDomains(request);
  const selectedRoles = new Set(ALWAYS_REQUIRED_ROLES);
  for (const impact of impacts) selectedRoles.add(IMPACT_ROLE_MAP[impact]);
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
  const selectedGates = config.qualityGates.filter((gate) => gate.required || gateApplies(gate.id, impacts));
  return {
    schemaVersion: "1.0.0",
    planId: `ENGPLAN-${request.requestId.replace(/^DEVREQ-/, "")}`,
    requestId: request.requestId,
    sourceDigest: digest,
    status: "planned",
    riskClass: classifyRisk(request, impacts),
    workstreams,
    qualityGates: selectedGates.map((gate) => gate.id),
    architectureDecisions: ["engineering/architecture/decisions/ADR-000-template.md"],
    createdAt: request.source.exportedAt
  };
}

export function inferImpactDomains(request) {
  const impacts = new Set(request.impacts ?? []);
  const fragments = [];
  for (const criterion of request.acceptanceCriteria ?? []) {
    fragments.push(criterion.statement, criterion.verification);
  }
  for (const requirement of request.nonFunctionalRequirements ?? []) {
    const normalizedDomain = normalizeDomain(requirement.domain);
    if (normalizedDomain) impacts.add(normalizedDomain);
    fragments.push(requirement.domain, requirement.requirement, requirement.verification);
  }
  fragments.push(...(request.constraints ?? []));
  const text = fragments.filter(Boolean).join("\n").normalize("NFKC").toLowerCase();
  for (const [impact, patterns] of Object.entries(IMPACT_INFERENCE_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(text))) impacts.add(impact);
  }
  return [...impacts];
}

function classifyRisk(request, impacts) {
  const text = JSON.stringify(request).toLowerCase();
  if (/critical|irreversible|safety[- ]critical/.test(text)) return "critical";
  if (impacts.some((impact) => ["database", "storage", "security", "privacy", "identity", "compliance", "infrastructure", "network", "messaging", "resilience"].includes(impact)) || text.includes("production")) return "high";
  if (impacts.some((impact) => ["backend", "api", "integration", "data", "ai", "devops", "performance"].includes(impact))) return "medium";
  return "low";
}

function normalizeDomain(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    db: "database",
    datastore: "database",
    data_store: "database",
    auth: "identity",
    authentication: "identity",
    authorization: "identity",
    infra: "infrastructure",
    reliability: "resilience",
    deployment: "devops",
    ci_cd: "devops"
  };
  const domain = aliases[normalized] ?? normalized;
  return IMPACT_ROLE_MAP[domain] ? domain : null;
}

const IMPACT_INFERENCE_PATTERNS = {
  architecture: [/\barchitecture\b/, /system boundary/, /معماری/],
  frontend: [/\bfront[ -]?end\b/, /user interface/, /رابط کاربری/],
  accessibility: [/\baccessibility\b/, /screen reader/, /keyboard navigation/, /دسترس[‌ ]?پذیری/],
  backend: [/\bback[ -]?end\b/, /server[ -]?side/, /سمت سرور/],
  api: [/\bapi\b/, /application programming interface/, /رابط برنامه[‌ ]?نویسی/],
  integration: [/\bintegration\b/, /webhook/, /یکپارچه[‌ ]?سازی/],
  messaging: [/\bmessage queue\b/, /\bevent bus\b/, /\bkafka\b/, /صف پیام/],
  mobile: [/\bmobile\b/, /\bios\b/, /\bandroid\b/, /موبایل/],
  desktop: [/\bdesktop\b/, /دسکتاپ/],
  database: [/\bdatabase\b/, /\bdb\b/, /\bsql\b/, /\bmigration\b/, /\bschema change\b/, /\bquery plan\b/, /\bindex(?:es|ing)?\b/, /\bbackup\b/, /\brestore\b/, /پایگاه داده/, /مهاجرت/, /نسخه پشتیبان/, /بازیابی/],
  storage: [/\bstorage\b/, /object store/, /blob store/, /ذخیره[‌ ]?سازی/],
  cache: [/\bcach(?:e|ing)\b/, /حافظه نهان/],
  search: [/\bsearch(?:able|ing)?\b/, /\bindexable\b/, /جست[‌ ]?وجو/],
  data: [/\bdata pipeline\b/, /\bdata lineage\b/, /خط لوله داده/, /تبار داده/],
  ai: [/\bai\b/, /artificial intelligence/, /machine learning/, /هوش مصنوعی/, /یادگیری ماشین/],
  analytics: [/\banalytics\b/, /تحلیل[‌ ]?گری/],
  network: [/\bnetwork\b/, /\bdns\b/, /\bcdn\b/, /\btls\b/, /\bfirewall\b/, /شبکه/],
  infrastructure: [/\binfrastructure\b/, /\bkubernetes\b/, /\bterraform\b/, /\bcloud\b/, /زیرساخت/, /رایانش ابری/],
  cost: [/\bcost budget\b/, /\bfinops\b/, /بودجه هزینه/],
  security: [/\bsecurity\b/, /\bvulnerabilit(?:y|ies)\b/, /\bthreat\b/, /\bsecret\b/, /\bcredential\b/, /\bencrypt(?:ion|ed)?\b/, /امنیت/, /آسیب[‌ ]?پذیری/, /رمزنگاری/],
  privacy: [/\bprivacy\b/, /personal data/, /\bpii\b/, /\bconsent\b/, /حریم خصوصی/, /داده شخصی/],
  identity: [/\bidentity\b/, /\bauthentication\b/, /\bauthorization\b/, /access control/, /\bpermission\b/, /هویت/, /احراز هویت/, /کنترل دسترسی/],
  compliance: [/\bcompliance\b/, /\bgdpr\b/, /\bhipaa\b/, /\bpci(?:[ -]?dss)?\b/, /انطباق/],
  sre: [/\bsre\b/, /site reliability/, /مهندسی قابلیت اطمینان/],
  observability: [/\bobservability\b/, /\btelemetry\b/, /\btracing\b/, /\bmetrics\b/, /مشاهده[‌ ]?پذیری/],
  performance: [/\bperformance\b/, /\blatency\b/, /\bthroughput\b/, /\bp\d{2}\b/, /web vitals/, /کارایی/, /تأخیر/],
  resilience: [/\bresilien(?:ce|t)\b/, /\bavailability\b/, /disaster recovery/, /\bfailover\b/, /\bincident\b/, /تاب[‌ ]?آوری/, /بازیابی بحران/],
  devops: [/\bdevops\b/, /\bci[\/-]?cd\b/, /\bdeployment\b/, /\brelease pipeline\b/, /استقرار/],
  seo: [/\bseo\b/, /search engine/, /canonical url/, /structured data/, /بهینه[‌ ]?سازی موتور جست[‌ ]?وجو/],
  documentation: [/\bdocumentation\b/, /\brunbook\b/, /مستندات/, /راهنمای عملیاتی/]
};

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
