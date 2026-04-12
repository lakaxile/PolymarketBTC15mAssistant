import { ethers } from "ethers";
import { CONFIG } from "../config.js";

/**
 * Chainlink 聚合器 ABI，仅包含我们需要的方法
 */
const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)"
];

const iface = new ethers.Interface(AGGREGATOR_ABI);

let preferredRpcUrl = null; // 优先使用的 RPC URL

let cachedDecimals = null; // 缓存的小数位数
let cachedResult = { price: null, updatedAt: null, source: "chainlink" }; // 缓存的最新价格结果
let cachedFetchedAtMs = 0; // 上次获取数据的时间戳（毫秒）
const MIN_FETCH_INTERVAL_MS = 2_000; // 最小获取间隔（2秒）
const RPC_TIMEOUT_MS = 5_000; // RPC 请求超时时间（5秒）

/**
 * 获取可用的 RPC 候选列表
 */
function getRpcCandidates() {
  const fromList = Array.isArray(CONFIG.chainlink.polygonRpcUrls) ? CONFIG.chainlink.polygonRpcUrls : [];
  const single = CONFIG.chainlink.polygonRpcUrl ? [CONFIG.chainlink.polygonRpcUrl] : [];
  const defaults = [
    "https://polygon-rpc.com",
    "https://rpc.ankr.com/polygon",
    "https://polygon.llamarpc.com"
  ];

  const all = [...fromList, ...single, ...defaults].map((s) => String(s).trim()).filter(Boolean);
  return Array.from(new Set(all));
}

/**
 * 获取排序后的 RPC 列表，将优先的放在首位
 */
function getOrderedRpcs() {
  const rpcs = getRpcCandidates();
  const pref = preferredRpcUrl;
  if (pref && rpcs.includes(pref)) {
    return [pref, ...rpcs.filter((x) => x !== pref)];
  }
  return rpcs;
}

/**
 * 执行 JSON-RPC 请求
 */
async function jsonRpcRequest(rpcUrl, method, params) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`rpc_http_${res.status}`);
    }

    const data = await res.json();
    if (data.error) {
      throw new Error(`rpc_error_${data.error.code}`);
    }
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 执行 eth_call
 */
async function ethCall(rpcUrl, to, data) {
  return await jsonRpcRequest(rpcUrl, "eth_call", [{ to, data }, "latest"]);
}

/**
 * 获取聚合器的小数位数
 */
async function fetchDecimals(rpcUrl, aggregator) {
  const data = iface.encodeFunctionData("decimals", []);
  const result = await ethCall(rpcUrl, aggregator, data);
  const [dec] = iface.decodeFunctionResult("decimals", result);
  return Number(dec);
}

/**
 * 获取最新的回合数据（包含价格和更新时间）
 */
async function fetchLatestRoundData(rpcUrl, aggregator) {
  const data = iface.encodeFunctionData("latestRoundData", []);
  const result = await ethCall(rpcUrl, aggregator, data);
  const decoded = iface.decodeFunctionResult("latestRoundData", result);
  return {
    answer: decoded[1],
    updatedAt: decoded[3]
  };
}

/**
 * 获取 Chainlink BTC/USD 价格
 */
export async function fetchChainlinkBtcUsd() {
  if ((!CONFIG.chainlink.polygonRpcUrl && (!CONFIG.chainlink.polygonRpcUrls || CONFIG.chainlink.polygonRpcUrls.length === 0)) || !CONFIG.chainlink.btcUsdAggregator) {
    return { price: null, updatedAt: null, source: "missing_config" };
  }

  const now = Date.now();
  // 检查缓存
  if (cachedFetchedAtMs && now - cachedFetchedAtMs < MIN_FETCH_INTERVAL_MS) {
    return cachedResult;
  }

  const rpcs = getOrderedRpcs();
  if (rpcs.length === 0) return { price: null, updatedAt: null, source: "missing_config" };

  const aggregator = CONFIG.chainlink.btcUsdAggregator;

  // 遍历 RPC 进行重试
  for (const rpc of rpcs) {
    preferredRpcUrl = rpc;
    try {
      if (cachedDecimals === null) {
        cachedDecimals = await fetchDecimals(rpc, aggregator);
      }

      const round = await fetchLatestRoundData(rpc, aggregator);
      const answer = Number(round.answer);
      const scale = 10 ** Number(cachedDecimals);
      const price = answer / scale;

      cachedResult = {
        price,
        updatedAt: Number(round.updatedAt) * 1000,
        source: "chainlink"
      };
      cachedFetchedAtMs = now;
      preferredRpcUrl = rpc;
      return cachedResult;
    } catch {
      cachedDecimals = null;
      continue;
    }
  }

  return cachedResult;
}

