import WebSocket from "ws";
import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js";

/**
 * 将输入转换为数字，如果非有限数字则返回 null
 */
function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * 构建币安交易流 WebSocket URL
 */
function buildWsUrl(symbol) {
  const s = String(symbol || "").toLowerCase();
  return `wss://stream.binance.com:9443/ws/${s}@trade`;
}

/**
 * 启动币安成交价流实时监听
 * @param {Object} params 参数
 * @param {string} params.symbol 交易对符号
 * @param {Function} params.onUpdate 更新时的回调函数
 */
export function startBinanceTradeStream({ symbol = CONFIG.symbol, onUpdate, onTrade } = {}) {
  let ws = null;
  let closed = false;
  let reconnectMs = 500; // 初始重连间隔
  let lastPrice = null;
  let lastTs = null;

  // Binance 要求每 3 分钟内发送一次 ping，否则服务端会主动断开
  const HEARTBEAT_INTERVAL_MS = 150_000; // 2.5 分钟发一次 ping
  const HEARTBEAT_TIMEOUT_MS = 30_000;   // 30 秒内没收到 pong 则重连
  let heartbeatInterval = null;
  let pongTimeout = null;
  let lastMessageTime = Date.now();

  const connect = () => {
    if (closed) return;

    lastMessageTime = Date.now();
    const url = buildWsUrl(symbol);
    ws = new WebSocket(url, { agent: wsAgentForUrl(url) });

    // 安排重连逻辑
    let reconnecting = false;
    const scheduleReconnect = () => {
      if (closed || reconnecting) return;
      reconnecting = true;

      if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
      if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }

      try {
        if (ws) {
          ws.removeAllListeners();
          ws.terminate();
        }
      } catch {
        // ignore
      }
      ws = null;

      const wait = reconnectMs;
      reconnectMs = Math.min(10_000, Math.floor(reconnectMs * 1.5)); // 指数退避
      setTimeout(() => {
        reconnecting = false;
        connect();
      }, wait);
    };

    ws.on("open", () => {
      reconnectMs = 500; // 连接成功后重置重连间隔

      // 定期发送 ping 保持连接活跃
      heartbeatInterval = setInterval(() => {
        if (closed || !ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.ping();
          // 若 30 秒内没收到 pong，触发重连
          pongTimeout = setTimeout(() => {
            console.warn("[DATA] Binance WS pong timeout, reconnecting...");
            scheduleReconnect();
          }, HEARTBEAT_TIMEOUT_MS);
        } catch {
          scheduleReconnect();
        }
      }, HEARTBEAT_INTERVAL_MS);
    });

    ws.on("pong", () => {
      lastMessageTime = Date.now();
      if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
    });

    ws.on("message", (buf) => {
      lastMessageTime = Date.now();
      try {
        const msg = JSON.parse(buf.toString());
        const p = toNumber(msg.p); // 获取成交价
        if (p === null) return;
        lastPrice = p;
        lastTs = Date.now();
        if (typeof onUpdate === "function") onUpdate({ price: lastPrice, ts: lastTs });
        // onTrade: 提供完整的成交信息供 CVD 计算 (p=price, q=quantity, m=isBuyerMaker)
        if (typeof onTrade === "function") {
            const qty = toNumber(msg.q);
            if (qty !== null) {
                onTrade({ price: p, quantity: qty, isBuyerMaker: !!msg.m });
            }
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
    /**
     * 获取最新价格和时间戳
     */
    getLast() {
      return { price: lastPrice, ts: lastTs };
    },
    /**
     * 关闭连接
     */
    close() {
      closed = true;
      if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
      if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  };
}

