// Regenerate the architecture ASCII diagram at a narrower target inner width.
const W = 78; // inner width between outer │ borders

function width(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff);
    n += wide ? 2 : 1;
  }
  return n;
}

function pad(s, len) {
  const d = len - width(s);
  return s + " ".repeat(Math.max(0, d));
}

// wrap text to fit maxW cells, returns array of lines
function wrap(text, maxW) {
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  let curW = 0;
  const flush = () => { if (cur) { lines.push(cur); cur = ""; curW = 0; } };
  for (const word of words) {
    const ww = width(word);
    if (cur === "") { cur = word; curW = ww; }
    else if (curW + 1 + ww <= maxW) { cur += " " + word; curW += 1 + ww; }
    else { flush(); cur = word; curW = ww; }
  }
  flush();
  return lines;
}

const out = [];
const row = (s) => "\u2502" + pad(s, W) + "\u2502";
const blank = () => row("");
const hrule = () => "\u251c" + "\u2500".repeat(W) + "\u2524";
const topB = () => "\u250c" + "\u2500".repeat(W) + "\u2510";
const botB = () => "\u2514" + "\u2500".repeat(W) + "\u2518";
const center = (s) => " ".repeat(Math.max(0, Math.floor((W - width(s)) / 2))) + s;

// nested box: indent 2; nested inner width = W-6; text width inside = W-8
const NI = W - 6;        // between nested ┌ ┐
const TEXTW = W - 8;     // between nested │ │ minus 1 space each side

function nestedBox(title, items) {
  const lines = [];
  lines.push("  \u250c" + "\u2500".repeat(NI) + "\u2510  ");
  if (title) {
    wrap(title, TEXTW).forEach(l => lines.push("  \u2502 " + pad(l, TEXTW) + " \u2502  "));
  }
  items.forEach((it) => {
    wrap(it, TEXTW).forEach(l => lines.push("  \u2502 " + pad(l, TEXTW) + " \u2502  "));
  });
  lines.push("  \u2514" + "\u2500".repeat(NI) + "\u2518  ");
  return lines;
}

out.push(topB());
out.push(blank());
out.push(row(center("MATS \u2014 MULTI-AGENT TRADING SYSTEM")));
out.push(row(center("Strategic \u2192 Cognitive \u2192 Execution (closed loop)")));
out.push(blank());
out.push(hrule());

// Layer 1
out.push(row("LAYER 1 \u00b7 STRATEGIC"));
nestedBox(null, [
  "Terminal Agent  \u00b7  user prefs \u2192 rules",
  "pre-cycle rule check + post-cycle decision verification",
]).forEach(l => out.push(row(l)));
out.push(row("      \u2502"));
out.push(row("      \u25bc  preferences / rules"));
out.push(hrule());

// Layer 2
out.push(row("LAYER 2 \u00b7 COGNITIVE  (TypeScript + LLM)"));
const l2 = [
  "\u2022 parallel multi-model inference",
  "\u2022 5 Sub-Agents \u2192 Skeptics \u2192 Meta-Agent",
  "\u2022 entry thesis + dark psychology + weighted voting",
  "\u2022 Self-evolution (15 layers + Edge Validation + Q-RL, v2.0.835)",
  "\u2022 Numeric Autoencoder (learned market-condition embedding)",
  "\u2022 AttnRes cycle-history retrieval (K3 dual pseudo-query)",
  "\u2022 Anti-pattern memory (failure lesson clustering)",
  "\u2022 Conditional WR soft gate (code-level enforcement)",
  "\u2022 Combo WR gate (symbol\u00d7side\u00d7regime Wilson LB, v2.0.221)",
  "\u2022 OLR P(win)\u00d7consensus discount (multiplicative, v2.0.224)",
  "\u2022 Execution-lens SL/TP (stop-out-trained direct control)",
  "\u2022 Replay buffer (PER mini-batch retrain, v2.0.219)",
  "\u2022 Close-Context Learning (closeReason+slNarrowed, v2.0.226)",
  "\u2022 Plan G dynamic threshold (5-factor [45-55%] + penalty decay)",
  "\u2022 Edge Validation (v2.0.833): edge-calculator + execution-tracker +",
  "  stability-monitor + risk-profile edge-store + backtest validation",
  "  (Sharpe / DSR / walk-forward)",
  "\u2022 Q-RL Alpha Discovery (v2.0.835): 270-cell Q-table + \u03b5-greedy +",
  "  Wilson LB + BH-FDR + Factor-Tagged Aligned Shadow",
  "\u2022 ANN Index (v2.0.843): IVF + spherical k-means \u2014 EXP vector memory",
  "  scales to 10k records at ~12% scan rate",
  "\u2022 Asset-Aware Meta-Learner (v2.0.843): symbol \u2192 category \u2192 global",
  "  hierarchy \u2014 each asset learns its own pattern",
  "\u2022 Component Attribution (v2.0.844-848): proxy credit assignment",
  "\u2022 Smart SL/TP (v2.0.852): S/R \u2192 50-candle \u2192 ATR floor, leverage-aware",
  "  SL floor, MFE-calibrated TP target/cap + SL floor",
  "\u2022 closeReason integrity + closeTrade dual-mode guard",
  "  (v2.0.851-853): exit closes never silently skipped",
  "\u2022 Self-Aware Evolution (v2.0.843): Meta-Cognitive Calibrator +",
  "  Self-Improver + Causal Reasoner + Meta-Learner",
  "\u2022 RIL Reason Intelligence (pattern clustering + similar trade",
  "  retrieval + subtle diff LLM analysis)",
  "\u2022 Trade Incident Panel (MAE/MFE + exitThesis + post-review)",
];
const l2box = [];
l2box.push("  \u250c" + "\u2500".repeat(NI) + "\u2510  ");
l2box.push("  \u2502 " + pad("HACP Protocol + Evolution Pipeline (self-evolving)", TEXTW) + " \u2502  ");
l2.forEach(it => wrap(it, TEXTW).forEach(l => l2box.push("  \u2502 " + pad(l, TEXTW) + " \u2502  ")));
l2box.push("  \u251c" + "\u2500".repeat(NI) + "\u2524  ");
l2box.push("  \u2502 " + pad("\u25bc  conviction + thesis  \u00b7  Meta-Agent scores edge + sets SL/TP", TEXTW) + " \u2502  ");
l2box.push("  \u2514" + "\u2500".repeat(NI) + "\u2518  ");
l2box.forEach(l => out.push(row(l)));
out.push(row("      \u2502  execute"));
out.push(row("      \u25bc"));
out.push(hrule());

// Layer 3
out.push(row("LAYER 3 \u00b7 EXECUTION  (TypeScript Runtime)"));
nestedBox(null, [
  "Trading Manager \u2192 Risk Engine \u2192 Position Tracking \u00b7 SL/TP",
  "\u2022 Hyperliquid WebSocket + REST (9 perpetual DEXs)",
  "\u2022 Risk engine (millisecond, no LLM)",
  "\u2022 Paper/Real trading with unified execute/close routing",
  "\u2022 Position tracking & SL/TP \u00b7 persistence \u00b7 observability",
]).forEach(l => out.push(row(l)));
out.push(row("      \u2502  fills + PnL (learn)"));
out.push(row("      \u25bc"));
nestedBox(null, [
  "Supabase \u2192 mats_app Client (theses persisted)",
]).forEach(l => out.push(row(l)));
out.push(botB());

console.log(out.join("\n"));
