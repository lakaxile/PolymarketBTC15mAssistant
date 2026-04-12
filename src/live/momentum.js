/**
 * momentum.js — 实时币安动能 (Binance Momentum) 计算模块
 *
 * 数据来源:
 *  - @bookTicker WS  → 买一/卖一价格+数量，毫秒级推送（计算 mid price + OBI）
 *  - getCvd() ring   → 复用 cvd.js 中已有的 aggTrade 记录（计算 Volume Velocity）
 *
 * 三个子指标:
 *  A. Micro-ROC     = 当前中间价 - N秒前的中间价（价格速率）
 *  B. VolVelocity   = 近N秒成交量 / 基线平均N秒成交量（暴力扫单检测）
 *  C. OBI           = (bidQty - askQty) / (bidQty + askQty)（挂单失衡度）
 *
 * 合成公式:
 *  rawScore = 0.5 * normalizedROC + 0.3 * (volVel - 1) + 0.2 * OBI
 *  score = clamp(rawScore * 100, -100, 100)
 *
 * 对外接口:
 *  startMomentumStream(symbol)   — 启动 @bookTicker WS（有重连）
 *  getMomentum(windowSec)        — 获取 { score, roc, volVel, obi }
 *  getMomentumDebug()            — 调试信息
 */

import WebSocket from "ws";
import { wsAgentForUrl } from "../net/proxy.js";
import { CONFIG } from "../config.js";

// ─── 内部状态 ──────────────────────────────────────────────────────────────────

/** 中间价历史快照 ring: { ts, mid } */
const midRing = [];
const MID_RING_MAX_MS = 180_000; // 保留 3 分钟

/** 成交量历史 ring（从 aggTrade 数据同步）: { ts, qty } */
const volRing = [];
const VOL_RING_MAX_MS = 660_000; // 保留 11 分钟（基线用 10min，多留 1min 缓冲）

/** 最新盘口 */
let latestBid = null;
let latestBidQty = null;
let latestAsk = null;
let latestAskQty = null;

/**
 * 外部调用入口：每笔 aggTrade 推送时调用，维护 volRing
 * （从 cvd.js 或 trade.js 的 onTrade 回调里调用）
 * @param {{ quantity: number, ts?: number }} trade
 */
export function updateMomentumVolume(trade) {
    const ts = trade.ts ?? Date.now();
    const qty = trade.quantity;
    if (!qty || qty <= 0) return;
    volRing.push({ ts, qty });
    const cutoff = Date.now() - VOL_RING_MAX_MS;
    while (volRing.length > 0 && volRing[0].ts < cutoff) volRing.shift();
}

// ─── 核心计算 ──────────────────────────────────────────────────────────────────

/**
 * 获取某窗口内的成交量
 */
function getVolume(windowSec) {
    const cutoff = Date.now() - windowSec * 1000;
    return volRing
        .filter(r => r.ts >= cutoff)
        .reduce((s, r) => s + r.qty, 0);
}

/**
 * 计算基线平均每N秒的成交量（用过去10分钟的数据，分成若干个窗口求平均）
 */
function getBaselineVol(windowSec) {
    const baselineMs = 600_000; // 10 分钟
    const slots = Math.floor(baselineMs / (windowSec * 1000));
    if (slots < 2) return getVolume(windowSec) || 1;
    let total = 0;
    for (let i = 1; i <= slots; i++) {
        const end = Date.now() - (i - 1) * windowSec * 1000;
        const start = end - windowSec * 1000;
        const vol = volRing
            .filter(r => r.ts >= start && r.ts < end)
            .reduce((s, r) => s + r.qty, 0);
        total += vol;
    }
    return total / slots || 1;
}

/**
 * 获取 N 秒前的中间价
 */
function getMidNSecondsAgo(windowSec) {
    const target = Date.now() - windowSec * 1000;
    // 找距 target 最近的快照
    let best = null;
    let bestDiff = Infinity;
    for (const snap of midRing) {
        const diff = Math.abs(snap.ts - target);
        if (diff < bestDiff) { bestDiff = diff; best = snap; }
    }
    return best?.mid ?? null;
}

/**
 * 获取动能综合分 (−100 to +100)
 * @param {number} windowSec 窗口秒数，如 30/60/120
 */
