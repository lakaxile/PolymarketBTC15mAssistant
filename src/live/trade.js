import { LIVE_CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "../data/binance.js";
import { fetchChainlinkBtcUsd } from "../data/chainlink.js";
import { startChainlinkPriceStream } from "../data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "../data/polymarketLiveWs.js";
import { cancelAllOpenOrders } from "./clob.js";
import {
    fetchMarketBySlug,
    fetchLiveEventsBySeriesId,
    flattenEventMarkets,
    pickLatestLiveMarket,
    fetchPolymarketSnapshot,
    extractNumericFromMarket,
    parsePriceToBeat,
    fetchExactPriceToBeat,
    fetchLivePriceFromFun
} from "../data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "../indicators/vwap.js";
import { computeRsi, slopeLast } from "../indicators/rsi.js";
import { computeMacd, ema } from "../indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "../indicators/heikenAshi.js";
import { scoreDirection, applyTimeAwareness } from "../engines/probability.js";
import { calcVolRegimeMetrics } from "../engines/regime.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep, ensureDir, rotateCsvFile } from "../utils.js";
import { startBinanceTradeStream } from "../data/binanceWs.js";
import { applyGlobalProxyFromEnv } from "../net/proxy.js";
import { LivePositionManager } from "./position_manager.js";
import { LiveExecutor } from "./executor.js";
import { myCustomStrategy } from "./strategy.js";
import { sendTelegramMessage } from "../utils/telegram.js";
import { startCvdStream, getCvd, getDeltaZScore, getTradeIntensity } from "./cvd.js";
import { recordWindow, calcVolRegime, calcBinanceMom, getPriorBias } from "./memory.js";
import { renderDashboard, executionLogs, logAction } from "./ui.js";
import { startMomentumStream, getMomentum, updateMomentumVolume } from "./momentum.js";
import { fetchAndRecordOI, getOIDelta } from "../data/openInterest.js";
import readline from "node:readline";
import fs from "fs";

// 全局 Live 状态
import { execSync } from "child_process";
import { generateDailyReport } from "../../scripts/daily_report.js";

const CONFIG = { symbol: "BTCUSDT", candleWindowMinutes: 15 };

// --- UI 工具 (保持与 index.js 一致) ---
const ANSI = {
    reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
    gray: "\x1b[90m", white: "\x1b[97m", dim: "\x1b[2m", cyan: "\x1b[36m", magenta: "\x1b[35m"
};
function screenWidth() { const w = Number(process.stdout?.columns); return Number.isFinite(w) && w >= 40 ? w : 80; }
function sepLine(ch = "─") { return `${ANSI.white}${ch.repeat(screenWidth())}${ANSI.reset}`; }
function renderScreen(text) { try { readline.cursorTo(process.stdout, 0, 0); readline.clearScreenDown(process.stdout); } catch { } process.stdout.write(text); }
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ""); }
function padLabel(label, width) { const visible = stripAnsi(label).length; return label + " ".repeat(Math.max(0, width - visible)); }
const LABEL_W = 16;
function kv(label, value) { return `${padLabel(String(label), LABEL_W)}${value}`; }

/**
 * 格式化剩余时间为 MM:SS
 */
function fmtTimeLeft(mins) {
    const totalSeconds = Math.max(0, Math.floor(mins * 60));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * 带有颜色和趋势箭头的价格显示
 */
function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
    if (price === null || price === undefined) return `${label}: ${ANSI.gray}-${ANSI.reset}`;
    const p = Number(price);
    const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);
    let color = ANSI.reset;
    let arrow = "";
    if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
        if (p > prev) { color = ANSI.green; arrow = " ↑"; } else { color = ANSI.red; arrow = " ↓"; }
    }
    const formatted = `${prefix}${formatNumber(p, decimals)}`;
    return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

