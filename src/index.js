import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd, fetchChainlinkEthUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchPolymarketSnapshot,
  fetchExactPriceToBeat,
  safeFileSlug
} from "./data/polymarket.js";
import { formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import { startMarsedgeStream, getMarsedgePrediction } from "./data/marsedgeWs.js";
import { evaluateSignal, formatSignal, STRATEGY } from "./engine/signal.js";
import { executeOrder, loadRecentOrders, updatePendingOrderStatus } from "./engine/executor.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";

// 应用环境变量中的代理设置
applyGlobalProxyFromEnv();

/**
 * 格式化剩余时间为 MM:SS
 */
function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ANSI 终端颜色代码
const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  lightRed: "\x1b[91m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

function sepLine(ch = "─") {
  const w = screenWidth();
  return `${ANSI.white}${ch.repeat(w)}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
  }
  process.stdout.write(text);
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padLabel(label, width) {
  const visible = stripAnsi(label).length;
  if (visible >= width) return label;
  return label + " ".repeat(width - visible);
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

const LABEL_W = 16;
function kv(label, value) {
  const l = padLabel(String(label), LABEL_W);
  return `${l}${value}`;
}

function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }

  const p = Number(price);
  const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);

  let color = ANSI.reset;
  let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) {
      color = ANSI.green;
      arrow = " ↑";
    } else {
      color = ANSI.red;
      arrow = " ↓";
    }
  }

  const formatted = `${prefix}${formatNumber(p, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;

  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function acquireSingleInstanceLock() {
  const lockFile = "./logs/bot.lock";
  try {
    fs.mkdirSync("./logs", { recursive: true });
    if (fs.existsSync(lockFile)) {
      const existingPidStr = fs.readFileSync(lockFile, "utf8").trim();
      const existingPid = parseInt(existingPidStr, 10);
      if (existingPid && isProcessRunning(existingPid)) {
        console.error(`\n❌ [FATAL] Another instance of Polymarket Assistant is already running under PID ${existingPid}.`);
        console.error("❌ Exiting this process to prevent duplicate order executions!\n");
        process.exit(1);
      }
    }
    fs.writeFileSync(lockFile, String(process.pid), "utf8");
    
    // Clean up lock file on graceful exit
    const cleanup = () => {
      try {
        if (fs.existsSync(lockFile)) {
          const content = fs.readFileSync(lockFile, "utf8").trim();
          if (content === String(process.pid)) {
            fs.unlinkSync(lockFile);
          }
        }
      } catch {}
    };
    
    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  } catch (err) {
    console.warn("[LOCK] Warning: Failed to set or verify single instance lock:", err.message);
  }
}

const dumpedMarkets = new Set();
let showAllOrders = false;
let currentLines = [];
let wakeUpLoop = null;

function interruptibleSleep(ms) {
  return new Promise((resolve) => {
    let timeout = setTimeout(() => {
      wakeUpLoop = null;
      resolve();
    }, ms);
    wakeUpLoop = () => {
      clearTimeout(timeout);
      wakeUpLoop = null;
      resolve();
    };
  });
}

function parseMouseClick(data) {
  // 1. Check for SGR mouse protocol: \x1b[<button>;<col>;<row>[Mm]
  const str = data.toString("utf8");
  const sgrMatch = str.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (sgrMatch) {
    const button = parseInt(sgrMatch[1], 10);
    const col = parseInt(sgrMatch[2], 10);
    const row = parseInt(sgrMatch[3], 10);
    const isRelease = sgrMatch[4] === "m";
    return { button, col, row, isRelease };
  }

  // 2. Check for X10 mouse protocol: \x1b[M <cb> <cx> <cy>
  if (data[0] === 0x1b && data[1] === 0x5b && data[2] === 0x4d && data.length >= 6) {
    const button = data[3] - 32;
    const col = data[4] - 32;
    const row = data[5] - 32;
    return { button, col, row, isRelease: button === 3 };
  }

  return null;
}

async function main() {
  acquireSingleInstanceLock();

  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch {}
    process.stdin.resume();

    // Enable mouse click tracking & SGR mouse mode
    process.stdout.write("\x1b[?1000h\x1b[?1006h");

    const disableMouse = () => {
      try {
        process.stdout.write("\x1b[?1000l\x1b[?1006l");
      } catch {}
    };

    // Clean up mouse tracking on exit
    process.on("exit", disableMouse);
    process.on("SIGINT", () => { disableMouse(); process.exit(0); });
    process.on("SIGTERM", () => { disableMouse(); process.exit(0); });

    process.stdin.on("data", (data) => {
      // 1. Ctrl+C (ASCII 3)
      if (data.length === 1 && data[0] === 3) {
        disableMouse();
        process.exit(0);
      }

      // 2. Parse mouse click
      const mouse = parseMouseClick(data);
      if (mouse) {
        const { button, col, row, isRelease } = mouse;
        // Left click (button 0) and not release
        if (button === 0 && !isRelease) {
          if (currentLines && row > 0 && row <= currentLines.length) {
            const lineText = stripAnsi(currentLines[row - 1]);
            if (lineText.includes("[Load More]") || lineText.includes("[Collapse]")) {
              showAllOrders = !showAllOrders;
              wakeUpLoop?.();
            }
          }
        }
        return;
      }

      // 3. Parse keyboard 'l' or 'L'
      const str = data.toString("utf8");
      if (str === "l" || str === "L") {
        showAllOrders = !showAllOrders;
        wakeUpLoop?.();
      }
    });
  }

  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const binanceStreamEth = startBinanceTradeStream({ symbol: "ETHUSDT" });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const polymarketLiveStreamEth = startPolymarketChainlinkPriceStream({ symbolIncludes: "eth" });
  const chainlinkStream = startChainlinkPriceStream({});
  const chainlinkStreamEth = startChainlinkPriceStream({ aggregator: CONFIG.chainlink.ethUsdAggregator, decimals: 8 });
  startMarsedgeStream();

  let prevSpotPrice = null;
  let prevSpotPriceEth = null;
  let prevCurrentPrice = null;
  let prevCurrentPriceEth = null;
  let priceToBeatState = { slug: null, value: null, fetching: false };
  let priceToBeatStateEth = { slug: null, value: null, fetching: false };
  // 防止同一轮重复下单
  let lastExecutedMarketSlug = null;
  let lastExecutedMarketSlugEth = null;
  const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() !== 'false';

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    const wsTick = binanceStream.getLast();
    const wsPrice = wsTick?.price ?? null;

    const wsTickEth = binanceStreamEth.getLast();
    const wsPriceEth = wsTickEth?.price ?? null;

    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;

    const polymarketWsTickEth = polymarketLiveStreamEth.getLast();
    const polymarketWsPriceEth = polymarketWsTickEth?.price ?? null;

    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    const chainlinkWsTickEth = chainlinkStreamEth.getLast();
    const chainlinkWsPriceEth = chainlinkWsTickEth?.price ?? null;

    try {
      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const chainlinkPromiseEth = polymarketWsPriceEth !== null
        ? Promise.resolve({ price: polymarketWsPriceEth, updatedAt: polymarketWsTickEth?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPriceEth !== null
          ? Promise.resolve({ price: chainlinkWsPriceEth, updatedAt: chainlinkWsTickEth?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkEthUsd();

      const [lastPrice, lastPriceEth, chainlink, chainlinkEth, poly, polyEth] = await Promise.all([
        fetchLastPrice("BTCUSDT"),
        fetchLastPrice("ETHUSDT"),
        chainlinkPromise,
        chainlinkPromiseEth,
        fetchPolymarketSnapshot("BTC"),
        fetchPolymarketSnapshot("ETH")
      ]);

      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;

      // ETH 市场数据解析
      const ethSettlementMs = polyEth.ok && polyEth.market?.endDate ? new Date(polyEth.market.endDate).getTime() : null;
      const ethSettlementLeftMin = ethSettlementMs ? (ethSettlementMs - Date.now()) / 60_000 : null;
      const ethTimeLeftMin = ethSettlementLeftMin !== null ? ethSettlementLeftMin : timing.remainingMinutes;

      const ethMarketUp = polyEth.ok ? polyEth.prices.up : null;
      const ethMarketDown = polyEth.ok ? polyEth.prices.down : null;

      // MarsEdge BTC/ETH Edge Calculation
      const prediction = getMarsedgePrediction("BTC");
      const predictionEth = getMarsedgePrediction("ETH");
      
      let alertMsg = null;
      let alertMsgEth = null;

      // BTC MarsEdge Board Strings
      let btcModelUpStr = "-";
      let btcPolyUpStr = "-";
      let btcEdgeUpStr = "-";
      let btcModelDownStr = "-";
      let btcPolyDownStr = "-";
      let btcEdgeDownStr = "-";

      if (prediction.ok && prediction.data) {
        const pUp = (prediction.data.p_up_pct || 0) / 100;
        const pDown = (prediction.data.p_down_pct || 0) / 100;
        const upAsk = marketUp !== null ? marketUp : 1.0;
        const downAsk = marketDown !== null ? marketDown : 1.0;
        const edgeUp = pUp - upAsk;
        const edgeDown = pDown - downAsk;

        btcModelUpStr = `${(pUp*100).toFixed(1)}%`;
        btcPolyUpStr = marketUp !== null ? `${(marketUp*100).toFixed(1)}%` : "-";
        btcEdgeUpStr = `${edgeUp > 0 ? "+" : ""}${(edgeUp*100).toFixed(1)}%`;

        btcModelDownStr = `${(pDown*100).toFixed(1)}%`;
        btcPolyDownStr = marketDown !== null ? `${(marketDown*100).toFixed(1)}%` : "-";
        btcEdgeDownStr = `${edgeDown > 0 ? "+" : ""}${(edgeDown*100).toFixed(1)}%`;
      } else {
        btcModelUpStr = prediction.error;
        btcModelDownStr = prediction.error;
      }

      // ETH MarsEdge Board Strings
      let ethModelUpStr = "-";
      let ethPolyUpStr = "-";
      let ethEdgeUpStr = "-";
      let ethModelDownStr = "-";
      let ethPolyDownStr = "-";
      let ethEdgeDownStr = "-";

      if (predictionEth.ok && predictionEth.data) {
        const pUp = (predictionEth.data.p_up_pct || 0) / 100;
        const pDown = (predictionEth.data.p_down_pct || 0) / 100;
        const upAsk = ethMarketUp !== null ? ethMarketUp : 1.0;
        const downAsk = ethMarketDown !== null ? ethMarketDown : 1.0;
        const edgeUp = pUp - upAsk;
        const edgeDown = pDown - downAsk;

        ethModelUpStr = `${(pUp*100).toFixed(1)}%`;
        ethPolyUpStr = ethMarketUp !== null ? `${(ethMarketUp*100).toFixed(1)}%` : "-";
        ethEdgeUpStr = `${edgeUp > 0 ? "+" : ""}${(edgeUp*100).toFixed(1)}%`;

        ethModelDownStr = `${(pDown*100).toFixed(1)}%`;
        ethPolyDownStr = ethMarketDown !== null ? `${(ethMarketDown*100).toFixed(1)}%` : "-";
        ethEdgeDownStr = `${edgeDown > 0 ? "+" : ""}${(edgeDown*100).toFixed(1)}%`;
      } else {
        ethModelUpStr = predictionEth.error;
        ethModelDownStr = predictionEth.error;
      }

      const spotPrice = wsPrice ?? lastPrice;
      const spotPriceEth = wsPriceEth ?? lastPriceEth;
      const currentPrice = chainlink?.price ?? null;
      const currentPriceEth = chainlinkEth?.price ?? null;
      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
      const ethMarketSlug = polyEth.ok ? String(polyEth.market?.slug ?? "") : "";

      // 周期性异步更新挂单状态（内置 5 秒限频，自动流转并确认 FILLED / MISSED / PARTIAL）
      updatePendingOrderStatus({ BTC: marketSlug, ETH: ethMarketSlug }).catch(() => {});

      // When BTC market changes, trigger a fresh PTB fetch
      if (marketSlug && priceToBeatState.slug !== marketSlug) {
        priceToBeatState = { slug: marketSlug, value: null, fetching: false };
      }

      if (priceToBeatState.slug && priceToBeatState.value === null && !priceToBeatState.fetching) {
        priceToBeatState.fetching = true;
        fetchExactPriceToBeat(priceToBeatState.slug).then((ptb) => {
          if (ptb && priceToBeatState.slug === marketSlug) {
            priceToBeatState.value = ptb;
          }
          priceToBeatState.fetching = false;
        }).catch(() => { priceToBeatState.fetching = false; });
      }

      const priceToBeat = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;

      // When ETH market changes, trigger a fresh PTB fetch
      if (ethMarketSlug && priceToBeatStateEth.slug !== ethMarketSlug) {
        priceToBeatStateEth = { slug: ethMarketSlug, value: null, fetching: false };
      }

      if (priceToBeatStateEth.slug && priceToBeatStateEth.value === null && !priceToBeatStateEth.fetching) {
        priceToBeatStateEth.fetching = true;
        fetchExactPriceToBeat(priceToBeatStateEth.slug).then((ptb) => {
          if (ptb && priceToBeatStateEth.slug === ethMarketSlug) {
            priceToBeatStateEth.value = ptb;
          }
          priceToBeatStateEth.fetching = false;
        }).catch(() => { priceToBeatStateEth.fetching = false; });
      }

      const priceToBeatEth = priceToBeatStateEth.slug === ethMarketSlug ? priceToBeatStateEth.value : null;

      const currentPriceBaseLine = colorPriceLine({
        label: "CURRENT PRICE",
        price: currentPrice,
        prevPrice: prevCurrentPrice,
        decimals: 2,
        prefix: "$"
      });

      const currentPriceBaseLineEth = colorPriceLine({
        label: "CURRENT PRICE",
        price: currentPriceEth,
        prevPrice: prevCurrentPriceEth,
        decimals: 2,
        prefix: "$"
      });

      const ptbDelta = (currentPrice !== null && priceToBeat !== null && Number.isFinite(currentPrice) && Number.isFinite(priceToBeat))
        ? currentPrice - priceToBeat
        : null;
      const ptbDeltaColor = ptbDelta === null
        ? ANSI.gray
        : ptbDelta > 0
          ? ANSI.green
          : ptbDelta < 0
            ? ANSI.red
            : ANSI.gray;
      const ptbDeltaText = ptbDelta === null
        ? `${ANSI.gray}-${ANSI.reset}`
        : `${ptbDeltaColor}${ptbDelta > 0 ? "+" : ptbDelta < 0 ? "-" : ""}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset}`;
      
      const currentPriceValue = currentPriceBaseLine.split(": ")[1] ?? currentPriceBaseLine;
      const currentPriceLine = kv("CURRENT PRICE:", `${currentPriceValue} (${ptbDeltaText})`);

      const ptbDeltaEth = (currentPriceEth !== null && priceToBeatEth !== null && Number.isFinite(currentPriceEth) && Number.isFinite(priceToBeatEth))
        ? currentPriceEth - priceToBeatEth
        : null;
      const ptbDeltaColorEth = ptbDeltaEth === null
        ? ANSI.gray
        : ptbDeltaEth > 0
          ? ANSI.green
          : ptbDeltaEth < 0
            ? ANSI.red
            : ANSI.gray;
      const ptbDeltaTextEth = ptbDeltaEth === null
        ? `${ANSI.gray}-${ANSI.reset}`
        : `${ptbDeltaColorEth}${ptbDeltaEth > 0 ? "+" : ptbDeltaEth < 0 ? "-" : ""}$${Math.abs(ptbDeltaEth).toFixed(2)}${ANSI.reset}`;
      
      const currentPriceValueEth = currentPriceBaseLineEth.split(": ")[1] ?? currentPriceBaseLineEth;
      const currentPriceLineEth = kv("CURRENT PRICE:", `${currentPriceValueEth} (${ptbDeltaTextEth})`);

      if (poly.ok && poly.market) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try {
            fs.mkdirSync("./logs", { recursive: true });
            fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8");
          } catch {}
        }
      }

      if (polyEth.ok && polyEth.market) {
        const slug = safeFileSlug(polyEth.market.slug || polyEth.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try {
            fs.mkdirSync("./logs", { recursive: true });
            fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(polyEth.market, null, 2), "utf8");
          } catch {}
        }
      }

      const binanceSpotBaseLine = colorPriceLine({ label: "BTC (Binance)", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" });
      const binanceSpotLine = `${binanceSpotBaseLine}`;
      const binanceSpotValue = binanceSpotLine.split(": ")[1] ?? binanceSpotLine;
      const binanceSpotKvLine = kv("BTC (Binance):", binanceSpotValue);

      const binanceSpotBaseLineEth = colorPriceLine({ label: "ETH (Binance)", price: spotPriceEth, prevPrice: prevSpotPriceEth, decimals: 2, prefix: "$" });
      const binanceSpotLineEth = `${binanceSpotBaseLineEth}`;
      const binanceSpotValueEth = binanceSpotLineEth.split(": ")[1] ?? binanceSpotLineEth;
      const binanceSpotKvLineEth = kv("ETH (Binance):", binanceSpotValueEth);

      const titleLine = poly.ok ? `${poly.market?.question ?? "-"}` : "-";
      const marketLine = kv("Market:", poly.ok ? (poly.market?.slug ?? "-") : "-");

      // ── 信号评估 & 自动下单（所有依赖变量已就绪）─────────────────────────
      if (prediction.ok && prediction.data) {
        const priceChangePct = (priceToBeat && currentPrice)
          ? Math.abs((currentPrice - priceToBeat) / priceToBeat * 100)
          : 0;
        const signal = evaluateSignal(prediction.data, priceChangePct);
        
        if (signal) {
          alertMsg = `🚀 [SIGNAL ACTIVE] BUY ${signal.direction} @ ${signal.limitPrice} (Edge: +${(signal.edge*100).toFixed(1)}%)`;
          if (lastExecutedMarketSlug !== marketSlug) {
            if (lastExecutedMarketSlug && lastExecutedMarketSlug !== marketSlug) {
              // 跨周期强制立即同步并撤销上一轮未成交的挂单，确保资金安全
              updatePendingOrderStatus({ BTC: marketSlug, ETH: ethMarketSlug }, true).catch(() => {});
            }
            lastExecutedMarketSlug = marketSlug;
            executeOrder(signal, { marketTitle: titleLine, marketSlug, priceToBeat, priceChangePct }).catch(() => {});
          } else {
             alertMsg += ` [ALREADY ORDERED]`;
          }
        } else if (prediction.data.p_up_pct >= 85 || prediction.data.p_down_pct >= 85) {
           // 解释为什么被过滤了
           if (priceChangePct < STRATEGY.minPriceChangePct) {
              alertMsg = `⚠️ [SIGNAL FILTERED] 涨跌幅不足 ${STRATEGY.minPriceChangePct}% (${priceChangePct.toFixed(3)}%), 防御横盘震荡`;
           } else if (prediction.data.rem_secs < STRATEGY.minRemSecs || prediction.data.rem_secs > STRATEGY.maxRemSecs) {
              alertMsg = `⚠️ [SIGNAL FILTERED] 时间窗口不符合 (剩余 ${prediction.data.rem_secs}s)`;
           }
        }
      }

      // ── ETH 信号评估 & 自动下单 ─────────────────────────────────────────
      if (predictionEth.ok && predictionEth.data) {
        const priceChangePctEth = (priceToBeatEth && currentPriceEth)
          ? Math.abs((currentPriceEth - priceToBeatEth) / priceToBeatEth * 100)
          : 0;
        const signalEth = evaluateSignal(predictionEth.data, priceChangePctEth);
        
        if (signalEth) {
          alertMsgEth = `🚀 [ETH SIGNAL] BUY ${signalEth.direction} @ ${signalEth.limitPrice} (Edge: +${(signalEth.edge*100).toFixed(1)}%)`;
          if (lastExecutedMarketSlugEth !== ethMarketSlug) {
            if (lastExecutedMarketSlugEth && lastExecutedMarketSlugEth !== ethMarketSlug) {
              // 跨周期强制立即同步并撤销上一轮未成交的挂单，确保资金安全
              updatePendingOrderStatus({ BTC: marketSlug, ETH: ethMarketSlug }, true).catch(() => {});
            }
            lastExecutedMarketSlugEth = ethMarketSlug;
            const ethTitle = polyEth.ok ? `${polyEth.market?.question ?? "-"}` : "-";
            executeOrder(signalEth, { marketTitle: ethTitle, marketSlug: ethMarketSlug, priceToBeat: priceToBeatEth, priceChangePct: priceChangePctEth }).catch(() => {});
          } else {
             alertMsgEth += ` [ALREADY ORDERED]`;
          }
        } else if (predictionEth.data.p_up_pct >= 85 || predictionEth.data.p_down_pct >= 85) {
           if (priceChangePctEth < STRATEGY.minPriceChangePct) {
              alertMsgEth = `⚠️ [ETH SIGNAL FILTERED] 涨跌幅不足 ${STRATEGY.minPriceChangePct}% (${priceChangePctEth.toFixed(3)}%), 防御横盘震荡`;
           } else if (predictionEth.data.rem_secs < STRATEGY.minRemSecs || predictionEth.data.rem_secs > STRATEGY.maxRemSecs) {
              alertMsgEth = `⚠️ [ETH SIGNAL FILTERED] 时间窗口不符合 (剩余 ${predictionEth.data.rem_secs}s)`;
           }
        }
      }

      const timeColor = timeLeftMin >= 10 && timeLeftMin <= 15
        ? ANSI.green
        : timeLeftMin >= 5 && timeLeftMin < 10
          ? ANSI.yellow
          : timeLeftMin >= 0 && timeLeftMin < 5
            ? ANSI.red
            : ANSI.reset;

      const ethTimeColor = ethTimeLeftMin >= 10 && ethTimeLeftMin <= 15
        ? ANSI.green
        : ethTimeLeftMin >= 5 && ethTimeLeftMin < 10
          ? ANSI.yellow
          : ethTimeLeftMin >= 0 && ethTimeLeftMin < 5
            ? ANSI.red
            : ANSI.reset;

      const polyTimeLeftColor = settlementLeftMin !== null
        ? (settlementLeftMin >= 10 && settlementLeftMin <= 15
          ? ANSI.green
          : settlementLeftMin >= 5 && settlementLeftMin < 10
            ? ANSI.yellow
            : settlementLeftMin >= 0 && settlementLeftMin < 5
              ? ANSI.red
              : ANSI.reset)
        : ANSI.reset;

      const ethPolyTimeLeftColor = ethSettlementLeftMin !== null
        ? (ethSettlementLeftMin >= 10 && ethSettlementLeftMin <= 15
          ? ANSI.green
          : ethSettlementLeftMin >= 5 && ethSettlementLeftMin < 10
            ? ANSI.yellow
            : ethSettlementLeftMin >= 0 && ethSettlementLeftMin < 5
              ? ANSI.red
              : ANSI.reset)
        : ANSI.reset;

      const btcMarketUpStr = `${marketUp ?? "-"}${marketUp === null || marketUp === undefined ? "" : "¢"}`;
      const btcMarketDownStr = `${marketDown ?? "-"}${marketDown === null || marketDown === undefined ? "" : "¢"}`;
      const btcPolyHeaderValue = `${ANSI.green}↑ UP${ANSI.reset} ${btcMarketUpStr}  |  ${ANSI.red}↓ DOWN${ANSI.reset} ${btcMarketDownStr}`;

      const ethMarketUpStr = `${ethMarketUp ?? "-"}${ethMarketUp === null || ethMarketUp === undefined ? "" : "¢"}`;
      const ethMarketDownStr = `${ethMarketDown ?? "-"}${ethMarketDown === null || ethMarketDown === undefined ? "" : "¢"}`;
      const ethPolyHeaderValue = `${ANSI.green}↑ UP${ANSI.reset} ${ethMarketUpStr}  |  ${ANSI.red}↓ DOWN${ANSI.reset} ${ethMarketDownStr}`;

      const lines = [
        titleLine,
        marketLine,
        kv("BTC Time left:", `${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`),
        kv("ETH Time left:", `${ethTimeColor}${fmtTimeLeft(ethTimeLeftMin)}${ANSI.reset}`),
        "",
        sepLine(),
        "",
        `${ANSI.yellow}MarsEdge AI Board:${ANSI.reset}`,
        `  ${ANSI.gray}── BTC Prediction ──${ANSI.reset}`,
        kv("  Model UP:", btcModelUpStr),
        kv("  Polymarket UP:", btcPolyUpStr),
        kv("  Edge UP:", btcEdgeUpStr),
        "",
        kv("  Model DOWN:", btcModelDownStr),
        kv("  Polymarket DOWN:", btcPolyDownStr),
        kv("  Edge DOWN:", btcEdgeDownStr),
        "",
        `  ${ANSI.gray}── ETH Prediction ──${ANSI.reset}`,
        kv("  Model UP:", ethModelUpStr),
        kv("  Polymarket UP:", ethPolyUpStr),
        kv("  Edge UP:", ethEdgeUpStr),
        "",
        kv("  Model DOWN:", ethModelDownStr),
        kv("  Polymarket DOWN:", ethPolyDownStr),
        kv("  Edge DOWN:", ethEdgeDownStr),
        alertMsg ? `\n${ANSI.lightRed}${alertMsg}${ANSI.reset}` : null,
        alertMsgEth ? `\n${ANSI.lightRed}${alertMsgEth}${ANSI.reset}` : null,
        "",
        sepLine(),
        "",
        `${ANSI.yellow}Polymarket Board:${ANSI.reset}`,
        kv("  [BTC]:", btcPolyHeaderValue),
        settlementLeftMin !== null ? kv("  Time left:", `${polyTimeLeftColor}${fmtTimeLeft(settlementLeftMin)}${ANSI.reset}`) : null,
        priceToBeat !== null ? kv("  PRICE TO BEAT:", `$${formatNumber(priceToBeat, 0)}`) : kv("  PRICE TO BEAT:", `${ANSI.gray}-${ANSI.reset}`),
        kv("  CURRENT PRICE:", `${currentPriceLine.split(": ")[1] ?? currentPriceLine}`),
        "",
        kv("  [ETH]:", ethPolyHeaderValue),
        ethSettlementLeftMin !== null ? kv("  Time left:", `${ethPolyTimeLeftColor}${fmtTimeLeft(ethSettlementLeftMin)}${ANSI.reset}`) : null,
        priceToBeatEth !== null ? kv("  PRICE TO BEAT:", `$${formatNumber(priceToBeatEth, 2)}`) : kv("  PRICE TO BEAT:", `${ANSI.gray}-${ANSI.reset}`),
        kv("  CURRENT PRICE:", `${currentPriceLineEth.split(": ")[1] ?? currentPriceLineEth}`),
        "",
        sepLine(),
        "",
        binanceSpotKvLine,
        binanceSpotKvLineEth,
        "",
        sepLine(),
        "",
        kv("ET | Session:", `${ANSI.white}${fmtEtTime(new Date())}${ANSI.reset} | ${ANSI.white}${getBtcSession(new Date())}${ANSI.reset}`),
        "",
        sepLine(),
        "",
        // ── Order History 面板 ─────────────────────────────────────────────
        `${ANSI.yellow}Order History (${showAllOrders ? "已展开全部" : "仅显示最近5单"}):${ANSI.reset}`,
        ...(() => {
          const maxCount = showAllOrders ? 30 : 5;
          const allOrders = loadRecentOrders(maxCount + 1);
          if (allOrders.length === 0) return [`${ANSI.gray}  暂无订单记录${ANSI.reset}`];
          
          const renderedOrders = allOrders.slice(0, maxCount).map(o => {
            const t = o.time || o.ts?.slice(11, 19) || '-';
            const sym = (o.symbol || 'BTC').padEnd(3);
            const period = o.marketTitle
              ? (o.marketTitle.match(/\d+:\d+[AP]M[-–]\d+:\d+[AP]M/)?.[0] || o.marketSlug || '-')
              : (o.marketSlug || '-');
            const dir = o.direction === 'UP'
              ? `${ANSI.green}▲UP${ANSI.reset}`
              : `${ANSI.red}▼DN${ANSI.reset}`;
            const statusColor = o.status === 'FILLED' ? ANSI.green
              : o.status === 'MISSED' ? ANSI.red
              : o.status === 'SIMULATED' ? ANSI.gray
              : ANSI.yellow;
            const statusStr = `${statusColor}${(o.status || '?').padEnd(9)}${ANSI.reset}`;
            return `  ${t}  ${sym}  ${period.padEnd(15)}  ${dir}  ` +
              `胜率${String(o.modelProb).padStart(4)}%  ` +
              `Edge+${String(o.edge).padStart(4)}%  ` +
              `@${String(o.price).slice(0,6)}  ` +
              `${statusStr}`;
          });

          if (!showAllOrders && allOrders.length > 5) {
            renderedOrders.push(`  ${ANSI.yellow}➡ [Load More] 按键盘 'L' 键查看全部历史交易...${ANSI.reset}`);
          } else if (showAllOrders) {
            renderedOrders.push(`  ${ANSI.yellow}➡ [Collapse] 按键盘 'L' 键收起历史交易...${ANSI.reset}`);
          }

          return renderedOrders;
        })(),
        "",
        sepLine(),
        centerText(`${ANSI.dim}${ANSI.gray}Polymarket Assistant (Refactored)${ANSI.reset}`, screenWidth())
      ].filter((x) => x !== null);

      currentLines = lines;
      renderScreen(lines.join("\n") + "\n");

      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevSpotPriceEth = spotPriceEth ?? prevSpotPriceEth;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;
      prevCurrentPriceEth = currentPriceEth ?? prevCurrentPriceEth;

    } catch (err) {
      console.log("────────────────────────────");
      console.log(`Error: ${err?.stack ?? String(err)}`);
      console.log("────────────────────────────");
    }

    await interruptibleSleep(CONFIG.pollIntervalMs);
  }
}

main();
