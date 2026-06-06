import { CONFIG } from "../config.js";
import { fetchChainlinkPriceAtTimestamp } from "./chainlink.js";

/**
 * 将输入转换为数字，如果非有限数字则返回 null
 */
function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function fetchWithRetry(url, options = {}, retries = 1) {
  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const fetchOptions = {
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent": "curl/8.4.0",
          ...options.headers
        }
      };
      const res = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);
      if (res.ok) return res;
      // If not ok, and it's the last retry, throw an error with the response text
      if (i === retries - 1) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      // Otherwise, log and retry (optional: add a delay)
      console.warn(`Fetch failed with status ${res.status} for ${url}. Retrying...`);
    } catch (e) {
      clearTimeout(timeoutId);
      // If an error occurred (e.g., network error), and it's the last retry, rethrow
      if (i === retries - 1) throw e;
      // Otherwise, log and retry with exponential backoff
      console.warn(`Fetch failed for ${url}: ${e.message}. Retrying in ${1000 * (i + 1)}ms...`);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  // This line should ideally not be reached if retries are exhausted and an error is thrown
  throw new Error("FetchWithRetry exhausted all retries without success.");
}

/**
 * 根据 slug 获取市场详情
 */
export async function fetchMarketBySlug(slug) {
  const url = new URL("/markets", CONFIG.gammaBaseUrl);
  url.searchParams.set("slug", slug);

  const res = await fetchWithRetry(url);
  const data = await res.json();
  let market = Array.isArray(data) ? data[0] : data;
  
  if (!market) {
    // Fallback: try querying closed markets
    url.searchParams.set("closed", "true");
    const resClosed = await fetchWithRetry(url);
    const dataClosed = await resClosed.json();
    market = Array.isArray(dataClosed) ? dataClosed[0] : dataClosed;
  }
  
  if (!market) return null;

  return market;
}

/**
 * 根据系列 slug 获取市场列表
 */
export async function fetchMarketsBySeriesSlug({ seriesSlug, limit = 50 }) {
  const url = new URL("/markets", CONFIG.gammaBaseUrl);
  url.searchParams.set("seriesSlug", seriesSlug);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("enableOrderBook", "true");
  url.searchParams.set("limit", String(limit));

  const res = await fetchWithRetry(url);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * 根据系列 ID 获取活跃事件列表
 */
export async function fetchLiveEventsBySeriesId({ seriesId, limit = 20 }) {
  const url = new URL("/events", CONFIG.gammaBaseUrl);
  url.searchParams.set("series_id", String(seriesId));
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", String(limit));

  const res = await fetchWithRetry(url);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * 展平事件中的市场列表
 */
export function flattenEventMarkets(events) {
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    const markets = Array.isArray(e.markets) ? e.markets : [];
    for (const m of markets) {
      out.push(m);
    }
  }
  return out;
}

/**
 * 获取活跃且启用了订单簿的市场列表
 */
export async function fetchActiveMarkets({ limit = 200, offset = 0 } = {}) {
  const url = new URL("/markets", CONFIG.gammaBaseUrl);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("enableOrderBook", "true");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));

  const res = await fetchWithRetry(url);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * 安全地获取时间戳（毫秒）
 */
