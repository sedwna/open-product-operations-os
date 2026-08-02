const STATUS_LABELS = {
  backlog: "صف انتظار",
  ready: "آماده",
  in_progress: "در حال انجام",
  blocked: "مسدود",
  in_review: "در بازبینی",
  done: "انجام‌شده",
  cancelled: "لغوشده"
};

export function renderDashboard(snapshot, { csrfToken = "", live = false, nonce = "" } = {}) {
  const safeSnapshot = JSON.stringify(snapshot)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  const renderNonce = nonce || randomNonce(snapshot.generatedAt);
  const completion = Math.round(snapshot.metrics.ratios.completion * 100);
  const evidence = Math.round(snapshot.metrics.ratios.evidenceCoverage * 100);
  const activeTasks = snapshot.tasks.filter((task) => !["done", "cancelled"].includes(task.status)).length;
  const pending = snapshot.approvals.filter((request) => request.status === "pending").length;
  const statusOptions = Object.entries(STATUS_LABELS)
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#15273f">
  <meta name="product-ops-csrf" content="${escapeHtml(csrfToken)}">
  <title>برج کنترل ${escapeHtml(snapshot.project.name)}</title>
  <style nonce="${renderNonce}">${styles()}</style>
</head>
<body>
  <a class="skip-link" href="#workspace">رفتن به محتوای اصلی</a>
  <div class="ambient ambient-one" aria-hidden="true"></div>
  <div class="ambient ambient-two" aria-hidden="true"></div>
  <div class="shell">
    <aside class="sidebar" aria-label="ناوبری اصلی">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span><strong>Product Ops</strong><small>Operating System</small></span>
      </div>
      <nav class="nav">
        <button class="nav-item active" data-view="overview"><span>۰۱</span> نمای کلی</button>
        <button class="nav-item" data-view="tasks"><span>۰۲</span> تابلوی کار</button>
        <button class="nav-item" data-view="approvals"><span>۰۳</span> تأییدهای انسانی <b>${pending}</b></button>
        <button class="nav-item" data-view="intake"><span>۰۴</span> ورودی محصول</button>
        <button class="nav-item" data-view="evidence"><span>۰۵</span> شواهد و آمادگی</button>
        <button class="nav-item" data-view="automation"><span>۰۶</span> مرکز خودکارسازی</button>
        <button class="nav-item" data-view="roles"><span>۰۷</span> نقش‌ها</button>
      </nav>
      <div class="mode-card ${snapshot.writable ? "mode-write" : ""}">
        <span class="mode-dot"></span>
        <div><strong>${snapshot.writable ? "حالت اجرایی" : "حالت مشاهده"}</strong><small>${snapshot.writable ? "ثبت تغییرات مجاز است" : "هیچ داده‌ای تغییر نمی‌کند"}</small></div>
      </div>
      <div class="sidebar-footer">
        <span>نسخهٔ داده</span><code>${escapeHtml(snapshot.schemaVersion)}</code>
      </div>
    </aside>

    <main id="workspace" class="workspace">
      <header class="topbar">
        <button class="mobile-menu" aria-label="بازکردن فهرست" aria-expanded="false">☰</button>
        <label class="search"><span aria-hidden="true">⌕</span><input id="global-search" type="search" placeholder="جست‌وجوی کار، نقش یا شناسه…" autocomplete="off"></label>
        <div class="top-actions">
          <button class="icon-button" id="export-button" title="دریافت گزارش داده" aria-label="دریافت گزارش داده">⇩</button>
          <button class="icon-button" id="theme-button" title="تغییر پوسته" aria-label="تغییر پوسته">◐</button>
          <button class="primary-button" id="new-intake-button"><span>＋</span> ورودی جدید</button>
        </div>
      </header>

      <section class="view active" data-panel="overview">
        <div class="hero reveal">
          <div class="hero-copy">
            <div class="eyebrow"><span class="live-dot"></span>${live ? "همگام با پروژه" : "تصویر ثبت‌شده از پروژه"}</div>
            <h1>صبح بخیر، مالک محصول.</h1>
            <p>${escapeHtml(snapshot.project.vision)}</p>
            <div class="hero-actions">
              <button class="primary-button" id="run-cycle-button" ${snapshot.writable ? "" : "disabled"}>اجرای چرخهٔ محصول</button>
              <button class="secondary-button" data-jump="tasks">مشاهدهٔ جریان کار</button>
            </div>
          </div>
          <div class="hero-orbit" aria-label="پیشرفت کل محصول ${completion} درصد">
            <div class="orbit-ring" style="--progress:${completion * 3.6}deg"><div><strong>${toPersianNumber(completion)}٪</strong><span>پیشرفت کل</span></div></div>
            <span class="orbit-chip chip-one">ایده</span><span class="orbit-chip chip-two">توسعه</span><span class="orbit-chip chip-three">انتشار</span>
          </div>
        </div>

        <div class="metric-grid">
          ${metricCard("کارهای فعال", activeTasks, "از " + snapshot.metrics.totals.tasks + " کار", "ink", "↗")}
          ${metricCard("منتظر تصمیم شما", pending, pending ? "نیازمند توجه" : "صف تصمیم خالی است", pending ? "coral" : "mint", "!")}
          ${metricCard("پوشش شواهد", `${evidence}٪`, evidence >= 80 ? "وضعیت سالم" : "قابل بهبود", evidence >= 80 ? "mint" : "amber", "✓")}
          ${metricCard("کارهای مسدود", snapshot.metrics.totals.blocked, snapshot.metrics.totals.overdue + " کار عقب‌افتاده", snapshot.metrics.totals.blocked ? "amber" : "blue", "◆")}
        </div>

        <div class="dashboard-grid">
          <article class="panel flow-panel reveal">
            <div class="panel-head"><div><span class="kicker">جریان ارزش</span><h2>از ایده تا انتشار</h2></div><button class="text-button" data-jump="tasks">جزئیات ←</button></div>
            <div id="flow-lane" class="flow-lane"></div>
          </article>
          <article class="panel attention-panel reveal">
            <div class="panel-head"><div><span class="kicker">تمرکز امروز</span><h2>نیازمند توجه</h2></div><span class="count-badge">${toPersianNumber(pending + snapshot.metrics.totals.blocked)}</span></div>
            <div id="attention-list" class="attention-list"></div>
          </article>
          <article class="panel evidence-panel reveal">
            <div class="panel-head"><div><span class="kicker">اعتماد به تصمیم</span><h2>سلامت شواهد</h2></div><strong>${toPersianNumber(evidence)}٪</strong></div>
            <div class="evidence-meter"><i style="width:${evidence}%"></i></div>
            <div class="evidence-stats"><span><b>${toPersianNumber(snapshot.metrics.totals.completed)}</b> تکمیل‌شده</span><span><b>${toPersianNumber(snapshot.readiness.verificationTasksDone)}</b> راستی‌آزمایی‌شده</span><span><b>${toPersianNumber(snapshot.risks.length)}</b> ریسک باز</span></div>
          </article>
          <article class="panel roles-mini-panel reveal">
            <div class="panel-head"><div><span class="kicker">تیم عامل‌ها</span><h2>فعالیت نقش‌ها</h2></div><button class="text-button" data-jump="roles">همهٔ نقش‌ها ←</button></div>
            <div id="roles-mini" class="role-strip"></div>
          </article>
        </div>
      </section>

      <section class="view" data-panel="tasks">
        ${sectionIntro("تابلوی کار", "هر کار، مالک، وابستگی و مدرک روشن دارد.", "TASK FLOW")}
        <div class="toolbar panel"><label>وضعیت<select id="status-filter"><option value="">همه</option>${statusOptions}</select></label><label>اولویت<select id="priority-filter"><option value="">همه</option><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select></label><span id="task-result-count"></span></div>
        <div id="kanban" class="kanban"></div>
      </section>

      <section class="view" data-panel="approvals">
        ${sectionIntro("مرکز تصمیم‌های انسانی", "زمینه، شواهد، ریسک و پیشنهاد را کنار هم ببینید؛ سپس تصمیمی ماندگار ثبت کنید.", "HUMAN GATES")}
        <div id="approval-grid" class="approval-grid"></div>
      </section>

      <section class="view" data-panel="intake">
        ${sectionIntro("ورودی محصول", "ایده، بازخورد، یافته و رخداد را یک‌جا وارد و ردیابی کنید.", "UNIFIED INTAKE")}
        <div class="panel table-panel"><div class="panel-head"><h2>آخرین ورودی‌ها</h2><button class="primary-button" data-open-intake>ثبت ورودی</button></div><div class="table-wrap"><table><thead><tr><th>شناسه</th><th>عنوان</th><th>نوع</th><th>وضعیت</th><th>زمان ثبت</th></tr></thead><tbody id="intake-table"></tbody></table></div></div>
      </section>

      <section class="view" data-panel="evidence">
        ${sectionIntro("شواهد و آمادگی انتشار", "پیش از اعلام آمادگی، زنجیرهٔ مدرک، راستی‌آزمایی و تصمیم انسانی را کنترل کنید.", "EVIDENCE CHAIN")}
        <div class="readiness-grid">
          <article class="panel readiness-score"><span class="kicker">امتیاز آمادگی</span><div class="big-score">${toPersianNumber(readinessScore(snapshot))}<small>/ ۱۰۰</small></div><p>${readinessMessage(snapshot)}</p></article>
          <article class="panel gate-list"><div class="panel-head"><h2>دروازه‌های انتشار</h2></div>${gateRow("پوشش شواهد", evidence >= 80, `${evidence}٪`)}${gateRow("راستی‌آزمایی مستقل", snapshot.readiness.verificationTasks === snapshot.readiness.verificationTasksDone, `${snapshot.readiness.verificationTasksDone}/${snapshot.readiness.verificationTasks}`)}${gateRow("تصمیم‌های انسانی", pending === 0, pending ? `${pending} باز` : "کامل")}${gateRow("کار مسدود", snapshot.metrics.totals.blocked === 0, `${snapshot.metrics.totals.blocked} مورد`)}</article>
          <article class="panel risk-list"><div class="panel-head"><h2>ریسک‌های باز</h2><span class="count-badge">${toPersianNumber(snapshot.risks.length)}</span></div><div id="risk-list"></div></article>
        </div>
      </section>

      <section class="view" data-panel="roles">
        ${sectionIntro("نقش‌ها و مرز مسئولیت", "فعالیت هر نقش را بدون شکستن استقلال تولیدکننده و راستی‌آزما ببینید.", "13 ROLE BOUNDARIES")}
        <div id="role-grid" class="role-grid"></div>
      </section>

      <section class="view" data-panel="automation">
        ${sectionIntro("مرکز خودکارسازی", "شفاف ببینید چه چیزی آماده است، چه عاملی توان اجرا دارد و چرخه دقیقاً در کدام نقطه ایستاده است.", "AUTOMATION CONTROL")}
        ${automationPanel(snapshot.automation, snapshot.autopilot, snapshot.writable)}
      </section>
    </main>
  </div>

  <div class="drawer-backdrop" id="drawer-backdrop"></div>
  <aside class="drawer" id="detail-drawer" aria-hidden="true" aria-labelledby="drawer-title"><button class="drawer-close" aria-label="بستن">×</button><div id="drawer-content"></div></aside>
  <dialog id="intake-dialog"><form id="intake-form"><button type="button" class="dialog-close" aria-label="بستن">×</button><span class="kicker">ورودی تازه</span><h2>چه چیزی وارد چرخهٔ محصول می‌شود؟</h2><label>نوع<select name="type" required><option value="new_idea">ایدهٔ جدید</option><option value="feedback">بازخورد</option><option value="user_finding">یافتهٔ کاربر</option><option value="incident">رخداد</option><option value="request">درخواست</option></select></label><label>عنوان<input name="title" required maxlength="160" placeholder="یک عنوان روشن و کوتاه"></label><label>شرح<textarea name="description" required maxlength="4000" rows="5" placeholder="مسئله، کاربر و نتیجهٔ مورد انتظار را توضیح دهید"></textarea></label><label>منبع<input name="source" required maxlength="240" placeholder="مصاحبه، پشتیبانی، تحلیل یا مشاهده"></label><label>اولویت<select name="priority"><option>P2</option><option>P0</option><option>P1</option><option>P3</option></select></label><button class="primary-button full-button" type="submit" ${snapshot.writable ? "" : "disabled"}>ثبت در چرخه</button><p class="form-note">${snapshot.writable ? "این ورودی در سابقهٔ پروژه ثبت می‌شود." : "برای ثبت، پنل را در حالت اجرایی باز کنید."}</p></form></dialog>
  <div id="toast-region" class="toast-region" aria-live="polite"></div>
  <script nonce="${renderNonce}">window.__PRODUCT_OPS__=${safeSnapshot};window.__PRODUCT_OPS_LIVE__=${live};</script>
  <script nonce="${renderNonce}">${clientScript()}</script>
</body></html>\n`;
}

function metricCard(label, value, hint, tone, icon) {
  return `<article class="metric-card reveal"><span class="metric-icon ${tone}">${icon}</span><div><small>${label}</small><strong>${toPersianNumber(value)}</strong><p>${toPersianNumber(hint)}</p></div></article>`;
}

function sectionIntro(title, description, eyebrow) {
  return `<div class="section-intro reveal"><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div>`;
}

function gateRow(label, passed, value) {
  return `<div class="gate-row"><span class="gate-state ${passed ? "passed" : "waiting"}">${passed ? "✓" : "!"}</span><div><strong>${label}</strong><small>${value}</small></div></div>`;
}

function automationPanel(automation = {}, autopilot = {}, writable = false) {
  const codex = automation.codex ?? {};
  const providerReady = Boolean(codex.canAutomate);
  const executorsReady = Boolean(automation.executorsEnabled);
  const schedulerReady = Boolean(automation.continuousOrchestrator);
  const status = automationStatusLabel(automation.status);
  const cycle = autopilot.state ?? {};
  const events = (autopilot.events ?? []).slice(-8).reverse();
  const report = autopilot.latestReport ?? null;
  return `<div class="automation-grid">
    <article class="panel automation-summary"><div class="panel-head"><div><span class="kicker">وضعیت واقعی</span><h2>${escapeHtml(status)}</h2></div><span class="automation-light ${executorsReady ? "ready" : "waiting"}"></span></div><p>${escapeHtml(automation.currentCapability || "وضعیت ثبت نشده است.")}</p><div class="automation-path">${automationStep("چرخهٔ محصول", automation.productCycle === "initialized", "ایده به وظایف وابسته و نقش‌محور تبدیل می‌شود")}${automationStep("موتور کدکس", providerReady, codex.message || "اتصال بررسی نشده است")}${automationStep("عامل‌های محصول", providerReady && schedulerReady, schedulerReady ? "تحلیل، قرارداد، کنترل کیفیت و گزارش را انجام می‌دهند" : "منتظر فعال‌شدن هماهنگ‌کننده‌اند")}${automationStep("عامل‌های توسعه", executorsReady, executorsReady ? "پانزده مرز مهندسی وابسته به اثر کار فعال‌اند" : "هنوز فعال نشده‌اند")}${automationStep("همگام‌سازی قرارداد و دفترکار", schedulerReady, schedulerReady ? "نتیجه و شواهد دوطرفه ثبت می‌شوند" : "هنوز نیازمند فرمان صریح است")}</div></article>
    <article class="panel automation-details"><div class="panel-head"><div><span class="kicker">موتور هوشمند</span><h2>کدکس</h2></div><span class="status-pill">${escapeHtml(codex.authenticationMode || "بدون اتصال")}</span></div>${detailRow("نصب", codex.installed ? "پیدا شد" : "پیدا نشد")}${detailRow("اجرای خط فرمان", codex.executableUsable ? "سالم" : "آماده نیست")}${detailRow("ورود", codex.authenticated ? "معتبر" : "نیازمند ورود")}${detailRow("نسخه", codex.version || "نامشخص")}${detailRow("اشتراک", "نوع اشتراک از خط فرمان خوانده نمی‌شود")}</article>
    <article class="panel automation-next"><span class="kicker">قدم بعدی سامانه</span><h2>چرخهٔ بعدی بازخورد</h2><p>${escapeHtml(automation.nextCapability || "ثبت بازخورد و آغاز چرخهٔ بعدی")}</p><div class="notice-line">انتشار زنده، عملیات مخرب و دسترسی به دادهٔ واقعی همچنان به تأیید جداگانه نیاز دارند.</div></article>
    <article class="panel autopilot-live"><div class="panel-head"><div><span class="kicker">اجرای زنده</span><h2 id="autopilot-status">${escapeHtml(autopilotStatusLabel(cycle.status))}</h2></div><span class="status-pill" id="autopilot-phase">${escapeHtml(cycle.phase || "idle")}</span></div><div class="autopilot-now"><div><small>نقش فعال</small><strong id="autopilot-role">${escapeHtml(cycle.currentRoleId || "—")}</strong></div><div><small>کار فعال</small><strong id="autopilot-task">${escapeHtml(cycle.currentTaskId || "—")}</strong></div><div><small>تلاش</small><strong id="autopilot-attempt">${toPersianNumber(cycle.attempt ?? 0)}</strong></div></div><p class="autopilot-error" id="autopilot-error">${escapeHtml(cycle.lastError || "")}</p><div class="autopilot-actions"><button class="primary-button" id="autopilot-start" ${writable ? "" : "disabled"}>شروع یا ادامه</button><button class="secondary-button" id="autopilot-pause" ${writable ? "" : "disabled"}>توقف امن</button><button class="secondary-button" id="autopilot-retry" ${writable ? "" : "disabled"}>تلاش دوباره</button></div><div class="autopilot-events" id="autopilot-events">${renderAutopilotEvents(events)}</div></article>
    ${autopilotReport(report)}
  </div>`;
}

function autopilotReport(report) {
  const implementation = report?.implementation ?? {};
  const changes = implementation.changedComponents ?? [];
  const risks = report?.knownRisks ?? [];
  return `<article class="panel autopilot-report" id="autopilot-report"><div class="panel-head"><div><span class="kicker">گزارش قابل تحویل</span><h2>${report ? escapeHtml(report.idea?.title || "نتیجهٔ چرخه") : "پس از پایان چرخه نمایش داده می‌شود"}</h2></div><span class="status-pill">${report ? "آماده" : "در انتظار"}</span></div>${report ? `<p>${escapeHtml(report.acceptance || "چرخه تکمیل شد.")}</p><div class="report-columns"><div><small>تغییرات</small>${renderReportItems(changes, "تغییری گزارش نشده است.")}</div><div><small>ریسک‌های باز</small>${renderReportItems(risks, "ریسک بازی گزارش نشده است.")}</div></div><div class="report-meta">شناسهٔ چرخه: <bdi>${escapeHtml(report.cycleId || "—")}</bdi></div>` : `<p>تحلیل محصول، نتیجهٔ توسعه، شواهد، کنترل کیفیت و ریسک‌های باز در این بخش جمع‌بندی می‌شوند.</p>`}</article>`;
}

function renderReportItems(items, empty) {
  if (!items.length) return `<div class="empty-state">${empty}</div>`;
  return `<ul>${items.slice(0, 12).map((item) => `<li><bdi>${escapeHtml(item)}</bdi></li>`).join("")}</ul>`;
}

function renderAutopilotEvents(events) {
  if (!events.length) return `<div class="empty-state">هنوز رویداد اجرایی ثبت نشده است.</div>`;
  return events.map((event) => `<div class="autopilot-event"><span></span><div><strong>${escapeHtml(event.message || event.type)}</strong><small>${escapeHtml([event.roleId, event.taskId, event.at].filter(Boolean).join(" · "))}</small></div></div>`).join("");
}

function autopilotStatusLabel(status) {
  return ({ idle: "آمادهٔ دریافت ایده", running: "در حال اجرا", paused: "متوقف‌شده", waiting_for_human: "منتظر تصمیم انسانی", completed: "چرخه کامل شد", blocked: "مسدودشده", failed: "در انتظار تلاش دوباره" })[status] ?? "آمادهٔ راه‌اندازی";
}

function automationStep(label, passed, description) {
  return `<div class="automation-step"><span class="gate-state ${passed ? "passed" : "waiting"}">${passed ? "✓" : "!"}</span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></div></div>`;
}

function detailRow(label, value) {
  return `<div class="detail-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function automationStatusLabel(status) {
  return ({
    "not-configured": "خودکارسازی پیکربندی نشده",
    manual: "اجرای دستی و کنترل‌شده",
    checking: "در حال بررسی اتصال",
    "provider-ready": "کدکس آمادهٔ اتصال است",
    "executors-ready": "اجراگرهای توسعه آماده‌اند"
  })[status] ?? "وضعیت ناشناخته";
}

