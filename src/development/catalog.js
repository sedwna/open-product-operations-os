export const DEVELOPMENT_SCHEMA_VERSION = "1.0.0";
export const DEVELOPMENT_CONFIG_FILE = "development-os.config.json";

/**
 * Everything this operating model writes into an application repository, at its root.
 *
 * Named once because two readers need the same answer for opposite reasons: validation walks these
 * paths because they are the only ones it owns, and adoption skips them because a team asked to
 * interpret a repository should be reading the product, not the furniture we moved in.
 */
export const DEVELOPMENT_NAMESPACE = Object.freeze([
  "engineering",
  ".development-os",
  "DEVELOPMENT.md",
  DEVELOPMENT_CONFIG_FILE
]);

export const ENGINEERING_ROLES = [
  role("ENG-01", "Engineering Coordination", "engineering_coordination",
    ["sequence engineering work", "manage technical dependencies", "consolidate delivery status"],
    ["change product scope", "waive specialist gates", "certify its own coordination claims"]),
  role("ENG-02", "Solution Architecture", "solution_architecture",
    ["define system boundaries", "author architecture decisions", "evaluate build versus buy and evolutionary design"],
    ["approve product direction", "hide architectural debt", "bypass security or reliability review"]),
  role("ENG-03", "Frontend and Accessibility", "frontend_accessibility",
    ["implement web interfaces", "own design-system integration", "verify accessibility and browser behavior"],
    ["invent user acceptance", "waive accessibility defects", "change public contracts silently"]),
  role("ENG-04", "Backend, API, and Integration", "backend_api_integration",
    ["implement services and APIs", "manage compatibility", "design integration and messaging behavior"],
    ["break consumers without a migration", "embed credentials", "claim database ownership"]),
  role("ENG-05", "Client Applications", "mobile_desktop_clients",
    ["implement mobile and desktop clients", "manage client lifecycle", "verify offline and upgrade behavior"],
    ["bypass platform security", "ship unreviewed permissions", "invent store approval"]),
  role("ENG-06", "Database and Storage", "database_storage",
    ["model persistent data", "author migrations and indexes", "design backup, restore, retention, replication, caching, search, and recovery"],
    ["run destructive migrations without authorization", "remove recovery paths", "expose protected data"]),
  role("ENG-07", "Data, Analytics, and AI", "data_analytics_ai",
    ["design data pipelines", "implement analytics contracts", "evaluate model quality and data provenance"],
    ["train on unauthorized data", "present estimates as facts", "hide model or data limitations"]),
  role("ENG-08", "Platform, Cloud, and Network", "platform_cloud_network",
    ["design infrastructure and networking", "manage DNS, CDN, queues and platform boundaries", "evaluate capacity and cost"],
    ["apply production changes without approval", "store secrets in code", "weaken network isolation silently"]),
  role("ENG-09", "Security, Privacy, and Compliance", "security_privacy_compliance",
    ["threat model changes", "review identity and access", "assess privacy, compliance, dependencies, and supply chain"],
    ["accept business risk", "disclose vulnerabilities carelessly", "certify its own remediation"]),
  role("ENG-10", "Quality Engineering", "quality_test_automation",
    ["design automated test strategy", "execute integration and end-to-end tests", "measure coverage and regression risk"],
    ["change expected outcomes during execution", "manufacture results", "replace independent verification"]),
  role("ENG-11", "SRE, Observability, and Performance", "sre_observability_performance",
    ["define service objectives", "instrument telemetry", "test performance, resilience, incident response, and disaster recovery"],
    ["invent production evidence", "suppress reliability risks", "approve risk acceptance"]),
  role("ENG-12", "Developer Experience and Delivery", "devex_ci_cd_release",
    ["maintain build and CI/CD", "produce reproducible artifacts", "manage release automation and rollback mechanics"],
    ["authorize production release", "bypass protected branches", "publish unverifiable artifacts"]),
  role("ENG-13", "SEO and Web Discovery", "seo_web_discovery",
    ["define technical SEO controls", "verify crawlability, metadata, structured data, rendering, and web vitals"],
    ["guarantee rankings", "use deceptive practices", "override product content decisions"]),
  role("ENG-14", "Technical Documentation", "technical_documentation",
    ["maintain architecture and operating documentation", "author runbooks", "record migration and support knowledge"],
    ["document unverified behavior as complete", "copy secrets into examples", "erase superseded decisions"]),
  role("ENG-15", "Independent Engineering Verification", "independent_engineering_verification",
    ["reproduce engineering claims", "inspect evidence and revisions", "issue verification dispositions"],
    ["edit producer output under review", "verify its own work", "hide evidence gaps"])
];

