import { APPROVAL_STORE_FILE, INTAKE_STORE_FILE } from "../constants.js";
import { loadApprovals } from "./approvals.js";
import { readJsonOptional, writeJson } from "./io.js";
import { calculateMetrics } from "./metrics.js";
import { loadTaskboard } from "./taskboard.js";
import { applyWrites, planWrites } from "../file-writer.js";

export async function buildDashboard(root, { dryRun = true, output = ".product-ops/runtime/dashboard.html" } = {}) {
  const [metrics, taskboard, approvals, intake] = await Promise.all([
    calculateMetrics(root),
    loadTaskboard(root),
    loadApprovals(root),
    readJsonOptional(root, INTAKE_STORE_FILE, { records: [] })
  ]);
  const html = renderDashboard({ metrics, tasks: taskboard.records, approvals: approvals.requests, intake: intake.records ?? [] });
  const operations = await planWrites(root, new Map([[output, html]]), { force: true });
  if (!dryRun) await applyWrites(root, operations);
  return { dryRun, output, metrics, bytes: Buffer.byteLength(html) };
}

export async function exportMetrics(root, { dryRun = true, output = ".product-ops/runtime/metrics.json" } = {}) {
  const metrics = await calculateMetrics(root);
  await writeJson(root, output, metrics, { dryRun });
  return { dryRun, output, metrics };
}

function renderDashboard({ metrics, tasks, approvals, intake }) {
  const cards = [
    ["کل کارها", metrics.totals.tasks],
    ["تکمیل‌شده", metrics.totals.completed],
    ["مسدود", metrics.totals.blocked],
    ["آماده", metrics.totals.ready],
    ["تأیید انسانی", metrics.totals.pendingHumanApprovals],
    ["عقب‌افتاده", metrics.totals.overdue]
  ].map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${value}</strong></article>`).join("");
  const taskRows = tasks.map((task) => `<tr><td>${escapeHtml(task.task_id)}</td><td>${escapeHtml(task.title)}</td><td>${escapeHtml(task.owner_role)}</td><td>${escapeHtml(task.status)}</td><td>${escapeHtml(task.priority)}</td></tr>`).join("");
  const approvalRows = approvals.filter((request) => request.status === "pending").map((request) => `<tr><td>${escapeHtml(request.requestId)}</td><td>${escapeHtml(request.taskId)}</td><td>${escapeHtml(request.gate)}</td><td>${escapeHtml(request.question)}</td></tr>`).join("");
  const intakeRows = intake.slice(-20).reverse().map((record) => `<tr><td>${escapeHtml(record.intakeId)}</td><td>${escapeHtml(record.title)}</td><td>${escapeHtml(record.type)}</td><td>${escapeHtml(record.status)}</td></tr>`).join("");
  return `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>داشبورد عملیات محصول</title><style>
:root{color-scheme:light;font-family:Tahoma,Arial,sans-serif;background:#f5f7fb;color:#172033}body{margin:0;padding:32px;max-width:1400px;margin-inline:auto}h1{margin:0 0 8px}p{color:#5b6578}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}.cards article{background:white;border:1px solid #dfe4ee;border-radius:12px;padding:18px}.cards span{display:block;color:#667085}.cards strong{font-size:2rem}section{background:white;border:1px solid #dfe4ee;border-radius:12px;padding:18px;margin:16px 0;overflow:auto}table{border-collapse:collapse;width:100%}th,td{text-align:right;padding:10px;border-bottom:1px solid #edf0f5;white-space:nowrap}th{color:#475467}code{direction:ltr;unicode-bidi:isolate}</style></head>
<body><h1>داشبورد عملیات محصول</h1><p>آخرین محاسبه: <code>${escapeHtml(metrics.generatedAt)}</code></p><div class="cards">${cards}</div>
<section><h2>تابلوی کار</h2><table><thead><tr><th>شناسه</th><th>عنوان</th><th>نقش</th><th>وضعیت</th><th>اولویت</th></tr></thead><tbody>${taskRows}</tbody></table></section>
<section><h2>تأییدهای در انتظار</h2><table><thead><tr><th>شناسه</th><th>کار</th><th>دروازه</th><th>پرسش</th></tr></thead><tbody>${approvalRows}</tbody></table></section>
<section><h2>ورودی‌های اخیر</h2><table><thead><tr><th>شناسه</th><th>عنوان</th><th>نوع</th><th>وضعیت</th></tr></thead><tbody>${intakeRows}</tbody></table></section></body></html>\n`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
