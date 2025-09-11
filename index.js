// OuterLimits portfolio watcher — daily digest + Friday weekly wrap
// Node 20+ (global fetch). SMTP via nodemailer. Stores snapshots in repo.

import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

// ---- Config ----------------------------------------------------------
const CFG = {
  driftMaxPct: 60,
  moveAlertPct: 2,
  buyDipPct: -3,
  considerSkimPct: 5,
  cashFlowAbsLimit: 200,
  lookbackHours: 24,
  dataDir: "data",
  snapshotFile: "data/snapshots.json"
};

// ---- Env secrets -----------------------------------------------------
const BASE = process.env.T212_BASE;
const KEY  = process.env.T212_API_KEY;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER;
const EMAIL_TO   = process.env.EMAIL_TO || SMTP_USER;

if (!BASE || !KEY) {
  console.error("❌ Missing T212_BASE or T212_API_KEY.");
  process.exit(1);
}
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_TO) {
  console.error("❌ Missing SMTP_* or EMAIL_* secrets.");
  process.exit(1);
}

// ---- Helpers ---------------------------------------------------------
async function jget(path) {
  const url = `${BASE}${path}`;
  const r = await fetch(url, { headers: { Authorization: KEY, Accept: "application/json" } });
  if (!r.ok) {
    const txt = await r.text().catch(()=>"");
    throw new Error(`❌ API ${path} -> ${r.status} ${r.statusText}\n${txt}`);
  }
  return r.json().catch(() => ({}));
}

const num = v => (typeof v === "number" && isFinite(v)) ? v : 0;
const pct = (a,b) => b ? (a/b)*100 : 0;
const fmtGBP = n => `£${n.toFixed(2)}`;
const todayISO = () => new Date().toISOString().slice(0,10); // YYYY-MM-DD

function pickPie(pies, keyword) {
  const k = keyword.toLowerCase();
  return pies.find(p => ((p?.settings?.name || p?.name || "").toLowerCase().includes(k)));
}

async function getRecentTxns(limit = 50) {
  // No 'time' param: API returns latest page (max 50)
  return jget(`/api/v0/history/transactions?limit=${limit}`);
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readSnapshots(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { days: [] }; // { days: [ { date, total, aiVal, olVal } ] }
  }
}

function writeSnapshot(file, snap) {
  ensureDir(file);
  const db = readSnapshots(file);
  const idx = db.days.findIndex(d => d.date === snap.date);
  if (idx >= 0) db.days[idx] = snap; else db.days.push(snap);
  // Keep last 120 days to avoid bloat
  db.days = db.days.sort((a,b) => a.date.localeCompare(b.date)).slice(-120);
  fs.writeFileSync(file, JSON.stringify(db, null, 2));
}

function findLastFriday(db) {
  // Find the most recent snapshot whose date is a Friday before today
  const today = todayISO();
  const candidates = db.days.filter(d => d.date < today).reverse();
  for (const c of candidates) {
    const dow = new Date(c.date + "T12:00:00Z").getUTCDay(); // 5 = Friday
    if (dow === 5) return c;
  }
  return null;
}

function weeklyWrap(current, prior) {
  if (!prior) return null;
  const totalChg = current.total - prior.total;
  const aiChg = current.aiVal - prior.aiVal;
  const olChg = current.olVal - prior.olVal;

  const best = Math.abs(aiChg) >= Math.abs(olChg)
    ? { name: "AI", chg: aiChg }
    : { name: "OuterLimits", chg: olChg };

  const lines = [];
  lines.push(`Week-over-Week (vs last Friday ${prior.date}):`);
  lines.push(`• Total: ${fmtGBP(current.total)} (${totalChg >= 0 ? "+" : ""}${fmtGBP(totalChg).slice(1)})`);
  lines.push(`• AI: ${fmtGBP(current.aiVal)} (${aiChg >= 0 ? "+" : ""}${fmtGBP(aiChg).slice(1)})`);
  lines.push(`• OuterLimits: ${fmtGBP(current.olVal)} (${olChg >= 0 ? "+" : ""}${fmtGBP(olChg).slice(1)})`);
  lines.push(`• Best mover: ${best.name} (${best.chg >= 0 ? "+" : ""}${fmtGBP(best.chg).slice(1)})`);
  return lines.join("\n");
}

