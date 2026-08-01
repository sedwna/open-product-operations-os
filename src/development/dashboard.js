import fs from "node:fs/promises";
import path from "node:path";
import { applyWrites, planWrites } from "../file-writer.js";
import { validateDevelopmentOs } from "./validation.js";

export async function buildDevelopmentDashboard(root, { dryRun = true, output } = {}) {
  const validation = await validateDevelopmentOs(root);
  if (validation.errors.length) throw new Error(`Development dashboard requires a valid Development OS:\n- ${validation.errors.join("\n- ")}`);
  const plans = await readJsonFiles(path.join(root, ".development-os/plans"));
  const results = await readJsonFiles(path.join(root, validation.config.sync.outbox));
  const runs = (await readJsonFiles(path.join(root, ".development-os/runs"))).filter((value) => value.workstreamId);
  const outputPath = output ?? ".development-os/dashboard/index.html";
  const html = render(validation, plans, results, runs);
  const operations = await planWrites(path.resolve(root), new Map([[outputPath, html]]), { force: true });
  if (!dryRun) await applyWrites(path.resolve(root), operations);
  return { dryRun, output: outputPath, bytes: Buffer.byteLength(html), validation, plans: plans.length, results: results.length, runs: runs.length };
}

async function readJsonFiles(directory) {
  let entries = [];
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const values = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try { values.push(JSON.parse(await fs.readFile(path.join(directory, entry.name), "utf8"))); }
    catch { /* validation reports managed contract parse failures before rendering */ }
  }
  return values;
}

function render(validation, plans, results, runs) {
  const config = validation.config;
  const workstreams = plans.flatMap((plan) => plan.workstreams.map((workstream) => ({ ...workstream, planId: plan.planId, risk: plan.riskClass })));
  const selectedGates = new Set(plans.flatMap((plan) => plan.qualityGates));
  return `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>برج کنترل توسعه — ${escapeHtml(config.project.name)}</title><style>
:root{color-scheme:dark;--bg:#09111f;--panel:#111d30;--line:#263852;--text:#edf4ff;--muted:#9fb0c8;--brand:#65d6ad;--gold:#f0c36a;--danger:#ff7a90}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top right,#17304c 0,#09111f 45%);color:var(--text);font-family:Tahoma,"Segoe UI",sans-serif;line-height:1.75}main{max-width:1300px;margin:auto;padding:32px 20px 64px}header{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:24px}h1,h2{margin:0}p{color:var(--muted)}.badge{padding:5px 12px;border:1px solid var(--line);border-radius:999px;color:var(--brand)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px}.card,.section{background:linear-gradient(145deg,rgba(17,29,48,.96),rgba(10,20,35,.96));border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 16px 40px #0004}.card strong{display:block;font-size:30px;color:var(--brand)}.section{margin-top:18px;overflow:auto}table{border-collapse:collapse;width:100%;min-width:760px}th,td{text-align:right;padding:11px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--gold)}code{direction:ltr;unicode-bidi:isolate;color:#b9d8ff}.roles{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}.role{border-right:3px solid var(--brand);padding:8px 12px;background:#ffffff06}.muted{color:var(--muted);font-size:13px}@media(max-width:640px){header{display:block}.card strong{font-size:24px}}
</style></head><body><main><header><div><span class="badge">Development OS</span><h1>برج کنترل مهندسی</h1><p>${escapeHtml(config.project.name)} — نمای محلی و فقط‌خواندنی از قراردادها، برنامه‌ها و کنترل‌های فنی</p></div><div class="muted">۱۵ مرز مهندسی · جداسازی محصول و توسعه · تأیید مستقل</div></header>
<section class="grid"><div class="card"><span>درخواست‌ها</span><strong>${validation.contractCounts.requests}</strong></div><div class="card"><span>برنامه‌ها</span><strong>${plans.length}</strong></div><div class="card"><span>جریان‌های کاری</span><strong>${workstreams.length}</strong></div><div class="card"><span>اجراهای تخصصی</span><strong>${runs.length}</strong></div><div class="card"><span>نتایج نهایی</span><strong>${results.length}</strong></div><div class="card"><span>دروازه‌های فعال</span><strong>${selectedGates.size}</strong></div></section>
<section class="section"><h2>برنامه‌های مهندسی</h2><table><thead><tr><th>برنامه</th><th>ریسک</th><th>مالک</th><th>حوزه</th><th>وضعیت</th><th>وابستگی</th></tr></thead><tbody>${workstreams.length ? workstreams.map((item) => `<tr><td><code>${escapeHtml(item.planId)}</code><br><code>${escapeHtml(item.id)}</code></td><td>${escapeHtml(item.risk)}</td><td><code>${escapeHtml(item.ownerRole)}</code></td><td>${escapeHtml(item.domain)}</td><td>${escapeHtml(item.status)}</td><td>${item.dependencies.map(escapeHtml).join("، ") || "—"}</td></tr>`).join("") : `<tr><td colspan="6">هنوز درخواست تأییدشده‌ای وارد نشده است.</td></tr>`}</tbody></table></section>
<section class="section"><h2>مرزهای تخصصی</h2><div class="roles">${config.roles.map((role) => `<div class="role"><code>${escapeHtml(role.id)}</code> — ${escapeHtml(role.name)}<div class="muted">${escapeHtml(role.boundary)}</div></div>`).join("")}</div></section>
<section class="section"><h2>دروازه‌های کیفیت</h2><table><thead><tr><th>دروازه</th><th>حوزه</th><th>مالک</th><th>الزام پایه</th></tr></thead><tbody>${config.qualityGates.map((gate) => `<tr><td><code>${escapeHtml(gate.id)}</code></td><td>${escapeHtml(gate.domain)}</td><td><code>${escapeHtml(gate.ownerRole)}</code></td><td>${gate.required ? "الزامی" : "وابسته به اثر"}</td></tr>`).join("")}</tbody></table></section>
</main></body></html>`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