function safeTimeMs(x) {
  if (!x) return null;
  const t = new Date(x).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 从市场列表中挑选出当前正在进行且最快结束的市场
 */
export function pickLatestLiveMarket(markets, nowMs = Date.now()) {
  if (!Array.isArray(markets) || markets.length === 0) return null;

  const enriched = markets
    .map((m) => {
      const endMs = safeTimeMs(m.endDate);
      const startMs = safeTimeMs(m.eventStartTime ?? m.startTime ?? m.startDate);
      return { m, endMs, startMs };
    })
    .filter((x) => x.endMs !== null);

  const live = enriched
    .filter((x) => {
      const started = x.startMs === null ? true : x.startMs <= nowMs;
      return started && nowMs < x.endMs;
    })
    .sort((a, b) => {
      if (a.endMs !== b.endMs) return a.endMs - b.endMs;
      if (a.startMs !== b.startMs) return a.startMs - b.startMs;
      return (a.m.conditionId || "").localeCompare(b.m.conditionId || "");
    });

  if (live.length) return live[0].m;

  const upcoming = enriched
    .filter((x) => nowMs < x.endMs)
    .sort((a, b) => {
      if (a.endMs !== b.endMs) return a.endMs - b.endMs;
      if (a.startMs !== b.startMs) return a.startMs - b.startMs;
      return (a.m.conditionId || "").localeCompare(b.m.conditionId || "");
    });

  return upcoming.length ? upcoming[0].m : null;
}

/**
 * 检查市场是否属于指定的系列 slug
 */
function marketHasSeriesSlug(market, seriesSlug) {
  if (!market || !seriesSlug) return false;

  const events = Array.isArray(market.events) ? market.events : [];
  for (const e of events) {
    const series = Array.isArray(e.series) ? e.series : [];
    for (const s of series) {
      if (String(s.slug ?? "").toLowerCase() === String(seriesSlug).toLowerCase()) return true;
    }
    if (String(e.seriesSlug ?? "").toLowerCase() === String(seriesSlug).toLowerCase()) return true;
  }
  if (String(market.seriesSlug ?? "").toLowerCase() === String(seriesSlug).toLowerCase()) return true;
  return false;
}

/**
 * 筛选符合条件的 BTC 15分钟涨跌市场
 */
export function filterBtcUpDown15mMarkets(markets, { seriesSlug, slugPrefix } = {}) {
  const prefix = (slugPrefix ?? "").toLowerCase();
  const wantedSeries = (seriesSlug ?? "").toLowerCase();

  return (Array.isArray(markets) ? markets : []).filter((m) => {
    const slug = String(m.slug ?? "").toLowerCase();
    const matchesPrefix = prefix ? slug.startsWith(prefix) : false;
    const matchesSeries = wantedSeries ? marketHasSeriesSlug(m, wantedSeries) : false;
    return matchesPrefix || matchesSeries;
  });
}

/**
 * 高频实时报价抓取 (基于 Polymarket 内部 data-api)
 * 用于解决链上预言机 (Aggregator) 400点巨大延迟问题
 */
export async function fetchLivePriceFromFun(symbol = "BTC") {
  const url = `https://data-api.fun.xyz/price/latest?symbol=${symbol}`;
  try {
    const res = await fetch(url, {
      headers: {
        "Origin": "https://polymarket.com",
        "Referer": "https://polymarket.com/",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Number(data.price || data.value || data.current);
  } catch (e) {
    return null;
  }
}

/**
 * 获取 CLOB（中限订单簿）的价格
 */
export async function fetchClobPrice({ tokenId, side }) {
  const url = new URL("/price", CONFIG.clobBaseUrl);
  url.searchParams.set("token_id", tokenId);
  url.searchParams.set("side", side);

  const res = await fetchWithRetry(url);
  const data = await res.json();
  return toNumber(data.price);
}

/**
 * 获取指定 Token 的订单簿
 */
export async function fetchOrderBook({ tokenId }) {
  const url = new URL("/book", CONFIG.clobBaseUrl);
  url.searchParams.set("token_id", tokenId);

  const res = await fetchWithRetry(url);
  return await res.json();
}

/**
 * 总结订单簿，提取最佳买卖价、价差、深度流动性及前 N 档挂单
 */
export function summarizeOrderBook(book, depthLevels = 5) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];

  // 排序买入价（按价格从高到低）
  const sortedBids = [...bids]
    .map(x => ({ price: toNumber(x.price), size: toNumber(x.size) }))
    .filter(x => x.price !== null)
    .sort((a, b) => b.price - a.price);

  // 排序卖出价（按价格从低到高）
  const sortedAsks = [...asks]
    .map(x => ({ price: toNumber(x.price), size: toNumber(x.size) }))
    .filter(x => x.price !== null)
    .sort((a, b) => a.price - b.price);

  const bestBid = sortedBids.length ? sortedBids[0].price : null;
  const bestAsk = sortedAsks.length ? sortedAsks[0].price : null;
  const spread = (bestBid !== null && bestAsk !== null) ? (bestAsk - bestBid) : null;

  const bidLiquidity = sortedBids.slice(0, depthLevels).reduce((acc, x) => acc + (x.size ?? 0), 0);
  const askLiquidity = sortedAsks.slice(0, depthLevels).reduce((acc, x) => acc + (x.size ?? 0), 0);
  const obi = (bidLiquidity + askLiquidity) > 0 ? (bidLiquidity - askLiquidity) / (bidLiquidity + askLiquidity) : 0;

  return {
    bestBid,
    bestAsk,
    spread,
    bidLiquidity,
    askLiquidity,
    obi,
    topBids: sortedBids.slice(0, depthLevels),
    topAsks: sortedAsks.slice(0, depthLevels)
  };
}


/**
 * 从市场题目中解析“待击败价格”（Price to beat）
 */
export function parsePriceToBeat(market) {
  const fields = [
    market?.question,
    market?.title,
    market?.groupItemTitle,
    market?.line,
    market?.description
  ];

  for (const text of fields.map(String)) {
    if (!text || text === "undefined" || text === "null") continue;

    // 1. "price to beat ... $68,500"
    const m1 = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
    if (m1) {
      const n = Number(m1[1].replace(/,/g, ""));
      if (Number.isFinite(n)) return n;
    }

    // 2. "$68,500" (BTC range)
    const m2 = text.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?)/);
    if (m2) {
      const n = Number(m2[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 1000 && n < 2000000) return n;
    }

    // 3. "> 68500" or "above 68500"
    const m3 = text.match(/(?:above|below|at|>\s*|<\s*|price)\s*\*?\$?\s*([0-9]{2,3},[0-9]{3}(?:\.[0-9]+)?|[0-9]{4,7}(?:\.[0-9]+)?)/i);
    if (m3) {
      const n = Number(m3[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 1000 && n < 2000000) return n;
    }
  }

  return null;
}

/**
 * 递归从市场对象中提取数值（尝试查找行权价、阈值等）
 */
export function extractNumericFromMarket(market) {
  const directKeys = [
    "priceToBeat",
    "price_to_beat",
    "strikePrice",
    "strike_price",
    "strike",
    "threshold",
    "thresholdPrice",
    "threshold_price",
    "targetPrice",
    "target_price",
    "referencePrice",
    "reference_price",
    "line",
    "groupItemTitle"
  ];

  for (const k of directKeys) {
    const v = market?.[k];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }

  const seen = new Set();
  const stack = [{ obj: market, depth: 0 }];

  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || typeof obj !== "object") continue;
    if (seen.has(obj) || depth > 6) continue;
    seen.add(obj);

    const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
    for (const [key, value] of entries) {
      const k = String(key).toLowerCase();
      if (value && typeof value === "object") {
        stack.push({ obj: value, depth: depth + 1 });
        continue;
      }

      if (!/(price|strike|threshold|target|beat)/i.test(k)) continue;

      const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n)) continue;

      if (n > 1000 && n < 2_000_000) return n;
    }
  }

  return null;
}

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