function buildRecommendations(m) {
  const recs = [];
  if (m.aiPct > CFG.driftMaxPct) {
    recs.push(`AI is ${m.aiPct.toFixed(1)}% (> ${CFG.driftMaxPct}%). Prefer new contributions to OuterLimits.`);
  } else if (m.olPct > CFG.driftMaxPct) {
    recs.push(`OuterLimits is ${m.olPct.toFixed(1)}% (> ${CFG.driftMaxPct}%). Prefer new contributions to AI.`);
  } else {
    recs.push(`Allocation healthy at AI ${m.aiPct.toFixed(1)}% / OL ${m.olPct.toFixed(1)}%.`);
  }

  if (m.aiMove != null && m.aiMove <= CFG.buyDipPct) recs.push(`AI moved ${m.aiMove.toFixed(2)}% → consider a small top-up.`);
  if (m.olMove != null && m.olMove <= CFG.buyDipPct) recs.push(`OuterLimits moved ${m.olMove.toFixed(2)}% → consider a small top-up.`);
  if (m.aiMove != null && m.aiMove >= CFG.considerSkimPct) recs.push(`AI jumped ${m.aiMove.toFixed(2)}% → optional light skim.`);
  if (m.olMove != null && m.olMove >= CFG.considerSkimPct) recs.push(`OuterLimits jumped ${m.olMove.toFixed(2)}% → optional light skim.`);

  if (Math.abs(m.flow) > CFG.cashFlowAbsLimit) recs.push(`Cash flow £${m.flow.toFixed(2)} (> £${CFG.cashFlowAbsLimit}). Review deposits/withdrawals.`);
  recs.push(`Maintain £100–£300 cash buffer. Rebalance if >${CFG.driftMaxPct}% cap breached.`);
  return recs;
}

async function sendEmail(subject, body) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  await transporter.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject, text: body });
}

// ---- Main -----------------------------------------------------------
(async () => {
  console.log("📡 Connecting to T212:", BASE);

  const cash = await jget("/api/v0/equity/account/cash");
  const pies = await jget("/api/v0/equity/pies");
  console.log("📊 Pies detected:", (pies||[]).map(p => p?.settings?.name || p?.name));

  // Transactions (last 24h via local filter)
  const sinceMs = Date.now() - CFG.lookbackHours*3600*1000;
  const txns = await getRecentTxns(50);
  const itemsRaw = txns.items || txns || [];
  const items = itemsRaw.filter(t => {
    const ts = new Date(t.time || t.timestamp || t.createdAt || t.date || 0).getTime();
    return Number.isFinite(ts) && ts >= sinceMs;
  });

  // Values
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

  // Cash flow
  const flow = items.reduce((s,t) => {
    const type = t?.type || "";
    const amt = num(t?.amount);
    if (type === "DEPOSIT") return s + amt;
    if (type === "WITHDRAW") return s - amt;
    return s;
  }, 0);

  // ---- Build daily email ------------------------------------------
  const lines = [];
  lines.push(`Total: ${fmtGBP(total)}  |  Free cash: ${fmtGBP(freeCash)}`);
  lines.push(`AI: ${fmtGBP(aiVal)} (${aiPct.toFixed(1)}%)  •  OL: ${fmtGBP(olVal)} (${olPct.toFixed(1)}%)`);
  lines.push(`Last ${CFG.lookbackHours}h cash flow: £${flow.toFixed(2)}`);
  if (aiMove != null || olMove != null) lines.push(`Moves — AI: ${aiMove?.toFixed(2) ?? "n/a"}%, OL: ${olMove?.toFixed(2) ?? "n/a"}%`);

  const alerts = [];
  if (aiPct > CFG.driftMaxPct || olPct > CFG.driftMaxPct) alerts.push("Allocation drift beyond cap.");
  if (Math.abs(flow) > CFG.cashFlowAbsLimit) alerts.push("Large cash flow.");
  if (aiMove != null && Math.abs(aiMove) >= CFG.moveAlertPct) alerts.push(`AI move ${aiMove.toFixed(2)}%.`);
  if (olMove != null && Math.abs(olMove) >= CFG.moveAlertPct) alerts.push(`OL move ${olMove.toFixed(2)}%.`);

  const recs = buildRecommendations({ aiPct, olPct, aiMove, olMove, flow });

  // ---- Persist snapshot -------------------------------------------
  const today = todayISO();
  const currentSnap = { date: today, total, aiVal, olVal };
  writeSnapshot(CFG.snapshotFile, currentSnap);
  const db = readSnapshots(CFG.snapshotFile);

  // ---- Weekly wrap (Fridays) --------------------------------------
  let weeklySection = "";
  const isFriday = new Date().getUTCDay() === 5; // Friday
  if (isFriday) {
    const priorFriday = findLastFriday(db);
    const wrap = weeklyWrap(currentSnap, priorFriday);
    if (wrap) {
      weeklySection = "\n\n📅 Weekly wrap\n" + wrap;
    }
  }

  const subject = alerts.length
    ? `OuterLimits • ALERT • ${new Date().toLocaleString("en-GB")}`
    : `OuterLimits • Daily • ${new Date().toLocaleDateString("en-GB")}`;

  const body =
    lines.join("\n") +
    "\n\n" +
    (alerts.length ? "⚠️ Alerts:\n- " + alerts.join("\n- ") + "\n\n" : "") +
    "💡 Recommendations:\n- " + recs.join("\n- ") +
    weeklySection + "\n";

  await sendEmail(subject, body);
  console.log("✅ Email sent.\n" + body);

})().catch(err => {
  console.error("❌ Fatal error:", err);
  sendEmail(`OuterLimits • ERROR • ${new Date().toLocaleString("en-GB")}`, String(err))
    .catch(() => process.exit(1));
});