export const QUALITY_GATES = [
  gate("GATE-ARCHITECTURE", "architecture", "ENG-02", true, ["architecture decision records", "system-boundary review"]),
  gate("GATE-CODE-REVIEW", "code", "ENG-01", true, ["review reference", "changed-component inventory"]),
  gate("GATE-AUTOMATED-TESTS", "testing", "ENG-10", true, ["test commands", "machine-readable results"]),
  gate("GATE-SECURITY", "security", "ENG-09", true, ["threat review", "secret and vulnerability scan"]),
  gate("GATE-SUPPLY-CHAIN", "supply_chain", "ENG-09", true, ["dependency audit", "software bill of materials"]),
  gate("GATE-DATABASE", "database", "ENG-06", false, ["migration plan", "backup and rollback proof", "query or index evidence"]),
  gate("GATE-API-COMPATIBILITY", "api", "ENG-04", false, ["contract diff", "consumer compatibility evidence"]),
  gate("GATE-INFRA-NETWORK", "infrastructure", "ENG-08", false, ["infrastructure plan", "network and cost review"]),
  gate("GATE-PRIVACY-COMPLIANCE", "privacy", "ENG-09", false, ["data classification", "retention and compliance review"]),
  gate("GATE-ACCESSIBILITY", "accessibility", "ENG-03", false, ["automated accessibility results", "keyboard and screen-reader evidence"]),
  gate("GATE-PERFORMANCE", "performance", "ENG-11", false, ["budget and load results", "regression comparison"]),
  gate("GATE-RELIABILITY", "reliability", "ENG-11", false, ["service objectives", "telemetry and recovery evidence"]),
  gate("GATE-SEO", "seo", "ENG-13", false, ["crawl and metadata audit", "structured-data and web-vitals evidence"]),
  gate("GATE-DOCUMENTATION", "documentation", "ENG-14", true, ["updated operating documentation", "runbook or migration notes"]),
  gate("GATE-INDEPENDENT-VERIFICATION", "verification", "ENG-15", true, ["reproduction record", "independent disposition"])
];

export const IMPACT_ROLE_MAP = {
  architecture: "ENG-02",
  frontend: "ENG-03",
  accessibility: "ENG-03",
  backend: "ENG-04",
  api: "ENG-04",
  integration: "ENG-04",
  messaging: "ENG-04",
  mobile: "ENG-05",
  desktop: "ENG-05",
  database: "ENG-06",
  storage: "ENG-06",
  cache: "ENG-06",
  search: "ENG-06",
  data: "ENG-07",
  ai: "ENG-07",
  analytics: "ENG-07",
  network: "ENG-08",
  infrastructure: "ENG-08",
  cost: "ENG-08",
  security: "ENG-09",
  privacy: "ENG-09",
  identity: "ENG-09",
  compliance: "ENG-09",
  sre: "ENG-11",
  observability: "ENG-11",
  performance: "ENG-11",
  resilience: "ENG-11",
  devops: "ENG-12",
  seo: "ENG-13",
  documentation: "ENG-14"
};

export const ALWAYS_REQUIRED_ROLES = ["ENG-01", "ENG-02", "ENG-09", "ENG-10", "ENG-14", "ENG-15"];

function role(id, name, boundary, may, mustNot) {
  return { id, name, boundary, actorId: `actor-${id.toLowerCase()}`, may, mustNot };
}

function gate(id, domain, ownerRole, required, evidence) {
  return { id, domain, ownerRole, required, evidence };
}
