import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildDevelopmentFiles, createDevelopmentConfig } from "../src/development/generator.js";
import { securityAssessmentPolicy } from "../src/development/runner.js";
import { validatePublishedSchema } from "../src/schema-validation.js";

test("every generated Development OS carries the governed security-assessment contract", () => {
  const config = createDevelopmentConfig(path.join("example", "application"));
  const files = buildDevelopmentFiles(config, { includeConfig: true });
  const contract = files.get("engineering/security/assessment-contract.md");
  const standard = files.get("engineering/standards/security.md");

  assert.match(contract, /sealed development request.*authoritative/is);
  assert.match(contract, /candidate.*validated.*rejected.*blocked/is);
  assert.match(contract, /External active testing[\s\S]*separate attributed human[\s\S]*authorization/i);
  assert.match(contract, /ENG-15.*independently reproduces/is);
  assert.match(standard, /risk-calibrated quick, standard, or deep assessment/i);
  assert.match(standard, /stable root-cause deduplication/i);
});

test("security-assessment depth is deterministic and preserves role separation", () => {
  assert.equal(securityAssessmentPolicy("low", "ENG-09").mode, "quick");
  assert.equal(securityAssessmentPolicy("medium", "ENG-09").mode, "standard");
  assert.equal(securityAssessmentPolicy("high", "ENG-09").mode, "standard");
  assert.equal(securityAssessmentPolicy("critical", "ENG-09").mode, "deep");
  assert.equal(securityAssessmentPolicy("high", "ENG-15").responsibility, "independent_reproduction");
  assert.equal(securityAssessmentPolicy("high", "ENG-04"), null);
  assert.equal(securityAssessmentPolicy("critical", "ENG-09").externalActiveTesting, "not_authorized_by_development_request");
});

test("the workstream schema separates candidates from validated findings", () => {
  const result = workstreamResult();
  assert.deepEqual(validatePublishedSchema("engineering-workstream-run.schema.json", result), []);

  const unproved = structuredClone(result);
  unproved.securityAssessment.findings[0].status = "candidate";
  assert.match(
    validatePublishedSchema("engineering-workstream-run.schema.json", unproved).join("\n"),
    /severity.*equal to constant|severity.*must be equal/i
  );

  const missingImpact = structuredClone(result);
  missingImpact.securityAssessment.findings[0].impact = [];
  assert.match(
    validatePublishedSchema("engineering-workstream-run.schema.json", missingImpact).join("\n"),
    /impact.*fewer than 1 item/i
  );
});

function workstreamResult() {
  const check = {
    status: "executed",
    commands: ["security-tool --safe-local-check"],
    evidence: ["machine-readable local result"],
    limitations: []
  };
  return {
    schemaVersion: "1.0.0",
    planId: "ENGPLAN-SECURITY-001",
    workstreamId: "WS-03",
    ownerRole: "ENG-09",
    producerActorId: "actor-eng-09",
    status: "completed",
    verificationDisposition: "not_applicable",
    implementationRevision: "pending",
    changedComponents: [],
    commands: ["security-tool --safe-local-check"],
    evidence: ["machine-readable local result"],
    knownRisks: [],
    securityAssessment: {
      mode: "standard",
      authorization: {
        scopeSource: "sealed_development_request",
        localTesting: "authorized_non_destructive",
        externalActiveTesting: "not_authorized_by_development_request"
      },
      attackSurfaces: ["public API"],
      trustBoundaries: ["unauthenticated client to API"],
      checks: {
        staticAnalysis: check,
        structuralAnalysis: check,
        secretScan: check,
        dependencyAndMisconfiguration: check,
        dynamicValidation: check
      },
      findings: [{
        fingerprint: "authz:orders:tenant-boundary",
        title: "Cross-tenant order read",
        status: "validated",
        severity: "high",
        weakness: "CWE-639",
        locations: ["src/orders/handler.js:42"],
        evidence: ["local integration reproduction without production data"],
        impact: ["another tenant's order metadata can be read"],
        remediation: ["enforce tenant ownership in the shared order lookup"],
        remainingRisk: ["adjacent order endpoints still require independent coverage"]
      }],
      unresolvedCoverage: [],
      conclusion: "validated_findings"
    },
    completedAt: "2026-08-23T00:00:00.000Z"
  };
}
