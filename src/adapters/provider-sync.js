import crypto from "node:crypto";
import { PROVIDER_INBOX_FILE, PROVIDER_OUTBOX_FILE, PROVIDER_RECEIPTS_FILE, SCHEMA_VERSION } from "../constants.js";
import { assertNoLinkTraversal, resolveInside } from "../paths.js";
import { validatePublishedSchema } from "../schema-validation.js";
import { readJsonOptional, utcTimestamp, writeJson } from "../runtime/io.js";
import fs from "node:fs/promises";
import { assertNoCredentialMaterial } from "../runtime/security.js";

export async function loadProviderCatalog(root) {
  const file = resolveInside(root, "adapters/providers.json", "Provider catalog");
  await assertNoLinkTraversal(root, file, "Provider catalog");
  const catalog = JSON.parse(await fs.readFile(file, "utf8"));
  const errors = validatePublishedSchema("provider-catalog.schema.json", catalog);
  if (errors.length > 0) throw new Error(`Invalid provider catalog:\n- ${errors.join("\n- ")}`);
  return catalog;
}

export async function syncProvider(
  root,
  providerName,
  { dryRun = true, fetchImplementation = globalThis.fetch, now = new Date() } = {}
) {
  const [catalog, outbox, inbox, receiptStore] = await Promise.all([
    loadProviderCatalog(root),
    readJsonOptional(root, PROVIDER_OUTBOX_FILE, { schemaVersion: SCHEMA_VERSION, items: [] }),
    readJsonOptional(root, PROVIDER_INBOX_FILE, { schemaVersion: SCHEMA_VERSION, records: [] }),
    readJsonOptional(root, PROVIDER_RECEIPTS_FILE, { schemaVersion: SCHEMA_VERSION, receipts: [] })
  ]);
  const provider = catalog.providers[providerName];
  if (!provider) throw new Error(`Unknown provider "${providerName}".`);
  const completedReceiptIds = new Set((receiptStore.receipts ?? []).map((receipt) => receipt.id));
  const queued = (outbox.items ?? []).filter(
    (item) => item.provider === providerName && item.status === "queued" && !completedReceiptIds.has(item.id)
  );
  const plans = queued.map((item) => validateOutboxItem(item, provider));
  if (dryRun) return { provider: providerName, dryRun: true, plannedRequests: plans };
  if (!provider.enabled) throw new Error(`Provider "${providerName}" is disabled.`);
  const token = process.env[provider.credentialEnvironmentVariable];
  if (!token) throw new Error(`Provider credential environment variable "${provider.credentialEnvironmentVariable}" is not available.`);
  const receipts = [];
  for (const plan of plans) {
    const response = await fetchImplementation(plan.url, {
      method: plan.method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: plan.method === "GET" ? undefined : JSON.stringify(plan.payload),
      redirect: "error"
    });
    const responseText = await response.text();
    if (responseText.length > 1048576) throw new Error(`Provider response for "${plan.id}" exceeds the 1 MiB receipt limit.`);
    let disposition = response.ok ? "accepted" : "http_error";
    let readbackSha256 = "";
    if (response.ok && provider.category === "workbook" && plan.method !== "GET") {
      const readbackUrl = new URL(plan.controls.readbackEndpoint.slice(1), `${new URL(provider.baseUrl).toString().replace(/\/$/, "")}/`).toString();
      const readback = await fetchImplementation(readbackUrl, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        redirect: "error"
      });
      const readbackText = await readback.text();
      if (readbackText.length > 1048576) throw new Error(`Provider read-back for "${plan.id}" exceeds the 1 MiB receipt limit.`);
      readbackSha256 = crypto.createHash("sha256").update(readbackText).digest("hex");
      if (!readback.ok || readbackSha256 !== plan.controls.expectedReadbackSha256) {
        disposition = "readback_mismatch";
      } else {
        disposition = "verified";
      }
    }
    let projectedData = null;
    let projectionFailure = null;
    if (response.ok && plan.responseFields.length > 0) {
      try {
        const parsed = JSON.parse(responseText);
        projectedData = Object.fromEntries(
          plan.responseFields.map((field) => [field, projectField(parsed, field)])
        );
        assertNoCredentialMaterial("Provider response projection", projectedData);
      } catch (error) {
        projectionFailure = error;
        disposition = "projection_failure";
      }
    }
    const receipt = {
      id: plan.id,
      provider: providerName,
      operation: plan.operation,
      statusCode: response.status,
      responseSha256: crypto.createHash("sha256").update(responseText).digest("hex"),
      readbackSha256,
      disposition,
      completedAt: utcTimestamp(now)
    };
    receipts.push(receipt);
    receiptStore.receipts = [...receiptStore.receipts, receipt];
    await writeJson(root, PROVIDER_RECEIPTS_FILE, receiptStore, { dryRun: false });
    outbox.items = outbox.items.map((item) => item.id === plan.id ? {
      ...item,
      status: ["accepted", "verified"].includes(disposition) ? "completed" : "needs_reconciliation"
    } : item);
    await writeJson(root, PROVIDER_OUTBOX_FILE, outbox, { dryRun: false });
    if (projectedData) {
      inbox.records = [...inbox.records, {
        id: plan.id,
        provider: providerName,
        operation: plan.operation,
        data: projectedData,
        receivedAt: utcTimestamp(now)
      }];
      await writeJson(root, PROVIDER_INBOX_FILE, inbox, { dryRun: false });
    }
    if (!response.ok) throw new Error(`Provider request "${plan.id}" failed with HTTP ${response.status}; reconciliation receipt recorded.`);
    if (disposition === "readback_mismatch") throw new Error(`Provider workbook write "${plan.id}" failed complete read-back; reconciliation receipt recorded.`);
    if (projectionFailure) throw new Error(`Provider response projection for "${plan.id}" failed; reconciliation receipt recorded: ${projectionFailure.message}`);
  }
  return { provider: providerName, dryRun: false, receipts };
}

