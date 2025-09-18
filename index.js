// OuterLimits watcher — daily digest + Friday wrap + realised-profit ledger
// Node 20+. SMTP via nodemailer. Persists snapshots + ledger in repo.

import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

// ---------------- Config ----------------
const CFG = {
  driftMaxPct: 60,
  moveAlertPct: 2,
  buyDipPct: -3,
  considerSkimPct: 5,
  cashFlowAbsLimit: 200,
  lookbackHours: 24,
  dataDir: "data",
  snapshotFile: "data/snapshots.json",
  ledgerFile: "data/ledger.json",          // <-- new
  readmeFile: "README.md"                   // <-- update dashboard
};

// ------------- Secrets / Env ------------
const BASE = process.env.T212_BASE;
const KEY  = process.env.T212_API_KEY;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER;
const EMAIL_TO   = process.env.EMAIL_TO || SMTP_USER;

if (!BASE || !KEY) { console.error("❌ Missing T212_BASE or T212_API_KEY."); process.exit(1); }
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_TO) { console.error("❌ Missing SMTP_* or EMAIL_*."); process.exit(1); }

// ------------- Helpers ------------------
async function jget(path) {
  const url = `${BASE}${path}`;
  const r = await fetch(url, { headers: { Authorization: KEY, Accept: "application/json" } });
  if (!r.ok) throw new Error(`❌ API ${path} -> ${r.status} ${r.statusText}\n${await r.text()}`);
  return r.json().catch(() => ({}));
}
const num = v => (typeof v === "number" && isFinite(v)) ? v : 0;
const pct = (a,b) => b ? (a/b)*100 : 0;
const fmtGBP = n => `£${n.toFixed(2)}`;
const todayISO = () => new Date().toISOString().slice(0,10);
function pickPie(pies, keyword) { const k = keyword.toLowerCase(); return pies.find(p => ((p?.settings?.name || p?.name || "").toLowerCase().includes(k))); }
function ensureDir(file) { const d = path.dirname(file); if (!fs.existsSync(d)) fs.mkdirSync(d, {recursive:true}); }
function readJSON(file, fallback){ try { return JSON.parse(fs.readFileSync(file,"utf8")); } catch { return fallback; } }
function writeJSON(file, obj){ ensureDir(file); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

// ----- Transactions (latest page; filter locally) -----
async function getRecentTxns(limit = 50) {
  // We avoid time+cursor constraints: grab most recent page (<=50) and filter by timestamp locally.
  return jget(`/api/v0/history/transactions?limit=${limit}`);
}

// ----- Weekly helpers (unchanged) -----
function readSnapshots(file){ return readJSON(file, { days: [] }); }
function writeSnapshot(file, snap){
  const db = readSnapshots(file);
  const i = db.days.findIndex(d => d.date === snap.date);
  if (i>=0) db.days[i]=snap; else db.days.push(snap);
  db.days = db.days.sort((a,b)=>a.date.localeCompare(b.date)).slice(-120);
  writeJSON(file, db);
}
function findLastFriday(db){
  const today = todayISO();
  const rev = db.days.filter(d=>d.date<today).reverse();
  for (const c of rev){ if (new Date(c.date+"T12:00:00Z").getUTCDay()===5) return c; }
  return null;
}
function weeklyWrap(cur, prev){
  if(!prev) return null;
  const t = cur.total - prev.total, a = cur.aiVal - prev.aiVal, o = cur.olVal - prev.olVal;
  const best = Math.abs(a) >= Math.abs(o) ? {name:"AI",chg:a} : {name:"OuterLimits",chg:o};
  return [
    `Week-over-Week (vs ${prev.date}):`,
    `• Total: ${fmtGBP(cur.total)} (${t>=0?"+":""}${fmtGBP(Math.abs(t)).slice(1)})`,
    `• AI: ${fmtGBP(cur.aiVal)} (${a>=0?"+":""}${fmtGBP(Math.abs(a)).slice(1)})`,
    `• OuterLimits: ${fmtGBP(cur.olVal)} (${o>=0?"+":""}${fmtGBP(Math.abs(o)).slice(1)})`,
    `• Best mover: ${best.name} (${best.chg>=0?"+":""}${fmtGBP(Math.abs(best.chg)).slice(1)})`
  ].join("\n");
}

// ----- Recommendations (unchanged) -----
function buildRecommendations(m){
  const recs=[];
  if (m.aiPct > CFG.driftMaxPct) recs.push(`AI is ${m.aiPct.toFixed(1)}% (> ${CFG.driftMaxPct}%). Prefer new contributions to OuterLimits.`);
  else if (m.olPct > CFG.driftMaxPct) recs.push(`OuterLimits is ${m.olPct.toFixed(1)}% (> ${CFG.driftMaxPct}%). Prefer new contributions to AI.`);
  else recs.push(`Allocation healthy at AI ${m.aiPct.toFixed(1)}% / OL ${m.olPct.toFixed(1)}%.`);
  if (m.aiMove!=null && m.aiMove<=CFG.buyDipPct) recs.push(`AI moved ${m.aiMove.toFixed(2)}% → consider a small top-up.`);
  if (m.olMove!=null && m.olMove<=CFG.buyDipPct) recs.push(`OuterLimits moved ${m.olMove.toFixed(2)}% → consider a small top-up.`);
  if (m.aiMove!=null && m.aiMove>=CFG.considerSkimPct) recs.push(`AI jumped ${m.aiMove.toFixed(2)}% → optional light skim.`);
  if (m.olMove!=null && m.olMove>=CFG.considerSkimPct) recs.push(`OuterLimits jumped ${m.olMove.toFixed(2)}% → optional light skim.`);
  if (Math.abs(m.flow) > CFG.cashFlowAbsLimit) recs.push(`Cash flow £${m.flow.toFixed(2)} (> £${CFG.cashFlowAbsLimit}). Review deposits/withdrawals.`);
  recs.push(`Maintain £100–£300 cash buffer. Rebalance if >${CFG.driftMaxPct}% cap breached.`);
  return recs;
}

// ----- Email -----
async function sendEmail(subject, body){
  const t = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT===465, auth:{user:SMTP_USER, pass:SMTP_PASS}});
  await t.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject, text: body });
}

