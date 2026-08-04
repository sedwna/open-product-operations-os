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
var nextId=1,waiting={},state=null,busy=false;
function send(method,params){var id=nextId++;window.parent.postMessage({jsonrpc:"2.0",id:id,method:method,params:params||{}},"*");
  return new Promise(function(res,rej){waiting[id]={res:res,rej:rej};});}
window.addEventListener("message",function(e){
  var m=e.data;if(!m||m.jsonrpc!=="2.0")return;
  if(m.id!==undefined&&waiting[m.id]){var w=waiting[m.id];delete waiting[m.id];
    if(m.error)w.rej(new Error(m.error.message||"host error"));else w.res(m.result);return;}
  if(m.method==="ui/notifications/tool-result"){adopt(m.params&&m.params.structuredContent);}
});
function adopt(data){if(data&&data.counts){state=data;render();}}
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
    +s.risks.map(function(r){return "<li>"+plain(r.detail)+' <span class="muted">('+esc(r.ownerRole)+")</span></li>";}).join("")
    +'</ul></div></div>':"";
  var foot='<div class="row between"><span class="note">'+esc(s.project.name)+' · '+esc((s.generatedAt||"").slice(11,16))+'</span>'
    +'<button id="refresh">تازه‌سازی</button></div>';
  root.className="wrap";
  root.innerHTML=head+counts+gates+risks+foot;
  document.getElementById("refresh").onclick=refresh;
  s.decisions.items.forEach(function(item){
    var b=document.getElementById("d-"+item.requestId);
    if(b)b.onclick=function(){decide(item);};
  });
}
function cell(n,label){return '<div class="count"><b>'+n+"</b><span>"+label+"</span></div>";}
function gate(item){
  return '<div class="gate"><div class="gate-q">'+plain(item.question)+'</div>'
    +'<div class="muted"><code>'+esc(item.gate)+"</code> · "+esc(item.taskId)+"</div>"
    +(item.risks&&item.risks.length?'<ul class="risks">'+item.risks.map(function(r){return "<li>"+plain(r)+"</li>";}).join("")+"</ul>":"")
    +'<div class="row"><button class="primary" id="d-'+esc(item.requestId)+'">ثبت تصمیم…</button>'
    +'<span class="note">پاسخ را خودتان در پنجرهٔ بعدی وارد می‌کنید.</span></div></div>';
}
function phaseLabel(p){return {idle:"بی‌کار",product_analysis:"تحلیل محصول",human_gate:"در انتظار انسان",
  development_handoff:"تحویل به توسعه",engineering:"مهندسی",product_validation:"اعتبارسنجی محصول",
  reporting:"گزارش",complete:"کامل"}[p]||p;}
function statusLabel(s){return {idle:"بی‌کار",running:"در حال اجرا",paused:"متوقف",waiting_for_human:"منتظر انسان",
  completed:"کامل",blocked:"مسدود",failed:"ناموفق"}[s]||s;}

function call(name,args){return send("tools/call",{name:name,arguments:args||{}});}
function refresh(){
  if(busy)return;busy=true;var b=document.getElementById("refresh");if(b){b.disabled=true;b.textContent="…";}
  call("product_ops_panel").then(function(r){adopt(r&&r.structuredContent);}).catch(fail).then(function(){busy=false;});
}
function decide(item){
  if(busy)return;busy=true;
  var b=document.getElementById("d-"+item.requestId);if(b){b.disabled=true;b.textContent="در انتظار پاسخ شما…";}
  call("product_ops_decide",{requestId:item.requestId,decisionToken:item.decisionToken,apply:true})
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