function readinessScore(snapshot) {
  const checks = [
    snapshot.metrics.ratios.evidenceCoverage,
    snapshot.readiness.pendingApprovals === 0 ? 1 : 0,
    snapshot.readiness.blockedTasks === 0 ? 1 : 0,
    snapshot.readiness.verificationTasks === 0 ? 0.5 : snapshot.readiness.verificationTasksDone / snapshot.readiness.verificationTasks
  ];
  return Math.round((checks.reduce((sum, value) => sum + value, 0) / checks.length) * 100);
}

function readinessMessage(snapshot) {
  const score = readinessScore(snapshot);
  if (score >= 90) return "زنجیرهٔ تصمیم و شواهد به آستانهٔ آمادگی نزدیک است.";
  if (score >= 65) return "مسیر سالم است، اما چند دروازه پیش از انتشار باقی مانده است.";
  return "برای انتشار زود است؛ ابتدا تصمیم‌ها، انسدادها و شواهد ناقص را ببندید.";
}

function randomNonce(seed) {
  return Buffer.from(String(seed)).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || "productops";
}

function toPersianNumber(value) {
  return String(value ?? "").replace(/[0-9]/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function styles() {
  return `
  :root{--bg:#f4f1e9;--surface:#fffdf8;--surface-2:#eee9de;--ink:#15273f;--muted:#6e756f;--line:#dcd7cb;--coral:#f26b4f;--mint:#67b99a;--blue:#4c82c3;--amber:#e1a64a;--shadow:0 18px 55px rgba(36,45,45,.09);--radius:24px;--sidebar:252px;color-scheme:light;font-family:Vazirmatn,"Segoe UI",Tahoma,sans-serif}
  [data-theme="dark"]{--bg:#0e1825;--surface:#152438;--surface-2:#1e3046;--ink:#edf3ed;--muted:#9eadb7;--line:#2d4055;--shadow:0 18px 55px rgba(0,0,0,.2);color-scheme:dark}
  *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);min-height:100vh;overflow-x:hidden}button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.46}code{direction:ltr;unicode-bidi:isolate;font-family:"Cascadia Code",Consolas,monospace}.skip-link{position:fixed;top:-60px;right:16px;background:var(--ink);color:var(--surface);padding:12px 18px;border-radius:12px;z-index:100}.skip-link:focus{top:16px}.ambient{position:fixed;border-radius:999px;filter:blur(1px);opacity:.35;pointer-events:none}.ambient-one{width:420px;height:420px;background:#f2c5a7;top:-220px;right:18%}.ambient-two{width:350px;height:350px;background:#b9d9cc;left:-160px;bottom:-150px}.shell{display:grid;grid-template-columns:var(--sidebar) minmax(0,1fr);min-height:100vh}.sidebar{position:fixed;inset:0 auto 0 0;width:var(--sidebar);background:var(--ink);color:#f7f4eb;padding:28px 20px;display:flex;flex-direction:column;z-index:20;direction:rtl}.brand{display:flex;align-items:center;gap:12px;padding:0 8px 30px;border-bottom:1px solid rgba(255,255,255,.12);direction:ltr}.brand span:last-child{display:flex;flex-direction:column}.brand strong{font-size:18px;letter-spacing:.02em}.brand small{font-size:10px;opacity:.62;letter-spacing:.14em;text-transform:uppercase}.brand-mark{position:relative;width:38px;height:38px;display:grid;place-items:center}.brand-mark i{position:absolute;width:9px;height:28px;border-radius:8px;background:var(--coral);transform:rotate(30deg)}.brand-mark i:nth-child(2){background:#f6c95d;transform:rotate(150deg)}.brand-mark i:nth-child(3){background:#8bc9b1;transform:rotate(270deg)}.nav{display:grid;gap:6px;margin-top:28px}.nav-item{border:0;background:transparent;color:rgba(255,255,255,.67);display:grid;grid-template-columns:34px 1fr auto;align-items:center;text-align:right;padding:12px 10px;border-radius:14px;transition:.2s}.nav-item span{direction:ltr;font-size:10px;letter-spacing:.08em;opacity:.6}.nav-item b{background:var(--coral);color:white;min-width:22px;height:22px;display:grid;place-items:center;border-radius:99px;font-size:11px}.nav-item:hover,.nav-item.active{background:rgba(255,255,255,.11);color:white;transform:translateX(-2px)}.mode-card{margin-top:auto;border:1px solid rgba(255,255,255,.13);border-radius:16px;padding:13px;display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.06)}.mode-card div{display:flex;flex-direction:column}.mode-card strong{font-size:13px}.mode-card small{font-size:10px;opacity:.65;margin-top:3px}.mode-dot{width:10px;height:10px;border-radius:50%;background:#c5aa78;box-shadow:0 0 0 5px rgba(197,170,120,.12)}.mode-write .mode-dot{background:#77d4ad;box-shadow:0 0 0 5px rgba(119,212,173,.13)}.sidebar-footer{display:flex;justify-content:space-between;font-size:10px;opacity:.55;padding:18px 5px 0}.workspace{grid-column:2;padding:0 42px 60px;max-width:1680px;width:100%;margin-inline:auto;position:relative}.topbar{height:88px;display:flex;align-items:center;justify-content:space-between;gap:18px}.search{display:flex;align-items:center;gap:8px;min-width:260px;max-width:500px;flex:1;background:rgba(255,255,255,.54);border:1px solid var(--line);border-radius:14px;padding:0 14px;backdrop-filter:blur(10px)}[data-theme="dark"] .search{background:rgba(21,36,56,.7)}.search input{border:0;background:transparent;outline:0;width:100%;padding:11px;color:var(--ink)}.top-actions{display:flex;gap:9px}.icon-button,.secondary-button,.primary-button,.text-button{border:0;border-radius:13px;transition:.2s}.icon-button{width:42px;height:42px;background:var(--surface);color:var(--ink);border:1px solid var(--line);box-shadow:0 5px 18px rgba(20,35,40,.04)}.primary-button{background:var(--ink);color:#fffdf8;padding:11px 17px;box-shadow:0 8px 24px rgba(21,39,63,.18)}.secondary-button{background:transparent;color:var(--ink);border:1px solid var(--line);padding:10px 16px}.text-button{background:transparent;color:var(--blue);padding:7px}.primary-button:hover:not(:disabled),.icon-button:hover,.secondary-button:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(21,39,63,.14)}.mobile-menu{display:none}.view{display:none}.view.active{display:block}.hero{min-height:320px;border-radius:32px;background:var(--surface);box-shadow:var(--shadow);border:1px solid var(--line);padding:42px 48px;display:flex;align-items:center;justify-content:space-between;overflow:hidden;position:relative}.hero:after{content:"";position:absolute;width:250px;height:250px;background:var(--surface-2);border-radius:48% 52% 35% 65%;left:-85px;top:-90px;transform:rotate(18deg)}.hero-copy{max-width:660px;position:relative;z-index:1}.eyebrow,.kicker{font-size:11px;letter-spacing:.11em;color:var(--coral);font-weight:800;text-transform:uppercase}.live-dot{display:inline-block;width:7px;height:7px;background:var(--mint);border-radius:50%;margin-left:8px;animation:pulse 2s infinite}.hero h1,.section-intro h1{font-size:clamp(34px,4vw,58px);line-height:1.13;margin:14px 0 12px;letter-spacing:-.04em}.hero p{max-width:600px;color:var(--muted);line-height:1.9;margin:0}.hero-actions{display:flex;gap:10px;margin-top:28px}.hero-orbit{width:230px;height:230px;display:grid;place-items:center;position:relative;z-index:2;margin-left:30px}.orbit-ring{width:170px;height:170px;border-radius:50%;padding:13px;background:conic-gradient(var(--coral) var(--progress),var(--surface-2) 0);animation:float 5s ease-in-out infinite}.orbit-ring>div{width:100%;height:100%;border-radius:50%;background:var(--surface);display:grid;place-content:center;text-align:center}.orbit-ring strong{font-size:35px}.orbit-ring span{font-size:11px;color:var(--muted)}.orbit-chip{position:absolute;background:var(--ink);color:#fff;padding:7px 11px;border-radius:99px;font-size:10px;box-shadow:0 8px 20px rgba(21,39,63,.18)}.chip-one{top:23px;right:0}.chip-two{bottom:24px;right:8px;background:var(--coral)}.chip-three{left:-4px;top:96px;background:var(--mint);color:#102c27}.metric-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin:18px 0}.metric-card{background:var(--surface);border:1px solid var(--line);border-radius:19px;padding:19px;display:flex;gap:14px;align-items:center}.metric-card small,.metric-card p{display:block;color:var(--muted);font-size:11px;margin:0}.metric-card strong{display:block;font-size:27px;margin:2px 0}.metric-icon{width:42px;height:42px;display:grid;place-items:center;border-radius:14px;background:var(--surface-2);font-weight:900}.metric-icon.coral{background:#fde4dd;color:#bb4b34}.metric-icon.mint{background:#dff2e9;color:#27775c}.metric-icon.blue{background:#dfebf7;color:#34689f}.metric-icon.amber{background:#faedcf;color:#8b641e}.dashboard-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(300px,.8fr);gap:16px}.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:24px}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.panel h2{font-size:19px;margin:4px 0 0}.flow-panel{grid-column:1}.attention-panel{grid-column:2;grid-row:1 / span 2}.evidence-panel,.roles-mini-panel{min-height:190px}.count-badge{background:var(--surface-2);min-width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-size:12px}.flow-lane{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;position:relative;padding-top:8px}.flow-step{position:relative;text-align:center}.flow-step:before{content:"";position:absolute;height:2px;background:var(--line);right:50%;left:-50%;top:18px}.flow-step:first-child:before{display:none}.flow-node{width:36px;height:36px;border-radius:13px;background:var(--surface-2);border:1px solid var(--line);display:grid;place-items:center;margin:0 auto 9px;position:relative;z-index:1;font-size:11px;font-weight:800}.flow-step.complete .flow-node{background:var(--mint);color:#0c3126;border-color:transparent}.flow-step.active .flow-node{background:var(--coral);color:white;border-color:transparent;box-shadow:0 0 0 6px rgba(242,107,79,.12)}.flow-step span{font-size:10px;color:var(--muted)}.attention-list{display:grid;gap:10px}.attention-item{border:1px solid var(--line);border-radius:15px;padding:13px;background:var(--bg);display:flex;gap:10px;align-items:flex-start}.attention-item i{width:8px;height:8px;border-radius:50%;background:var(--amber);margin-top:7px}.attention-item.approval i{background:var(--coral)}.attention-item div{min-width:0}.attention-item strong{font-size:12px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.attention-item small{color:var(--muted);font-size:10px}.empty-state{color:var(--muted);text-align:center;padding:24px 10px;font-size:12px}.evidence-meter{height:9px;background:var(--surface-2);border-radius:99px;overflow:hidden}.evidence-meter i{display:block;height:100%;background:var(--mint);border-radius:99px}.evidence-stats{display:flex;justify-content:space-between;gap:10px;margin-top:20px}.evidence-stats span{font-size:10px;color:var(--muted)}.evidence-stats b{display:block;color:var(--ink);font-size:17px}.role-strip{display:flex;align-items:center;padding-top:9px}.role-avatar{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:var(--ink);color:white;border:3px solid var(--surface);font-size:10px;font-weight:800;margin-left:-8px}.role-avatar:nth-child(3n+2){background:var(--coral)}.role-avatar:nth-child(3n){background:var(--mint);color:#15352d}.role-more{font-size:11px;color:var(--muted);margin-right:14px}.section-intro{padding:42px 5px 28px}.section-intro h1{font-size:42px;margin:8px 0}.section-intro p{color:var(--muted);margin:0}.toolbar{display:flex;align-items:end;gap:16px;margin-bottom:16px;padding:16px}.toolbar label{display:grid;gap:5px;color:var(--muted);font-size:10px}.toolbar select,dialog input,dialog select,dialog textarea,.drawer input,.drawer textarea{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:11px;padding:9px 12px;outline:none}.toolbar span{margin-right:auto;color:var(--muted);font-size:11px}.kanban{display:grid;grid-template-columns:repeat(4,minmax(260px,1fr));gap:13px;overflow:auto;padding-bottom:14px}.kanban-column{min-height:450px;background:color-mix(in srgb,var(--surface) 60%,transparent);border:1px solid var(--line);border-radius:21px;padding:13px}.kanban-head{display:flex;align-items:center;justify-content:space-between;padding:4px 4px 13px}.kanban-head strong{font-size:13px}.kanban-head span{font-size:10px;color:var(--muted)}.task-card{background:var(--surface);border:1px solid var(--line);border-radius:17px;padding:15px;margin-bottom:10px;box-shadow:0 7px 20px rgba(20,35,40,.04);transition:.2s}.task-card:hover{transform:translateY(-3px);box-shadow:0 12px 26px rgba(20,35,40,.1)}.task-meta{display:flex;align-items:center;justify-content:space-between;gap:8px}.task-meta code{font-size:9px;color:var(--muted)}.priority{padding:3px 7px;border-radius:99px;background:var(--surface-2);font-size:9px}.priority.P0,.priority.P1{background:#fde4dd;color:#9e3521}.task-card h3{font-size:13px;line-height:1.7;margin:11px 0 14px}.task-footer{display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:10px}.role-pill,.status-pill{padding:4px 8px;border-radius:99px;background:var(--surface-2);direction:ltr;unicode-bidi:isolate}.approval-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:15px}.approval-card{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:23px;position:relative;overflow:hidden}.approval-card.pending:before{content:"";position:absolute;inset:0 0 auto;height:4px;background:var(--coral)}.approval-card h2{font-size:16px;line-height:1.8;margin:14px 0 8px}.approval-card p{color:var(--muted);font-size:12px;line-height:1.8;min-height:42px}.approval-actions{display:flex;gap:8px;margin-top:18px}.approval-actions button{flex:1}.table-panel{padding:0;overflow:hidden}.table-panel .panel-head{padding:21px 23px;margin:0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:14px 22px;text-align:right;border-top:1px solid var(--line);white-space:nowrap}th{font-size:10px;color:var(--muted);background:var(--bg)}td{font-size:12px}.readiness-grid{display:grid;grid-template-columns:.7fr 1fr 1.2fr;gap:15px}.big-score{font-size:58px;font-weight:800;letter-spacing:-.05em;margin:22px 0 5px}.big-score small{font-size:14px;color:var(--muted)}.readiness-score p{color:var(--muted);font-size:12px;line-height:1.8}.gate-row{display:flex;align-items:center;gap:11px;border-top:1px solid var(--line);padding:13px 0}.gate-row:first-of-type{border-top:0}.gate-state{width:28px;height:28px;display:grid;place-items:center;border-radius:10px;font-weight:800}.gate-state.passed{background:#dff2e9;color:#27775c}.gate-state.waiting{background:#faedcf;color:#8b641e}.gate-row div{display:flex;flex-direction:column}.gate-row strong{font-size:12px}.gate-row small{color:var(--muted);font-size:10px}.risk-item{padding:13px 0;border-top:1px solid var(--line)}.risk-item:first-child{border:0}.risk-item header{display:flex;justify-content:space-between;gap:10px}.risk-item strong{font-size:12px}.risk-item p{font-size:10px;color:var(--muted);line-height:1.7;margin:6px 0 0}.risk-level{font-size:9px;padding:4px 8px;border-radius:99px;background:#faedcf;color:#8b641e}.risk-level.high,.risk-level.critical{background:#fde4dd;color:#9e3521}.role-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}.role-card{background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:19px}.role-card header{display:flex;align-items:center;gap:11px}.role-card h2{font-size:14px;margin:0}.role-card code{font-size:9px;color:var(--muted)}.role-bars{display:grid;gap:7px;margin-top:17px}.role-bar{display:grid;grid-template-columns:55px 1fr 24px;align-items:center;gap:8px;font-size:9px;color:var(--muted)}.role-bar i{height:6px;background:var(--surface-2);border-radius:99px;overflow:hidden}.role-bar i:after{content:"";display:block;height:100%;width:var(--width);background:var(--blue);border-radius:99px}.drawer-backdrop{position:fixed;inset:0;background:rgba(8,18,29,.4);backdrop-filter:blur(4px);opacity:0;pointer-events:none;transition:.25s;z-index:39}.drawer-backdrop.open{opacity:1;pointer-events:auto}.drawer{position:fixed;inset:0 0 0 auto;width:min(460px,94vw);background:var(--surface);z-index:40;padding:34px;transform:translateX(105%);transition:.3s;overflow:auto;box-shadow:-20px 0 60px rgba(10,25,35,.18)}.drawer.open{transform:none}.drawer-close,.dialog-close{position:absolute;top:18px;left:18px;border:0;background:var(--surface-2);color:var(--ink);width:36px;height:36px;border-radius:12px;font-size:22px}.drawer h2{font-size:24px;line-height:1.6;margin:20px 0}.detail-list{display:grid;gap:0;margin:20px 0}.detail-row{display:grid;grid-template-columns:110px 1fr;gap:12px;padding:11px 0;border-top:1px solid var(--line)}.detail-row span{color:var(--muted);font-size:10px}.detail-row strong,.detail-row code{font-size:11px;overflow-wrap:anywhere}.decision-form{display:grid;gap:12px;margin-top:24px}.decision-form label{display:grid;gap:6px;font-size:11px;color:var(--muted)}dialog{width:min(560px,92vw);border:1px solid var(--line);border-radius:26px;background:var(--surface);color:var(--ink);padding:0;box-shadow:var(--shadow)}dialog::backdrop{background:rgba(8,18,29,.48);backdrop-filter:blur(5px)}dialog form{padding:34px;display:grid;gap:14px;position:relative}dialog h2{font-size:24px;margin:2px 0 10px}dialog label{display:grid;gap:6px;font-size:11px;color:var(--muted)}.full-button{width:100%;margin-top:8px}.form-note{text-align:center;color:var(--muted);font-size:10px;margin:0}.toast-region{position:fixed;left:24px;bottom:24px;z-index:80;display:grid;gap:8px}.toast{background:var(--ink);color:#fff;padding:13px 17px;border-radius:14px;box-shadow:var(--shadow);font-size:11px;animation:toast-in .25s both}.toast.error{background:#963d2c}.reveal{animation:reveal .5s both}.reveal:nth-child(2){animation-delay:.06s}.reveal:nth-child(3){animation-delay:.12s}
  @keyframes reveal{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}@keyframes pulse{50%{box-shadow:0 0 0 7px rgba(103,185,154,0)}}@keyframes float{50%{transform:translateY(-6px) rotate(2deg)}}@keyframes toast-in{from{opacity:0;transform:translateY(8px)}}
  .automation-grid{display:grid;grid-template-columns:1.35fr .9fr;gap:15px}.automation-summary{grid-row:span 2}.automation-summary>p,.automation-next p{color:var(--muted);line-height:1.9;font-size:12px}.automation-light{width:13px;height:13px;border-radius:50%;background:var(--amber);box-shadow:0 0 0 7px rgba(225,166,74,.13)}.automation-light.ready{background:var(--mint);box-shadow:0 0 0 7px rgba(103,185,154,.13)}.automation-path{display:grid;gap:9px;margin-top:22px}.automation-step{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line)}.automation-step div{display:grid;gap:4px}.automation-step strong{font-size:12px}.automation-step small{font-size:10px;color:var(--muted);line-height:1.7}.automation-details .detail-row{grid-template-columns:120px 1fr}.notice-line{border:1px solid #efd6a5;background:#fff4df;color:#76551c;border-radius:14px;padding:13px;font-size:11px;line-height:1.9;margin-top:18px}[data-theme="dark"] .notice-line{background:#332b1b;border-color:#5b4b29;color:#e9cc91}.autopilot-live,.autopilot-report{grid-column:1/-1}.autopilot-now{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.autopilot-now div{background:var(--bg);border:1px solid var(--line);border-radius:15px;padding:14px}.autopilot-now small{display:block;color:var(--muted);font-size:10px}.autopilot-now strong{display:block;margin-top:6px;direction:ltr;unicode-bidi:isolate}.autopilot-actions{display:flex;gap:9px;margin:18px 0}.autopilot-error{color:var(--coral);font-size:11px;line-height:1.8}.autopilot-events{display:grid;gap:8px}.autopilot-event{display:flex;gap:10px;align-items:flex-start;border-top:1px solid var(--line);padding-top:10px}.autopilot-event>span{width:8px;height:8px;border-radius:50%;background:var(--mint);margin-top:6px}.autopilot-event div{display:grid;gap:3px}.autopilot-event strong{font-size:11px}.autopilot-event small{font-size:9px;color:var(--muted);direction:ltr;unicode-bidi:isolate}.autopilot-report>p{color:var(--muted);line-height:1.9}.report-columns{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px}.report-columns>div{border:1px solid var(--line);background:var(--bg);border-radius:15px;padding:14px}.report-columns small{color:var(--muted)}.report-columns ul{margin:12px 0 0;padding-right:18px;line-height:1.9;font-size:11px}.report-meta{margin-top:14px;color:var(--muted);font-size:10px}.report-meta bdi{direction:ltr;unicode-bidi:isolate}
  @media(max-width:1100px){.metric-grid{grid-template-columns:repeat(2,1fr)}.dashboard-grid{grid-template-columns:1fr}.flow-panel,.attention-panel{grid-column:auto;grid-row:auto}.readiness-grid{grid-template-columns:1fr 1fr}.risk-list{grid-column:1/-1}.hero-orbit{width:190px}.kanban{grid-template-columns:repeat(4,280px)}.automation-grid{grid-template-columns:1fr}}
  @media(max-width:760px){:root{--sidebar:0px}.sidebar{transform:translateX(-105%);transition:.25s;width:260px}.sidebar.open{transform:none}.workspace{grid-column:1;padding:0 16px 40px}.topbar{height:72px}.mobile-menu{display:block;border:0;background:var(--surface);color:var(--ink);width:42px;height:42px;border-radius:13px}.search{min-width:0}.search input{font-size:12px}.top-actions .icon-button{display:none}.primary-button{padding:10px 13px}.hero{padding:29px 24px;min-height:400px}.hero-orbit{position:absolute;opacity:.18;left:-20px;bottom:-25px}.hero h1,.section-intro h1{font-size:34px}.metric-grid{grid-template-columns:1fr 1fr}.metric-card{padding:14px}.metric-icon{display:none}.dashboard-grid{display:block}.panel{margin-bottom:13px}.flow-lane{overflow:auto;grid-template-columns:repeat(6,90px)}.evidence-panel,.roles-mini-panel{min-height:0}.readiness-grid{display:block}.toolbar{overflow:auto}.toolbar span{display:none}.top-actions #new-intake-button span{display:none}.section-intro{padding-top:28px}.report-columns{grid-template-columns:1fr}}
  @media(max-width:480px){.metric-grid{grid-template-columns:1fr}.search{display:none}.hero h1{font-size:31px}.hero-actions{flex-direction:column;align-items:stretch}.evidence-stats{flex-wrap:wrap}.approval-grid{grid-template-columns:1fr}}
  @media(prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.001ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.001ms!important}}
  `;
}

function clientScript() {
  return `
  (()=>{
    const state={snapshot:window.__PRODUCT_OPS__,query:"",status:"",priority:""};
    const $=(selector,root=document)=>root.querySelector(selector);const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
    const fa=(value)=>String(value??"").replace(/[0-9]/g,d=>"۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
    const esc=(value)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    const statusLabels=${JSON.stringify(STATUS_LABELS)};
    const roleColor=(id)=>({"RB-01":"#15273f","RB-02":"#f26b4f","RB-03":"#67b99a","RB-04":"#4c82c3","RB-05":"#e1a64a","RB-06":"#8667a9","RB-07":"#2f8f9d","RB-08":"#c35f78","RB-09":"#4d9275","RB-10":"#68758a","RB-11":"#d07a46","RB-12":"#315f86","RB-13":"#8b6c42"}[id]||"#15273f");
    function render(){renderFlow();renderAttention();renderRoles();renderTasks();renderApprovals();renderIntake();renderRisks();renderAutopilot()}
    function renderAutopilot(){const cycle=state.snapshot.autopilot?.state||{};const labels={idle:'آمادهٔ دریافت ایده',running:'در حال اجرا',paused:'متوقف‌شده',waiting_for_human:'منتظر تصمیم انسانی',completed:'چرخه کامل شد',blocked:'مسدودشده',failed:'در انتظار تلاش دوباره'};$('#autopilot-status').textContent=labels[cycle.status]||'آمادهٔ راه‌اندازی';$('#autopilot-phase').textContent=cycle.phase||'idle';$('#autopilot-role').textContent=cycle.currentRoleId||'—';$('#autopilot-task').textContent=cycle.currentTaskId||'—';$('#autopilot-attempt').textContent=fa(cycle.attempt||0);$('#autopilot-error').textContent=cycle.lastError||'';const events=[...(state.snapshot.autopilot?.events||[])].slice(-8).reverse();$('#autopilot-events').innerHTML=events.length?events.map(event=>'<div class="autopilot-event"><span></span><div><strong>'+esc(event.message||event.type)+'</strong><small>'+esc([event.roleId,event.taskId,event.at].filter(Boolean).join(' · '))+'</small></div></div>').join(''):'<div class="empty-state">هنوز رویداد اجرایی ثبت نشده است.</div>';$('#autopilot-report').outerHTML=reportHtml(state.snapshot.autopilot?.latestReport)}
    function reportHtml(report){if(!report)return '<article class="panel autopilot-report" id="autopilot-report"><div class="panel-head"><div><span class="kicker">گزارش قابل تحویل</span><h2>پس از پایان چرخه نمایش داده می‌شود</h2></div><span class="status-pill">در انتظار</span></div><p>تحلیل محصول، نتیجهٔ توسعه، شواهد، کنترل کیفیت و ریسک‌های باز در این بخش جمع‌بندی می‌شوند.</p></article>';const changes=report.implementation?.changedComponents||[];const risks=report.knownRisks||[];const list=(items,empty)=>items.length?'<ul>'+items.slice(0,12).map(item=>'<li><bdi>'+esc(item)+'</bdi></li>').join('')+'</ul>':'<div class="empty-state">'+empty+'</div>';return '<article class="panel autopilot-report" id="autopilot-report"><div class="panel-head"><div><span class="kicker">گزارش قابل تحویل</span><h2>'+esc(report.idea?.title||'نتیجهٔ چرخه')+'</h2></div><span class="status-pill">آماده</span></div><p>'+esc(report.acceptance||'چرخه تکمیل شد.')+'</p><div class="report-columns"><div><small>تغییرات</small>'+list(changes,'تغییری گزارش نشده است.')+'</div><div><small>ریسک‌های باز</small>'+list(risks,'ریسک بازی گزارش نشده است.')+'</div></div><div class="report-meta">شناسهٔ چرخه: <bdi>'+esc(report.cycleId||'—')+'</bdi></div></article>'}
    function renderFlow(){const groups=[{name:"کشف",roles:["RB-02","RB-03"]},{name:"تصمیم",roles:["RB-04","RB-05"]},{name:"طراحی",roles:["RB-06","RB-07"]},{name:"توسعه",roles:["RB-13"]},{name:"کیفیت",roles:["RB-09","RB-10","RB-12"]},{name:"انتشار",roles:["RB-11"]}];$("#flow-lane").innerHTML=groups.map((group,index)=>{const tasks=state.snapshot.tasks.filter(t=>group.roles.includes(t.owner_role));const done=tasks.length&&tasks.every(t=>t.status==="done");const active=tasks.some(t=>["ready","in_progress","in_review","blocked"].includes(t.status));return '<div class="flow-step '+(done?'complete':active?'active':'')+'"><div class="flow-node">'+fa(index+1)+'</div><span>'+group.name+'</span></div>'}).join("")}
    function renderAttention(){const approvals=state.snapshot.approvals.filter(a=>a.status==="pending").map(a=>({kind:"approval",title:a.question,meta:"تصمیم انسانی · "+a.taskId,action:()=>openApproval(a)}));const blocked=state.snapshot.tasks.filter(t=>t.status==="blocked").map(t=>({kind:"blocked",title:t.title,meta:"مسدود · "+t.owner_role,action:()=>openTask(t)}));const items=[...approvals,...blocked].slice(0,6);$("#attention-list").innerHTML=items.length?items.map((item,i)=>'<button class="attention-item '+item.kind+'" data-attention="'+i+'"><i></i><div><strong>'+esc(item.title)+'</strong><small>'+esc(item.meta)+'</small></div></button>').join(''):'<div class="empty-state">همه‌چیز آرام است؛ مورد فوری ندارید.</div>';$$('[data-attention]').forEach(button=>button.onclick=()=>items[Number(button.dataset.attention)].action())}
    function renderRoles(){const roles=state.snapshot.roleActivity;$("#roles-mini").innerHTML=roles.filter(r=>r.active>0).slice(0,6).map(r=>'<span class="role-avatar" style="background:'+roleColor(r.roleId)+'" title="'+esc(r.name)+'">'+r.roleId+'</span>').join('')+'<span class="role-more">'+fa(roles.filter(r=>r.active>0).length)+' نقش فعال</span>';$("#role-grid").innerHTML=roles.map(r=>{const max=Math.max(1,r.total);return '<article class="role-card"><header><span class="role-avatar" style="background:'+roleColor(r.roleId)+'">'+r.roleId+'</span><div><h2>'+esc(r.name)+'</h2><code>'+esc(r.actorId)+'</code></div></header><div class="role-bars"><span class="role-bar">فعال<i style="--width:'+(r.active/max*100)+'%"></i><b>'+fa(r.active)+'</b></span><span class="role-bar">تکمیل<i style="--width:'+(r.completed/max*100)+'%"></i><b>'+fa(r.completed)+'</b></span><span class="role-bar">کل<i style="--width:100%"></i><b>'+fa(r.total)+'</b></span></div></article>'}).join('')}
    function filteredTasks(){return state.snapshot.tasks.filter(t=>(!state.status||t.status===state.status)&&(!state.priority||t.priority===state.priority)&&(!state.query||[t.task_id,t.title,t.owner_role,t.owner_actor_id,t.event_id].join(' ').toLowerCase().includes(state.query)))}
    function renderTasks(){const tasks=filteredTasks();const columns=[{id:"backlog",label:"صف انتظار",statuses:["backlog"]},{id:"active",label:"در جریان",statuses:["ready","in_progress"]},{id:"review",label:"بازبینی و انسداد",statuses:["in_review","blocked"]},{id:"done",label:"پایان‌یافته",statuses:["done","cancelled"]}];$("#task-result-count").textContent=fa(tasks.length)+' نتیجه';$("#kanban").innerHTML=columns.map(column=>{const matches=tasks.filter(t=>column.statuses.includes(t.status));return '<section class="kanban-column"><div class="kanban-head"><strong>'+column.label+'</strong><span>'+fa(matches.length)+'</span></div>'+matches.map(taskCard).join('')+(matches.length?'':'<div class="empty-state">کاری در این ستون نیست.</div>')+'</section>'}).join('');$$('[data-task]').forEach(card=>card.onclick=()=>openTask(state.snapshot.tasks.find(t=>t.task_id===card.dataset.task)))}
    function taskCard(t){return '<button class="task-card" data-task="'+esc(t.task_id)+'"><div class="task-meta"><code>'+esc(t.task_id)+'</code><span class="priority '+esc(t.priority)+'">'+esc(t.priority)+'</span></div><h3>'+esc(t.title)+'</h3><div class="task-footer"><span class="role-pill">'+esc(t.owner_role)+'</span><span>'+esc(statusLabels[t.status]||t.status)+'</span></div></button>'}
    function renderApprovals(){const approvals=[...state.snapshot.approvals].sort((a,b)=>(a.status==="pending"?-1:1)-(b.status==="pending"?-1:1));$("#approval-grid").innerHTML=approvals.length?approvals.map(a=>'<article class="approval-card '+esc(a.status)+'"><span class="status-pill">'+(a.status==="pending"?'منتظر تصمیم':a.status==="approved"?'تأییدشده':'ردشده')+'</span><h2>'+esc(a.question)+'</h2><p>'+esc(a.context||'برای این تصمیم توضیح تکمیلی ثبت نشده است.')+'</p><div class="task-footer"><code>'+esc(a.requestId)+'</code><span>'+esc(a.gate)+'</span></div><div class="approval-actions"><button class="secondary-button" data-approval="'+esc(a.requestId)+'">دیدن جزئیات</button></div></article>').join(''):'<div class="panel empty-state">هنوز درخواست تأییدی ثبت نشده است.</div>';$$('[data-approval]').forEach(button=>button.onclick=()=>openApproval(state.snapshot.approvals.find(a=>a.requestId===button.dataset.approval)))}
    function renderIntake(){const rows=[...state.snapshot.intake].reverse();$("#intake-table").innerHTML=rows.length?rows.map(r=>'<tr><td><code>'+esc(r.intakeId)+'</code></td><td>'+esc(r.title)+'</td><td><span class="status-pill">'+esc(r.type)+'</span></td><td>'+esc(r.status)+'</td><td><code>'+esc(r.receivedAt||'—')+'</code></td></tr>').join(''):'<tr><td colspan="5" class="empty-state">ورودی ثبت‌شده‌ای وجود ندارد.</td></tr>'}
    function renderRisks(){const risks=state.snapshot.risks;$("#risk-list").innerHTML=risks.length?risks.map(r=>'<div class="risk-item"><header><strong>'+esc(r.title)+'</strong><span class="risk-level '+esc(r.severity)+'">'+esc(r.severity)+'</span></header><p>'+esc(r.detail)+'</p></div>').join(''):'<div class="empty-state">ریسک بازی ثبت نشده است.</div>'}
    function openTask(task){openDrawer('<span class="kicker">جزئیات کار</span><h2>'+esc(task.title)+'</h2><div class="detail-list">'+detail('شناسه','<code>'+esc(task.task_id)+'</code>')+detail('رویداد','<code>'+esc(task.event_id)+'</code>')+detail('مالک',esc(task.owner_role)+' · '+esc(task.owner_actor_id))+detail('وضعیت',esc(statusLabels[task.status]||task.status))+detail('اولویت',esc(task.priority))+detail('وابستگی‌ها','<code>'+esc(task.dependency_ids||'ندارد')+'</code>')+detail('دروازهٔ انسانی',esc(task.human_gate||'ندارد'))+detail('خروجی‌ها',esc(task.canonical_output_refs||'ثبت نشده'))+detail('شواهد',esc(task.evidence_refs||'ثبت نشده'))+'</div>')}
    function openApproval(a){let form='';if(a.status==="pending"){form='<form class="decision-form" id="decision-form"><label>تصمیم<select name="decision"><option value="approved">تأیید</option><option value="rejected">رد</option></select></label><label>شناسهٔ تصمیم‌گیر<input name="actorId" value="'+esc(state.snapshot.project.humanAuthorityActorId)+'" required></label><label>دلیل تصمیم<textarea name="rationale" rows="4" required maxlength="2000"></textarea></label><button class="primary-button" '+(state.snapshot.writable?'':'disabled')+'>ثبت تصمیم ماندگار</button><p class="form-note">'+(state.snapshot.writable?'این تصمیم با نام شما ثبت می‌شود.':'پنل در حالت مشاهده است.')+'</p></form>'}openDrawer('<span class="kicker">دروازهٔ انسانی</span><h2>'+esc(a.question)+'</h2><p>'+esc(a.context||'بدون زمینهٔ تکمیلی')+'</p><div class="detail-list">'+detail('درخواست','<code>'+esc(a.requestId)+'</code>')+detail('کار','<code>'+esc(a.taskId)+'</code>')+detail('دروازه',esc(a.gate))+detail('پیشنهاد',esc(a.recommendedOption||'بدون پیشنهاد'))+detail('شواهد',esc((a.evidenceRefs||[]).join('، ')||'ثبت نشده'))+detail('ریسک‌ها',esc((a.risks||[]).join('، ')||'ثبت نشده'))+'</div>'+form);const decision=$("#decision-form");if(decision)decision.onsubmit=async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(decision));await api('/api/approvals/'+encodeURIComponent(a.requestId)+'/decision',data);closeDrawer();await refresh();toast('تصمیم شما ثبت شد.')}}
    function detail(label,value){return '<div class="detail-row"><span>'+label+'</span><strong>'+value+'</strong></div>'}
    function openDrawer(html){$("#drawer-content").innerHTML=html;$("#detail-drawer").classList.add('open');$("#drawer-backdrop").classList.add('open');$("#detail-drawer").setAttribute('aria-hidden','false')}
    function closeDrawer(){$("#detail-drawer").classList.remove('open');$("#drawer-backdrop").classList.remove('open');$("#detail-drawer").setAttribute('aria-hidden','true')}
    function switchView(name){$$('.nav-item').forEach(item=>item.classList.toggle('active',item.dataset.view===name));$$('.view').forEach(panel=>panel.classList.toggle('active',panel.dataset.panel===name));$('.sidebar').classList.remove('open');window.scrollTo({top:0,behavior:'smooth'})}
    async function api(url,body){if(!window.__PRODUCT_OPS_LIVE__)throw new Error('این تصویر به سرور محلی متصل نیست.');const response=await fetch(url,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-product-ops-csrf':$('meta[name="product-ops-csrf"]').content},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw new Error(data.error||'درخواست انجام نشد.');return data}
    async function refresh(){if(!window.__PRODUCT_OPS_LIVE__)return;const data=await api('/api/snapshot');state.snapshot=data;render()}
    function toast(message,error=false){const item=document.createElement('div');item.className='toast'+(error?' error':'');item.textContent=message;$('#toast-region').append(item);setTimeout(()=>item.remove(),4200)}
    $$('.nav-item').forEach(item=>item.onclick=()=>switchView(item.dataset.view));$$('[data-jump]').forEach(item=>item.onclick=()=>switchView(item.dataset.jump));$('.mobile-menu').onclick=()=>$('.sidebar').classList.toggle('open');$('#drawer-backdrop').onclick=closeDrawer;$('.drawer-close').onclick=closeDrawer;
    $('#global-search').oninput=event=>{state.query=event.target.value.trim().toLowerCase();if(state.query)switchView('tasks');renderTasks()};$('#status-filter').onchange=event=>{state.status=event.target.value;renderTasks()};$('#priority-filter').onchange=event=>{state.priority=event.target.value;renderTasks()};
    const intakeDialog=$('#intake-dialog');function openIntake(){intakeDialog.showModal()}$('#new-intake-button').onclick=openIntake;$$('[data-open-intake]').forEach(button=>button.onclick=openIntake);$('.dialog-close').onclick=()=>intakeDialog.close();
    $('#intake-form').onsubmit=async event=>{event.preventDefault();try{const data=Object.fromEntries(new FormData(event.currentTarget));await api('/api/intake',data);intakeDialog.close();event.currentTarget.reset();await refresh();toast('ورودی تازه با موفقیت ثبت شد.')}catch(error){toast(error.message,true)}};
    $('#run-cycle-button').onclick=async()=>{try{const route=state.snapshot.automation?.continuousOrchestrator?'/api/autopilot/resume':'/api/operate';await api(route,{});await refresh();toast('چرخهٔ محصول شروع یا ادامه داده شد.')}catch(error){toast(error.message,true)}};
    $('#autopilot-start').onclick=async()=>{try{await api('/api/autopilot/resume',{});await refresh();toast('چرخهٔ خودکار شروع یا ادامه داده شد.')}catch(error){toast(error.message,true)}};
    $('#autopilot-pause').onclick=async()=>{try{await api('/api/autopilot/pause',{});await refresh();toast('توقف امن پس از کار جاری اعمال می‌شود.')}catch(error){toast(error.message,true)}};
    $('#autopilot-retry').onclick=async()=>{try{await api('/api/autopilot/retry',{});await refresh();toast('تلاش دوباره آغاز شد.')}catch(error){toast(error.message,true)}};
    $('#export-button').onclick=()=>{const blob=new Blob([JSON.stringify(state.snapshot,null,2)],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='product-ops-dashboard.json';link.click();URL.revokeObjectURL(link.href)};
    const savedTheme=localStorage.getItem('product-ops-theme');if(savedTheme)document.documentElement.dataset.theme=savedTheme;$('#theme-button').onclick=()=>{const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;localStorage.setItem('product-ops-theme',theme)};
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeDrawer();intakeDialog.close()}if(event.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){event.preventDefault();$('#global-search').focus()}});
    render();if(window.__PRODUCT_OPS_LIVE__)setInterval(()=>refresh().catch(()=>{}),2000);
  })();`;
}