export async function queueProviderItem(root, item, { dryRun = true } = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("Provider outbox item must be an object.");
  }
  const catalog = await loadProviderCatalog(root);
  assertNoCredentialMaterial("Provider outbox item", item);
  const provider = catalog.providers[item.provider];
  if (!provider) throw new Error(`Unknown provider "${item.provider}".`);
  validateOutboxItem({ ...item, status: "queued" }, provider);
  const outbox = await readJsonOptional(root, PROVIDER_OUTBOX_FILE, { schemaVersion: SCHEMA_VERSION, items: [] });
  if (outbox.items.some((candidate) => candidate.id === item.id)) {
    throw new Error(`Provider outbox item "${item.id}" already exists.`);
  }
  const queued = { ...item, method: String(item.method).toUpperCase(), status: "queued" };
  const schemaErrors = validatePublishedSchema("provider-outbox-item.schema.json", queued);
  if (schemaErrors.length > 0) throw new Error(`Invalid provider outbox item:\n- ${schemaErrors.join("\n- ")}`);
  await writeJson(root, PROVIDER_OUTBOX_FILE, { ...outbox, items: [...outbox.items, queued] }, { dryRun });
  return { dryRun, item: queued };
}

function validateOutboxItem(item, provider) {
  if (!item || !/^[A-Za-z0-9._-]+$/.test(item.id ?? "")) throw new Error("Provider outbox item has an unsafe ID.");
  if (!provider.operations.includes(item.operation)) throw new Error(`Provider operation "${item.operation}" is not allowed.`);
  const method = String(item.method ?? "POST").toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(method)) throw new Error(`Provider method "${method}" is not allowed.`);
  const endpoint = String(item.endpoint ?? "");
  if (!endpoint.startsWith("/") || endpoint.includes("..") || endpoint.includes("\\")) throw new Error("Provider endpoint must be a safe absolute API path.");
  if (provider.category === "workbook" && method !== "GET") {
    for (const field of ["approvedPlanHash", "humanAuthorizationId", "preconditionHash", "expectedReadbackSha256", "rollbackPlan", "readbackEndpoint"]) {
      if (!item.controls?.[field]) throw new Error(`Workbook provider writes require controls.${field}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(item.controls.expectedReadbackSha256)) throw new Error("Workbook expected read-back hash must be SHA-256.");
    if (!item.controls.readbackEndpoint.startsWith("/") || item.controls.readbackEndpoint.includes("..")) throw new Error("Workbook read-back endpoint is unsafe.");
  }
  const base = new URL(provider.baseUrl);
  if (base.protocol !== "https:") throw new Error("Provider base URL must use HTTPS.");
  const responseFields = item.responseFields ?? [];
  if (!Array.isArray(responseFields) || responseFields.some((field) => !/^[A-Za-z0-9_.-]+$/.test(field))) throw new Error("Provider responseFields must contain safe dotted field names.");
  return { id: item.id, operation: item.operation, method, url: new URL(endpoint.slice(1), `${base.toString().replace(/\/$/, "")}/`).toString(), payload: item.payload ?? {}, controls: item.controls ?? {}, responseFields };
}

function projectField(value, dottedPath) {
  return dottedPath.split(".").reduce((current, segment) =>
    current && typeof current === "object" ? current[segment] : undefined, value) ?? null;
}
