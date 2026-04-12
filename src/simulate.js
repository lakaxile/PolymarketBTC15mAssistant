import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
    fetchMarketBySlug,
    fetchLiveEventsBySeriesId,
    flattenEventMarkets,
    pickLatestLiveMarket,
    fetchClobPrice,
    fetchOrderBook,
    summarizeOrderBook,
    fetchPolymarketSnapshot,
    extractNumericFromMarket,
    parsePriceToBeat
} from "./data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { SimulationEngine } from "./simulation/engine.js";
import { myCustomStrategy } from "./simulation/strategy.js";
import readline from "node:readline";

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

async function main() {
    applyGlobalProxyFromEnv();
    const INITIAL_BALANCE = 1000;
    const simulator = new SimulationEngine(INITIAL_BALANCE);

    const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
    const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
    const chainlinkStream = startChainlinkPriceStream({});

    let prevSpotPrice = null;
    let lastMarketId = null;
    let priceToBeatState = { slug: null, value: null, setAtMs: null };
    const SIM_LOG_FILE = "./logs/simulation_trades.csv";
    const LOG_HEADER = ["Time", "MarketID", "Question", "Strategy", "Side", "TAProb", "MarketOdds", "EntryPrice", "PTB", "Result", "Profit", "Balance"];

    // 追踪 Binance 和 Chainlink 之间的基础价差 (EMA)
    let premiumEma = null;

    while (true) {
        const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);
        let spotPrice = null;
        let currentPrice = null;
        try {
            spotPrice = binanceStream.getLast()?.price ?? await fetchLastPrice();
            currentPrice = polymarketLiveStream.getLast()?.price ?? chainlinkStream.getLast()?.price ?? (await fetchChainlinkBtcUsd()).price;
        } catch (e) {
            console.warn(`Price fetch warning: ${e.message}`);
        }

        if (spotPrice !== null && currentPrice !== null) {
            const currentPremium = spotPrice - currentPrice;
            if (premiumEma === null) {
                premiumEma = currentPremium;
            } else {
                premiumEma = premiumEma * 0.90 + currentPremium * 0.10; // 近期平滑差值
            }
        }

        // --- 定期检查结算 (移到外面，确保网络抖动也能结算) ---
        if (currentPrice !== null) {
            for (const [mid, trade] of simulator.activeTrades.entries()) {
                if (Date.now() > trade.expiryMs) {
                    // 到期判断获胜方
                    // 如果结算时依然 PTB 为空，给出警告，并尝试 fallback 到 0 (虽然不准确但防止程序崩溃)
                    const basePtb = trade.ptb ?? 0;
                    if (trade.ptb === null || trade.ptb === undefined) {
                        console.log(`[WARNING] Trade ${mid} expired with null PTB. Settling with 0.00.`);
                    }

                    const winningSide = currentPrice >= basePtb ? "UP" : "DOWN";
                    const result = simulator.settle(mid, winningSide);

                    if (result) {
                        // 写入 CSV 日志
                        appendCsvRow(SIM_LOG_FILE, LOG_HEADER, [
                            new Date().toLocaleString(),
                            mid,
                            trade.question || "Unknown Question",
                            trade.strategyType || "UNKNOWN",
                            trade.side,
                            trade.taProb !== undefined ? trade.taProb.toFixed(4) : "-",
                            trade.marketOdds !== undefined ? trade.marketOdds.toFixed(4) : "-",
                            (trade.entryPrice || 0).toFixed(4),
                            (basePtb || 0).toFixed(2),
                            result.isWin ? "WIN" : "LOSS",
                            (result.profit || 0).toFixed(2),
                            (result.balance || 0).toFixed(2)
                        ]);
                    }
                }
            }
        }

        try {
            const poly = await fetchPolymarketSnapshot();
            if (!poly.ok) {
                // 如果仅仅是 market_not_found，不要抛出 Error，可能是交接期
                if (poly.reason === "market_not_found") {
                    await sleep(1000);
                    continue;
                }
                throw new Error(poly.reason);
            }

            const marketSlug = poly.market?.slug ?? "";
            const marketStartMs = poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;

            if (marketSlug && priceToBeatState.slug !== marketSlug) {
                priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
            }

            if (priceToBeatState.slug && priceToBeatState.value === null && currentPrice !== null) {
                const nowMs = Date.now();
                // 允许一定的偏差或严格等于
                const okToLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
                if (okToLatch) {
                    priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs };
                }
            }

            lastMarketId = poly.market.id;

            // --- 技术指标计算 (略过重复的 index.js 逻辑，直接取关键值) ---
            const [klines1m] = await Promise.all([fetchKlines({ interval: "1m", limit: 60 })]);
            const closes = klines1m.map(c => c.close);
            const vwapNow = computeSessionVwap(klines1m);
            const rsiNow = computeRsi(closes, 14);
            const rsiSeries = [];
            for (let i = 0; i < closes.length; i++) {
                const r = computeRsi(closes.slice(0, i + 1), 14);
                if (r !== null) rsiSeries.push(r);
            }
            const rsiSlope = slopeLast(rsiSeries, 3);

            const macd = computeMacd(closes, 12, 26, 9);
            const ha = computeHeikenAshi(klines1m);
            const consec = countConsecutive(ha);

            const lastClose = closes[closes.length - 1] ?? null;
            const close1mAgo = closes.length >= 2 ? closes[closes.length - 2] : null;
            const close3mAgo = closes.length >= 4 ? closes[closes.length - 4] : null;
            const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
            const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

            const vwapSeries = computeVwapSeries(klines1m);
            const vwapDist = vwapNow ? (spotPrice - vwapNow) / vwapNow : null;

            const scored = scoreDirection({ price: spotPrice, vwap: vwapNow, rsi: rsiNow, rsiSlope, macd, heikenColor: consec.color, heikenCount: consec.count });
            const timeAware = applyTimeAwareness(scored.rawUp, timing.remainingMinutes, CONFIG.candleWindowMinutes);

            // --- 叙事格式化 ---
            const haNarrative = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
            const heikenValue = `${consec.color ?? "-"} x${consec.count}`;
            const heikenLine = formatNarrativeValue("Heiken Ashi", heikenValue, haNarrative);

            const rsiNarrative = narrativeFromSlope(rsiSlope);
            const rsiArrow = rsiSlope !== null && rsiSlope < 0 ? "↓" : rsiSlope !== null && rsiSlope > 0 ? "↑" : "-";
            const rsiValue = `${formatNumber(rsiNow, 1)} ${rsiArrow}`;
            const rsiLine = formatNarrativeValue("RSI", rsiValue, rsiNarrative);

            const macdNarrative = narrativeFromSign(macd?.hist ?? null);
            const macdLabel = macd === null ? "-" : (macd.hist < 0 ? "bearish" : "bullish");
            const macdLine = formatNarrativeValue("MACD", macdLabel, macdNarrative);

            const delta1Narrative = narrativeFromSign(delta1m);
            const deltaValue = `${colorByNarrative(formatSignedDelta(delta1m, lastClose), delta1Narrative)} | ${colorByNarrative(formatSignedDelta(delta3m, lastClose), narrativeFromSign(delta3m))}`;

            const vwapNarrative = narrativeFromSign(vwapDist);
            const vwapValue = `${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)})`;
            const vwapLine = formatNarrativeValue("VWAP", vwapValue, vwapNarrative);

            // --- 早期平仓逻辑 (Scalping / 利好于抢跑策略) ---
            for (const [tradeKey, trade] of simulator.activeTrades.entries()) {
                // 仅针对抢跑策略尝试早期获利了结 (因为该策略赚的是盘口滞后的钱)
                if (trade.strategyType === "STRATEGY_2_PREMIUM") {
                    const currentBid = trade.side === "UP" ? poly.orderbook.up.bestBid : poly.orderbook.down.bestBid;

                    if (currentBid !== null && currentBid !== undefined && currentBid > 0) {
                        const currentProfitPct = (currentBid / trade.entryPrice) - 1;

                        // 止盈条件：如果单笔理论利润超过 12% (考虑到买卖价差，这已经很丰厚了)，
                        // 我们选择直接平仓离场，锁定利润，不参与最后 15 分钟的末尾开奖风险。
                        if (currentProfitPct > 0.12) {
                            const exitResult = simulator.closePosition(tradeKey, currentBid);
                            if (exitResult) {
                                console.log(`\n[SCALP EXIT] ${trade.strategyType} | ${trade.side} | Profit: ${formatPct(currentProfitPct, 2)} | Price: ${trade.entryPrice.toFixed(2)} -> ${currentBid.toFixed(2)}`);
                                appendCsvRow(SIM_LOG_FILE, LOG_HEADER, [
                                    new Date().toLocaleString(), trade.marketId, trade.question || "-",
                                    trade.strategyType, trade.side, "-", "-", trade.entryPrice.toFixed(4),
                                    "-", "SCALPED", exitResult.profit.toFixed(2), exitResult.balance.toFixed(2)
                                ]);
                            }
                        }
                    }
                }
            }

            // --- 模拟下单 ---
            let ptb = extractNumericFromMarket(poly.market) ?? parsePriceToBeat(poly.market);

            // 回退方案：如果 Polymarket 没有直接给出阈值，那么 BTC 15m 规则通常是记录市场开始那刻的价格 
            if (ptb === null && priceToBeatState.slug === poly.market?.slug) {
                ptb = priceToBeatState.value;
            }

            // 同步最新的 PTB 给当前市场已经建仓的早期订单 (解决早期订单 PTB 为 0 的导致误判胜负的 bug)
            if (ptb !== null) {
                for (const [key, tradeObj] of simulator.activeTrades.entries()) {
                    if (key.startsWith(poly.market.id) && (tradeObj.ptb === null || tradeObj.ptb === undefined)) {
                        tradeObj.ptb = ptb;
                    }
                }
            }

            // 如果 PTB 没找到，保存快照用于分析具体字段格式
            if (ptb === null && poly.market) {
                try {
                    ensureDir("./logs");
                    fs.writeFileSync("./logs/market_debug.json", JSON.stringify(poly.market, null, 2));
                } catch (e) { }
            }
            const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
            const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;

            const strategySignal = myCustomStrategy(timeAware,
                { upPrice: poly.prices.up, downPrice: poly.prices.down },
                { timeLeft: settlementLeftMin, spotPrice, livePrice: currentPrice, priceToBeat: ptb, premiumEma }
            );

            if (strategySignal) {
                const currentPriceInUnits = strategySignal.side === "UP" ? poly.prices.up : poly.prices.down;
                const cost = 100 * (currentPriceInUnits || 1);

                const tradeKey = `${poly.market.id}@${strategySignal.type}`;
                const isNewTrade = !simulator.activeTrades.has(tradeKey);

                if (isNewTrade) {
                    simulator.enterPosition(poly.market.id, strategySignal.side, currentPriceInUnits, cost, strategySignal.type);

                    if (simulator.activeTrades.has(tradeKey)) {
                        const tradeObj = simulator.activeTrades.get(tradeKey);
                        tradeObj.expiryMs = new Date(poly.market.endDate).getTime();
                        tradeObj.ptb = ptb;
                        tradeObj.question = poly.market.question;
                        // strategyType already set in enterPosition
                        tradeObj.taProb = strategySignal.taProb;
                        tradeObj.marketOdds = strategySignal.marketOdds;

                        appendCsvRow(SIM_LOG_FILE, LOG_HEADER, [
                            new Date().toLocaleString(), poly.market.id, poly.market.question,
                            strategySignal.type,
                            strategySignal.side,
                            strategySignal.taProb !== undefined ? strategySignal.taProb.toFixed(4) : "-",
                            strategySignal.marketOdds !== undefined ? strategySignal.marketOdds.toFixed(4) : "-",
                            (currentPriceInUnits || 0).toFixed(4), (ptb || 0).toFixed(2),
                            "OPENED", "0.00", simulator.balance.toFixed(2)
                        ]);
                    }
                }
            }

            // --- UI 渲染 ---
            const sim = simulator.getSummary();

            const timeColor = settlementLeftMin !== null
                ? (settlementLeftMin >= 10 && settlementLeftMin <= 15
                    ? ANSI.green
                    : settlementLeftMin >= 5 && settlementLeftMin < 10
                        ? ANSI.yellow
                        : settlementLeftMin >= 0 && settlementLeftMin < 5
                            ? ANSI.red
                            : ANSI.reset)
                : ANSI.reset;

            const upBook = poly.orderbook.up;
            const downBook = poly.orderbook.down;

            const upBids = formatOrderBookSide(upBook.topBids, ANSI.green);
            const upAsks = formatOrderBookSide(upBook.topAsks, ANSI.red);
            const downBids = formatOrderBookSide(downBook.topBids, ANSI.green);
            const downAsks = formatOrderBookSide(downBook.topAsks, ANSI.red);

            const upHeader = `  ┌──────────────────── UP ─────────────────────┐  `;
            const downHeader = `  ┌─────────────────── DOWN ────────────────────┐  `;
            const boxSep = `  ├─────────────────────────────────────────────┤  `;
            const boxBottom = `  └─────────────────────────────────────────────┘  `;
            const boxContentHead = `  │          Bids           /            Asks     │  `;

            // 内部可见宽度为 45
            function padBoxSide(s) {
                const vis = stripAnsi(s).length;
                return s + " ".repeat(Math.max(0, 13 - vis));
            }

            const boxLines = [
                upHeader + downHeader,
                boxContentHead + boxContentHead,
                boxSep + boxSep,
                ...[0, 1, 2, 3, 4].map(i => {
                    const ub = padBoxSide(upBids[i] || "");
                    const ua = padBoxSide(upAsks[i] || "");
                    const db = padBoxSide(downBids[i] || "");
                    const da = padBoxSide(downAsks[i] || "");
                    // 内部宽度 45: 4(padding) + 13(ub) + 5(gap) + 1(/) + 5(gap) + 13(ua) + 4(padding)
                    return `  │    ${ub}     /     ${ua}    │  │    ${db}     /     ${da}    │  `;
                }),
                boxBottom + boxBottom
            ];

            // ptb already defined above

            const ptbDelta = (currentPrice !== null && ptb !== null) ? (currentPrice - ptb) : null;
            const ptbDeltaColor = ptbDelta > 0 ? ANSI.green : ptbDelta < 0 ? ANSI.red : ANSI.gray;
            const ptbDeltaStr = ptbDelta !== null
                ? `${ptbDeltaColor}(${ptbDelta > 0 ? "+" : ""}$${ptbDelta.toFixed(2)})${ANSI.reset}`
                : "";
            const ptbStr = ptb !== null ? ` (Target: $${formatNumber(ptb, 0)})` : "";

            const premium = spotPrice - currentPrice;
            const premiumColor = premium > 0 ? ANSI.green : premium < 0 ? ANSI.red : ANSI.gray;
            const premiumLine = `${premiumColor}${premium > 0 ? "+" : ""}$${premium.toFixed(2)}${ANSI.reset}`;

            const predictValue = `${ANSI.green}LONG${ANSI.reset} ${ANSI.green}${formatProbPct(timeAware.adjustedUp, 0)}${ANSI.reset} / ${ANSI.red}SHORT${ANSI.reset} ${ANSI.red}${formatProbPct(timeAware.adjustedDown, 0)}${ANSI.reset}`;

            const lines = [
                `${ANSI.cyan}═══ SIMULATION MODE ═══${ANSI.reset}`,
                kv("Market:", poly.market.question),
                kv("Status:", `Balance: $${sim.balance.toFixed(2)} | Profit: $${sim.totalProfit.toFixed(2)} | WinRate: ${sim.winRate}`),
                kv("Time Left:", `${timeColor}${fmtTimeLeft(settlementLeftMin ?? 0)}${ANSI.reset}`),
                sepLine(),
                `${ANSI.white}ORDER BOOKS (Top 5)${ANSI.reset}`,
                "",
                ...boxLines,
                sepLine(),
                kv("TA Predict:", predictValue),
                kv("Heiken Ashi:", heikenLine.split(": ")[1] ?? heikenLine),
                kv("RSI:", rsiLine.split(": ")[1] ?? rsiLine),
                kv("MACD:", macdLine.split(": ")[1] ?? macdLine),
                kv("Delta 1/3:", deltaValue),
                kv("VWAP:", vwapLine.split(": ")[1] ?? vwapLine),
                "",
                kv("Price to Beat:", ptb !== null ? `$${formatNumber(ptb, 2)}` : `${ANSI.red}NOT FOUND${ANSI.reset}`),
                ptb === null ? `${ANSI.gray}  (Q: ${poly.market.question.slice(0, 50)}...)${ANSI.reset}` : "",
                kv("Binance Price:", `$${formatNumber(spotPrice, 2)} (${premiumLine})`),
                kv("Live Price:", `$${formatNumber(currentPrice, 2)} ${ptbDeltaStr}`),
                kv("TA Score (Raw):", `UP ${formatProbPct(timeAware.adjustedUp)} / DOWN ${formatProbPct(timeAware.adjustedDown)}`),
                sepLine(),
                `Active Trade: ${[...simulator.activeTrades.keys()].some(k => k.startsWith(poly.market.id)) ? ANSI.yellow + "POSITION OPENED" + ANSI.reset : "WAITING FOR SIGNAL"}`,
            ];

            // --- 追加最近交易记录 ---
            if (simulator.history && simulator.history.length > 0) {
                lines.push("");
                lines.push(sepLine());
                lines.push(`${ANSI.white}RECENT TRADES${ANSI.reset}`);
                const recent = simulator.history; // 显示全部结算订单
                for (const r of recent) {
                    const t = new Date(r.closedAt || r.timestamp).toLocaleTimeString();
                    const sideColor = r.side === "UP" ? ANSI.green : ANSI.red;
                    const resColor = r.isWin ? ANSI.green : ANSI.red;
                    const resStr = r.isWin ? `+${r.profit.toFixed(2)}` : `${r.profit.toFixed(2)}`;

                    let stratName = "";
                    if (r.strategyType === "STRATEGY_2_PREMIUM") stratName = "抢跑极速套利";
                    else if (r.strategyType === "EDGE") stratName = "常规优势打点";
                    else if (r.strategyType === "STRATEGY_1") stratName = "暴涨暴跌突破";
                    else stratName = r.strategyType || "未知策略";

                    lines.push(`[${t}] ${ANSI.cyan}[${stratName}]${ANSI.reset} ${sideColor}${r.side}${ANSI.reset} @ ${r.entryPrice.toFixed(2)} | Cost: $${r.size.toFixed(0)} | ${resColor}${r.isWin ? "WIN" : "LOSS"} (${resStr})${ANSI.reset}`);
                }
            }

            renderScreen(lines.join("\n") + "\n");

        } catch (e) {
            console.log("Error in Sim Loop:", e.message);
        }
        await sleep(2000);
    }
}

main();