function formatSignedDelta(delta, base) {
    if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
    const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
    const pct = (Math.abs(delta) / Math.abs(base)) * 100;
    return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`;
}

function colorByNarrative(text, narrative) {
    if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
    if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
    return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatNarrativeValue(label, value, narrative) {
    return `${label}: ${colorByNarrative(value, narrative)}`;
}

function narrativeFromSign(x) {
    if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL";
    return Number(x) > 0 ? "LONG" : "SHORT";
}

function narrativeFromSlope(slope) {
    if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL";
    return Number(slope) > 0 ? "LONG" : "SHORT";
}

function formatProbPct(p, digits = 0) {
    if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-";
    return `${(Number(p) * 100).toFixed(digits)}%`;
}

function formatOrderBookSide(sideData, color) {
    if (!sideData || sideData.length === 0) return [`${ANSI.gray}  (empty)     ${ANSI.reset}`];
    return sideData.map(lvl => {
        const price = (lvl.price * 100).toFixed(1) + "¢";
        const size = formatNumber(lvl.size, 0);
        // 价格 5位 + 空格 1位 + 数量 7位 = 13位可见字符
        return `${color}${price.padStart(5)}${ANSI.reset} ${ANSI.gray}${size.padStart(7)}${ANSI.reset}`;
    });
}

export async function runLiveTrading() {
    // --- 启动时日志轮转 (防止单个文件过大) ---
    rotateCsvFile("./logs/signals.csv", 400 * 1024 * 1024); // 400MB 轮转
    rotateCsvFile("./logs/live_trades.csv", 50 * 1024 * 1024); // 50MB 轮转

    console.log(`${ANSI.cyan}[BOOT] Starting BTC-15m Trading Engine...${ANSI.reset}`);
    applyGlobalProxyFromEnv();

    const pm = new LivePositionManager();
    const executor = new LiveExecutor(pm);
    const liveHistory = [];

    console.log(`[BOOT] Initializing Data Streams (WS)...`);
    const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
    // CVD 使用独立的 AggTrade WS 流（含断线回补逻辑）
    startCvdStream(CONFIG.symbol);
    // 动能流：@bookTicker 中间价 + OBI，与 CVD 共用 aggTrade 数据给 VolVelocity
    startMomentumStream(CONFIG.symbol);
    // 将 aggTrade 同时喂给 momentum 模块
    const _cvdOrig = (await import("./cvd.js")).updateCvd;
    // 在 cvd.js 的 ring 写入时同步听用 volRing (monkeypatch trade stream)
    // 注：由于 cvd.js 的 startCvdStream 已经独立运行 aggtrade，这里通过内置动态 import 吅入
    // 实际地: momentum volRing 通过 cvd.js 的 updateCvd 被调用时同时善加
    // cvd.js updateCvd 内里直接调用 updateMomentumVolume
    
    const polymarketLiveStream = startPolymarketChainlinkPriceStream({ onUpdate: d => d.error && console.warn(`[DATA] Poly Live WS Error: ${d.error}`) });
    const chainlinkStream = startChainlinkPriceStream({ onUpdate: d => d.error && console.warn(`[DATA] Chainlink WS Error: ${d.error}`) });

    let lastKnownSpotPrice = null;
    let lastKnownCurrentPrice = null;
    let priceToBeatState = { slug: null, value: null, setAtMs: null };

    // --- 三层策略新增状态变量 ---
    let crossCount = 0;               // 当前窗口 oracle 穿越 PTB 次数
    let lastCrossSide = null;         // 上一次 spot 相对 PTB 的位置 ('above'|'below')
    let upPriceSeries = [];           // 最近30秒的 UP token 价格序列
    let spotPriceRing = [];           // 最近60秒的现货价格序列，用于计算 Nat Abs
    let lastWindowMarketId = null;    // 用于检测窗口切换
    let lastWindowPtb = null;         // 记录当前窗口的 PTB
    let lastWindowFinalSpot = null;   // 记录当前窗口最后一个现货价格
    let memoryWindowFeatures = null;  // 当前窗口特征向量（送给 Memory Layer）
    let premiumEma = null;
    let initialMarketId = null; // 用于记录启动时遇到的第一个市场，该市场内禁止建新仓
    let lastReportDay = new Date().getDate(); // 记录当前日期天数
    const LIVE_LOG_FILE = "./logs/live_trades.csv";
    const LOG_HEADER = ["Time", "MarketID", "Question", "Strategy", "Side", "Shares", "EntryConf", "EntryPrice", "ExitPrice", "Result", "Profit", "CVD_Score", "Oracle_Score", "Mom_Score", "OBI_Score", "Multiplier", "DefReason"];
    // --- 异步快照背景任务 ---
    // 为了防止缓慢的 Polymarket API 阻塞 100ms 级别的抢跑逻辑，我们将 Gamma/CLOB 快照异步化
    const snapshotState = { data: null, updatedAt: 0, isFetching: false, error: null };
    const runSnapshotCycle = async () => {
        if (snapshotState.isFetching) return;
        snapshotState.isFetching = true;
        try {
            const poly = await fetchPolymarketSnapshot();
            if (poly.ok) {
                snapshotState.data = poly;
                snapshotState.updatedAt = Date.now();
                snapshotState.error = null;
            } else { snapshotState.error = poly.reason; }
        } catch (e) { snapshotState.error = e.message; }
        finally { snapshotState.isFetching = false; }
    };

    console.log(`[BOOT] Fetching initial market snapshot...`);
    await runSnapshotCycle();
    setInterval(runSnapshotCycle, 3000);

    // 每小时强制进行一次深度垃圾回收 (需要 node --expose-gc 启动)
    setInterval(() => {
        if (global.gc) {
            console.log("[MEMORY] Running scheduled hourly garbage collection...");
            global.gc();
        } else {
            console.warn("[MEMORY] Scheduled GC skipped. Please run node with --expose-gc flag to enable manual memory cleanup.");
        }
    }, 60 * 60 * 1000);

    // 每 20 秒启动订单清道夫，主动扫除链上所有残留废单
    // 防止 IOC 取消失效导致的地雷订单积累
    if (!LIVE_CONFIG.isDryRun) {
        setInterval(async () => {
            try {
                await cancelAllOpenOrders();
            } catch (e) {
                console.warn("[JANITOR] Order sweep failed:", e.message);
            }
        }, 20 * 1000);
        console.log(`[BOOT] Order Janitor started (sweeps every 20s).`);
    }

    // OI 轮询 (每 5 秒一次，无需 API Key)
    fetchAndRecordOI();
    setInterval(() => fetchAndRecordOI(), 5000);
    console.log(`[BOOT] OI polling started (Binance Futures, 5s interval).`);

    console.log(`[BOOT] Verifying USDC Balance...`);
    await pm.fetchUsdcBalance();

    // --- Polymarket CLOB 服务器延迟测量 ---
    let serverLatencyMs = null;
    let lastLatencyCheck = 0;
    const measureLatency = async () => {
        const start = Date.now();
        try {
            const res = await fetch("https://clob.polymarket.com/markets?limit=1", { 
                method: "GET",
                headers: { "Content-Type": "application/json" }
            });
            serverLatencyMs = Date.now() - start;
            lastLatencyCheck = Date.now();
        } catch (e) {
            serverLatencyMs = null;
        }
    };
    // 初始测量
    measureLatency();
    // 每 30 秒测量一次延迟
    setInterval(measureLatency, 30000);

    console.log(`[BOOT] Entering Fast Action Loop (200ms)...`);
    let loopCount = 0;
    let lastRenderTime = 0;
    let activeNatAbs = { type: "NONE", strength: 0, expiresAt: 0 };

    while (true) {
            // --- 每日自动生成报表 (由于是长时间运行程序) ---
            const currentDay = new Date().getDate();
            if (currentDay !== lastReportDay) {
                console.log(`[REPORT] Date changed, generating daily diagnostic...`);
                try {
                    const msg = await generateDailyReport();
                    if (msg) sendTelegramMessage(msg);
                    lastReportDay = currentDay;
                } catch (e) {
                    console.error("Failed to generate daily report", e);
                }
            }

            loopCount++;
            try {
        const poly = snapshotState.data;
        if (!poly) { console.log("poly null, error:", snapshotState.error); await sleep(1000); continue; }

        const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);
        // 这里是 100ms 级别的实时读取，优先使用 WebSocket 数据
        let spotPrice = binanceStream.getLast()?.price ?? lastKnownSpotPrice;

        const polyWs = polymarketLiveStream.getLast();
        const clWs = chainlinkStream.getLast();
        
        // 恢复：直接让 Polymarket 的高频报价主导
        let currentPrice = polyWs?.price ?? clWs?.price;
        let priceSource = polyWs?.price ? "PM_WS" : (clWs?.price ? "CL_WS" : "NONE");

        // 强力兜底逻辑：如果 WebSocket 全挂了，或者检测到 100 点以上的异常基差，每隔 2 秒通过 Fun.xyz API 同步最准实时价
        const isStaleOrOff = currentPrice === null || (spotPrice && Math.abs(currentPrice - spotPrice) > 150);
        if (isStaleOrOff && (loopCount % 10 === 0)) {
            const funPrice = await fetchLivePriceFromFun("BTC");
            if (funPrice) {
                currentPrice = funPrice;
                priceSource = "FUN_API";
            } else if (currentPrice === null) {
                // 如果 Fun API 也挂了，才用最后的 Aggregator REST
                const chainlinkRest = await fetchChainlinkBtcUsd();
                if (chainlinkRest?.price) {
                    currentPrice = chainlinkRest.price;
                    priceSource = "CL_REST";
                }
            }
        }

        if (currentPrice !== null) {
            lastKnownCurrentPrice = currentPrice;
        } else {
            currentPrice = lastKnownCurrentPrice;
            if (currentPrice !== null) priceSource = "CACHE";
        }

        if (spotPrice !== null && currentPrice !== null) {
            lastKnownSpotPrice = spotPrice;
            lastWindowFinalSpot = spotPrice; // 不断更新，作为最后关头的结算参考价
            const currentPremium = spotPrice - currentPrice;
            // 计算溢价 EMA，用于策略参考
            premiumEma = (premiumEma === null) ? currentPremium : premiumEma * 0.9 + currentPremium * 0.1;
            
            // 记录 60 秒内的现货价格轨迹
            spotPriceRing.push({ ts: Date.now(), p: spotPrice });
            const cutoff60s = Date.now() - 60000;
            while (spotPriceRing.length > 0 && spotPriceRing[0].ts < cutoff60s) {
                spotPriceRing.shift();
            }
        }

        // 定期同步 (30s)
        if (loopCount % 150 === 1) await pm.syncWithClob(poly);

        // 过期结算判断与本地状态更新 (但不立刻从内存中删除，等待链上真正清零)
        for (const [key, pos] of pm.positions.entries()) {
            if (Date.now() > pos.expiryMs && !pos.isSettling) {
                // Polymarket 15m盘口完全按 Chainlink 数据流结算。优先使用最新 Chainlink 价 (currentPrice)，其次兜底
                const finalRefPrice = currentPrice ?? spotPrice ?? 0;
                const winningSide = finalRefPrice >= (pos.ptb || 0) ? "UP" : "DOWN";
                const isWin = pos.side === winningSide;
                const profit = (isWin ? pos.shares : 0) - pos.totalCost;
                if (!pos.isDead) { // 重新加上这个 if，以匹配 316 行的 }
                    const s = pos.entrySignal || {};
                    liveHistory.unshift({ 
                        timestamp: Date.now(), 
                        marketId: pos.marketId,
                        side: pos.side,
                        shares: pos.shares,
                        avgPrice: pos.averagePrice,
                        isWin, 
                        profit, 
                        exitType: "SETTLED" 
                    });
                    if (liveHistory.length > 10) liveHistory.pop();
                    appendCsvRow(LIVE_LOG_FILE, LOG_HEADER, [
                        new Date().toLocaleString(), pos.marketId, pos.question || "-", pos.strategyType, pos.side,
                        pos.shares?.toFixed(2) || "-",
                        s.conf?.toFixed(1) || "-",
                        (pos.averagePrice || 0).toFixed(4), (isWin ? 1 : 0).toFixed(4), // ExitPrice for settled is 1 or 0
                        isWin ? "WIN" : "LOSS", profit.toFixed(2),
                        s.scores?.cvd?.toFixed(2) || "-",
                        s.scores?.oracle?.toFixed(2) || "-",
                        s.scores?.mom?.toFixed(2) || "-",
                        s.scores?.obi?.toFixed(2) || "-",
                        s.multiplier?.toFixed(2) || "-",
                        s.reason || "-"
                    ]);
                    sendTelegramMessage(`🏁 *周期完结等待派发 [${pos.strategyType}]*\n市场: \`${pos.marketId}\`\n预测结果: *${isWin ? "命中" : "未命中"}*\n这笔仓位将静置直到链上合约自动结算配币。`);
                }

                // 标记为正在结算中，防止 UI 闪烁和机器人再对它做任何交易操作
                // 不调用 pm.recordExit()！让它留在 pm 里，直到 syncWithClob 发现链上余额归零再去 delete
                pos.isSettling = true;
            }
        }

        const marketSlug = poly.market?.slug ?? "";
            const currentMarketId = poly.market?.id ?? null;

            // --- 窗口切换检测：重置 crossCount 和 upPriceSeries ---
            if (currentMarketId && currentMarketId !== lastWindowMarketId) {
                // 记录上一个窗口到 Memory Layer
                if (lastWindowMarketId && memoryWindowFeatures && lastWindowPtb !== null && lastWindowFinalSpot !== null) {
                    const winningSide = lastWindowFinalSpot >= lastWindowPtb ? "UP" : "DOWN";
                    recordWindow(memoryWindowFeatures, winningSide);
                }

                crossCount = 0;
                lastCrossSide = null;
                upPriceSeries = [];
                memoryWindowFeatures = null;
                
                executionLogs.length = 0; // Clear the UI session logs
                logAction(`[SYSTEM] New 15m session detected: ${currentMarketId}. Cache cleared.`, "warn");

                lastWindowMarketId = currentMarketId;
                lastWindowPtb = null;
                console.log(`[MEMORY] New window detected: ${currentMarketId}. CrossCount reset.`);
            }

            if (marketSlug && priceToBeatState.slug !== marketSlug) {
                priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
                // 异步获取真正的 Baseline Price (PTB)
                fetchExactPriceToBeat(marketSlug, poly.market?.conditionId).then(exactPtb => {
                    if (exactPtb && priceToBeatState.slug === marketSlug) {
                        priceToBeatState.value = exactPtb;
                        priceToBeatState.setAtMs = Date.now();
                        // 强制更新当前的局部 ptb 变量，确保 UI 立即响应
                        if (typeof ptb !== 'undefined') ptb = exactPtb; 
                        console.log(`[DATA] PTB Resolved: $${exactPtb} for ${marketSlug}`);
                    }
                }).catch(e => console.warn(`[DATA] PTB Fetch error: ${e.message}`));
            }

            // 15m 市场优先相信异步获取的精确值，不再使用模糊的 parsePriceToBeat（防止误抓现价）
            let ptb = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;
            
            // 如果内部协议还没抓到，再尝试从 market 对象内置字段里找 (针对非 15m 市场)
            if (ptb === null && !marketSlug.includes("-15m-")) {
                ptb = extractNumericFromMarket(poly.market) ?? parsePriceToBeat(poly.market);
            }
            if (ptb !== null) {
                lastWindowPtb = ptb;
                for (const [key, tradeObj] of pm.positions.entries()) {
                    if (key.startsWith(poly.market.id) && (tradeObj.ptb === null || tradeObj.ptb === undefined)) tradeObj.ptb = ptb;
                }
            }

            const settlementMs = poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
            const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;

            // --- 策略与信号 ---
            const [klines1m] = await Promise.all([fetchKlines({ interval: "1m", limit: 60 })]);
            const closes = klines1m.map(c => c.close);
            const vwapNow = computeSessionVwap(klines1m);
            const rsiNow = computeRsi(closes, 14);
            const rsiSeries = [];
            for (let i = Math.max(0, closes.length - 5); i < closes.length; i++) {
                const r = computeRsi(closes.slice(0, i + 1), 14);
                if (r !== null) rsiSeries.push(r);
            }
            const rsiSlope = slopeLast(rsiSeries, 3);
            const macd = computeMacd(closes, 12, 26, 9);
            const ema9 = ema(closes, 9);
            const ema21 = ema(closes, 21);
            const ha = computeHeikenAshi(klines1m);
            const consec = countConsecutive(ha);
            // --- 追踪 oracle 穿越次数 ---
            if (ptb !== null && spotPrice !== null) {
                const nowSide = spotPrice >= ptb ? 'above' : 'below';
                if (lastCrossSide !== null && nowSide !== lastCrossSide) {
                    crossCount++;
                    console.log(`[CROSS] Oracle crossed PTB! crossCount=${crossCount}`);
                }
                lastCrossSide = nowSide;
            }

            // --- 追踪 UP token 价格序列 (最近30秒，每秒一条记录) ---
            if (poly.prices?.up && loopCount % 5 === 0) { // 每 ~1s 采样一次
                upPriceSeries.push(poly.prices.up);
                if (upPriceSeries.length > 30) upPriceSeries.shift();
            }

            // --- 构建当前窗口特征向量 (Window Features for Memory Layer) ---
            if (memoryWindowFeatures === null && ptb !== null && spotPrice !== null && klines1m.length > 0) {
                memoryWindowFeatures = {
                    openDevPct: (spotPrice - ptb) / ptb,
                    volRegime: calcVolRegime(klines1m),
                    binanceMom: calcBinanceMom(klines1m),
                    upOddsOpen: poly.prices?.up ?? 0.5,
                };
            }

            //综合指标打分
            const scored = scoreDirection({ price: spotPrice, vwap: vwapNow, rsi: rsiNow, rsiSlope, macd, heikenColor: consec.color, heikenCount: consec.count });
            const volRegime = calcVolRegimeMetrics(klines1m);
            // 考虑时间衰减的概率调整
            const timeAware = applyTimeAwareness(scored.rawUp, timing.remainingMinutes, CONFIG.candleWindowMinutes);

            // --- Scalping 止盈核心逻辑 (按策略+方向分组，聚合成本后统一决策) ---

            // Step 1: 按方向(UP/DOWN)统一分组 — 所有策略同方向合并出货，避免碎仓<5share
            // MANUAL, EDGE, STRATEGY_2_PREMIUM, STRATEGY_1 同方向全部合池
            const exitGroups = new Map();
            for (const [tradeKey, pos] of pm.positions.entries()) {
                if (!tradeKey.startsWith(poly.market.id)) continue;
                if (pos.isDead || pos.isSettling) continue;

                // 只按方向分组，不区分策略
                const groupKey = pos.side; // "UP" or "DOWN"

                if (!exitGroups.has(groupKey)) {
                    // 用最高优先级策略
                    exitGroups.set(groupKey, {
                        positions: [], totalShares: 0, totalCost: 0,
                        side: pos.side,
                        strategyType: pos.strategyType,   // 第一个进来的策略作代表，后续覆盖优先级
                        tokenID: pos.tokenID, marketId: pos.marketId, question: pos.question,
                    });
                }
                const g = exitGroups.get(groupKey);
                g.positions.push({ tradeKey, pos });
                g.totalShares += pos.shares;
                g.totalCost += pos.totalCost;
                // 如果组内有 EDGE 仓位，强制全组用 99¢ 出货规则（EDGE 不能被 MANUAL 的+12¢ 规则覆盖）
                if (pos.strategyType === "EDGE") g.hasEdge = true;
                // 非EDGE策略优先级: STRATEGY_2_PREMIUM > MANUAL > STRATEGY_1
                const priority = { STRATEGY_2_PREMIUM: 3, MANUAL: 2, STRATEGY_1: 1 };
                if (!g.hasEdge && (priority[pos.strategyType] ?? 0) > (priority[g.strategyType] ?? 0)) {
                    g.strategyType = pos.strategyType;
                }
            }

            // Step 2: 对每个分组做一次统一的止损 / 止盈决策
            for (const [groupKey, g] of exitGroups.entries()) {
                const book = g.side === "UP" ? poly.orderbook.up : poly.orderbook.down;
                const currentBid = book.bestBid;
                if (!currentBid || g.totalShares <= 0) continue;

                const avgPrice = g.totalCost / g.totalShares;
                const currentProfitPct = (currentBid / avgPrice) - 1;

                // --- 深度亏损自动清理 (Auto-Abandon) ---
                if ((currentBid === null || currentBid <= 0.02) && settlementLeftMin !== null && settlementLeftMin <= 8) {
                    for (const { pos } of g.positions) {
                        if (!pos.isDead) {
                            const profit = -pos.totalCost;
                            const s = pos.entrySignal || {};
                            liveHistory.unshift({ 
                                timestamp: Date.now(), 
                                marketId: pos.marketId,
                                side: pos.side,
                                shares: pos.shares,
                                avgPrice: avgPrice,
                                isWin: false, 
                                profit, 
                                exitType: "LOSS (AUTO)" 
                            });
                            if (liveHistory.length > 10) liveHistory.pop();
                            appendCsvRow(LIVE_LOG_FILE, LOG_HEADER, [
                                new Date().toLocaleString(), pos.marketId, pos.question || "-", pos.strategyType, pos.side,
                                pos.shares?.toFixed(2) || "-",
                                s.conf?.toFixed(1) || "-",
                                avgPrice.toFixed(4), currentBid.toFixed(4), "LOSS (AUTO)", profit.toFixed(2),
                                s.scores?.cvd?.toFixed(2) || "-",
                                s.scores?.oracle?.toFixed(2) || "-",
                                s.scores?.mom?.toFixed(2) || "-",
                                s.scores?.obi?.toFixed(2) || "-",
                                s.multiplier?.toFixed(2) || "-",
                                s.reason || "-"
                            ]);
                            sendTelegramMessage(`💀 *深度亏损自动拔管 [${pos.strategyType}]*\n方向: *${g.side}*\n成本: \`$${pos.totalCost.toFixed(2)}\`\n状态: 无买盘，自动按止损结算。`);
                            pos.isDead = true;
                        }
                    }
                    continue;
                }

                // --- 止盈规则 (全量拿到 99¢ 才出局) ---
                // 根据用户需求，取消原有的网格剥头皮 (10¢/15%自动跑路) 逻辑。
                // 现在不管是哪种策略，全部死拿到 99¢ 为止 (或者等过期结算)。
                let shouldSell = false;
                if (currentBid >= 0.99) {
                    shouldSell = true;
                }

                if (!shouldSell) continue;

                // --- 5-share 最小挂单强制检查 ---
                // 规则：卖出后剩余必须是 0 或 >= 5。不满足就卖光全部。
                let sharesToSell = g.totalShares;
                // 如果总量本身就不足 5，标记为粉尘，结算时等待到期
                if (sharesToSell < 5) {
                    for (const { pos } of g.positions) {
                        if (!pos.isDust) {
                            console.warn(`[EXEC] Group ${groupKey} total ${sharesToSell.toFixed(4)} shares < 5. Marking as Dust.`);
                            pos.isDust = true;
                        }
                    }
                    continue;
                }

                // 执行出货 (统一以第一个持仓的 tokenID 为准，同组 tokenID 都一样)
                console.log(`[EXEC] Group exit: ${groupKey} | ${sharesToSell.toFixed(4)} shares @ avg ${avgPrice.toFixed(3)} | P/L ${(currentProfitPct * 100).toFixed(1)}%`);
                const matchedShares = await executor.executeScalp(g.marketId, g.side, g.strategyType, currentBid, book);
                if (matchedShares && matchedShares > 0) {
                    const profit = (currentBid * matchedShares) - (avgPrice * matchedShares);
                    const s = g.positions[0]?.pos?.entrySignal || {};
                    liveHistory.unshift({ 
                        timestamp: Date.now(), 
                        marketId: g.marketId, 
                        side: g.side, 
                        strategyType: g.strategyType, 
                        question: g.question, 
                        avgPrice: avgPrice, 
                        sellPrice: currentBid,
                        isWin: profit >= 0, 
                        profit, 
                        exitType: "SCALPED" 
                    });
                    if (liveHistory.length > 10) liveHistory.pop();
                    pm.fetchUsdcBalance();
                    // 记录完整的 17 列日志，保持与 SETTLED 一致
                    appendCsvRow(LIVE_LOG_FILE, LOG_HEADER, [
                        new Date().toLocaleString(), g.marketId, g.question || "-", g.strategyType, g.side, 
                        matchedShares.toFixed(2),
                        s.conf?.toFixed(1) || "-",
                        avgPrice.toFixed(4), currentBid.toFixed(4), 
                        "SCALPED", profit.toFixed(2),
                        s.scores?.cvd?.toFixed(2) || "-",
                        s.scores?.oracle?.toFixed(2) || "-",
                        s.scores?.mom?.toFixed(2) || "-",
                        s.scores?.obi?.toFixed(2) || "-",
                        s.multiplier?.toFixed(2) || "-",
                        s.reason || "-"
                    ]);
                    // 标记所有子仓位为已清仓
                    for (const { pos } of g.positions) { pos.isDust = false; }
                } else {
                    console.warn(`[EXEC] Group scalp for ${groupKey} failed. ${sharesToSell.toFixed(4)} shares could not be sold.`);
                }
            }

            // --- 下单逻辑 ---
            // 第一重保护：记录启动时的第一个市场 ID 
            if (initialMarketId === null && poly.market?.id) {
                initialMarketId = poly.market.id;
            }

            // 前 25 秒只看不做，等数据稳定
            // --- 计算 Nat Abs (原生吸收) ---
            if (Date.now() > activeNatAbs.expiresAt) {
                activeNatAbs = { type: "NONE", strength: 0, expiresAt: 0 };
            }

            if (spotPriceRing.length >= 2) {
                const cvdDelta = getCvd(60);
                const priceDelta = spotPriceRing[spotPriceRing.length - 1].p - spotPriceRing[0].p;
                const atr = volRegime?.atr || 50; 
                const zScore = getDeltaZScore(30) || 0;
                
                const cvdTrigger = Math.abs(cvdDelta) > 2.5 || Math.abs(zScore) > 1.5;
                const priceAbsorbed = Math.abs(priceDelta) < Math.max(20, atr * 0.2);

                if (cvdTrigger && priceAbsorbed) {
                    if (cvdDelta > 0) activeNatAbs = { type: 'SELL_WALL', strength: cvdDelta, expiresAt: Date.now() + 5000 };
                    else if (cvdDelta < 0) activeNatAbs = { type: 'BUY_WALL', strength: Math.abs(cvdDelta), expiresAt: Date.now() + 5000 };
                }
            }
            let natAbs = { type: activeNatAbs.type, strength: activeNatAbs.strength };

            let strategySignal = null;
            if (loopCount > 25) {
                strategySignal = myCustomStrategy(
                    timeAware,
                    { upPrice: poly.prices.up, downPrice: poly.prices.down },
                    {
                        timeLeft: settlementLeftMin,
                        spotPrice, livePrice: currentPrice,
                        priceToBeat: ptb, premiumEma,
                        marketId: poly.market.id, positions: pm.positions,
                        // 三层策略新增上下文
                        crossCount,
                        upPriceSeries: [...upPriceSeries],
                        upBestBid: poly.orderbook?.up?.bestBid ?? null,
                        downBestBid: poly.orderbook?.down?.bestBid ?? null,
                        klines1m,
                        memoryFeatures: memoryWindowFeatures,
                        // 全量三层架构补充数据，用于 Signal 层 5 个独立模块打分
                        cvd1m: getCvd(60),
                        cvd5m: getCvd(300),
                        mom30s: getMomentum(30),
                        mom60s: getMomentum(60),
                        obi: poly.orderbook?.up?.obi ?? 0,
                        oiDelta: getOIDelta(60),  // 过去60秒 OI 净变化
                        natAbs                   // 原生吸收
                    }
                );
                if (strategySignal && !strategySignal.blocked && strategySignal.side) {
                    const sig = strategySignal || {};
                    const baseSignal = sig.signal || sig; // handle both blocked wrapper and clean signal
                    const rScores = baseSignal.ruleScores || [];
                    const getC = (prefix) => rScores.filter(r => r.rule.startsWith(prefix)).reduce((sum, r) => sum + parseFloat(r.contribution || 0), 0);

                    const tokenToBuy = strategySignal.side === "UP" ? poly.tokens.upTokenId : poly.tokens.downTokenId;
                    const book = strategySignal.side === "UP" ? poly.orderbook.up : poly.orderbook.down;
                    const priceUnits = strategySignal.side === "UP" ? poly.prices.up : poly.prices.down;
                    // 调用执行引擎下单 (FOK 模式)，传入防御层计算出的实际份数
                    const actualShares = strategySignal.actualShares ?? LIVE_CONFIG.tradeSizeShares;
                    const success = await executor.executeEntry(poly.market.id, strategySignal.side, tokenToBuy, priceUnits, strategySignal.type, book, actualShares);
                     if (success) {
                        const p = pm.getPosition(poly.market.id, strategySignal.side, strategySignal.type);
                        if (p) { 
                            p.expiryMs = settlementMs; p.ptb = ptb; p.question = poly.market.question; 
                            // 关键：捕捉下单瞬间的完整信号快照
                            p.entrySignal = {
                                conf: baseSignal.confidence || 0,
                                multiplier: sig.defenseMultiplier || 1.0,
                                reason: sig.reason || "CLEAN",
                                scores: {
                                    cvd: parseFloat((getC("R1_CVD1m") + getC("R2_CVD5m")).toFixed(3)),
                                    oracle: parseFloat(getC("R5_OracleDist").toFixed(3)),
                                    mom: parseFloat((getC("R3_Mom30s") + getC("R4_Mom60s")).toFixed(3)),
                                    obi: parseFloat(getC("R7_OBI").toFixed(3)),
                                    token: parseFloat(getC("R8_TokenTrend").toFixed(3))
                                }
                            };
                        }
                    }
                }
            }

            // --- 后台记录全量 Tick 数据用于回测 ---
            if (loopCount > 25) {
                try {
                    const header = [
                        "timestamp", "time_left_min", "ptb", "spot_price",
                        "cvd1m", "cvd5m", "mom30s", "mom60s", "obi", "cross_count",
                        "signal_dir", "signal_conf", "def_multiplier", "def_reason",
                        "actual_shares", "action",
                        "r1_cvd", "r2_oracle", "r3_mom", "r4_obi", "r5_token",
                        "cl_price", "basis"
                    ];
                    
                    const timeLeftVal = settlementLeftMin !== null ? settlementLeftMin : 0;
                    const { getCvd: _getCvd } = await import("./cvd.js");
                    const cvd1mLog = _getCvd(60);
                    const cvd5mLog = _getCvd(300);
                    const mom30score = getMomentum(30)?.score || 0;
                    const mom60score = getMomentum(60)?.score || 0;
                    const obiLog = poly.orderbook?.up?.obi || 0;

                    const sig = strategySignal || {};
                    const isBlocked = sig.blocked || !sig.side;
                    const baseSignal = sig.signal || sig; // handle both blocked wrapper and clean signal
                    const rScores = baseSignal.ruleScores || [];

                    const getC = (prefix) => rScores.filter(r => r.rule.startsWith(prefix)).reduce((sum, r) => sum + parseFloat(r.contribution || 0), 0);

                    appendCsvRow("./logs/signals.csv", header, [
                        new Date().toISOString(),
                        timeLeftVal.toFixed(3),
                        ptb || 0,
                        spotPrice || 0,
                        cvd1mLog, cvd5mLog,
                        mom30score, mom60score,
                        obiLog.toFixed(3),
                        crossCount,
                        baseSignal.direction || "NONE",
                        baseSignal.confidence || 0,
                        sig.defenseMultiplier || 1.0,
                        sig.reason || "CLEAN",
                        isBlocked ? 0 : (sig.actualShares || 0),
                        isBlocked ? "NO_TRADE" : `${sig.side}:${sig.actualShares}`,
                        (getC("R1_CVD1m") + getC("R2_CVD5m")).toFixed(3),
                        getC("R5_OracleDist").toFixed(3),
                        (getC("R3_Mom30s") + getC("R4_Mom60s")).toFixed(3),
                        getC("R7_OBI").toFixed(3),
                        getC("R8_TokenTrend").toFixed(3),
                        currentPrice || 0,
                        (spotPrice && currentPrice) ? (spotPrice - currentPrice).toFixed(2) : 0
                    ]);
                } catch (e) { console.error("CSV Log Error", e); }
            }

            // --- UI 渲染 (Session Engine Dashboard) ---
            const now2 = Date.now();
            if (now2 - lastRenderTime > 1000) {
                const sim = pm.getSummary();
                const { getCvd: _getCvd } = await import("./cvd.js");
                renderDashboard({
                    // market
                    spotPrice, currentPrice, ptb,
                    timeLeft: settlementLeftMin,
                    marketQuestion: poly.market?.question ?? "",
                    marketId: poly.market?.id ?? "",
                    snapshotAge: (Date.now() - snapshotState.updatedAt) / 1000,
                    isDryRun: LIVE_CONFIG.isDryRun,
                    priceSource,
                    // strategy
                    crossCount,
                    upPrice: poly.prices?.up ?? null,
                    downPrice: poly.prices?.down ?? null,
                    upBestBid: poly.orderbook?.up?.bestBid ?? null,
                    downBestBid: poly.orderbook?.down?.bestBid ?? null,
                    strategySignal,
                    ruleScores: strategySignal?.ruleScores ?? [],
                    defenseMultiplier: strategySignal?.defenseMultiplier ?? null,
                    // positions
                    positions: pm.positions,
                    pm_summary: {
                        totalPnl: liveHistory.reduce((s, r) => s + (r.profit ?? 0), 0),
                        totalCost: sim.totalCost,
                        balance: sim.balance,
                    },
                    liveHistory,
                    // CVD
                    cvd1m: _getCvd(60),
                    cvd5m:  _getCvd(300),
                    // Momentum (30s/60s/120s)
                    momentum30s: getMomentum(30),
                    momentum60s: getMomentum(60),
                    momentum120s: getMomentum(120),
                    deltaZScore: getDeltaZScore(30),
                    // Memory Bias (Top 5)
                    biasScore: memoryWindowFeatures ? getPriorBias(memoryWindowFeatures, 5) : null,
                    // Vol Regime
                    volRegime,
                    // Trade Intensity
                    tradeIntensity30s: getTradeIntensity(30),
                    tradeIntensity60s: getTradeIntensity(60),
                    adjustedUp: timeAware?.adjustedUp,
                    adjustedDown: timeAware?.adjustedDown,
                    rsiNow, macd, vwapNow, klines1m, ema9, ema21,
                    obi: poly.orderbook?.up?.obi,
                    oiDelta: getOIDelta(60),
                    natAbs,
                    // stats
                    totalWins:  liveHistory.filter(r => r.exitType === "WIN" || r.exitType === "SCALPED").length,
                    totalLosses: liveHistory.filter(r => r.exitType?.includes("LOSS")).length,
                    sessionPnl: {
                        yes: liveHistory.filter(r => r.exitType === "WIN" || r.exitType === "SCALPED").reduce((s, r) => s + (r.profit ?? 0), 0),
                        no:  liveHistory.filter(r => r.exitType?.includes("LOSS")).reduce((s, r) => s + (r.profit ?? 0), 0),
                    },
                    // loop
                    loopCount,
                    isWaiting: loopCount <= 25,
                    // server latency
                    serverLatency: serverLatencyMs,
                });
                lastRenderTime = now2;
            }
        } catch (e) {
            if (!e.message.includes("aborted")) {
                console.error("Loop Error:", e.message);
            }
        }
        await sleep(200);
    }
}

runLiveTrading();
