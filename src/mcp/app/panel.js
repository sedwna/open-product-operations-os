export const PANEL_URI = "ui://product-ops/control-tower";
export const PANEL_MIME_TYPE = "text/html;profile=mcp-app";
const APP_PROTOCOL_VERSION = "2026-01-26";

/**
 * The control tower as an MCP App: a self-contained interactive panel the host renders inside the
 * conversation.
 *
 * It answers the three questions the product owner actually has — what is happening, what stage are
 * we in, and what needs my decision — and it can put a gate to them without leaving the chat.
 *
 * Deciding still goes through `product_ops_decide`, which opens the host's own dialog. The button
 * here means "put this to me", not "approve this". A panel that recorded a disposition directly
 * would be the model deciding through a nicer surface.
 */
export function renderPanel() {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>برج کنترل محصول</title>
<style>${styles()}</style>
</head>
<body>
<div id="root" class="loading">در حال دریافت وضعیت…</div>
<script>${script()}</script>
</body>
</html>`;
}

function styles() {
  return `
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,"Segoe UI",Tahoma,sans-serif;font-size:13px;line-height:1.6;
background:var(--color-background-primary,light-dark(#fbfaf8,#15181d));
color:var(--color-text-primary,light-dark(#1b1f26,#e8eaed))}
.loading{padding:24px;opacity:.6}
.wrap{padding:14px;display:flex;flex-direction:column;gap:12px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.between{justify-content:space-between}
h1{font-size:14px;margin:0;font-weight:650}
h2{font-size:12px;margin:0 0 6px;font-weight:600;opacity:.65;letter-spacing:.02em}
.card{border:1px solid var(--color-border-primary,light-dark(#e3e0da,#2c313a));border-radius:10px;padding:11px 12px;
background:var(--color-background-secondary,light-dark(#fff,#1b1f26))}
.phase{font-size:16px;font-weight:650}
.muted{opacity:.62}
.pill{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;
border:1px solid var(--color-border-primary,light-dark(#e3e0da,#2c313a))}
.pill.warn{background:light-dark(#fdf1e3,#3a2a17);border-color:light-dark(#f0d3a8,#5a4223)}
.pill.stop{background:light-dark(#fdeceb,#3c1f1e);border-color:light-dark(#f2c0bd,#5d2f2c)}
.pill.go{background:light-dark(#e9f5ee,#16301f);border-color:light-dark(#bfe0cc,#245536)}
.counts{display:grid;grid-template-columns:repeat(auto-fit,minmax(74px,1fr));gap:7px}
.count{border:1px solid var(--color-border-primary,light-dark(#e3e0da,#2c313a));border-radius:8px;padding:7px 9px;text-align:center}
.count b{display:block;font-size:17px;font-weight:650}
.count span{font-size:10.5px;opacity:.6}
.gate{border:1px solid var(--color-border-primary,light-dark(#e3e0da,#2c313a));border-radius:9px;padding:10px 11px;
display:flex;flex-direction:column;gap:7px}
.gate+.gate{margin-top:8px}
.gate-q{font-weight:600}
.risks{margin:0;padding-inline-start:16px;font-size:12px}
.risks li{margin:1px 0}
textarea{font:inherit;font-size:12px;width:100%;min-height:62px;resize:vertical;padding:7px 9px;border-radius:7px;
border:1px solid var(--color-border-primary,light-dark(#c9c4bb,#3a4048));
background:var(--color-background-primary,light-dark(#fff,#15181d));color:inherit}
textarea:focus,select:focus{outline:2px solid light-dark(#8fa9c6,#3d5a86);outline-offset:-1px}
textarea.cond{min-height:42px;margin-top:6px}
select{font:inherit;font-size:12px;width:100%;padding:6px 9px;border-radius:7px;margin-bottom:6px;
border:1px solid var(--color-border-primary,light-dark(#c9c4bb,#3a4048));
background:var(--color-background-primary,light-dark(#fff,#15181d));color:inherit}
button.yes{background:light-dark(#1d6b3f,#2f8a55);color:#fff;border-color:transparent}
button.no{background:light-dark(#a33a33,#b6483f);color:#fff;border-color:transparent}
.flow{display:flex;gap:0;overflow-x:auto;padding-bottom:3px}
.step{flex:0 0 auto;display:flex;align-items:center;gap:0}
.node{border:1px solid var(--color-border-primary,light-dark(#e3e0da,#2c313a));border-radius:8px;
padding:6px 9px;min-width:96px;text-align:center;background:var(--color-background-primary,light-dark(#fff,#1b1f26))}
.node b{display:block;font-size:11px;font-weight:600;line-height:1.35}
.node span{font-size:10px;opacity:.6}
.node.now{border-color:light-dark(#c08a2e,#c9932f);box-shadow:0 0 0 2px light-dark(#f6e6c8,#3a2c12)}
.node.done{opacity:.5}
.node.stuck{border-color:light-dark(#c2534b,#a8463e)}
.node.gate-node{border-style:dashed}
.arrow{width:16px;text-align:center;opacity:.35;font-size:11px}
.teams{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:7px}
.team{border:1px solid var(--color-border-primary,light-dark(#e3e0da,#2c313a));border-radius:8px;padding:7px 9px}
.team b{font-size:11.5px;font-weight:600;display:block}
.team small{font-size:10px;opacity:.55;display:block;line-height:1.4;margin-top:1px}
.team .tally{margin-top:5px;font-size:10.5px;display:flex;gap:7px}
.team.idle{opacity:.45}
.tag{font-size:10px;padding:1px 6px;border-radius:5px;border:1px solid var(--color-border-primary,light-dark(#e3e0da,#2c313a))}
.side{display:flex;align-items:center;gap:6px;margin:0 0 6px}
.side b{font-size:12px}
button{font:inherit;font-weight:600;font-size:12px;padding:6px 13px;border-radius:7px;cursor:pointer;
border:1px solid var(--color-border-primary,light-dark(#c9c4bb,#3a4048));
background:var(--color-background-primary,light-dark(#fff,#232830));color:inherit}
button:hover:not(:disabled){filter:brightness(.97)}
button:disabled{opacity:.45;cursor:default}
button.primary{background:light-dark(#1b1f26,#e8eaed);color:light-dark(#fff,#15181d);border-color:transparent}
.empty{padding:12px;text-align:center;opacity:.55}
.note{font-size:11.5px;opacity:.6}
.err{border-color:light-dark(#f2c0bd,#5d2f2c);background:light-dark(#fdeceb,#3c1f1e)}
code{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;opacity:.75}
`;
}

function script() {
  return `
(function(){
var nextId=1,waiting={},state=null,busy=false,drafts={},poll=null;
var LIVE_MS=10000,IDLE_MS=45000;
function send(method,params){var id=nextId++;window.parent.postMessage({jsonrpc:"2.0",id:id,method:method,params:params||{}},"*");
  return new Promise(function(res,rej){waiting[id]={res:res,rej:rej};});}
window.addEventListener("message",function(e){
  var m=e.data;if(!m||m.jsonrpc!=="2.0")return;
  if(m.id!==undefined&&waiting[m.id]){var w=waiting[m.id];delete waiting[m.id];
    if(m.error)w.rej(new Error(m.error.message||"host error"));else w.res(m.result);return;}
  if(m.method==="ui/notifications/tool-result"){adopt(m.params&&m.params.structuredContent);}
});
function adopt(data){if(data&&data.counts){state=data;render();schedule();}}

// A refresh rebuilds the interface, which would throw away a rationale, a set of conditions, or a
// chosen option the owner is halfway through. All three are captured before the rebuild and put
// back after it.
var DRAFT_FIELDS=["t-","c-","o-"];
function captureDrafts(){
  if(!state||!state.decisions)return;
  state.decisions.items.forEach(function(item){
    DRAFT_FIELDS.forEach(function(prefix){
      var box=document.getElementById(prefix+item.requestId);
      if(box&&typeof box.value==="string"&&box.value!=="")drafts[prefix+item.requestId]=box.value;
    });
  });
}
function restoreDrafts(){
  if(!state||!state.decisions)return;
  state.decisions.items.forEach(function(item){
    DRAFT_FIELDS.forEach(function(prefix){
      var box=document.getElementById(prefix+item.requestId);
      if(box&&drafts[prefix+item.requestId])box.value=drafts[prefix+item.requestId];
    });
  });
}
function clearDrafts(requestId){
  DRAFT_FIELDS.forEach(function(prefix){delete drafts[prefix+requestId];});
}
/** Poll faster while something is moving or waiting on the owner, slower when nothing is. */
function schedule(){
  if(poll)clearTimeout(poll);
  var live=state&&(state.decisions.pending>0
    ||["running","waiting_for_human","failed","blocked"].indexOf(state.cycle.status)!==-1
    ||state.counts.inProgress>0);
  poll=setTimeout(function(){refresh(true);},live?LIVE_MS:IDLE_MS);
  if(poll&&poll.unref)poll.unref();
}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
// Record text arrives wrapped by the server so a model reports it instead of obeying it. A person
// reading the panel does not need the envelope, so unwrap it on the raw string and escape the
// result. Unwrapping after escaping means matching against entity-encoded attributes, which is both
// fragile and easy to get wrong.
function plain(s){
  var t=String(s==null?"":s);
  var m=/^<untrusted-record[^>]*>([\\s\\S]*)<\\/untrusted-record>$/.exec(t);
  return esc(m?m[1]:t);
}
function el(html){var d=document.createElement("div");d.innerHTML=html;return d.firstElementChild;}

function render(){
  var s=state,c=s.counts,root=document.getElementById("root");
  var tone=s.decisions.pending>0?"warn":(c.blocked>0?"stop":"go");
  var head='<div class="card"><div class="row between">'
    +'<div><div class="phase">'+esc(phaseLabel(s.cycle.phase))+'</div>'
    +'<div class="muted">'+(s.cycle.currentTaskId?("«"+esc(s.cycle.currentTaskId)+"» نزد "+esc(s.cycle.currentRoleId)):"هیچ کاری برداشته نشده")+'</div></div>'
    +'<span class="pill '+tone+'">'+esc(statusLabel(s.cycle.status))+'</span></div></div>';
  var counts='<div class="counts">'
    +cell(c.ready,"آماده")+cell(c.inProgress,"در حال انجام")+cell(c.blocked,"مسدود")
    +cell(c.done,"انجام‌شده")+cell(c.total,"کل")+'</div>';
  var gates='<div><h2>در انتظار تصمیم شما</h2>'+(s.decisions.items.length?
    s.decisions.items.map(gate).join(""):'<div class="card empty">هیچ دروازه‌ای منتظر شما نیست.</div>')+'</div>';
  var risks=s.risks&&s.risks.length?'<div><h2>ریسک‌های باز</h2><div class="card"><ul class="risks">'
    +s.risks.map(function(r){return '<li dir="auto">'+plain(r.detail)+' <span class="muted">('+esc(teamOf(r.ownerRole))+")</span></li>";}).join("")
    +'</ul></div></div>':"";
  var foot='<div class="row between"><span class="note">'+esc(s.project.name)+' · '+esc((s.generatedAt||"").slice(11,16))+'</span>'
    +'<button id="refresh">تازه‌سازی</button></div>';
  captureDrafts();
  root.className="wrap";
  root.innerHTML=head+counts+gates+stuckSection(s)+flowSection(s)+teamsSection(s)+risks+foot;
  restoreDrafts();
  document.getElementById("refresh").onclick=function(){refresh();};
  s.decisions.items.forEach(function(item){
    var yes=document.getElementById("y-"+item.requestId);
    var no=document.getElementById("n-"+item.requestId);
    if(yes)yes.onclick=function(){submit(item,"approved");};
    if(no)no.onclick=function(){submit(item,"rejected");};
  });
}

// ── who holds what ───────────────────────────────────────────────────────────
function teamOf(roleId){
  if(roleId==="human")return "مالک محصول";
  var s=state&&state.teams;
  if(s){var all=(s.product||[]).concat(s.engineering||[]);
    for(var i=0;i<all.length;i++) if(all[i].id===roleId) return all[i].name;}
  return roleId||"—";
}
// Stuck work, separated by whose it is to clear. A blockage the owner cannot act on still belongs
// on the panel — they asked where the work is stuck, not only where they are needed — but it must
// not read as another thing waiting on them.
function stuckSection(s){
  var b=s.blockages;if(!b||!b.length)return "";
  var mine=b.filter(function(x){return x.kind==="awaiting_decision";});
  var theirs=b.filter(function(x){return x.kind!=="awaiting_decision";});
  return '<div><h2>کجا گیر کرده‌ایم</h2>'
    +(theirs.length?'<div class="card"><ul class="risks">'+theirs.map(stuckItem).join("")+"</ul></div>":"")
    +(mine.length?'<div class="note" style="margin-top:6px">'+mine.length
      +' مورد از این‌ها در بخش بالا منتظر تصمیم شماست.</div>':"")
    +(theirs.length?"":'<div class="card empty">هیچ کاری پشت وابستگی نمانده است.</div>')+"</div>";
}
function stuckItem(x){
  var why=x.reason?plain(x.reason):"دلیلی روی کارت ثبت نشده است.";
  var out='<li dir="auto"><b>'+esc(x.team)+"</b> — "+why;
  if(x.unblockCondition)out+='<div class="note" dir="auto">برای باز شدن: '+plain(x.unblockCondition)+"</div>";
  if(x.waitingOn&&x.waitingOn.length)out+='<div class="note">در انتظار: '+esc(x.waitingOn.join("، "))+"</div>";
  if(x.nextTeam)out+='<div class="note">پس از آن نزد '+esc(x.nextTeam)+" می‌رود.</div>";
  return out+"</li>";
}
function flowSection(s){
  var f=s.flow;if(!f||!f.steps||!f.steps.length)return "";
  var nodes=f.steps.map(function(step,i){
    var cls=step.status==="done"?"done":(step.status==="in_progress"?"now":
      (step.status==="blocked"?"stuck":(step.humanGate?"gate-node":"")));
    var mark=step.status==="done"?"✓":(step.status==="in_progress"?"●":
      (step.status==="blocked"?"!":(step.humanGate?"⌾":"○")));
    return '<div class="step">'+(i?'<div class="arrow">◀</div>':"")
      +'<div class="node '+cls+'" title="'+esc(step.taskId)+'"><b>'+esc(step.team)+"</b>"
      +"<span>"+mark+" "+esc(taskStatusLabel(step.status,step.humanGate))+"</span></div></div>";
  }).join("");
  return '<div><h2>مسیر کار و پاس‌کاری تیم‌ها</h2><div class="card"><div class="flow">'+nodes+"</div>"
    +'<div class="note" style="margin-top:7px">● در حال انجام · ⌾ منتظر تصمیم شما · ! متوقف · ✓ انجام‌شده</div></div></div>';
}
function teamsSection(s){
  var t=s.teams;if(!t)return "";
  return '<div><h2>تیم‌ها</h2>'+sideBlock("محصول",t.product,"مسئول معنا، اولویت و پذیرش")
    +(t.engineering&&t.engineering.length?sideBlock("مهندسی",t.engineering,"مسئول پیاده‌سازی و شواهد فنی")
      :'<div class="note" style="margin-top:6px">تیم مهندسی هنوز به این فضای کاری متصل نشده است.</div>')+"</div>";
}
function sideBlock(title,teams,subtitle){
  var busy=teams.filter(function(x){return x.total>0||x.cardless;}).length;
  return '<div class="side"><b>'+esc(title)+'</b><span class="tag">'+busy+" از "+teams.length+" درگیر</span>"
    +'<span class="note">'+esc(subtitle)+"</span></div>"
    +'<div class="teams" style="margin-bottom:10px">'+teams.map(function(x){
      // A team that is never dispatched a card is not an idle team. Coordination is the control
      // plane itself, and showing it as "no work" beside twelve working teams read as a fault.
      var quiet=!x.total&&!x.cardless;
      return '<div class="team'+(quiet?" idle":"")+'"><b>'+esc(x.name)+"</b><small>"+esc(x.focus)+"</small>"
        +'<div class="tally">'+(x.active?"<span>"+x.active+" فعال</span>":"")
        +(x.blocked?"<span>"+x.blocked+" متوقف</span>":"")
        +(x.done?"<span>"+x.done+" انجام‌شده</span>":"")
        +(quiet?"<span>بدون کار</span>":"")
        +(x.cardless&&!x.total?"<span>مسیریابی و ثبت — کارت نمی‌گیرد</span>":"")+"</div></div>";
    }).join("")+"</div>";
}
function cell(n,label){return '<div class="count"><b>'+n+"</b><span>"+label+"</span></div>";}
function gate(item){
  // dir="auto" per record string: a question or a risk may be written in any language, and letting
  // each pick its own direction keeps punctuation where its author put it.
  var id=esc(item.requestId);
  // A gate that offered real options is asking which one, not merely whether. Collapsing that to a
  // yes throws the answer away and records the owner as having simply agreed.
  var opts=item.options&&item.options.length?item.options:["approved","rejected"];
  var choose=!(opts.length===2&&opts.indexOf("approved")>-1&&opts.indexOf("rejected")>-1);
  var chooser=choose?'<div class="note">کدام گزینه؟</div><select id="o-'+id+'" dir="auto">'
    +opts.map(function(o){return '<option value="'+esc(o)+'"'
      +(item.recommendedOption===o?" selected":"")+">"+esc(o)
      +(item.recommendedOption===o?" — پیشنهاد سیستم":"")+"</option>";}).join("")
    +"</select>":"";
  return '<div class="gate"><div class="gate-q" dir="auto">'+plain(item.question)+'</div>'
    +'<div class="muted">'+esc(teamOf(ownerOf(item.taskId)))+' · <code>'+esc(item.gate)+"</code> · "+esc(item.taskId)+"</div>"
    +(item.context?'<div class="note" dir="auto">'+plain(item.context)+"</div>":"")
    +(item.risks&&item.risks.length?'<ul class="risks">'+item.risks.map(function(r){return '<li dir="auto">'+plain(r)+"</li>";}).join("")+"</ul>":"")
    +chooser
    +'<textarea id="t-'+id+'" dir="auto" placeholder="دلیل تصمیم‌تان را بنویسید — همین متن در پروندهٔ محصول ثبت و به شما نسبت داده می‌شود."></textarea>'
    +'<textarea id="c-'+id+'" dir="auto" class="cond" placeholder="شرط‌ها (اختیاری) — هر شرط در یک خط. تأیید مشروط با تأیید ساده یکی نیست."></textarea>'
    +'<div class="row"><button class="yes" id="y-'+id+'">تأیید</button>'
    +'<button class="no" id="n-'+id+'">رد</button>'
    +'<span class="note" id="m-'+id+'">بدون دلیل، تصمیم ثبت نمی‌شود.</span></div></div>';
}
function ownerOf(taskId){
  var f=state&&state.flow;if(!f||!f.steps)return null;
  for(var i=0;i<f.steps.length;i++) if(f.steps[i].taskId===taskId) return f.steps[i].roleId;
  return null;
}
function phaseLabel(p){return {idle:"بی‌کار",product_analysis:"تحلیل محصول",human_gate:"در انتظار انسان",
  development_handoff:"تحویل به توسعه",engineering:"مهندسی",product_validation:"اعتبارسنجی محصول",
  reporting:"گزارش",complete:"کامل"}[p]||p;}
function statusLabel(s){return {idle:"بی‌کار",running:"در حال اجرا",paused:"متوقف",waiting_for_human:"منتظر انسان",
  completed:"کامل",blocked:"مسدود",failed:"ناموفق"}[s]||s;}
// Task statuses are a different vocabulary from coordinator statuses; the flow reads task ones.
function taskStatusLabel(s,gate){
  if(s==="ready"&&gate)return "منتظر تصمیم شما";
  return {backlog:"در نوبت",ready:"آماده",in_progress:"در حال انجام",blocked:"متوقف",
    in_review:"در بازبینی",done:"انجام‌شده",cancelled:"لغوشده"}[s]||s;
}

function call(name,args){return send("tools/call",{name:name,arguments:args||{}});}
function refresh(quiet){
  if(busy){if(quiet)schedule();return;}
  busy=true;
  var b=document.getElementById("refresh");
  if(b&&!quiet){b.disabled=true;b.textContent="…";}
  call("product_ops_panel")
    .then(function(r){adopt(r&&r.structuredContent);})
    .catch(function(e){ if(quiet)schedule(); else fail(e); })
    .then(function(){busy=false;});
}
/**
 * The product owner writes their own reasoning here and chooses. The source flag tells the server a
 * person composed this rather than a model summarising them; the record keeps that attribution.
 */
function submit(item,decision){
  if(busy)return;
  var box=document.getElementById("t-"+item.requestId);
  var note=document.getElementById("m-"+item.requestId);
  var rationale=box&&box.value?box.value.trim():"";
  if(!rationale){
    if(note)note.textContent="برای ثبت تصمیم، دلیلش را بنویسید.";
    if(box)box.focus();
    return;
  }
  var chooser=document.getElementById("o-"+item.requestId);
  var conditionBox=document.getElementById("c-"+item.requestId);
  var conditions=conditionBox&&conditionBox.value?conditionBox.value.split(/\\r?\\n/).map(function(line){
    return line.trim();}).filter(Boolean).slice(0,20):[];
  busy=true;
  if(poll)clearTimeout(poll);
  var yes=document.getElementById("y-"+item.requestId),no=document.getElementById("n-"+item.requestId);
  if(yes)yes.disabled=true;if(no)no.disabled=true;
  if(note)note.textContent="در حال ثبت…";
  clearDrafts(item.requestId);
  call("product_ops_decide",{requestId:item.requestId,decisionToken:item.decisionToken,apply:true,
    source:"panel",decision:decision,rationale:rationale,
    selectedOption:chooser?chooser.value:undefined,
    conditions:conditions.length?conditions:undefined,
    actorId:state&&state.humanAuthorityActorId?state.humanAuthorityActorId:undefined})
    .then(function(){busy=false;refresh();})
    .catch(function(e){busy=false;fail(e);});
}
function fail(e){
  var root=document.getElementById("root");
  var box=el('<div class="card err">'+esc(e&&e.message?e.message:"درخواست ناموفق بود.")+"</div>");
  root.insertBefore(box,root.firstChild);
  setTimeout(function(){if(box.parentNode)box.parentNode.removeChild(box);},6000);
  if(state)render();
}

send("ui/initialize",{protocolVersion:"${APP_PROTOCOL_VERSION}",
  appCapabilities:{availableDisplayModes:["inline","fullscreen"]},
  clientInfo:{name:"product-ops-control-tower",version:"1.0.0"}})
  .then(function(){ if(!state) refresh(); })
  .catch(function(){ document.getElementById("root").textContent="این میزبان پنل تعاملی را پشتیبانی نمی‌کند."; });
})();
`;
}
