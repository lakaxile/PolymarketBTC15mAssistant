/**
 * cvd.js — 累计成交量差 (CVD) 计算模块 v2
 *
 * 特性:
 *  - 使用 AggTrade 流 (归集交易)：同价格/方向的多笔成交合并为1条，更准确
 *  - 断线时自动通过 REST `/api/v3/aggTrades` 补回丢失的增量数据
 *  - 环形缓冲区保留最近 6 分钟原始数据，支持 getCvd(60)/getCvd(300)
 *  - 提供 getCvd(windowSec), getCvdSlope(windowSec), getCvdDebug()
 *
 * 对外接口:
 *  updateCvd(trade)        — 供 binanceWs.js 的 onTrade 回调调用
 *  getCvd(windowSec)       — 获取过去 N 秒的 CVD
 *  getCvdSlope(windowSec)  — 获取 CVD 趋势斜率
 *  getCvdDebug()           — 返回调试信息
 *  startCvdStream(symbol)  — 启动内置 AggTrade WebSocket + 断线 REST 回补
 */

import WebSocket from "ws";
import { wsAgentForUrl } from "../net/proxy.js";
import { CONFIG } from "../config.js";

// 导入动能模块的 volume 回调（延迟导入避免循环依赖）
let _updateMomVol = null;
async function getMomVol() {
    if (!_updateMomVol) {
        const m = await import("./momentum.js");
        _updateMomVol = m.updateMomentumVolume;
    }
    return _updateMomVol;
}

// ─── 内部状态 ──────────────────────────────────────────────────────────────────
const RING_MAX_MS = 660_000;  // 最多保留 11 分钟原始数据

/** 环形缓冲区，每条: { ts: number, delta: number } */
const ring = [];

/** 记录上次接收到数据的时间，用于心跳超时检测 */
let lastReceivedMs = 0;
/** 记录 WS 断开时的时间戳，用于 REST 回补 */
let disconnectedAtMs = null;

// ─── 核心数据函数 ──────────────────────────────────────────────────────────────
/**
 * 处理一笔成交（来自 WS 推送或 REST 回补）
 * @param {{ price: number, quantity: number, isBuyerMaker: boolean, ts?: number }} trade
 */
export function updateCvd(trade) {
    const ts = trade.ts ?? Date.now();
    // isBuyerMaker = true → 卖方主动 → -delta (净卖压)
    // isBuyerMaker = false → 买方主动 → +delta (净买压)
    const delta = trade.isBuyerMaker ? -trade.quantity : trade.quantity;
    ring.push({ ts, delta });

    // 淘汰超过 6 分钟的记录
    const cutoff = Date.now() - RING_MAX_MS;
    while (ring.length > 0 && ring[0].ts < cutoff) ring.shift();

    lastReceivedMs = Date.now();
    // 同步喂给动能模块的 volume ring（延迟加载避免循环依赖）
    getMomVol().then(fn => fn?.(trade)).catch(() => {});
}

/**
 * 获取过去 windowSec 秒内的 CVD (净买量)
 * @param {number} windowSec  60 = 1m, 300 = 5m
 */
export function getCvd(windowSec = 60) {
    const cutoff = Date.now() - windowSec * 1000;
    let cvd = 0;
    for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i].ts < cutoff) break;
        cvd += ring[i].delta;
    }
    return cvd;
}

/**
 * 计算 CVD 线性回归斜率（正 = 买压加速，负 = 卖压加速）
 */
export function getCvdSlope(windowSec = 30) {
    const cutoff = Date.now() - windowSec * 1000;
    const points = ring.filter(r => r.ts >= cutoff);
    if (points.length < 3) return 0;
    let cum = 0;
    const series = points.map(p => { cum += p.delta; return { x: p.ts, y: cum }; });
    const n = series.length;
    const xBar = series.reduce((s, p) => s + p.x, 0) / n;
    const yBar = series.reduce((s, p) => s + p.y, 0) / n;
    const num = series.reduce((s, p) => s + (p.x - xBar) * (p.y - yBar), 0);
    const den = series.reduce((s, p) => s + (p.x - xBar) ** 2, 0);
    return den === 0 ? 0 : num / den;
}

/**
 * 交易强度 (Trade Intensity)
 *  - tickRate:  过去 N 秒内的成交笔数 / N（笔/秒）
 *  - volRate:   过去 N 秒内的总成交量 / N（BTC/秒）
 * @param {number} windowSec
 */
export function getTradeIntensity(windowSec = 30) {
    const cutoff = Date.now() - windowSec * 1000;
    let ticks = 0;
    let totalVol = 0;
    for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i].ts < cutoff) break;
        ticks++;
        totalVol += Math.abs(ring[i].delta);
    }
    return {
        tickRate: parseFloat((ticks / windowSec).toFixed(2)),
        volRate:  parseFloat((totalVol / windowSec).toFixed(4)),
    };
}

export function getCvdDebug() {

    return {
        bufferSize: ring.length,
        cvd1m:  getCvd(60),
        cvd5m:  getCvd(300),
        slope30s: getCvdSlope(30),
        lastReceivedMsAgo: lastReceivedMs ? Date.now() - lastReceivedMs : null,
    };
}

/**
 * Delta Z-score — 将当前 windowSec 的 CVD 值放到历史分布中标准化
 *
 * 公式: Z = (currentDelta - mean) / std
 *
 * @param {number} windowSec  每个采样窗口的秒数（如 30/60）
 * @param {number} numPeriods 用多少个历史样本计算均值和标准差（默认20）
 * @returns {number|null}     Z-score，若数据不足返回 null
 */