/**
 * 自动解析或根据配置选择当前的 BTC 5分钟/15分钟市场
 * (通过精确计算时间戳来预测 Slug，彻底解决 Gamma API seriesSlug 过滤器失效的问题)
 */
export async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }

  const windowMs = CONFIG.candleWindowMinutes * 60_000;
  const currentWindowStart = Math.floor(now / windowMs) * windowMs;
  const prefix = CONFIG.candleWindowMinutes === 5 ? "btc-updown-5m-" : "btc-updown-15m-";
  
  const currentSlug = `${prefix}${Math.floor(currentWindowStart / 1000)}`;
  const nextSlug = `${prefix}${Math.floor((currentWindowStart + windowMs) / 1000)}`;

  // 并发获取当前和下一个时间窗口的市场
  const [currentMarket, nextMarket] = await Promise.all([
    fetchMarketBySlug(currentSlug),
    fetchMarketBySlug(nextSlug)
  ]);

  const markets = [currentMarket, nextMarket].filter(Boolean);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

const ethMarketCache = {
  market: null,
  fetchedAtMs: 0
};

/**
 * 自动解析当前的 ETH 5分钟市场
 */
export async function resolveCurrentEthMarket() {
  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (ethMarketCache.market && now - ethMarketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return ethMarketCache.market;
  }

  const windowMs = 5 * 60_000; // ETH 是 5m 市场
  const currentWindowStart = Math.floor(now / windowMs) * windowMs;
  const prefix = "eth-updown-5m-";
  
  const currentSlug = `${prefix}${Math.floor(currentWindowStart / 1000)}`;
  const nextSlug = `${prefix}${Math.floor((currentWindowStart + windowMs) / 1000)}`;

  // 并发获取当前和下一个时间窗口的市场
  const [currentMarket, nextMarket] = await Promise.all([
    fetchMarketBySlug(currentSlug),
    fetchMarketBySlug(nextSlug)
  ]);

  const markets = [currentMarket, nextMarket].filter(Boolean);
  const picked = pickLatestLiveMarket(markets);

  ethMarketCache.market = picked;
  ethMarketCache.fetchedAtMs = now;
  return picked;
}

