// OuterLimits portfolio watcher — emails a daily digest + recommendations
// Node 20+ (has global fetch). SMTP via nodemailer.

import nodemailer from "nodemailer";

// ---- Config (tweak thresholds here) --------------------
const CFG = {
  driftMaxPct: 60,          // max % any single pie should occupy (target 60/40 cap)
  moveAlertPct: 2,          // daily move alert (±%)
  buyDipPct: -3,            // recommend top-up if daily move <= this
  considerSkimPct: 5,       // consider skimming if daily move >= this
  cashFlowAbsLimit: 200,    // alert if |cash flow 24h| > this
  lookbackHours: 24
};

const BASE = process.env.T212_BASE;
const KEY  = process.env.T212_API_KEY;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER;
const EMAIL_TO   = process.env.EMAIL_TO || SMTP_USER;

if (!BASE || !KEY) {
  console.error("Missing T212_BASE or T212_API_KEY.");
  process.exit(1);
}
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_TO) {
  console.error("Missing SMTP_* or EMAIL_* secrets.");
  process.exit(1);
}

// ---- Helpers ------------------------------------------
async function jget(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { Authorization: KEY, Accept: "application/json" },
    redirect: "follow"
  });
  if (!r.ok) {
    const txt = await r.text().catch(()=>"");
    throw new Error(`${path} -> ${r.status} ${r.statusText}\n${txt}`);
  }
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? r.json() : {};
}

const num = v => (typeof v === "number" && isFinite(v)) ? v : 0;

function pickPie(pies, keyword) {
  const k = keyword.toLowerCase();
  return pies.find(p => ((p?.settings?.name || p?.name || "").toLowerCase().includes(k)));
}

function pct(a, b) { return b === 0 ? 0 : (a / b) * 100; }

function fmtGBP(n) { return `£${n.toFixed(2)}`; }

function buildRecommendations(m) {
  const recs = [];
  // Allocation
  if (m.aiPct > CFG.driftMaxPct) {
    recs.push(`AI is ${m.aiPct.toFixed(1)}% (> ${CFG.driftMaxPct}%). Prefer new contributions to OuterLimits until back near 55/45.`);
  } else if (m.olPct > CFG.driftMaxPct) {
    recs.push(`OuterLimits is ${m.olPct.toFixed(1)}% (> ${CFG.driftMaxPct}%). Prefer new contributions to AI until ~55/45.`);
  } else {
    recs.push(`Allocation healthy at AI ${m.aiPct.toFixed(1)}% / OL ${m.olPct.toFixed(1)}%. Keep contributions split to preserve ~55/45.`);
  }

  // Daily movement logic
  if (m.aiMove != null && m.aiMove <= CFG.buyDipPct) {
    recs.push(`AI moved ${m.aiMove.toFixed(2)}% today → consider a **small top-up** if conviction holds.`);
  }
  if (m.olMove != null && m.olMove <= CFG.buyDipPct) {
    recs.push(`OuterLimits moved ${m.olMove.toFixed(2)}% today → consider a **small top-up** (buy the dip).`);
  }
  if (m.aiMove != null && m.aiMove >= CFG.considerSkimPct) {
    recs.push(`AI popped ${m.aiMove.toFixed(2)}% → consider **light profit-skim** (optional).`);
  }
  if (m.olMove != null && m.olMove >= CFG.considerSkimPct) {
    recs.push(`OuterLimits popped ${m.olMove.toFixed(2)}% → consider **light profit-skim** (optional).`);
  }

  // Cash flow
  if (Math.abs(m.flow) > CFG.cashFlowAbsLimit) {
    recs.push(`Cash flow in last ${CFG.lookbackHours}h is ${fmtGBP(m.flow)} (>|£${CFG.cashFlowAbsLimit}|). Review recent deposits/withdrawals.`);
  }

  // General
  recs.push(`Maintain a £100–£300 cash buffer; otherwise let gains compound. Rebalance only if >${CFG.driftMaxPct}% cap breached.`);

  return recs;
}

async function sendEmail(subject, body) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    text: body
  });
}

// ---- Main ---------------------------------------------
(async () => {
  // Fetch data
  const cash = await jget("/api/v0/equity/account/cash");   // free, invested, pieCash, total
  const pies = await jget("/api/v0/equity/pies");           // array
  const sinceIso = new Date(Date.now() - CFG.lookbackHours*3600*1000).toISOString();
  const txns = await jget(`/api/v0/history/transactions?time=${encodeURIComponent(sinceIso)}&limit=100`);

  // Identify pies
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

  const items = txns.items || txns || [];
  const flow = items.reduce((s, t) => {
    const type = t?.type || "";
    const amt = num(t?.amount);
    if (type === "DEPOSIT") return s + amt;
    if (type === "WITHDRAW") return s - amt;
    return s;
  }, 0);

  const lines = [];
  lines.push(`Total: ${fmtGBP(total)}  |  Free cash: ${fmtGBP(freeCash)}`);
  lines.push(`AI: ${fmtGBP(aiVal)} (${aiPct.toFixed(1)}%)  •  OuterLimits: ${fmtGBP(olVal)} (${olPct.toFixed(1)}%)`);
  lines.push(`Last ${CFG.lookbackHours}h cash flow: ${fmtGBP(flow)}`);
  if (aiMove != null || olMove != null) {
    lines.push(`Moves — AI: ${aiMove?.toFixed(2) ?? "n/a"}%, OL: ${olMove?.toFixed(2) ?? "n/a"}%`);
  }

  // Alerts
  const alerts = [];
  if (aiPct > CFG.driftMaxPct || olPct > CFG.driftMaxPct) {
    alerts.push(`Allocation drift beyond ${CFG.driftMaxPct}% cap.`);
  }
  if (Math.abs(flow) > CFG.cashFlowAbsLimit) {
    alerts.push(`Cash flow ${fmtGBP(flow)} (> £${CFG.cashFlowAbsLimit}).`);
  }
  if (aiMove != null && Math.abs(aiMove) >= CFG.moveAlertPct) {
    alerts.push(`AI move ${aiMove.toFixed(2)}% (≥ ±${CFG.moveAlertPct}%).`);
  }
  if (olMove != null && Math.abs(olMove) >= CFG.moveAlertPct) {
    alerts.push(`OL move ${olMove.toFixed(2)}% (≥ ±${CFG.moveAlertPct}%).`);
  }

  const recs = buildRecommendations({ aiPct, olPct, aiMove, olMove, flow });

  const subject = alerts.length
    ? `OuterLimits • ALERT • ${new Date().toLocaleString("en-GB")}`
    : `OuterLimits • Daily • ${new Date().toLocaleDateString("en-GB")}`;

  const body =
    lines.join("\n") +
    "\n\n" +
    (alerts.length ? "⚠️ Alerts:\n- " + alerts.join("\n- ") + "\n\n" : "") +
    "💡 Recommendations:\n- " + recs.join("\n- ") + "\n";

  await sendEmail(subject, body);
  console.log("Email sent.\n" + body);
})().catch(err => {
  console.error(err);
  // Try to notify via email even on error (best effort)
  sendEmail(`OuterLimits • ERROR • ${new Date().toLocaleString("en-GB")}`, String(err))
    .catch(() => process.exit(1));
});
