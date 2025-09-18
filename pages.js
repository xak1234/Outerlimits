// Build a static dashboard (dist/) for GitHub Pages
// Node 20+, no secrets exposed on the page.

import fs from "fs";
import path from "path";

// ---- Config ----
const CFG = {
  driftMaxPct: 60,
  lookbackHours: 24,
  outDir: "dist"
};

const BASE = process.env.T212_BASE;
const KEY  = process.env.T212_API_KEY;

if (!BASE || !KEY) {
  console.error("❌ Missing T212_BASE or T212_API_KEY.");
  process.exit(1);
}

async function jget(p) {
  const r = await fetch(`${BASE}${p}`, { headers: { Authorization: KEY, Accept: "application/json" } });
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${r.statusText}: ${await r.text()}`);
  return r.json().catch(()=> ({}));
}

const num = v => (typeof v === "number" && isFinite(v)) ? v : 0;
const pct = (a,b) => b ? (a/b)*100 : 0;
const fmt = n => `£${n.toFixed(2)}`;

function pickPie(pies, kw) {
  const k = kw.toLowerCase();
  return pies.find(p => ((p?.settings?.name || p?.name || "").toLowerCase().includes(k)));
}

async function getRecentTxns(limit=50){
  return jget(`/api/v0/history/transactions?limit=${limit}`);
}

function html({total, freeCash, aiVal, olVal, aiPct, olPct, aiMove, olMove, flow, generatedAt}) {
  const alerts = [];
  if (aiPct > CFG.driftMaxPct || olPct > CFG.driftMaxPct) alerts.push("Allocation drift beyond 60% cap.");
  if (Math.abs(flow) > 200) alerts.push("Large 24h cash flow (> £200).");
  if (aiMove != null && Math.abs(aiMove) >= 2) alerts.push(`AI daily move ${aiMove.toFixed(2)}%.`);
  if (olMove != null && Math.abs(olMove) >= 2) alerts.push(`OuterLimits daily move ${olMove.toFixed(2)}%.`);

  const advice = [];
  if (aiPct > CFG.driftMaxPct) advice.push(`AI is ${aiPct.toFixed(1)}% (>60%). Prefer new contributions to OuterLimits.`);
  else if (olPct > CFG.driftMaxPct) advice.push(`OuterLimits is ${olPct.toFixed(1)}% (>60%). Prefer new contributions to AI.`);
  else advice.push(`Allocation healthy at AI ${aiPct.toFixed(1)}% / OL ${olPct.toFixed(1)}%.`);
  if (aiMove != null && aiMove <= -3) advice.push(`AI dipped ${aiMove.toFixed(2)}% — consider small top-up if conviction holds.`);
  if (olMove != null && olMove <= -3) advice.push(`OuterLimits dipped ${olMove.toFixed(2)}% — consider small top-up.`);
  if (aiMove != null && aiMove >= 5) advice.push(`AI popped ${aiMove.toFixed(2)}% — optional light skim.`);
  if (olMove != null && olMove >= 5) advice.push(`OuterLimits popped ${olMove.toFixed(2)}% — optional light skim.`);
  advice.push(`Keep £100–£300 cash buffer; rebalance only if >60% cap breached.`);

  const alertsHtml = alerts.length ? `<ul>${alerts.map(a=>`<li>⚠️ ${a}</li>`).join("")}</ul>` : `<p>✅ No alerts.</p>`;
  const adviceHtml = `<ul>${advice.map(a=>`<li>💡 ${a}</li>`).join("")}</ul>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>OuterLimits Dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:#0b0f14; color:#e6eef8; margin:0; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 24px; }
  .card { background:#121826; border:1px solid #1f2a44; border-radius:14px; padding:18px 20px; margin-bottom:16px; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  h2 { font-size: 18px; margin: 0 0 10px; }
  .grid { display:grid; gap:12px; grid-template-columns: repeat(auto-fit,minmax(250px,1fr)); }
  .muted { color:#9fb0c8; font-size: 13px; }
  .big { font-size: 22px; font-weight: 700; }
  .row { display:flex; justify-content: space-between; margin:6px 0; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; background:#1a2336; border:1px solid #2b3b5c; font-size:12px; }
  footer{ margin-top: 20px; color:#8190a9; font-size: 12px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>OuterLimits Portfolio</h1>
    <div class="card">
      <div class="row"><div>Total value</div><div class="big">${fmt(total)}</div></div>
      <div class="row"><div>Free cash</div><div class="big">${fmt(freeCash)}</div></div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>AI Stocks – Main</h2>
        <div class="row"><span>Value</span><span class="pill">${fmt(aiVal)}</span></div>
        <div class="row"><span>Allocation</span><span class="pill">${aiPct.toFixed(1)}%</span></div>
        <div class="row"><span>Today</span><span class="pill">${aiMove!=null?aiMove.toFixed(2)+"%":"n/a"}</span></div>
      </div>

      <div class="card">
        <h2>OuterLimits</h2>
        <div class="row"><span>Value</span><span class="pill">${fmt(olVal)}</span></div>
        <div class="row"><span>Allocation</span><span class="pill">${olPct.toFixed(1)}%</span></div>
        <div class="row"><span>Today</span><span class="pill">${olMove!=null?olMove.toFixed(2)+"%":"n/a"}</span></div>
      </div>
    </div>

    <div class="card">
      <h2>Alerts</h2>
      ${alertsHtml}
    </div>

    <div class="card">
      <h2>Recommendations</h2>
      ${adviceHtml}
    </div>

    <footer class="muted">
      Updated: ${generatedAt} • 24h cash flow considered: £${flow.toFixed(2)} • Target cap: 60%
    </footer>
  </div>
</body>
</html>`;
}

(async () => {
  console.log("Fetching data from T212…");
  const cash = await jget("/api/v0/equity/account/cash");
  const pies = await jget("/api/v0/equity/pies");

  const ai = pickPie(pies, "ai");
  const ol = pickPie(pies, "outerlimits");

  const aiVal = num(ai?.result?.priceAvgValue);
  const olVal = num(ol?.result?.priceAvgValue);
  const invested = aiVal + olVal;

  const total = num(cash?.total) || invested + num(cash?.free);
  const freeCash = num(cash?.free);

  const aiPct = pct(aiVal, invested);
  const olPct = pct(olVal, invested);

  const aiMove = (ai?.result?.priceAvgResultCoef != null) ? ai.result.priceAvgResultCoef * 100 : null;
  const olMove = (ol?.result?.priceAvgResultCoef != null) ? ol.result.priceAvgResultCoef * 100 : null;

  // Recent txns for 24h flow label
  const sinceMs = Date.now() - CFG.lookbackHours*3600*1000;
  const txns = await getRecentTxns(50);
  const raw = txns.items || txns || [];
  const items = raw.filter(t => {
    const ts = new Date(t.time || t.timestamp || t.createdAt || t.date || 0).getTime();
    return Number.isFinite(ts) && ts >= sinceMs;
  });
  const flow = items.reduce((s,t)=>{
    const ty = (t?.type||"").toUpperCase(); const amt = num(t?.amount);
    if (ty.includes("DEPOSIT")) return s + amt;
    if (ty.includes("WITHDRAW")) return s - amt;
    return s;
  },0);

  // Output folder
  fs.rmSync(CFG.outDir, { recursive: true, force: true });
  fs.mkdirSync(CFG.outDir, { recursive: true });

  // Save a machine-readable snapshot too
  const snapshot = {
    generatedAt: new Date().toISOString(),
    total, freeCash, aiVal, olVal, aiPct, olPct, aiMove, olMove, flow
  };
  fs.writeFileSync(path.join(CFG.outDir, "latest.json"), JSON.stringify(snapshot, null, 2));

  // Build index.html
  const htmlStr = html({ ...snapshot, generatedAt: new Date().toLocaleString("en-GB") });
  fs.writeFileSync(path.join(CFG.outDir, "index.html"), htmlStr, "utf8");

  console.log("Built dist/index.html and dist/latest.json");
})();
