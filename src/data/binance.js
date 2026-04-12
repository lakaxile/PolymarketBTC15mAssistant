import { CONFIG } from "../config.js";

/**
 * 将输入转换为数字，如果非有限数字则返回 null
 */
function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

const klinesCache = new Map();

/**
 * 从币安获取 K 线数据
 * @param {Object} params 参数
 * @param {string} params.interval K 线周期（如 "15m"）
 * @param {number} params.limit 数据点数量
 */
export async function fetchKlines({ interval, limit }) {
  const cacheKey = `${interval}_${limit}`;
  const now = Date.now();
  const cached = klinesCache.get(cacheKey);
  // 缓存 2500ms 以大幅降低内存在 500ms 主循环中的持续分配，防止 OOM
  if (cached && now - cached.ts < 2500) {
    return cached.data;
  }

  const url = new URL("/api/v3/klines", CONFIG.binanceBaseUrl);
  url.searchParams.set("symbol", CONFIG.symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Binance klines error: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();

    // 解析币安返回的数组格式 K 线数据
    const parsedData = data.map((k) => ({
      openTime: Number(k[0]),
      open: toNumber(k[1]),
      high: toNumber(k[2]),
      low: toNumber(k[3]),
      close: toNumber(k[4]),
      volume: toNumber(k[5]),
      closeTime: Number(k[6])
    }));

    klinesCache.set(cacheKey, { ts: now, data: parsedData });
    return parsedData;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 获取币安指定交易对的最新价格
 */
export async function fetchLastPrice() {
  const url = new URL("/api/v3/ticker/price", CONFIG.binanceBaseUrl);
  url.searchParams.set("symbol", CONFIG.symbol);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Binance last price error: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    return toNumber(data.price);
  } finally {
    clearTimeout(t);
  }
}

