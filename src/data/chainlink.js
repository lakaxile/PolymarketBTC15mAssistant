import { ethers } from "ethers";
import { CONFIG } from "../config.js";

/**
 * Chainlink 聚合器 ABI，仅包含我们需要的方法
 */
const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function getRoundData(uint80 _roundId) view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)"
];

const iface = new ethers.Interface(AGGREGATOR_ABI);

let preferredRpcUrl = null; // 优先使用的 RPC URL

let cachedDecimals = {}; // 缓存的小数位数 (asset -> decimals)
let cachedResult = {
  BTC: { price: null, updatedAt: null, source: "chainlink" },
  ETH: { price: null, updatedAt: null, source: "chainlink" }
}; // 缓存的最新价格结果
let cachedFetchedAtMs = { BTC: 0, ETH: 0 }; // 上次获取数据的时间戳（毫秒）
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
    roundId: decoded[0],
    answer: decoded[1],
    updatedAt: decoded[3]
  };
}

/**
 * 根据 roundId 获取历史价格数据
 */
async function fetchRoundDataById(rpcUrl, aggregator, roundId) {
  const data = iface.encodeFunctionData("getRoundData", [roundId]);
  const result = await ethCall(rpcUrl, aggregator, data);
  const decoded = iface.decodeFunctionResult("getRoundData", result);
  return {
    roundId: decoded[0],
    answer: decoded[1],
    updatedAt: decoded[3]
  };
}

/**
 * 获取 Chainlink 实时价格
 */
export async function fetchChainlinkPrice(asset = "BTC") {
  const aggregator = asset === "ETH" ? CONFIG.chainlink.ethUsdAggregator : CONFIG.chainlink.btcUsdAggregator;
  if ((!CONFIG.chainlink.polygonRpcUrl && (!CONFIG.chainlink.polygonRpcUrls || CONFIG.chainlink.polygonRpcUrls.length === 0)) || !aggregator) {
    return { price: null, updatedAt: null, source: "missing_config" };
  }

  const now = Date.now();
  // 检查缓存
  if (cachedFetchedAtMs[asset] && now - cachedFetchedAtMs[asset] < MIN_FETCH_INTERVAL_MS) {
    return cachedResult[asset];
  }

  const rpcs = getOrderedRpcs();
  if (rpcs.length === 0) return { price: null, updatedAt: null, source: "missing_config" };

  // 遍历 RPC 进行重试
  for (const rpc of rpcs) {
    preferredRpcUrl = rpc;
    try {
      if (cachedDecimals[asset] === undefined || cachedDecimals[asset] === null) {
        cachedDecimals[asset] = await fetchDecimals(rpc, aggregator);
      }

      const round = await fetchLatestRoundData(rpc, aggregator);
      const answer = Number(round.answer);
      const scale = 10 ** Number(cachedDecimals[asset]);
      const price = answer / scale;

      cachedResult[asset] = {
        price,
        updatedAt: Number(round.updatedAt) * 1000,
        source: "chainlink"
      };
      cachedFetchedAtMs[asset] = now;
      preferredRpcUrl = rpc;
      return cachedResult[asset];
    } catch {
      cachedDecimals[asset] = null;
      continue;
    }
  }

  return cachedResult[asset];
}

/**
 * 获取 Chainlink BTC/USD 价格
 */
export async function fetchChainlinkBtcUsd() {
  return fetchChainlinkPrice("BTC");
}

/**
 * 获取 Chainlink ETH/USD 价格
 */
export async function fetchChainlinkEthUsd() {
  return fetchChainlinkPrice("ETH");
}

/**
 * 查询 Chainlink 在指定 Unix 时间戳（秒）时的历史价格
 * 使用二分查找高效定位最近的 round
 * 这是 Polymarket 官方使用的同一链上数据源，PTB 完全准确
 */
export async function fetchChainlinkPriceAtTimestamp(targetTimestampSec, asset = "BTC") {
  const rpcs = getOrderedRpcs();
  const aggregator = asset === "ETH" ? CONFIG.chainlink.ethUsdAggregator : CONFIG.chainlink.btcUsdAggregator;
  if (!aggregator) return null;

  for (const rpc of rpcs) {
    try {
      if (cachedDecimals[asset] === undefined || cachedDecimals[asset] === null) {
        cachedDecimals[asset] = await fetchDecimals(rpc, aggregator);
      }
      const scale = 10 ** cachedDecimals[asset];

      const latestRaw = await fetchLatestRoundData(rpc, aggregator);
      const latestRoundId = BigInt(latestRaw.roundId);
      const latestTs = Number(latestRaw.updatedAt);

      if (targetTimestampSec >= latestTs) {
        return Number(latestRaw.answer) / scale;
      }

      // Chainlink roundId = (phaseId << 64) | aggregatorRound
      const PHASE_BITS = 64n;
      const phaseId = latestRoundId >> PHASE_BITS;
      const latestAggRound = latestRoundId & ((1n << PHASE_BITS) - 1n);

      // 不再基于"每秒1 round"的错误估算来定位窗口
      // 直接从最新 round 往前推 600 个 round（足以覆盖任何更新频率下的 30 分钟历史）
      // 二分查找只需约 10 次 RPC 调用
      let lo = latestAggRound > 600n ? latestAggRound - 600n : 1n;
      let hi = latestAggRound;
      let resultPrice = null;
      let resultRound = null;

      while (lo <= hi) {
        const mid = (lo + hi) / 2n;
        const roundId = (phaseId << PHASE_BITS) | mid;
        try {
          const round = await fetchRoundDataById(rpc, aggregator, roundId);
          const ts = Number(round.updatedAt);
          if (ts > 0 && ts >= targetTimestampSec) {
            // 找到一个 >= target 的 round，记录并继续向左缩小找更早的
            resultPrice = Number(round.answer) / scale;
            resultRound = mid;
            hi = mid - 1n;
          } else {
            lo = mid + 1n;
          }
        } catch {
          lo = mid + 1n;
        }
      }

      if (resultPrice !== null) return resultPrice;
    } catch {
      continue;
    }
  }
  return null;
}