export function getMomentum(windowSec = 30) {
    const mid = latestBid !== null && latestAsk !== null
        ? (latestBid + latestAsk) / 2
        : null;

    // --- A: Micro-ROC ---
    const midPast = getMidNSecondsAgo(windowSec);
    let roc = 0;
    let normRoc = 0;
    if (mid !== null && midPast !== null && midPast > 0) {
        roc = mid - midPast;
        // 归一化：以 $100 变动为满分 (±1.0)
        normRoc = Math.max(-1, Math.min(1, roc / 100));
    }

    // --- B: Volume Velocity ---
    const recentVol = getVolume(windowSec);
    const baselineVol = getBaselineVol(windowSec);
    const volVel = baselineVol > 0 ? recentVol / baselineVol : 1;
    // 1.0 = 正常，>1 = 活跃，归一化：以 3x 倍量为满分
    const normVol = Math.max(-1, Math.min(1, (volVel - 1) / 2));

    // --- C: OBI (Order Book Imbalance) ---
    let obi = 0;
    if (latestBidQty !== null && latestAskQty !== null) {
        const total = latestBidQty + latestAskQty;
        obi = total > 0 ? (latestBidQty - latestAskQty) / total : 0;
    }

    // --- 综合分 ---
    // 修复缺陷: normVol 仅代表力度大小，如果直接相加会导致“放量下跌”也变成看涨得分。
    // 因此需要让 normVol 带上当前价格的方向 (normRoc 的正负号)。
    const rocSign = normRoc !== 0 ? Math.sign(normRoc) : 0;
    // 成交量确认非对称: 下跌(rocSign < 0)时，成交量权重打 0.8 折
    // 理由: 空头往往更具恐慌性且波动大，通过打折提高空头信号的放量门槛，过滤虚假突破。
    const volAsymmetry = (rocSign < 0) ? 0.8 : 1.0;
    const dirNormVol = normVol * rocSign * volAsymmetry;
    const rawScore = 0.5 * normRoc + 0.3 * dirNormVol + 0.2 * obi;
    const score = Math.max(-100, Math.min(100, Math.round(rawScore * 100)));

    return { score, roc: parseFloat(roc.toFixed(2)), volVel: parseFloat(volVel.toFixed(2)), obi: parseFloat(obi.toFixed(3)) };
}

export function getMomentumDebug() {
    return {
        midRingSize: midRing.length,
        volRingSize: volRing.length,
        latestBid, latestAsk,
        latestBidQty, latestAskQty,
        mom30s: getMomentum(30),
        mom60s: getMomentum(60),
        mom120s: getMomentum(120),
    };
}

// ─── @bookTicker WebSocket 流 ──────────────────────────────────────────────────

/**
 * 启动 @bookTicker 流，维护 midRing 和最新盘口数据
 * @param {string} symbol 如 "BTCUSDT"
 */
export function startMomentumStream(symbol = CONFIG.symbol) {
    const BASE_RECONNECT_MS = 500;
    const HEARTBEAT_TIMEOUT_MS = 10_000;
    let ws = null;
    let closed = false;
    let reconnectMs = BASE_RECONNECT_MS;
    let heartbeatTimer = null;

    const buildUrl = (s) =>
        `wss://stream.binance.com:9443/ws/${String(s).toLowerCase()}@bookTicker`;

    const clearHb = () => { if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; } };
    const resetHb = () => {
        clearHb();
        heartbeatTimer = setTimeout(() => {
            console.warn("[MOMENTUM] bookTicker heartbeat timeout — reconnecting...");
            try { ws?.terminate(); } catch {}
        }, HEARTBEAT_TIMEOUT_MS);
    };

    function connect() {
        if (closed) return;
        const url = buildUrl(symbol);
        ws = new WebSocket(url, { agent: wsAgentForUrl(url) });

        ws.on("open", () => {
            console.log(`[MOMENTUM] bookTicker WS connected: ${symbol}`);
            reconnectMs = BASE_RECONNECT_MS;
            resetHb();
        });

        ws.on("message", (buf) => {
            try {
                const msg = JSON.parse(buf.toString());
                // bookTicker: { b: bestBidPrice, B: bestBidQty, a: bestAskPrice, A: bestAskQty }
                const bid = parseFloat(msg.b);
                const ask = parseFloat(msg.a);
                const bidQty = parseFloat(msg.B);
                const askQty = parseFloat(msg.A);

                if (!isFinite(bid) || !isFinite(ask)) return;

                latestBid = bid;
                latestAsk = ask;
                latestBidQty = isFinite(bidQty) ? bidQty : latestBidQty;
                latestAskQty = isFinite(askQty) ? askQty : latestAskQty;

                const mid = (bid + ask) / 2;
                const ts = Date.now();
                midRing.push({ ts, mid });

                // 淘汰超时快照
                const cutoff = ts - MID_RING_MAX_MS;
                while (midRing.length > 0 && midRing[0].ts < cutoff) midRing.shift();

                resetHb();
            } catch {}
        });

        let reconnecting = false;
        const scheduleReconnect = () => {
            clearHb();
            if (closed || reconnecting) return;
            reconnecting = true;
            try { ws?.removeAllListeners(); ws?.terminate(); } catch {}
            ws = null;
            const wait = reconnectMs;
            reconnectMs = Math.min(15_000, Math.floor(reconnectMs * 1.5));
            console.warn(`[MOMENTUM] bookTicker disconnected. Reconnecting in ${wait}ms...`);
            setTimeout(() => { reconnecting = false; connect(); }, wait);
        };

        ws.on("close", scheduleReconnect);
        ws.on("error", scheduleReconnect);
    }

    connect();
    return { stop() { closed = true; clearHb(); try { ws?.close(); } catch {} ws = null; } };
}