// ----- Ledger (new) -----------------------------------
// Tracks realised profit (skims) from transaction types that reduce invested ->
// We recognise a few likely types; anything unknown is ignored.
function readLedger(){ return readJSON(CFG.ledgerFile, { realised: 0, entries: [] }); }

function txIsRealisation(t){
  const ty = (t?.type || "").toUpperCase();
  // Common candidates; keep broad to be robust
  return [
    "WITHDRAW",                // generic cash withdraw
    "PIE_WITHDRAWAL",          // pie cash pulled out
    "SELL_AND_WITHDRAW",       // sell then withdraw
    "INVESTMENT_WITHDRAWAL"    // any investment withdrawal
  ].some(x => ty.includes(x));
}

function upsertLedger(ledger, additions){
  let realisedAdd = 0;
  for (const tx of additions){
    const id = tx?.id || `${tx.type}-${tx.time || tx.timestamp || tx.createdAt}`;
    if (!id) continue;
    if (ledger.entries.some(e => e.id===id)) continue; // already counted
    if (!txIsRealisation(tx)) continue;
    const amt = num(tx.amount);
    // Positive amount for money leaving investments to cash/bank:
    // Some APIs use negative; normalise: we count outflow to cash as +realised
    const add = Math.abs(amt);
    ledger.entries.push({ id, type: tx.type, amount: add, at: tx.time || tx.timestamp || tx.createdAt || "" });
    realisedAdd += add;
  }
  ledger.realised += realisedAdd;
  // keep last 500 entries
  ledger.entries = ledger.entries.slice(-500);
  return { ledger, realisedAdd };
}

// ----- README dashboard (new) -------------------------
function updateReadme(readmePath, stats){
  const badgeStart = "<!-- OUTERLIMITS-DASHBOARD:START -->";
  const badgeEnd   = "<!-- OUTERLIMITS-DASHBOARD:END -->";
  const block =
`${badgeStart}
**Total**: ${fmtGBP(stats.total)} | **Cash**: ${fmtGBP(stats.freeCash)}  
**AI**: ${fmtGBP(stats.aiVal)} (${stats.aiPct.toFixed(1)}%) • **OuterLimits**: ${fmtGBP(stats.olVal)} (${stats.olPct.toFixed(1)}%)  
**Unrealised P/L today** — AI: ${stats.aiMove!=null?stats.aiMove.toFixed(2)+"%":"n/a"}, OL: ${stats.olMove!=null?stats.olMove.toFixed(2)+"%":"n/a"}  
**Realised profit (to date)**: ${fmtGBP(stats.realised)}
${badgeEnd}`;
  let readme = "";
  try { readme = fs.readFileSync(readmePath,"utf8"); } catch { /* ignore */ }
  if (!readme.includes(badgeStart)) {
    readme += `\n\n## Outerlimits Dashboard\n${block}\n`;
  } else {
    readme = readme.replace(new RegExp(`${badgeStart}[\\s\\S]*?${badgeEnd}`,'m'), block);
  }
  fs.writeFileSync(readmePath, readme);
}

