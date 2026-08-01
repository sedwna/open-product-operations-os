"use client";

import { useMemo, useState } from "react";

type View = "overview" | "tasks" | "approvals" | "evidence";

const tasks = [
  { id: "PINE-0201", title: "مرور ورودی ایدهٔ خلاصهٔ هفتگی", role: "RB-02", status: "done", priority: "P2" },
  { id: "PINE-0202", title: "تکمیل کشف و زمینهٔ کاربر", role: "RB-03", status: "done", priority: "P2" },
  { id: "PINE-0203", title: "ثبت تصمیم و تحلیل اثر", role: "RB-04", status: "review", priority: "P1" },
  { id: "PINE-0204", title: "تهیهٔ قرارداد تحویل", role: "RB-06", status: "active", priority: "P1" },
  { id: "PINE-0205", title: "طراحی سناریوهای اعتبارسنجی", role: "RB-07", status: "ready", priority: "P2" },
  { id: "PINE-0206", title: "پیاده‌سازی رفتار تأییدشده", role: "RB-13", status: "backlog", priority: "P2" },
  { id: "PINE-0207", title: "اجرای آزمون و ثبت شواهد", role: "RB-09", status: "backlog", priority: "P2" },
  { id: "PINE-0208", title: "راستی‌آزمایی مستقل ادعاها", role: "RB-12", status: "backlog", priority: "P1" },
];

const views: Array<{ id: View; number: string; label: string }> = [
  { id: "overview", number: "۰۱", label: "نمای کلی" },
  { id: "tasks", number: "۰۲", label: "تابلوی کار" },
  { id: "approvals", number: "۰۳", label: "تصمیم‌ها" },
  { id: "evidence", number: "۰۴", label: "شواهد" },
];

const statusLabels: Record<string, string> = {
  backlog: "صف انتظار",
  ready: "آماده",
  active: "در حال انجام",
  review: "در بازبینی",
  done: "انجام‌شده",
};

