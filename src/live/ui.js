/**
 * ui.js — SESSION ENGINE DASHBOARD 终端 UI 渲染器
 * (RESTORED FULL EXPANDED METRICS + NEW SESSION FEATURES)
 */

import readline from "node:readline";

// ─── ANSI 颜色 ───────────────────────────────────────────────────────────────
const C = {
    reset:   "\x1b[0m",
    bold:    "\x1b[1m",
    dim:     "\x1b[2m",
    red:     "\x1b[31m",
    green:   "\x1b[32m",
    yellow:  "\x1b[33m",
    blue:    "\x1b[34m",
    magenta: "\x1b[35m",
    cyan:    "\x1b[36m",
    white:   "\x1b[97m",
    gray:    "\x1b[90m",
    bgDark:  "\x1b[48;5;234m",
    bgPanel: "\x1b[48;5;235m",
};

export const executionLogs = [];
export function logAction(msg, level = "info") {
    // level: "info" | "success" | "warm" | "error"
    const t = new Date().toLocaleTimeString();
    let prefix = gray(`[${t}]`);
    let colorMsg = msg;
    if (level === "success") colorMsg = green(msg);
    else if (level === "warn") colorMsg = yellow(msg);
    else if (level === "error") colorMsg = red(msg);
    
    executionLogs.push(`${prefix} ${colorMsg}`);
    if (executionLogs.length > 25) {
        executionLogs.shift();
    }
}

function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ""); }
function visLen(s)     { return stripAnsi(s).length; }
function padR(s, n)    { return String(s) + " ".repeat(Math.max(0, n - visLen(s))); }
function padL(s, n)    { return " ".repeat(Math.max(0, n - visLen(s))) + String(s); }
function padC(s, n)    { const gap = Math.max(0, n - visLen(s)); return " ".repeat(Math.floor(gap/2)) + s + " ".repeat(Math.ceil(gap/2)); }
function screenW()     { const w = Number(process.stdout?.columns); return (w >= 80) ? w : 160; }
function col(clr, s)   { return clr + s + C.reset; }
function green(s)      { return col(C.green, s); }
function red(s)        { return col(C.red, s); }
function yellow(s)     { return col(C.yellow, s); }
function cyan(s)       { return col(C.cyan, s); }
function gray(s)       { return col(C.gray, s); }
function bold(s)       { return col(C.bold, s); }

function signedColor(v, suffix="") {
    const n = Number(v);
    if (!Number.isFinite(n)) return gray("-");
    const s = (n >= 0 ? "+" : "") + n.toFixed(2) + suffix;
    return n > 0 ? green(s) : n < 0 ? red(s) : gray(s);
}

function fmtTime(mins) {
    if (mins === null || mins === undefined) return "--:--";
    const t = Math.max(0, Math.floor(Number(mins) * 60));
    return `${String(Math.floor(t/60)).padStart(2,"0")}:${String(t%60).padStart(2,"0")}`;
}

function sep(w, ch="─", clr=C.gray) {
    return col(clr, ch.repeat(w));
}

function signalBar(label, value, barW = 24) {
    const v = Math.max(-100, Math.min(100, Number(value) || 0));
    const half = Math.floor(barW / 2);
    let leftBar  = " ".repeat(half);
    let rightBar = " ".repeat(half);

    if (v < 0) {
        const fill = Math.round(Math.abs(v) / 100 * half);
        leftBar = " ".repeat(half - fill) + col(C.red, "█".repeat(fill));
    } else if (v > 0) {
        const fill = Math.round(v / 100 * half);
        rightBar = col(C.green, "█".repeat(fill)) + " ".repeat(half - fill);
    }

    const lbl = padL(label, 16);
    const center = col(C.gray, "│");
    return `   ${gray(lbl)} ${leftBar}${center}${rightBar}`;
}