// ---------------- Main -------------------------------
(async () => {
  console.log("📡 Connecting to T212:", BASE);

  const cash = await jget("/api/v0/equity/account/cash");
  const pies = await jget("/api/v0/equity/pies");
  console.log("📊 Pies:", (pies||[]).map(p => p?.settings?.name || p?.name));

  // Txns (last page, then filter by time)
  const sinceMs = Date.now() - CFG.lookbackHours*3600*1000;
  const txns = await getRecentTxns(50);
  const raw = txns.items || txns || [];
  const items = raw.filter(t => {
    const ts = new Date(t.time || t.timestamp || t.createdAt || t.date || 0).getTime();
    return Number.isFinite(ts) && ts >= sinceMs;
  });

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

  // Cash flow (24h)
  const flow = items.reduce((s,t)=> {
    const ty = (t?.type||"").toUpperCase();
    const amt = num(t?.amount);
    if (ty.includes("DEPOSIT")) return s + amt;
    if (ty.includes("WITHDRAW")) return s - amt;
    return s;
  }, 0);

  // ---------- Ledger: add new realisations ----------
  const ledger = readLedger();
  const { ledger: updated, realisedAdd } = upsertLedger(ledger, raw); // use raw so we don't miss items slightly older than 24h
  writeJSON(CFG.ledgerFile, updated);

  // ---------- Daily email content ----------
  const lines = [];
  lines.push(`Total: ${fmtGBP(total)}  |  Free cash: ${fmtGBP(freeCash)}`);
  lines.push(`AI: ${fmtGBP(aiVal)} (${aiPct.toFixed(1)}%)  •  OL: ${fmtGBP(olVal)} (${olPct.toFixed(1)}%)`);
  lines.push(`Last ${CFG.lookbackHours}h cash flow: £${flow.toFixed(2)}`);
  if (aiMove != null || olMove != null) lines.push(`Moves — AI: ${aiMove?.toFixed(2) ?? "n/a"}%, OL: ${olMove?.toFixed(2) ?? "n/a"}%`);
  lines.push(`Realised profit to date: ${fmtGBP(updated.realised)}${realisedAdd ? ` (today +${fmtGBP(realisedAdd).slice(1)})` : ""}`);

  const alerts=[];
  if (aiPct>CFG.driftMaxPct || olPct>CFG.driftMaxPct) alerts.push("Allocation drift beyond cap.");
  if (Math.abs(flow)>CFG.cashFlowAbsLimit) alerts.push("Large cash flow.");
  if (aiMove!=null && Math.abs(aiMove)>=CFG.moveAlertPct) alerts.push(`AI move ${aiMove.toFixed(2)}%.`);
  if (olMove!=null && Math.abs(olMove)>=CFG.moveAlertPct) alerts.push(`OL move ${olMove.toFixed(2)}%.`);
  const recs = buildRecommendations({ aiPct, olPct, aiMove, olMove, flow });

  // ---------- Snapshot + weekly wrap ----------
  const today = todayISO();
  const snap = { date: today, total, aiVal, olVal };
  writeSnapshot(CFG.snapshotFile, snap);
  const db = readSnapshots(CFG.snapshotFile);
  let weeklySection = "";
  if (new Date().getUTCDay()===5) { // Friday
    const prior = findLastFriday(db);
    const wrap = weeklyWrap(snap, prior);
    if (wrap) weeklySection = "\n\n📅 Weekly wrap\n" + wrap;
  }

  // ---------- README dashboard ----------
  updateReadme(CFG.readmeFile, { total, freeCash, aiVal, olVal, aiPct, olPct, aiMove, olMove, realised: updated.realised });

  const subject = alerts.length ? `OuterLimits • ALERT • ${new Date().toLocaleString("en-GB")}`
                                : `OuterLimits • Daily • ${new Date().toLocaleDateString("en-GB")}`;
  const body = lines.join("\n") + "\n\n" +
               (alerts.length ? "⚠️ Alerts:\n- " + alerts.join("\n- ") + "\n\n" : "") +
               "💡 Recommendations:\n- " + recs.join("\n- ") +
               weeklySection + "\n";

  await sendEmail(subject, body);
  console.log("✅ Email sent.\n" + body);
})().catch(err => {
  console.error("❌ Fatal error:", err);
  sendEmail(`OuterLimits • ERROR • ${new Date().toLocaleString("en-GB")}`, String(err)).catch(()=>process.exit(1));
});
