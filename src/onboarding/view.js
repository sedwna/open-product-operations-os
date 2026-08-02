import { ONBOARDING_STEPS } from "./service.js";

export function renderOnboarding({ csrfToken, nonce, preflight }) {
  const data = serialize(preflight);
  const progressRows = ONBOARDING_STEPS.map((step, index) => `
    <li data-progress="${step.id}">
      <span class="progress-index">${toPersianDigits(index + 1)}</span>
      <span><strong>${step.label}</strong><small>در انتظار</small></span>
      <i aria-hidden="true"></i>
    </li>`).join("");
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="product-ops-csrf" content="${escapeHtml(csrfToken)}">
  <title>راه‌اندازی یک‌کلیکی محصول</title>
  <style>
    @font-face{font-family:"Vazirmatn";src:url("/assets/vazirmatn.woff2") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
    :root{--ink:#17283f;--muted:#667384;--paper:#f4f1e9;--card:#fffdf8;--line:#ddd7ca;--coral:#f26b4f;--mint:#67b99a;--blue:#4c82c3;--amber:#e2a83b;--shadow:0 24px 60px rgba(23,40,63,.12)}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 12% 8%,rgba(103,185,154,.18),transparent 26%),radial-gradient(circle at 88% 92%,rgba(242,107,79,.16),transparent 30%),var(--paper);font-family:"Vazirmatn",Tahoma,"Segoe UI",sans-serif;color:var(--ink)}button,input,textarea,select{font:inherit}button{cursor:pointer}
    .shell{width:min(1180px,calc(100% - 32px));margin:24px auto;display:grid;grid-template-columns:310px minmax(0,1fr);gap:20px;min-height:calc(100vh - 48px)}
    aside,.workspace{background:rgba(255,253,248,.92);border:1px solid rgba(221,215,202,.9);border-radius:26px;box-shadow:var(--shadow);backdrop-filter:blur(18px)}aside{padding:26px;display:flex;flex-direction:column}.brand{display:flex;gap:13px;align-items:center}.mark{width:44px;height:44px;border-radius:15px;background:var(--ink);display:grid;place-items:center;color:white;font-weight:900}.brand strong{display:block;font-size:15px}.brand small{color:var(--muted)}
    .side-copy{margin:38px 0 24px}.side-copy span{display:inline-flex;padding:6px 10px;background:#e8f3ee;color:#34765d;border-radius:999px;font-size:12px}.side-copy h2{font-size:28px;line-height:1.55;margin:15px 0 10px}.side-copy p{font-size:13px;line-height:2;color:var(--muted)}
    .journey{list-style:none;padding:0;margin:0;display:grid;gap:8px}.journey li{display:flex;align-items:center;gap:10px;color:var(--muted);padding:10px 12px;border-radius:12px;font-size:13px}.journey li b{display:grid;place-items:center;width:24px;height:24px;border:1px solid var(--line);border-radius:50%;font-size:11px}.journey li.active{background:#eef3f8;color:var(--ink);font-weight:700}.journey li.active b{background:var(--blue);color:white;border-color:var(--blue)}
    .trust{margin-top:auto;padding-top:20px;border-top:1px solid var(--line);font-size:11px;line-height:1.9;color:var(--muted)}.trust strong{color:var(--ink)}
    .workspace{min-width:0;padding:34px 40px;overflow:hidden}.topline{display:flex;justify-content:space-between;align-items:center;margin-bottom:26px}.system-pill{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.system-pill i{width:8px;height:8px;background:var(--mint);border-radius:50%;box-shadow:0 0 0 5px rgba(103,185,154,.15)}.counter{font-size:12px;color:var(--muted)}
    .page{display:none;animation:rise .32s ease}.page.active{display:block}@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}.eyebrow{color:var(--coral);font-weight:800;font-size:12px;letter-spacing:.04em}.page h1{font-size:34px;margin:8px 0 12px;line-height:1.45}.lead{color:var(--muted);line-height:2;margin:0 0 28px;max-width:720px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.field{display:grid;gap:8px;margin-bottom:18px}.field.full{grid-column:1/-1}.field label{font-size:13px;font-weight:800}.hint{color:var(--muted);font-size:11px;line-height:1.8}.control{width:100%;border:1px solid var(--line);background:#fff;padding:13px 14px;border-radius:13px;color:var(--ink);outline:none;transition:.2s}.control:focus{border-color:var(--blue);box-shadow:0 0 0 4px rgba(76,130,195,.12)}textarea.control{resize:vertical;min-height:110px;line-height:1.9}.ltr{direction:ltr;text-align:left;font-family:"Vazirmatn",Consolas,monospace}
    .choice-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:22px}.choice{border:1px solid var(--line);border-radius:16px;padding:15px;background:white;cursor:pointer;transition:.2s}.choice:has(input:checked){border-color:var(--blue);box-shadow:0 0 0 3px rgba(76,130,195,.1);background:#f7fbff}.choice input{accent-color:var(--blue)}.choice strong,.choice small{display:block;margin-top:7px}.choice small{color:var(--muted);line-height:1.7}
    .switch-row{display:flex;justify-content:space-between;gap:16px;align-items:center;border:1px solid var(--line);border-radius:15px;padding:14px 16px;background:white;margin-bottom:11px}.switch-row span{display:grid;gap:4px}.switch-row small{color:var(--muted)}.switch{width:44px;height:25px;appearance:none;background:#cbd1d7;border-radius:999px;position:relative;transition:.2s}.switch:after{content:"";position:absolute;width:19px;height:19px;top:3px;right:3px;border-radius:50%;background:white;box-shadow:0 2px 5px #788;transition:.2s}.switch:checked{background:var(--mint)}.switch:checked:after{right:22px}
    .codex-card{border:1px solid #bdd6c9;background:#f2faf6;border-radius:16px;padding:15px 17px;margin:0 0 14px;display:grid;gap:8px}.codex-card strong{font-size:13px}.codex-card p{margin:0;color:var(--muted);font-size:11px;line-height:1.9}.codex-state{display:inline-flex;align-items:center;gap:7px;font-size:11px;color:#2d7357}.codex-state:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--mint)}.codex-state.waiting{color:#9a6820}.codex-state.waiting:before{background:var(--amber)}
    .review{display:grid;grid-template-columns:1fr 1fr;gap:12px}.review article{border:1px solid var(--line);background:white;border-radius:15px;padding:15px}.review small{display:block;color:var(--muted);margin-bottom:7px}.review strong{word-break:break-word}.notice{padding:14px 16px;border-radius:14px;background:#fff4df;border:1px solid #efd6a5;font-size:12px;line-height:1.9;margin:18px 0}
    .actions{display:flex;justify-content:space-between;gap:12px;margin-top:28px;padding-top:22px;border-top:1px solid var(--line)}.btn{border:0;border-radius:13px;padding:12px 20px;font-weight:800}.btn.primary{color:white;background:var(--ink);box-shadow:0 8px 20px rgba(23,40,63,.22)}.btn.primary:hover{transform:translateY(-1px)}.btn.ghost{background:#ece9e1;color:var(--ink)}.btn:disabled{opacity:.45;cursor:not-allowed}
    .progress-layout{display:grid;grid-template-columns:1fr 1fr;gap:20px}.progress-list{list-style:none;padding:0;margin:0;display:grid;gap:8px}.progress-list li{display:grid;grid-template-columns:32px 1fr 12px;align-items:center;gap:10px;border:1px solid var(--line);border-radius:14px;padding:11px;background:white}.progress-index{width:28px;height:28px;display:grid;place-items:center;border-radius:9px;background:#f1eee7;font-size:11px}.progress-list small{display:block;color:var(--muted);margin-top:4px}.progress-list i{width:9px;height:9px;border-radius:50%;background:#cbd1d7}.progress-list li.running{border-color:#d9b661;background:#fffaf0}.progress-list li.running i{background:var(--amber);animation:pulse 1s infinite}.progress-list li.completed i{background:var(--mint)}.progress-list li.failed i{background:var(--coral)}@keyframes pulse{50%{transform:scale(1.7);opacity:.45}}
    .terminal{direction:ltr;text-align:left;background:#132338;color:#dce7ef;border-radius:16px;padding:16px;height:410px;overflow:auto;font:12px/1.8 "Vazirmatn",Consolas,monospace;white-space:pre-wrap}.success{display:none;text-align:center;padding:30px 10px}.success.show{display:block}.success-icon{width:86px;height:86px;border-radius:28px;background:var(--mint);color:white;display:grid;place-items:center;font-size:44px;margin:0 auto 22px;transform:rotate(-5deg)}.success h2{font-size:30px}.success p{color:var(--muted);line-height:2}.error-box{display:none;background:#fff0ed;border:1px solid #f4b4a7;color:#9c3826;border-radius:14px;padding:14px;margin-top:16px;line-height:1.8}.error-box.show{display:block}
    @media(max-width:860px){.shell{grid-template-columns:1fr}.journey,.side-copy{display:none}.trust{margin-top:20px}.workspace{padding:26px 22px}.grid,.review,.progress-layout{grid-template-columns:1fr}.choice-grid{grid-template-columns:1fr}.page h1{font-size:28px}}
    @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  </style>
</head>
<body>
  <main class="shell">
    <aside>
      <div class="brand"><span class="mark">OP</span><span><strong>عملیات محصول باز</strong><small>راه‌اندازی یک‌کلیکی</small></span></div>
      <section class="side-copy"><span>محلی، امن و ادامه‌پذیر</span><h2>از یک ایده تا یک فضای محصول آماده</h2><p>پوشه‌ها، قراردادها، تسک‌ها، تاریخچه و پنل مدیریتی در یک مسیر روشن ساخته می‌شوند.</p></section>
      <ol class="journey">
        <li class="active" data-nav="0"><b>۱</b>فضای کاری</li><li data-nav="1"><b>۲</b>مشخصات محصول</li><li data-nav="2"><b>۳</b>ایدهٔ نخست</li><li data-nav="3"><b>۴</b>تنظیمات نهایی</li><li data-nav="4"><b>۵</b>ساخت و اجرا</li>
      </ol>
      <div class="trust"><strong>مرز امنیتی:</strong> سرویس فقط روی رایانهٔ شما اجرا می‌شود. پوشهٔ غیرخالی بازنویسی نمی‌شود و اطلاعات محرمانه پذیرفته نمی‌شوند.</div>
    </aside>
    <section class="workspace">
      <div class="topline"><span class="system-pill"><i></i><span id="system-label">محیط آماده است</span></span><span class="counter" id="counter">مرحلهٔ ۱ از ۵</span></div>
      <form id="wizard">
        <section class="page active" data-page="0">
          <span class="eyebrow">قدم اول</span><h1>فضای محصول کجا ساخته شود؟</h1><p class="lead">موتور عملیات، پرونده‌های محصول و کد برنامه از هم جدا می‌مانند تا تیم بتواند تمیز و قابل‌کنترل همکاری کند.</p>
          <div class="grid">
            <div class="field full"><label for="workspaceParent">مسیر اصلی فضای کاری</label><input class="control ltr" id="workspaceParent" name="workspaceParent" required><span class="hint">دو پوشهٔ عملیات و کد داخل این مسیر ساخته می‌شوند.</span></div>
            <div class="field"><label for="operationsFolder">نام پوشهٔ عملیات</label><input class="control ltr" id="operationsFolder" name="operationsFolder" value="my-product-ops" pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,63}" required></div>
            <div class="field"><label for="applicationFolder">نام پوشهٔ کد محصول</label><input class="control ltr" id="applicationFolder" name="applicationFolder" value="my-product-app" pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,63}" required></div>
          </div>
          <div class="choice-grid">
            <label class="choice"><input type="radio" name="appMode" value="create" checked><strong>ساخت پوشهٔ تازه</strong><small>یک مخزن کد خالی و تمیز آماده شود.</small></label>
            <label class="choice"><input type="radio" name="appMode" value="existing"><strong>استفاده از کد موجود</strong><small>مسیر یک پروژهٔ فعلی را معرفی می‌کنم.</small></label>
            <label class="choice"><input type="radio" name="appMode" value="skip"><strong>فعلاً بدون کد</strong><small>فقط فضای عملیات محصول ساخته شود.</small></label>
          </div>
          <div class="field" id="existing-path-field" hidden><label for="existingApplicationPath">مسیر پروژهٔ موجود</label><input class="control ltr" id="existingApplicationPath" name="existingApplicationPath"></div>
        </section>
        <section class="page" data-page="1">
          <span class="eyebrow">قدم دوم</span><h1>محصول را در چند جمله تعریف کنید</h1><p class="lead">این داده‌ها شناسنامهٔ تصمیم‌ها و تسک‌های بعدی هستند و هر زمان قابل اصلاح‌اند.</p>
          <div class="grid">
            <div class="field"><label for="productName">نام محصول</label><input class="control" id="productName" name="productName" minlength="2" maxlength="100" required></div>
            <div class="field"><label for="humanAuthorityActorId">شناسهٔ مالک محصول</label><input class="control ltr" id="humanAuthorityActorId" name="humanAuthorityActorId" value="human-product-owner" required></div>
            <div class="field full"><label for="vision">چشم‌انداز</label><textarea class="control" id="vision" name="vision" minlength="10" maxlength="1200" required placeholder="این محصول چه نتیجه‌ای برای چه کسانی ایجاد می‌کند؟"></textarea></div>
            <div class="field"><label for="targetUsers">کاربران هدف</label><input class="control" id="targetUsers" name="targetUsers" required placeholder="مدیر محصول، تیم پشتیبانی"><span class="hint">موارد را با ویرگول جدا کنید.</span></div>
            <div class="field"><label for="environments">محیط‌ها</label><input class="control ltr" id="environments" name="environments" value="local,test,staging" required><span class="hint">گزینه‌ها: local، test، staging، production</span></div>
          </div>
        </section>
        <section class="page" data-page="2">
          <span class="eyebrow">قدم سوم</span><h1>اولین ایده را همین حالا ثبت کنیم؟</h1><p class="lead">با ثبت ایده، چرخهٔ نخست اجرا می‌شود و تسک‌های نقش‌محور بلافاصله در پنل دیده خواهند شد.</p>
          <label class="switch-row"><span><strong>ثبت ایدهٔ نخست</strong><small>می‌توان این مرحله را به بعد موکول کرد.</small></span><input class="switch" type="checkbox" id="ideaEnabled" name="ideaEnabled" checked></label>
          <div id="idea-fields" class="grid">
            <div class="field full"><label for="ideaTitle">عنوان کوتاه ایده</label><input class="control" id="ideaTitle" name="ideaTitle" minlength="3" maxlength="180" required></div>
            <div class="field full"><label for="ideaDescription">شرح مسئله یا فرصت</label><textarea class="control" id="ideaDescription" name="ideaDescription" minlength="10" maxlength="2400" required></textarea></div>
            <div class="field"><label for="ideaSource">منبع</label><input class="control" id="ideaSource" name="ideaSource" value="راه‌اندازی یک‌کلیکی محلی"></div>
            <div class="field"><label for="ideaPriority">اولویت اولیه</label><select class="control ltr" id="ideaPriority" name="ideaPriority"><option>P0</option><option>P1</option><option selected>P2</option><option>P3</option></select></div>
          </div>
        </section>
        <section class="page" data-page="3">
          <span class="eyebrow">قدم چهارم</span><h1>جزئیات اجرای خودکار</h1><p class="lead">مقادیر استاندارد از قبل انتخاب شده‌اند. برای شروع معمولاً نیازی به تغییر آن‌ها نیست.</p>
          <label class="switch-row"><span><strong>نصب دقیق وابستگی‌ها</strong><small>نسخه‌های قفل‌شده و بررسی‌شده نصب شوند.</small></span><input class="switch" type="checkbox" name="installDependencies" checked></label>
          <label class="switch-row"><span><strong>راه‌اندازی مخزن گیت</strong><small>برای پوشه‌های تازه تاریخچهٔ مستقل ساخته شود.</small></span><input class="switch" type="checkbox" name="initializeGit" checked></label>
          <label class="switch-row"><span><strong>ساخت تعهد اولیه</strong><small>اگر نام و ایمیل موجود باشد، اولین تعهد ساخته شود.</small></span><input class="switch" type="checkbox" name="createInitialCommit" checked></label>
          <label class="switch-row"><span><strong>ساخت خودکار با موتور هوشمند</strong><small>عامل‌های محصول و توسعه با ارائه‌دهندهٔ انتخاب‌شده فعال می‌شوند.</small></span><input class="switch" id="automationEnabled" type="checkbox" name="automationEnabled" checked></label>
          <div class="field" data-provider-option><label for="automationProvider">انتخاب موتور هوشمند</label><select class="control" id="automationProvider" name="automationProvider"><option value="auto" selected>انتخاب خودکار بهترین گزینهٔ آماده</option><option value="codex">کدکس</option><option value="claude">کلاد کد</option></select><small class="hint">در حالت خودکار، موتور دارای نصب و ورود معتبر انتخاب می‌شود؛ در وضعیت برابر، کدکس اولویت دارد.</small></div>
          <div class="grid" data-provider-option>
            <div class="codex-card" id="codex-card"><strong>وضعیت موتور کدکس</strong><span class="codex-state" id="codex-state"></span><p id="codex-copy"></p></div>
            <div class="codex-card" id="claude-card"><strong>وضعیت موتور کلاد کد</strong><span class="codex-state" id="claude-state"></span><p id="claude-copy"></p></div>
          </div>
          <label class="switch-row" data-provider-option><span><strong>نصب ابزار خط فرمان در صورت نیاز</strong><small>فقط بستهٔ رسمی ارائه‌دهندهٔ انتخاب‌شده نصب می‌شود.</small></span><input class="switch" type="checkbox" name="installProviderCli" checked></label>
          <label class="switch-row" data-provider-option><span><strong>تکمیل ورود در صورت نیاز</strong><small>مرورگر باز می‌شود؛ رمز و نشست ورود هرگز داخل پروژه نوشته نمی‌شود.</small></span><input class="switch" type="checkbox" name="authenticateProvider" checked></label>
          <label class="switch-row"><span><strong>راه‌اندازی سامانهٔ عملیات توسعه</strong><small id="development-os-hint">برای مخزن تازه به‌صورت خودکار ساخته و اعتبارسنجی می‌شود.</small></span><input class="switch" id="initializeDevelopmentOs" type="checkbox" name="initializeDevelopmentOs" checked disabled></label>
          <label class="switch-row"><span><strong>پنل قابل‌نوشتن محلی</strong><small>ثبت ایده و بازخورد فقط در همین نشست محلی مجاز می‌شود.</small></span><input class="switch" type="checkbox" name="writableDashboard" checked></label>
          <div class="grid" style="margin-top:20px"><div class="field"><label for="gitName">نام ثبت‌کننده در گیت</label><input class="control" id="gitName" name="gitName"></div><div class="field"><label for="gitEmail">ایمیل ثبت‌کننده در گیت</label><input class="control ltr" id="gitEmail" name="gitEmail" type="email"></div></div>
        </section>
        <section class="page" data-page="4">
          <span class="eyebrow">قدم پنجم</span><h1>همه‌چیز آمادهٔ ساخت است</h1><p class="lead">مسیرها و پاسخ‌ها را مرور کنید. اجرای نهایی پوشهٔ موجود و غیرخالی را بازنویسی نخواهد کرد.</p>
          <div class="review" id="review"></div>
          <div class="notice">هیچ رمز یا کلید دسترسی در پاسخ‌ها وارد نکنید. اگر ساخت خودکار روشن باشد، ورود کدکس یا کلاد کد بیرون از پروژه نگه داشته می‌شود و عملیات تولید، انتشار و تغییر مخرب همچنان پشت دروازهٔ انسانی می‌ماند.</div>
        </section>
        <div class="error-box" id="form-error" role="alert"></div>
        <div class="actions" id="form-actions"><button class="btn ghost" type="button" id="back" disabled>مرحلهٔ قبل</button><button class="btn primary" type="button" id="next">مرحلهٔ بعد</button></div>
      </form>
      <section id="running" hidden><span class="eyebrow">در حال آماده‌سازی</span><h1>لقمهٔ آماده در راه است</h1><p class="lead">این صفحه را باز نگه دارید. مراحل سنگین ممکن است چند دقیقه زمان ببرند.</p><div class="progress-layout"><ol class="progress-list">${progressRows}</ol><pre class="terminal" id="terminal">شروع راه‌اندازی…\n</pre></div><div class="error-box" id="error-box" role="alert"></div><div class="actions" id="recovery-actions" hidden><button class="btn ghost" type="button" id="retry">بازگشت، اصلاح و تلاش دوباره</button></div></section>
      <section class="success" id="success"><div class="success-icon">✓</div><span class="eyebrow">آماده شد</span><h2>فضای محصول شما آماده است</h2><p id="success-copy"></p><button class="btn primary" id="open-dashboard" type="button">ورود به پنل محصول</button></section>
    </section>
  </main>
  <script nonce="${escapeHtml(nonce)}">
    const PREFLIGHT=${data};
    const $=(selector)=>document.querySelector(selector);const $$=(selector)=>[...document.querySelectorAll(selector)];let page=0;let dashboardUrl='';
    $('#workspaceParent').value=PREFLIGHT.suggestedWorkspaceParent||'';$('#gitName').value=PREFLIGHT.gitName||'';$('#gitEmail').value=PREFLIGHT.gitEmail||'';$('#system-label').textContent=(PREFLIGHT.platform||'local')+' · '+(PREFLIGHT.nodeVersion||'');
    function renderProviderReadiness(provider,label){const c=PREFLIGHT[provider]||{};$('#'+provider+'-state').textContent=c.status==='ready'?'آمادهٔ اتصال':c.status==='login-required'?'نیازمند ورود':c.status==='not-executable'?'نصب‌شده اما غیرقابل‌اجرا':'نیازمند نصب';$('#'+provider+'-state').classList.toggle('waiting',c.status!=='ready');$('#'+provider+'-copy').textContent=(c.message||('وضعیت '+label+' هنگام اجرا بررسی می‌شود.'))+(c.version?' نسخه: '+c.version:'')}
    renderProviderReadiness('codex','کدکس');renderProviderReadiness('claude','کلاد کد');
    function showPage(next){page=next;$$('.page').forEach((el,i)=>el.classList.toggle('active',i===page));$$('[data-nav]').forEach((el,i)=>el.classList.toggle('active',i===page));$('#back').disabled=page===0;$('#next').textContent=page===4?'ساخت محصول و بازکردن پنل':'مرحلهٔ بعد';$('#counter').textContent='مرحلهٔ '+['۱','۲','۳','۴','۵'][page]+' از ۵';if(page===4)review()}
    function pageValid(){const active=$$('.page')[page];for(const input of active.querySelectorAll('input,textarea,select')){if(!input.checkValidity()){input.reportValidity();return false}}return true}
    $('#next').onclick=()=>{if(!pageValid())return;if(page<4)showPage(page+1);else start()};$('#back').onclick=()=>showPage(Math.max(0,page-1));
    function syncDevelopmentOption(){const mode=$('input[name=appMode]:checked').value;const option=$('#initializeDevelopmentOs');const automation=$('#automationEnabled');$('#existing-path-field').hidden=mode!=='existing';$('#existingApplicationPath').required=mode==='existing';$('#applicationFolder').disabled=mode!=='create';if(mode==='create'){option.checked=true;option.disabled=true;$('#development-os-hint').textContent='برای مخزن تازه به‌صورت خودکار ساخته و اعتبارسنجی می‌شود.'}else if(mode==='existing'){option.checked=false;option.disabled=false;$('#development-os-hint').textContent='فقط با انتخاب صریح شما، فایل‌های نام‌گذاری‌شدهٔ سامانهٔ توسعه به مخزن موجود افزوده می‌شوند.'}else{option.checked=false;option.disabled=true;automation.checked=false;$('#development-os-hint').textContent='بدون مخزن کد، راه‌اندازی سامانهٔ توسعه به بعد موکول می‌شود.'}automation.disabled=mode==='skip';syncProviderOptions()}
    function syncProviderOptions(){const enabled=$('#automationEnabled').checked;$$('[data-provider-option] input,[data-provider-option] select').forEach(el=>el.disabled=!enabled);$$('[data-provider-option]').forEach(el=>el.style.opacity=enabled?'1':'.55')}
    $$('input[name=appMode]').forEach(el=>el.onchange=syncDevelopmentOption);syncDevelopmentOption();
    $('#automationEnabled').onchange=syncProviderOptions;
    $('#ideaEnabled').onchange=()=>{$('#idea-fields').hidden=!$('#ideaEnabled').checked;for(const el of $('#idea-fields').querySelectorAll('[required]'))el.disabled=!$('#ideaEnabled').checked};
    function formData(){const f=new FormData($('#wizard'));const appMode=f.get('appMode');return{workspaceParent:f.get('workspaceParent'),operationsFolder:f.get('operationsFolder'),applicationFolder:f.get('applicationFolder'),appMode,existingApplicationPath:f.get('existingApplicationPath'),productName:f.get('productName'),vision:f.get('vision'),targetUsers:String(f.get('targetUsers')||'').split(',').map(x=>x.trim()).filter(Boolean),environments:String(f.get('environments')||'').split(',').map(x=>x.trim()).filter(Boolean),humanAuthorityActorId:f.get('humanAuthorityActorId'),ideaEnabled:$('#ideaEnabled').checked,ideaTitle:f.get('ideaTitle'),ideaDescription:f.get('ideaDescription'),ideaSource:f.get('ideaSource'),ideaPriority:f.get('ideaPriority'),installDependencies:f.has('installDependencies'),initializeGit:f.has('initializeGit'),createInitialCommit:f.has('createInitialCommit'),initializeDevelopmentOs:appMode==='create'||f.has('initializeDevelopmentOs'),automationMode:f.has('automationEnabled')?f.get('automationProvider'):'manual',installProviderCli:f.has('installProviderCli'),authenticateProvider:f.has('authenticateProvider'),writableDashboard:f.has('writableDashboard'),gitName:f.get('gitName'),gitEmail:f.get('gitEmail')}}
    function review(){const f=formData();const app=f.appMode==='create'?f.applicationFolder:(f.appMode==='existing'?f.existingApplicationPath:'فعلاً ساخته نمی‌شود');const automationLabel=f.automationMode==='auto'?'ساخت خودکار با انتخاب بهترین موتور آماده':f.automationMode==='claude'?'ساخت خودکار با کلاد کد':f.automationMode==='codex'?'ساخت خودکار با کدکس':'اجرای دستی و کنترل‌شده';$('#review').innerHTML=[['نام محصول',f.productName],['پوشهٔ عملیات',f.operationsFolder],['کد محصول',app],['سامانهٔ توسعه',f.initializeDevelopmentOs?'ساخته و اعتبارسنجی می‌شود':'فعلاً راه‌اندازی نمی‌شود'],['حالت اجرا',automationLabel],['دسترسی پنل',f.writableDashboard?'قابل‌نوشتن در نشست محلی':'فقط خواندنی'],['کاربران هدف',f.targetUsers.join('، ')],['محیط‌ها',f.environments.join('، ')],['ایدهٔ نخست',f.ideaEnabled?f.ideaTitle:'بعداً ثبت می‌شود']].map(([a,b])=>'<article><small>'+escape(a)+'</small><strong>'+escape(b||'—')+'</strong></article>').join('')}
    function escape(v){const d=document.createElement('div');d.textContent=String(v);return d.innerHTML}
    async function start(){const token=$('meta[name=product-ops-csrf]').content;const next=$('#next');next.disabled=true;hideError($('#form-error'));try{const res=await fetch('/api/apply',{method:'POST',headers:{'content-type':'application/json','x-product-ops-csrf':token},body:JSON.stringify(formData())});const data=await res.json();if(!res.ok)throw new Error(data.error||'شروع راه‌اندازی ناموفق بود.');resetProgress();$('#wizard').hidden=true;$('.topline').hidden=true;$('#running').hidden=false;poll(token)}catch(error){showError($('#form-error'),error.message);next.disabled=false}}
    async function poll(token){try{const res=await fetch('/api/status',{headers:{'x-product-ops-csrf':token}});const data=await res.json();renderStatus(data);if(data.status==='completed'){dashboardUrl=data.dashboardUrl;$('#running').hidden=true;$('#success').classList.add('show');const developmentReady=data.result.development&&data.result.development.status==='ready';const executorsReady=data.result.development&&data.result.development.executorsEnabled;const provider=data.result.automation&&data.result.automation.provider==='claude'?'کلاد کد':'کدکس';$('#success-copy').textContent='پوشهٔ عملیات در '+data.result.operationsPath+' ساخته شد. '+(developmentReady?'سامانهٔ توسعه آماده و معتبر است. ':'')+(executorsReady?'نقش‌های محصول و مهندسی نیز به '+provider+' متصل شده‌اند. ':'')+'تا چند لحظهٔ دیگر وارد پنل می‌شوید.';setTimeout(()=>location.href=dashboardUrl,1800);return}if(data.status==='failed'){fail(data.error);return}setTimeout(()=>poll(token),700)}catch(error){fail(error.message)}}
    function renderStatus(data){for(const update of data.steps||[]){const row=$('[data-progress="'+update.id+'"]');if(!row)continue;row.className=update.status;row.querySelector('small').textContent=update.message}const terminal=$('#terminal');terminal.textContent=(data.logs||[]).join('\\n')+'\\n';terminal.scrollTop=terminal.scrollHeight}
    function resetProgress(){$$('[data-progress]').forEach(row=>{row.className='';row.querySelector('small').textContent='در انتظار'});$('#terminal').textContent='شروع راه‌اندازی…\\n';hideError($('#error-box'));$('#recovery-actions').hidden=true}
    function showError(box,message){box.textContent=message||'راه‌اندازی ناموفق بود.';box.classList.add('show')}
    function hideError(box){box.textContent='';box.classList.remove('show')}
    function fail(message){showError($('#error-box'),message);$('#recovery-actions').hidden=false}
    $('#retry').onclick=()=>{$('#running').hidden=true;$('#wizard').hidden=false;$('.topline').hidden=false;$('#next').disabled=false;hideError($('#error-box'));$('#recovery-actions').hidden=true;showPage(4)};
    $('#open-dashboard').onclick=()=>{if(dashboardUrl)location.href=dashboardUrl};
  </script>
</body></html>`;
}

function serialize(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function toPersianDigits(value) {
  return String(value).replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
}
