import WebSocket from "ws";
import { ethers } from "ethers";
import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js";

// Chainlink 价格更新事件的 Topic0
const ANSWER_UPDATED_TOPIC0 = ethers.id("AnswerUpdated(int256,uint256,uint256)");

/**
 * 获取 WSS 候选列表
 */
function getWssCandidates() {
  const fromList = Array.isArray(CONFIG.chainlink.polygonWssUrls) ? CONFIG.chainlink.polygonWssUrls : [];
  const single = CONFIG.chainlink.polygonWssUrl ? [CONFIG.chainlink.polygonWssUrl] : [];
  const all = [...fromList, ...single].map((s) => String(s).trim()).filter(Boolean);
  return Array.from(new Set(all));
}

/**
 * 将十六进制字符串转换为有符号 BigInt
 */
function hexToSignedBigInt(hex) {
  const x = ethers.toBigInt(hex);
  const TWO_255 = 1n << 255n;
  const TWO_256 = 1n << 256n;
  return x >= TWO_255 ? x - TWO_256 : x;
}

/**
 * 将输入转换为数字，如果非有限数字则返回 null
 */
function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * 启动 Chainlink 价格流监听（直接通过 RPC 的 WebSocket 订阅日志更新）
 * @param {Object} params 参数
 * @param {string} params.aggregator 聚合器合约地址
 * @param {number} params.decimals 小数位数
 * @param {Function} params.onUpdate 更新时的回调函数
 */
export function startChainlinkPriceStream({
  aggregator = CONFIG.chainlink.btcUsdAggregator,
  decimals = 8,
  onUpdate
} = {}) {
  const wssUrls = getWssCandidates();
  if (!aggregator || wssUrls.length === 0) {
    return {
      getLast() {
        return { price: null, updatedAt: null, source: "chainlink_ws" };
      },
      close() { }
    };
  }

  let ws = null;
  let closed = false;
  let reconnecting = false;
  let reconnectMs = 500;
  let urlIndex = 0;

  let lastPrice = null;
  let lastUpdatedAt = null;

  let nextId = 1;
  let subId = null;

  let heartbeatInterval = null;
  const HEARTBEAT_KEEPALIVE_MS = 60000;
  let lastTrafficTime = Date.now();

  const connect = () => {
    if (closed || reconnecting) return;

    lastTrafficTime = Date.now();

    // 轮询使用不同的 WSS URL 进行连接
    const url = wssUrls[urlIndex % wssUrls.length];
    urlIndex += 1;

    ws = new WebSocket(url, { agent: wsAgentForUrl(url) });

    const send = (obj) => {
      try {
        ws?.send(JSON.stringify(obj));
      } catch {
        // ignore
      }
    };

    const scheduleReconnect = () => {
      if (closed || reconnecting) return;
      reconnecting = true;

      try {
        if (ws) {
          ws.removeAllListeners();
          if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
            ws.terminate();
          }
        }
      } catch (err) {
        // ignore
      }
      ws = null;
      subId = null;
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = null;

      const wait = reconnectMs;
      reconnectMs = Math.min(10_000, Math.floor(reconnectMs * 1.5));
      setTimeout(() => {
        reconnecting = false;
        connect();
      }, wait);
    };

    heartbeatInterval = setInterval(() => {
      if (Date.now() - lastTrafficTime > HEARTBEAT_KEEPALIVE_MS) {
        console.warn(`[DATA] Chainlink WS quiet for ${HEARTBEAT_KEEPALIVE_MS}ms, reconnecting...`);
        scheduleReconnect();
      }
    }, 15000);

    ws.on("open", () => {
      reconnectMs = 500;
      const id = nextId++;
      // 订阅 eth_subscribe 'logs'，监听特定合约的价格更新事件
      send({
        jsonrpc: "2.0",
        id,
        method: "eth_subscribe",
        params: [
          "logs",
          {
            address: aggregator,
            topics: [ANSWER_UPDATED_TOPIC0]
          }
        ]
      });
    });

    ws.on("ping", () => {
      lastTrafficTime = Date.now();
    });

    ws.on("message", (buf) => {
      lastTrafficTime = Date.now();
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }

      // 处理订阅成功后的 ID 确认
      if (msg.id && msg.result && typeof msg.result === "string" && !subId) {
        subId = msg.result;
        return;
      }

      // 只关心订阅的消息推送
      if (msg.method !== "eth_subscription") return;
      const params = msg.params;
      if (!params || !params.result) return;

      const log = params.result;
      const topics = Array.isArray(log.topics) ? log.topics : [];
      if (topics.length < 2) return;

      try {
        // topics[1] 是 AnswerUpdated 事件中的有符号整数价格
        const answer = hexToSignedBigInt(topics[1]);
        const price = toNumber(answer) / 10 ** Number(decimals);
        const updatedAtHex = typeof log.data === "string" ? log.data : null;
        const updatedAt = updatedAtHex ? toNumber(ethers.toBigInt(updatedAtHex)) : null;

        lastPrice = Number.isFinite(price) ? price : lastPrice;
        lastUpdatedAt = updatedAt ? updatedAt * 1000 : lastUpdatedAt;

        if (typeof onUpdate === "function") {
          onUpdate({ price: lastPrice, updatedAt: lastUpdatedAt, source: "chainlink_ws" });
        }
      } catch {
        return;
      }
    });

    ws.on("close", scheduleReconnect);
    ws.on("error", scheduleReconnect);
  };

  connect();

  return {
    getLast() {
      return { price: lastPrice, updatedAt: lastUpdatedAt, source: "chainlink_ws" };
    },
    close() {
      closed = true;
      try {
        // 取消订阅
        if (ws && subId) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "eth_unsubscribe", params: [subId] }));
        }
      } catch {
        // ignore
      }
      try {
        ws?.close();
      } catch {
        // ignore
      }
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = null;
      ws = null;
      subId = null;
    }
  };
}