export function getDeltaZScore(windowSec = 30, numPeriods = 20) {
    const now = Date.now();
    const stepMs = windowSec * 1000;

    // 采集历史样本：每个样本是一段长度为 windowSec 的 delta 值
    const samples = [];
    for (let i = 1; i <= numPeriods; i++) {
        const end = now - (i - 1) * stepMs;
        const start = end - stepMs;
        let delta = 0;
        for (const r of ring) {
            if (r.ts >= start && r.ts < end) delta += r.delta;
        }
        samples.push(delta);
    }

    if (samples.length < 3) return null;

    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
    const std = Math.sqrt(variance);
    if (std < 0.0001) return 0; // 标准差接近零，市场极静

    const currentDelta = getCvd(windowSec);
    return parseFloat(((currentDelta - mean) / std).toFixed(2));
}

// ─── REST 补偿（断线回补）──────────────────────────────────────────────────────
/**
 * 通过 Binance REST API 拉取历史 AggTrade，补回断线期间丢失的 CVD 数据
 */
async function backfillFromRest(symbol, fromMs, toMs) {
    const limit = 1000;
    const url = `https://api.binance.com/api/v3/aggTrades?symbol=${symbol}&startTime=${fromMs}&endTime=${toMs}&limit=${limit}`;
    try {
        const res = await fetch(url);
        if (!res.ok) { console.warn(`[CVD] REST backfill HTTP ${res.status}`); return 0; }
        const trades = await res.json();
        let count = 0;
        for (const t of trades) {
            // AggTrade REST: T=time, q=quantity, m=isBuyerMaker
            updateCvd({
                ts: t.T,
                quantity: parseFloat(t.q),
                isBuyerMaker: t.m,
            });
            count++;
        }
        console.log(`[CVD] REST backfill: +${count} trades from ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}`);
        return count;
    } catch (e) {
        console.warn(`[CVD] REST backfill failed:`, e.message);
        return 0;
    }
}

// ─── AggTrade WebSocket 流（内置，带重连 + REST 回补）───────────────────────────
/**
 * 独立启动内置的 AggTrade WS 流，不需要外部再传入 onTrade。
 * 在 trade.js 的 [BOOT] 阶段调用一次即可。
 * @param {string} symbol  例如 "BTCUSDT"
 */
export function startCvdStream(symbol = CONFIG.symbol) {
    const HEARTBEAT_TIMEOUT_MS = 8_000;  // 超过 8 秒没收到数据 → 认为断线
    const BASE_RECONNECT_MS = 500;
    let reconnectMs = BASE_RECONNECT_MS;
    let ws = null;
    let closed = false;
    let heartbeatTimer = null;

    function buildUrl(sym) {
        const s = String(sym).toLowerCase();
        return `wss://stream.binance.com:9443/ws/${s}@aggTrade`;
    }

    function clearHeartbeat() {
        if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
    }

    function resetHeartbeat(sym) {
        clearHeartbeat();
        heartbeatTimer = setTimeout(() => {
            console.warn("[CVD] Heartbeat timeout — forcing WS reconnect...");
            try { ws?.terminate(); } catch {}
        }, HEARTBEAT_TIMEOUT_MS);
    }

    async function connect() {
        if (closed) return;
        const url = buildUrl(symbol);
        ws = new WebSocket(url, { agent: wsAgentForUrl(url) });

        ws.on("open", () => {
            console.log(`[CVD] AggTrade WS connected: ${url}`);
            reconnectMs = BASE_RECONNECT_MS;
            resetHeartbeat(symbol);

            // 断线回补：用 REST 填回断线期间的缺口
            if (disconnectedAtMs !== null) {
                const gapEnd = Date.now() - 1000; // 留 1s 缓冲
                const gapStart = disconnectedAtMs - 2000; // 多补 2s 确保无遗漏
                disconnectedAtMs = null;
                backfillFromRest(symbol, gapStart, gapEnd).catch(() => {});
            }
        });

        ws.on("message", (buf) => {
            try {
                const msg = JSON.parse(buf.toString());
                // AggTrade: { T: tradeTime, q: qty, m: isBuyerMaker }
                const qty = parseFloat(msg.q);
                if (!isFinite(qty) || qty <= 0) return;
                updateCvd({
                    ts: msg.T,
                    quantity: qty,
                    isBuyerMaker: !!msg.m,
                });
                resetHeartbeat(symbol);
            } catch {}
        });

        let reconnecting = false;
        const scheduleReconnect = () => {
            clearHeartbeat();
            if (closed || reconnecting) return;
            reconnecting = true;
            disconnectedAtMs = Date.now(); // 记录断线时间，供 open 时回补用
            try { ws?.removeAllListeners(); ws?.terminate(); } catch {}
            ws = null;
            const wait = reconnectMs;
            reconnectMs = Math.min(15_000, Math.floor(reconnectMs * 1.5));
            console.warn(`[CVD] WS disconnected. Reconnecting in ${wait}ms...`);
            setTimeout(() => { reconnecting = false; connect(); }, wait);
        };

        ws.on("close", scheduleReconnect);
        ws.on("error", scheduleReconnect);
    }

    connect();

    return {
        stop() { closed = true; clearHeartbeat(); try { ws?.close(); } catch {} ws = null; },
    };
}
