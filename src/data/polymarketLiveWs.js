import WebSocket from "ws";
import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js";

/**
 * 安全地解析 JSON 字符串
 */
function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * 规范化消息负载（Payload）
 */
function normalizePayload(payload) {
  if (!payload) return null;
  if (typeof payload === "object") return payload;
  if (typeof payload === "string") return safeJsonParse(payload);
  return null;
}

/**
 * 确保输入为有限数字
 */
function toFiniteNumber(x) {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * 启动 Polymarket 提供的实时 Chainlink 价格流监听
 * @param {Object} params 参数
 * @param {string} params.wsUrl WebSocket 地址
 * @param {string} params.symbolIncludes 需要匹配的交易对关键字符（如 "btc"）
 * @param {Function} params.onUpdate 更新时的回调函数
 */
export function startPolymarketChainlinkPriceStream({
  wsUrl = CONFIG.polymarket.liveDataWsUrl,
  symbolIncludes = "btc",
  onUpdate
} = {}) {
  if (!wsUrl) {
    return {
      getLast() {
        return { price: null, updatedAt: null, source: "polymarket_ws" };
      },
      close() { }
    };
  }

  let ws = null;
  let closed = false;
  let reconnecting = false;
  let reconnectMs = 500;

  let lastPrice = null;
  let lastUpdatedAt = null;

  let heartbeatInterval = null;
  const HEARTBEAT_KEEPALIVE_MS = 15000;
  let lastMessageTime = Date.now();

  const connect = () => {
    if (closed || reconnecting) return;

    lastMessageTime = Date.now();

    ws = new WebSocket(wsUrl, {
      handshakeTimeout: 10_000,
      agent: wsAgentForUrl(wsUrl)
    });

    const scheduleReconnect = () => {
      if (closed || reconnecting) return;
      reconnecting = true;

      try {
        if (ws) {
          ws.removeAllListeners();
          // 仅在非 CLOSED 状态下尝试关闭
          if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
            ws.terminate();
          }
        }
      } catch (err) {
        // ignore
      }
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
      if (Date.now() - lastMessageTime > HEARTBEAT_KEEPALIVE_MS) {
        console.warn(`[DATA] Poly Live WS quiet for ${HEARTBEAT_KEEPALIVE_MS}ms, reconnecting...`);
        scheduleReconnect();
      }
    }, 5000);

    ws.on("open", () => {
      reconnectMs = 500;
      try {
        // 订阅加密货币价格（由 Chainlink 提供）
        ws.send(
          JSON.stringify({
            action: "subscribe",
            subscriptions: [{ topic: "crypto_prices_chainlink", type: "*", filters: "" }]
          })
        );
      } catch {
        scheduleReconnect();
      }
    });

    ws.on("message", (buf) => {
      lastMessageTime = Date.now();
      const msg = typeof buf === "string" ? buf : buf?.toString?.() ?? "";
      if (!msg || !msg.trim()) return;

      const data = safeJsonParse(msg);
      if (!data || data.topic !== "crypto_prices_chainlink") return;

      const payload = normalizePayload(data.payload) || {};
      const symbol = String(payload.symbol || payload.pair || payload.ticker || "").toLowerCase();
      // 只关注包含指定关键字符的对
      if (symbolIncludes && !symbol.includes(String(symbolIncludes).toLowerCase())) return;

      const price = toFiniteNumber(payload.value ?? payload.price ?? payload.current ?? payload.data);
      if (price === null) return;

      // 尝试解析各种格式的时间戳
      const updatedAtMs = toFiniteNumber(payload.timestamp)
        ? Math.floor(Number(payload.timestamp) * 1000)
        : toFiniteNumber(payload.updatedAt)
          ? Math.floor(Number(payload.updatedAt) * 1000)
          : null;

      lastPrice = price;
      lastUpdatedAt = updatedAtMs ?? lastUpdatedAt;

      if (typeof onUpdate === "function") {
        onUpdate({ price: lastPrice, updatedAt: lastUpdatedAt, source: "polymarket_ws" });
      }
    });

    ws.on("close", scheduleReconnect);
    ws.on("error", scheduleReconnect);
  };

  connect();

  return {
    getLast() {
      return { price: lastPrice, updatedAt: lastUpdatedAt, source: "polymarket_ws" };
    },
    close() {
      closed = true;
      try {
        ws?.close();
      } catch {
        // ignore
      }
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = null;
      ws = null;
    }
  };
}

