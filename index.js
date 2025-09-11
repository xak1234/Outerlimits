// OuterLimits portfolio watcher — emails a daily digest + recommendations
// Node 20+ (has global fetch). SMTP via nodemailer.

import nodemailer from "nodemailer";

// ---- Config (tweak thresholds here) --------------------
const CFG = {
  driftMaxPct: 60,          // max % any single pie should occupy
  moveAlertPct: 2,          // daily move alert (±%)
  buyDipPct: -3,            // recommend top-up if daily move <= this
  considerSkimPct: 5,       // suggest skimming if daily move >= this
  cashFlowAbsLimit: 200,    // alert if |cash flow 24h| > this
  lookbackHours: 24
};

// ---- Env secrets ---------------------------------------
const BASE = process.env.T212_BASE;
const KEY  = process.env.T212_API_KEY;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER;
const EMAIL_TO   = process.env.EMAIL_TO || SMTP_USER;

// ---- Sanity checks -------------------------------------
if (!BASE || !KEY) {
  console.error("❌ Missing T212_BASE or T212_API_KEY. Check repo secrets.");
  process.exit(1);
}
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_TO) {
  console.error("❌ Missing SMTP_* or EMAIL_* secrets. Check repo secrets.");
  process.exit(1);
}

// ---- Helpers ------------------------------------------
async function jget(path) {
  const url = `${BASE}${path}`;
  const r = await fetch(url, {
    headers: { Authorization: KEY, Accept: "application/json" }
  });
  if (!r.ok) {
    const txt = await r.text().catch(()=>"");
    throw new Error(`❌ API ${path} -> ${r.status} ${r.statusText}\n${txt}`);
  }
  return r.json().catch(() => ({}));
}

const num = v => (typeof v === "number" && isFinite(v)) ? v : 0;
const pct = (a,b) => b ? (a/b)*100 : 0;
const fmtGBP = n => `£${n.toFixed(2)}`;

function pickPie(pies, keyword) {
  const k = keyword.toLowerCase();
  return pies.find(p => ((p?.settings?.name || p?.name || "").toLowerCase().includes(k)));
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

  if (m.aiMove != null && m.aiMove <= CFG.buyDipPct) {
    recs.push(`AI moved ${m.aiMove.toFixed(2)}% → consider a small top-up.`);
  }
  if (m.olMove != null && m.olMove <= CFG.buyDipPct) {
    recs.push(`OuterLimits moved ${m.olMove.toFixed(2)}% → consider a small top-up.`);
  }
  if (m.aiMove != null && m.aiMove >= CFG.considerSkimPct) {
    recs.push(`AI jumped ${m.aiMove.toFixed(2)}% → optional light skim.`);
  }
  if (m.olMove != null && m.olMove >= CFG.considerSkimPct) {
    recs.push(`OuterLimits jumped ${m.olMove.toFixed(2)}% → optional light skim.`);
  }

  if (Math.abs(m.flow) > CFG.cashFlowAbsLimit) {
    recs.push(`Cash flow ${fmtGBP(m.flow)} (> £${CFG.cashFlowAbsLimit}). Review deposits/withdrawals.`);
  }

  recs.push(`Maintain £100–£300 cash buffer. Rebalance if >${CFG.driftMaxPct}% cap breached.`);
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
  console.log("📡 Connecting to T212:", BASE);

  const cash = await jget("/api/v0/equity/account/cash");
  const pies = await jget("/api/v0/equity/pies");
  console.log("📊 Pies detected:", (pies||[]).map(p => p?.settings?.name || p?.name));

  const sinceIso = new Date(Date.now() - CFG.lookbackHours*3600*1000).toISOString();
  const txns = await jget(`/api/v0/history/transactions?time=${encodeURIComponent(sinceIso)}&limit=50`);


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
  const flow = items.reduce((s,t) => {
    const type = t?.type || "";
    const amt = num(t?.amount);
    if (type === "DEPOSIT") return s + amt;
    if (type === "WITHDRAW") return s - amt;
    return s;
  }, 0);

  const lines = [];
  lines.push(`Total: ${fmtGBP(total)}  |  Free cash: ${fmtGBP(freeCash)}`);
  lines.push(`AI: ${fmtGBP(aiVal)} (${aiPct.toFixed(1)}%)  •  OL: ${fmtGBP(olVal)} (${olPct.toFixed(1)}%)`);
  lines.push(`Last ${CFG.lookbackHours}h cash flow: ${fmtGBP(flow)}`);
  if (aiMove != null || olMove != null) {
    lines.push(`Moves — AI: ${aiMove?.toFixed(2) ?? "n/a"}%, OL: ${olMove?.toFixed(2) ?? "n/a"}%`);
  }

  const alerts = [];
  if (aiPct > CFG.driftMaxPct || olPct > CFG.driftMaxPct) alerts.push("Allocation drift.");
  if (Math.abs(flow) > CFG.cashFlowAbsLimit) alerts.push("Large cash flow.");
  if (aiMove != null && Math.abs(aiMove) >= CFG.moveAlertPct) alerts.push(`AI move ${aiMove.toFixed(2)}%.`);
  if (olMove != null && Math.abs(olMove) >= CFG.moveAlertPct) alerts.push(`OL move ${olMove.toFixed(2)}%.`);

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
  console.log("✅ Email sent.\n" + body);

})().catch(err => {
  console.error("❌ Fatal error:", err);
  sendEmail(`OuterLimits • ERROR • ${new Date().toLocaleString("en-GB")}`, String(err))
    .catch(() => process.exit(1));
});