export default function Home() {
  const [view, setView] = useState<View>("overview");
  const [query, setQuery] = useState("");
  const [dark, setDark] = useState(false);
  const filtered = useMemo(
    () => tasks.filter((task) => `${task.id} ${task.title} ${task.role}`.toLowerCase().includes(query.toLowerCase())),
    [query],
  );

  return (
    <div className={dark ? "app dark" : "app"}>
      <a className="skip" href="#main">رفتن به محتوای اصلی</a>
      <aside className="sidebar">
        <div className="brand"><span className="mark"><i /><i /><i /></span><span><strong>Product Ops</strong><small>Operating System</small></span></div>
        <nav aria-label="ناوبری اصلی">
          {views.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><span>{item.number}</span>{item.label}{item.id === "approvals" && <b>۱</b>}</button>)}
        </nav>
        <div className="safe-mode"><i /><span><strong>نسخهٔ نمایشی امن</strong><small>بدون اتصال به دادهٔ واقعی</small></span></div>
        <a className="repo-link" href="https://github.com/sedwna/open-product-operations-os">مشاهدهٔ مخزن ←</a>
      </aside>

      <main id="main">
        <header className="topbar">
          <label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} onFocus={() => setView("tasks")} placeholder="جست‌وجوی کار یا نقش…" /></label>
          <div><button className="icon" onClick={() => setDark(!dark)} aria-label="تغییر پوسته">◐</button><a className="primary" href="https://github.com/sedwna/open-product-operations-os#quick-start">شروع سریع</a></div>
        </header>

        {view === "overview" && <section className="view">
          <article className="hero">
            <div><span className="eyebrow"><i /> سیستم زندهٔ تصمیم و شواهد</span><h1>محصول را با وضوح هدایت کنید، نه با حدس.</h1><p>یک برج کنترل برای تبدیل سیگنال‌های پراکنده به تصمیم، تحویل، آزمون و انتشار قابل بازسازی.</p><div className="hero-actions"><button className="primary" onClick={() => setView("tasks")}>دیدن جریان واقعی</button><a className="secondary" href="https://github.com/sedwna/open-product-operations-os/blob/main/START-HERE.md">راهنمای شروع</a></div></div>
            <div className="orbit" aria-label="پیشرفت چرخه ۴۲ درصد"><span><strong>۴۲٪</strong><small>پیشرفت چرخه</small></span><b className="chip c1">کشف</b><b className="chip c2">توسعه</b><b className="chip c3">انتشار</b></div>
          </article>
          <div className="metrics">
            <Metric label="کارهای فعال" value="۴" note="از ۸ کار" tone="navy" />
            <Metric label="منتظر تصمیم شما" value="۱" note="نیازمند توجه" tone="coral" />
            <Metric label="پوشش شواهد" value="۷۵٪" note="رو به بهبود" tone="mint" />
            <Metric label="انسداد بحرانی" value="۰" note="مسیر باز است" tone="blue" />
          </div>
          <div className="grid">
            <article className="panel flow"><PanelTitle kicker="جریان ارزش" title="از سیگنال تا انتشار" action="جزئیات" onClick={() => setView("tasks")} /><div className="flowline">{["کشف","تصمیم","طراحی","توسعه","کیفیت","انتشار"].map((item,index)=><div key={item} className={index<2?"complete":index===2?"current":""}><i>{index<2?"✓":toFa(index+1)}</i><span>{item}</span></div>)}</div></article>
            <article className="panel attention"><PanelTitle kicker="تمرکز امروز" title="یک تصمیم باز" /><span className="tag">دروازهٔ انسانی</span><h3>آیا اولویت این تغییر برای چرخهٔ جاری تأیید می‌شود؟</h3><p>اثر روی کاربر، ریسک و شواهد اولیه کنار تصمیم شما آماده است.</p><button className="secondary" onClick={() => setView("approvals")}>بررسی تصمیم</button></article>
            <article className="panel evidence"><PanelTitle kicker="اعتماد به تصمیم" title="سلامت شواهد" /><div className="meter"><i /></div><div className="mini-stats"><span><b>۲</b> خروجی کامل</span><span><b>۱</b> بازبینی مستقل</span><span><b>۰</b> ریسک بحرانی</span></div></article>
            <article className="panel roles"><PanelTitle kicker="تیم عامل‌ها" title="مرزهای روشن مسئولیت" /><div className="avatars">{["RB-02","RB-03","RB-04","RB-06","RB-07","RB-13"].map((role,index)=><span key={role} style={{"--avatar": ["#15273f","#f26b4f","#67b99a","#4c82c3","#e1a64a","#8667a9"][index]} as React.CSSProperties}>{role}</span>)}</div><small>۱۳ نقش، یک مسیر هماهنگ</small></article>
          </div>
        </section>}

        {view === "tasks" && <section className="view inner"><Intro eyebrow="TASK FLOW" title="تابلوی کار" text="هر کار یک مالک، مسیر وابستگی و انتظار شواهد دارد." /><div className="kanban">{Object.entries(statusLabels).map(([status,label])=><div className="column" key={status}><header><strong>{label}</strong><span>{toFa(filtered.filter((task)=>task.status===status).length)}</span></header>{filtered.filter((task)=>task.status===status).map((task)=><article className="task" key={task.id}><div><code>{task.id}</code><b className={task.priority}>{task.priority}</b></div><h3>{task.title}</h3><footer><span>{task.role}</span><small>{label}</small></footer></article>)}</div>)}</div></section>}

        {view === "approvals" && <section className="view inner"><Intro eyebrow="HUMAN GATES" title="مرکز تصمیم‌های انسانی" text="زمینه، شواهد و ریسک در یک قاب؛ تصمیم نهایی همچنان با انسان است." /><article className="approval-card"><span className="tag">منتظر تصمیم</span><h2>اولویت تغییر خلاصهٔ هفتگی</h2><p>پژوهش اولیه نیاز را تأیید می‌کند. ریسک اصلی، افزایش پیچیدگی تنظیمات برای مدیر فضای کاری است.</p><dl><div><dt>کار مرتبط</dt><dd>PINE-0203</dd></div><div><dt>پیشنهاد سیستم</dt><dd>تأیید مشروط</dd></div><div><dt>شواهد</dt><dd>۳ مرجع</dd></div><div><dt>ریسک</dt><dd>متوسط</dd></div></dl><div className="notice">این نسخه نمایشی و فقط‌خواندنی است. ثبت تصمیم در پنل محلی و با انتساب به مالک محصول انجام می‌شود.</div></article></section>}

        {view === "evidence" && <section className="view inner"><Intro eyebrow="EVIDENCE CHAIN" title="شواهد و آمادگی انتشار" text="آمادگی یک احساس نیست؛ حاصل عبور روشن از دروازه‌هاست." /><div className="readiness"><article className="score"><span>امتیاز آمادگی</span><strong>۷۳<small>/۱۰۰</small></strong><p>مسیر سالم است، اما تصمیم اولویت و آزمون مستقل هنوز باقی مانده است.</p></article><article className="gates">{[["پوشش شواهد","۷۵٪",true],["تصمیم انسانی","۱ باز",false],["راستی‌آزمایی مستقل","در انتظار",false],["ریسک بحرانی","صفر",true]].map(([title,value,ok])=><div key={String(title)}><i className={ok?"ok":"wait"}>{ok?"✓":"!"}</i><span><strong>{title}</strong><small>{value}</small></span></div>)}</article></div></section>}
      </main>
    </div>
  );
}

function Metric({label,value,note,tone}:{label:string;value:string;note:string;tone:string}) { return <article className="metric"><i className={tone}>◆</i><span><small>{label}</small><strong>{value}</strong><em>{note}</em></span></article>; }
function PanelTitle({kicker,title,action,onClick}:{kicker:string;title:string;action?:string;onClick?:()=>void}) { return <header className="panel-title"><div><span>{kicker}</span><h2>{title}</h2></div>{action&&<button onClick={onClick}>{action} ←</button>}</header>; }
function Intro({eyebrow,title,text}:{eyebrow:string;title:string;text:string}) { return <header className="intro"><span>{eyebrow}</span><h1>{title}</h1><p>{text}</p></header>; }
function toFa(value:number){return String(value).replace(/[0-9]/g,(digit)=>"۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);}