export function renderDashboard(ctx) {
    const {
        spotPrice = null, currentPrice = null, ptb = null, timeLeft = null,
        marketQuestion = "", marketId = "", snapshotAge = 0, isDryRun = false, priceSource = "??",
        crossCount = 0, upPrice = null, downPrice = null, upBestBid = null, downBestBid = null, strategySignal = null,
        ruleScores = [], defenseMultiplier = null, positions = new Map(), pm_summary = {}, liveHistory = [],
        cvd1m = 0, cvd5m = 0, adjustedUp = null, adjustedDown = null, rsiNow = null, macd = null, vwapNow = null,
        totalWins = 0, totalLosses = 0, sessionPnl = { yes: 0, no: 0 }, loopCount = 0, isWaiting = false,
        momentum30s = null, momentum60s = null, momentum120s = null, deltaZScore = null, volRegime = null, biasScore = null, tradeIntensity30s = null,
        ema9 = null, ema21 = null, obi = null, oiDelta = 0, natAbs = { type: 'NONE', strength: 0 },
    } = ctx;

    const W = Math.min(screenW(), 220);
    const now = new Date().toLocaleTimeString();
    const out = [];

    // (1) HEADER
    const dryTag = isDryRun ? col(C.yellow, " [DRY RUN]") : "";
    const pStr = spotPrice ? col(C.white + C.bold, `$${Number(spotPrice).toLocaleString()}`) : gray("$-----");
    const header = ` BTC${dryTag}  15m  ${pStr}  ${padC(bold(C.cyan+"SESSION ENGINE DASHBOARD"), 50)}  ${col(C.green, "● LIVE")}  ${now} `;
    out.push(col(C.bgDark, padR(header, W)));
    out.push(sep(W, "─", C.gray));

    // (2) STATS
    const totalPnl = (pm_summary.totalPnl ?? 0);
    const cols2 = [
        `${gray("LIVE P&L")}  ${signedColor(totalPnl)}`,
        `${gray("RECORD")}  ${green(String(totalWins))}W/${red(String(totalLosses))}L`,
        `${gray("CURR PNL")}  Y:${signedColor(sessionPnl.yes)} N:${signedColor(sessionPnl.no)}`,
        `${gray("BALANCE")}  ${cyan("$"+(500.00 + totalPnl).toFixed(2))}`,
    ];
    out.push(" " + cols2.map(c => padR(c, Math.floor(W/cols2.length))).join(" "));
    out.push(sep(W, "═", C.gray));

    // (3) CORE COLUMNS
    const LEFT = 32, MID = 42, RIGHT = Math.max(20, W - LEFT - MID - 8);
    const ptbDist = (spotPrice !== null && ptb !== null) ? (spotPrice - ptb) : null;
    const clDist = (currentPrice !== null && ptb !== null) ? (currentPrice - ptb) : null;
    const timeColor = timeLeft < 3 ? C.red : timeLeft < 7 ? C.yellow : C.green;

    const natAbsStr = natAbs?.type === 'NONE' || !natAbs?.type ? gray("NONE") : 
        (natAbs.type === 'BUY_WALL' ? green(`BUY_WALL (+${natAbs.strength.toFixed(1)})`) : red(`SELL_WALL (-${natAbs.strength.toFixed(1)})`));

    const sessionLines = [
        bold(C.white+"[ SESSION INFO ]"),
        `${gray("Time Left")}    ${col(timeColor, fmtTime(timeLeft))}`,
        `${gray("PTB (Strike)")} ${ptb ? cyan("$"+ptb.toFixed(2)) : gray("-")}`,
        `${gray("BN Price")}     ${spotPrice ? cyan("$"+spotPrice.toFixed(1)) : gray("-")} (${signedColor(ptbDist)})`,
        `${gray("CL Price")}     ${currentPrice ? cyan("$"+currentPrice.toFixed(1)) : gray("-")} (${signedColor(clDist)})`,
        `${gray("Bias/Top5")}    ${biasScore ? (biasScore.upProb >= 0.6 ? green("UP "+(biasScore.upProb*100).toFixed(0)+"%") : biasScore.downProb >= 0.6 ? red("DN "+(biasScore.downProb*100).toFixed(0)+"%") : yellow("UP "+(biasScore.upProb*100).toFixed(0)+"%")) : gray("-")}`,
        `${gray("Src / Age")}    ${cyan(priceSource)} / ${snapshotAge.toFixed(1)}s`,
        `${gray("Nat Abs")}      ${natAbsStr}`,
        `${gray("Direction")}    ${strategySignal ? (strategySignal.side === "UP" ? green("▲ UP") : red("▼ DOWN")) : gray("NONE")}`,
        `${gray("Confidence")}   ${strategySignal ? (strategySignal.confidence >= 65 ? green(strategySignal.confidence+"%") : yellow(strategySignal.confidence+"%")) : gray("-")}`,
        `${gray("Cross Count")}  ${crossCount > 4 ? red(String(crossCount)+"⚡") : yellow(String(crossCount))}`,
        `${gray("CVD (1m/5m)")}  ${signedColor(cvd1m)} / ${signedColor(cvd5m)}`,
        `${gray("Status")}       ${isWaiting ? yellow("WAIT") : green("ACTIVE")}`,
        `${gray("Latency")}     ${ctx.serverLatency ? (ctx.serverLatency < 100 ? green(ctx.serverLatency + "ms") : ctx.serverLatency < 200 ? yellow(ctx.serverLatency + "ms") : red(ctx.serverLatency + "ms")) : gray("-")}`,
    ];

        const sumCvd = ((ruleScores.find(r=>r.rule==="R1_CVD1m")?.contribution||0) * 1) + ((ruleScores.find(r=>r.rule==="R2_CVD5m")?.contribution||0) * 1);
        const sumMom = ((ruleScores.find(r=>r.rule==="R3_Mom30s")?.contribution||0) * 1) + ((ruleScores.find(r=>r.rule==="R4_Mom60s")?.contribution||0) * 1);

    const signalLines = [
        bold(C.white+"[ SIGNAL CONFIDENCE ]"),
        signalBar("CVD", sumCvd * 40, 40),
        signalBar("Oracle", (parseFloat(ruleScores.find(r=>r.rule==="R5_OracleDist")?.contribution||0)) * 40, 40),
        signalBar("Momentum", sumMom * 40, 40),
        signalBar("OBI", (parseFloat(ruleScores.find(r=>r.rule==="R7_OBI")?.contribution||0)) * 40, 40),
        signalBar("Token Trend", (parseFloat(ruleScores.find(r=>r.rule==="R8_TokenTrend")?.contribution||0)) * 40, 40),
        signalBar("NaturalΔ OI", (parseFloat(ruleScores.find(r=>r.rule==="R9_NaturalDelta")?.contribution||0)) * 40, 40),
        "",
        `   ${gray("Composite:")} ${strategySignal ? bold(strategySignal.side==="UP"?green(`UP ${strategySignal.confidence}%`):red(`DOWN ${strategySignal.confidence}%`)) : gray("NO SIGNAL")}`
    ];

    const posLines = [bold(C.white+"[ POSITIONS ]")];
    for (const [k, p] of positions.entries()) {
        const sideC = p.side === "UP" ? green : red;
        posLines.push(`${sideC("●")} ${sideC(p.side.padEnd(4))} ${gray("$"+p.averagePrice.toFixed(3))} (${p.shares.toFixed(0)}sh)`);
    }

    const maxRows = Math.max(sessionLines.length, signalLines.length, posLines.length);
    for (let i = 0; i < maxRows; i++) {
        const l = padR(sessionLines[i] ?? "", LEFT);
        const m = padR(signalLines[i] ?? "", MID);
        const r = padR(posLines[i] ?? "", RIGHT);
        out.push(`  ${l}  │  ${m}  │  ${r}`);
    }
    out.push(sep(W, "═", C.gray));

    // (4) EXPANDED (FULL VERSION RESTORED)
    out.push(bold(gray("  EXPANDED METRICS")));
    const colAExt = [
        [`TA UP`, `${(adjustedUp*100).toFixed(1)}%`],
        [`TA DOWN`, `${(adjustedDown*100).toFixed(1)}%`],
        [`RSI(14)`, rsiNow?.toFixed(1) || "-"],
        [`VWAP`, vwapNow ? "$"+vwapNow.toFixed(2) : "-"],
        [`MACD Sig`, macd?.signal?.toFixed(4) || "-"],
        [`EMA 9`, ema9 ? "$"+ema9.toFixed(2) : "-"],
        [`EMA 21`, ema21 ? "$"+ema21.toFixed(2) : "-"],
        [`EMA Cross`, signedColor((ema9||0) - (ema21||0))],
        [`Bias/Top5`, biasScore ? (biasScore.upProb >= 0.6 ? "UP "+(biasScore.upProb*100).toFixed(0)+"%" : "DN "+(biasScore.downProb*100).toFixed(0)+"%") : "-"],
        [`CVD 1m`, signedColor(cvd1m)],
        [`OI Delta 60s`, signedColor(oiDelta, " BTC")],
        [`OBI`, obi?.toFixed(3) || "-"],
        [`Delta Z`, deltaZScore?.toFixed(2) || "-"],
        [`Tick/s 30`, tradeIntensity30s?.tickRate || "-"]
    ];
    const colBExt = [
        [`CVD 5m`, signedColor(cvd5m)],
        [`Mom 30s`, signedColor(momentum30s?.score)],
        [`Mom 60s`, signedColor(momentum60s?.score)],
        [`Mom 120s`, signedColor(momentum120s?.score)],
        [`Up Bid`, upBestBid ? "$"+upBestBid.toFixed(3) : "-"],
        [`Down Bid`, downBestBid ? "$"+downBestBid.toFixed(3) : "-"],
        [`Cross #`, String(crossCount)],
        [`Snap Age`, snapshotAge.toFixed(1) + "s"],
        [`Vol Regime`, volRegime?.regime || "-"],
        [`ATR`, volRegime?.atr ? "$"+volRegime.atr.toFixed(2) : "-"],
        [`ATR%`, volRegime?.atrPct || "-"],
        [`HV(ann)`, volRegime?.hv ? volRegime.hv+"%" : "-"],
        [`BB Width`, volRegime?.bbWidth || "-"]
    ];

    const mWExt = Math.floor(W/2)-4;
    for (let i=0; i<Math.max(colAExt.length, colBExt.length); i++) {
        const a = colAExt[i] ? `${gray(padR(colAExt[i][0],12))} ${cyan(colAExt[i][1])}` : "";
        const b = colBExt[i] ? `${gray(padR(colBExt[i][0],12))} ${cyan(colBExt[i][1])}` : "";
        out.push("  " + padR(a, mWExt) + "  " + b);
    }

    // (5) RECENT HISTORY (Last 10 trades)
    if (liveHistory && liveHistory.length > 0) {
        out.push(sep(W, "─", C.gray));
        out.push(bold(C.white + "  [ RECENT HISTORY (Last 10) ]"));
        out.push(gray(`  ${padR("TIME", 10)} ${padR("MARKET", 12)} ${padR("SIDE", 6)} ${padR("PRICE", 10)} ${padR("RESULT", 12)} ${padR("PNL", 10)}`));
        
        liveHistory.slice(0, 10).forEach(h => {
            const timeStr = new Date(h.timestamp).toLocaleTimeString();
            const sideC = h.side === "UP" ? green : red;
            const resC = h.isWin ? green : red;
            out.push(`  ${gray(padR(timeStr, 10))} ${cyan(padR(h.marketId.slice(-8), 12))} ${sideC(padR(h.side, 6))} ${gray("$"+h.avgPrice.toFixed(3))} ${resC(padR(h.exitType, 12))} ${signedColor(h.profit)}`);
        });
    }

    if (executionLogs.length > 0) {
        out.push(sep(W, "─", C.gray));
        out.push(bold(C.cyan + "  [ SESSION EXECUTION LOGS ]"));
        for (const log of executionLogs) {
            out.push("  " + log);
        }
    }

    try { readline.cursorTo(process.stdout, 0, 0); readline.clearScreenDown(process.stdout); } catch {}
    process.stdout.write(out.join("\n") + "\n");
}