/**
 * 获取 Polymarket 的市场快照（价格、订单簿、Token ID 等）
 */
export async function fetchPolymarketSnapshot(asset = "BTC") {
  const market = asset === "ETH" ? await resolveCurrentEthMarket() : await resolveCurrentBtc15mMarket();

  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  // 匹配看涨和看跌 Token 的 ID
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return {
      ok: false,
      reason: "missing_token_ids",
      market,
      outcomes,
      clobTokenIds,
      outcomePrices
    };
  }

  let upBuy = null;
  let downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let fetchErrorMsg = null;

  try {
    // 获取 CLOB 价格和订单簿 (优化：不再单独获取价格，直接从订单簿摘要里提取)
    const [upBook, downBook] = await Promise.all([
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);

    // 价格取买一价 (与之前 fetchClobPrice side: "buy" 逻辑一致)
    upBuy = upBookSummary.bestBid;
    downBuy = downBookSummary.bestBid;
  } catch (e) {
    // 降级处理：使用 Gamma API 的价格
    fetchErrorMsg = e.message;
    console.warn(`[DATA] CLOB Data Fetch Failed (using Gamma fallback): ${e.message}`);
    upBuy = null;
    downBuy = null;
    upBookSummary = {
      bestBid: Number(market.bestBid) || null,
      bestAsk: Number(market.bestAsk) || null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
    downBookSummary = {
      bestBid: null,
      bestAsk: null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
  }

  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: {
      up: (upBuy > 0 ? upBuy : gammaYes),
      down: (downBuy > 0 ? downBuy : gammaNo)
    },
    orderbook: {
      up: upBookSummary,
      down: downBookSummary
    },
    error: fetchErrorMsg
  };
}
/**
 * 将字符串转换为安全的文件名格式
 */
export function safeFileSlug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 从 Polymarket 内部 API 获取指定时段的开盘价 (PTB)
 * @param {string} slug 市场 Slug，例如 "btc-updown-15m-1774065600"
 */
export async function fetchPtbFromInternalApi(slug) {
  if (!slug) return null;
  // 从 slug 提取市场开盘时间戳（秒）
  const match = slug.match(/-(\d{10})$/);
  if (!match) return null;
  
  const startTimeSec = Number(match[1]);
  const asset = slug.toLowerCase().includes("eth") ? "ETH" : "BTC";
  
  // 直接查询 Polygon 链上的 Chainlink 聚合器历史价格
  // 这和 Polymarket 解析时使用的是完全相同的数据源，PTB 精确到分
  return await fetchChainlinkPriceAtTimestamp(startTimeSec, asset);
}

/**
 * 根据 ID 获取事件详情
 */
export async function fetchEventById(id) {
  const url = new URL(`/events/${id}`, CONFIG.gammaBaseUrl);
  try {
    const res = await fetchWithRetry(url);
    return await res.json();
  } catch (e) {
    return null;
  }
}

/**
 * 网页逆向抓包：精析 Polymarket 15 分钟 BTC 市场的准确基准目标价 (PTB)
 */
export async function fetchExactPriceToBeat(slug, conditionId = null) {
  if (!slug) return null;
  
  let webPtb = null;
  let chainlinkPtb = null;

  // 1. 获取链上开盘价
  try {
    chainlinkPtb = await fetchPtbFromInternalApi(slug);
  } catch (e) {
    console.warn(`[PTB] Failed to fetch on-chain price for ${slug}: ${e.message}`);
  }

  // 2. 获取网页抓包价格
  try {
    const res = await fetchWithRetry(`https://polymarket.com/event/${slug}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>(.*?)<\/script>/s);
      if (match && match[1]) {
        const data = JSON.parse(match[1]);
        const queries = data.props?.pageProps?.dehydratedState?.queries || [];
        
        const startTimeMatch = slug.match(/-(\d{10})$/);
        if (startTimeMatch) {
          const startTimeSec = Number(startTimeMatch[1]);
          const asset = slug.toLowerCase().includes("eth") ? "ETH" : "BTC";
          const date = new Date(startTimeSec * 1000);
          const startIsoWithMs = date.toISOString();
          const startIsoWithoutMs = startIsoWithMs.replace(".000", "");

          // 1. 尝试从 crypto-prices 历史报价详情查询中直接提取对应时间窗口的 openPrice
          for (const q of queries) {
            if (Array.isArray(q.queryKey) && q.queryKey[0] === "crypto-prices") {
              const qAsset = q.queryKey[2];
              const qStart = q.queryKey[3];
              if (String(qAsset).toUpperCase() === asset && 
                  (qStart === startIsoWithMs || qStart === startIsoWithoutMs)) {
                const openPrice = Number(q.state?.data?.openPrice);
                if (Number.isFinite(openPrice)) {
                  webPtb = openPrice;
                  // console.log(`[PTB] Extracted exact openPrice $${webPtb} from crypto-prices query for ${slug}`);
                  break;
                }
              }
            }
          }

          // 2. 尝试从 past-results 往期结算结果列表查询中提取对应时间窗口的 openPrice/closePrice
          if (webPtb === null) {
            for (const q of queries) {
              if (Array.isArray(q.queryKey) && q.queryKey[0] === "past-results") {
                const qAsset = q.queryKey[1];
                if (String(qAsset).toUpperCase() === asset) {
                  const results = q.state?.data?.data?.results || [];
                  for (const res of results) {
                    if (res.startTime === startIsoWithMs || res.startTime === startIsoWithoutMs) {
                      const openPrice = Number(res.openPrice);
                      if (Number.isFinite(openPrice)) {
                        webPtb = openPrice;
                        // console.log(`[PTB] Extracted openPrice $${webPtb} from past-results query for ${slug}`);
                        break;
                      }
                    }
                    if (res.endTime === startIsoWithMs || res.endTime === startIsoWithoutMs) {
                      const closePrice = Number(res.closePrice);
                      if (Number.isFinite(closePrice)) {
                        webPtb = closePrice;
                        // console.log(`[PTB] Extracted closePrice $${webPtb} from past-results query for ${slug}`);
                        break;
                      }
                    }
                  }
                }
              }
              if (webPtb !== null) break;
            }
          }
        }

        // 3. 兜底方案：如果上述特定价格查询中未找到（例如刚开盘，页面查询尚未生成），则递归搜索匹配目标 slug/conditionId 的对象
        if (webPtb === null) {
          const targetSlug = String(slug).toLowerCase();
          
          function searchObj(obj, path = "") {
            if (!obj || typeof obj !== 'object') return;
            
            const objSlug = String(obj.slug || "").toLowerCase();
            const isSlugMatch = objSlug === targetSlug || objSlug.startsWith(targetSlug + "-");
            const isConditionMatch = conditionId && String(obj.conditionId || "").toLowerCase() === String(conditionId).toLowerCase();

            if (isSlugMatch || isConditionMatch) {
              const ptbValue = obj.eventMetadata?.priceToBeat || obj.priceToBeat;
              if (ptbValue) {
                webPtb = Number(ptbValue);
                return;
              }
            }
            
            for (const [k, v] of Object.entries(obj)) {
              if (webPtb !== null) return;
              if (v && typeof v === 'object') {
                searchObj(v, path ? `${path}.${k}` : k);
              }
            }
          }
          
          searchObj(data);
        }
        
        // 4. 最后让步：如果仍未找到，且数据中只有一个 event，直接匹配
        if (webPtb === null) {
           const firstEvent = data.props?.pageProps?.dehydratedState?.queries?.find(q => q.state?.data?.event)?.state?.data?.event;
           if (firstEvent && (firstEvent.slug === slug || !slug)) {
              webPtb = Number(firstEvent.eventMetadata?.priceToBeat || firstEvent.priceToBeat);
           }
        }
      }
    }
  } catch (e) {
    console.warn(`[PTB] Failed to scrape web price for ${slug}: ${e.message}`);
  }

  // 3. 对比并记录价格，优先返回网页价格
  if (webPtb !== null && chainlinkPtb !== null) {
    const diff = Math.abs(webPtb - chainlinkPtb);
    if (diff > 0.000001) {
      console.warn(`[PTB COMPARE] Mismatch for ${slug}: Web PTB = ${webPtb}, On-Chain = ${chainlinkPtb} (Diff = ${diff}). Prioritizing Web PTB.`);
    } else {
      console.log(`[PTB COMPARE] Match for ${slug}: ${webPtb}`);
    }
    return webPtb;
  }

  if (webPtb !== null) {
    console.log(`[PTB] Only Web PTB available for ${slug}: ${webPtb}`);
    return webPtb;
  }

  if (chainlinkPtb !== null) {
    console.log(`[PTB] Only On-Chain PTB available for ${slug}: ${chainlinkPtb}`);
    return chainlinkPtb;
  }

  console.warn(`[PTB] Both Web and On-Chain PTB are unavailable for ${slug}`);
  return null;
}

