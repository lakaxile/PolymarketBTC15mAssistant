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

  const connect = () => {
    if (closed) return;

    const url = buildWsUrl(symbol);
    ws = new WebSocket(url, { agent: wsAgentForUrl(url) });

    ws.on("open", () => {
      reconnectMs = 500; // 连接成功后重置重连间隔
    });

    ws.on("message", (buf) => {
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

    // 安排重连逻辑
    let reconnecting = false;
    const scheduleReconnect = () => {
      if (closed || reconnecting) return;
      reconnecting = true;

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
      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  };
}

