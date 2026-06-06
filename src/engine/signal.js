/**
 * 信号评估器 - 基于 MarsEdge 教程策略
 * 每次调用时传入最新的 MarsEdge 数据，返回是否需要下单的决策
 */

// ─── 策略参数 ─────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, '../../logs/strategy_config.json');

function loadPersistedStrategy() {
  const defaults = {
    minPriceChangePct: 0.16,
    minPriceChangePctEth: 0.20,
  };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      const saved = JSON.parse(content);
      if (typeof saved.minPriceChangePct === 'number') defaults.minPriceChangePct = saved.minPriceChangePct;
      if (typeof saved.minPriceChangePctEth === 'number') defaults.minPriceChangePctEth = saved.minPriceChangePctEth;
    }
  } catch (e) {
    // Ignore error, use default values
  }
  return defaults;
}

const persisted = loadPersistedStrategy();

export const STRATEGY = {
  minModelProb: 0.80,    // 最低模型胜率 (大于80%)
  minEdge: 0.10,         // 最低 Edge（模型概率 - ask 价格，大于等于10%）
  minAskPrice: 0.70,     // 附加条件：下注单价格大于0.7
  minRemSecs: 15,        // 最少剩余秒数（太少来不及成交）
  maxRemSecs: 180,       // 最多剩余秒数（太多不确定性大）
  minPriceChangePct: persisted.minPriceChangePct, // 最低 5分钟涨跌幅（%），排除横盘噪音
  minPriceChangePctEth: persisted.minPriceChangePctEth, // ETH 最低 5分钟涨跌幅（%）
  limitOrderOffset: 0.01, // 挂单价格：比 ask 低多少（争取更好成交价）
  marketOrderMinEdge: 0.15, // 市价单最低 Edge
  marketOrderMaxRemSecs: 45, // 市价单最多剩余秒数（最后时刻才市价）
  marketOrderMinProb: 0.93,  // 市价单最低胜率
};

/**
 * 评估信号
 * @param {Object} item - MarsEdge API 返回的单个 item（symbol = BTC）
 * @param {number} priceChangePct - 当前 5 分钟涨跌幅（绝对值，单位 %）
 * @returns {Object|null} 信号对象，或 null 表示不操作
 */
export function evaluateSignal(item, priceChangePct = 0) {
  if (!item) return null;

  const {
    symbol,
    p_up_pct,
    p_down_pct,
    up_ask,
    down_ask,
    up_bid,
    down_bid,
    up_token_id,
    down_token_id,
    rem_secs
  } = item;

  const pUp = (p_up_pct || 0) / 100;
  const pDown = (p_down_pct || 0) / 100;
  const edgeUp = pUp - (up_ask || 1);
  const edgeDown = pDown - (down_ask || 1);
  const secs = rem_secs || 0;

  // 剩余时间窗口检查
  if (secs < STRATEGY.minRemSecs || secs > STRATEGY.maxRemSecs) return null;

  // 5 分钟涨跌幅过滤（排除横盘噪音）
  const threshold = (symbol === 'ETH') ? STRATEGY.minPriceChangePctEth : STRATEGY.minPriceChangePct;
  if (Math.abs(priceChangePct) < threshold) return null;

  // 检查 UP 方向
  if (pUp > STRATEGY.minModelProb && edgeUp >= STRATEGY.minEdge && (up_ask || 1) > STRATEGY.minAskPrice) {
    const isMarketOrder = (
      pUp >= STRATEGY.marketOrderMinProb &&
      edgeUp >= STRATEGY.marketOrderMinEdge &&
      secs <= STRATEGY.marketOrderMaxRemSecs
    );

    return {
      direction: 'UP',
      symbol,
      tokenId: up_token_id,
      modelProb: pUp,
      askPrice: up_ask,
      bidPrice: up_bid,
      edge: edgeUp,
      remSecs: secs,
      orderType: isMarketOrder ? 'MARKET' : 'LIMIT',
      // 挂单价格：比 ask 低一点，争取更好成交
      limitPrice: isMarketOrder
        ? up_ask
        : Math.max(0.01, up_ask - STRATEGY.limitOrderOffset),
    };
  }

  // 检查 DOWN 方向
  if (pDown > STRATEGY.minModelProb && edgeDown >= STRATEGY.minEdge && (down_ask || 1) > STRATEGY.minAskPrice) {
    const isMarketOrder = (
      pDown >= STRATEGY.marketOrderMinProb &&
      edgeDown >= STRATEGY.marketOrderMinEdge &&
      secs <= STRATEGY.marketOrderMaxRemSecs
    );

    return {
      direction: 'DOWN',
      symbol,
      tokenId: down_token_id,
      modelProb: pDown,
      askPrice: down_ask,
      bidPrice: down_bid,
      edge: edgeDown,
      remSecs: secs,
      orderType: isMarketOrder ? 'MARKET' : 'LIMIT',
      limitPrice: isMarketOrder
        ? down_ask
        : Math.max(0.01, down_ask - STRATEGY.limitOrderOffset),
    };
  }

  return null;
}

/**
 * 格式化信号为可读字符串（用于终端日志）
 */
export function formatSignal(signal) {
  if (!signal) return '';
  return [
    `[SIGNAL] ${signal.symbol} ${signal.direction}`,
    `  模型胜率: ${(signal.modelProb * 100).toFixed(1)}%`,
    `  Ask价格: ${(signal.askPrice * 100).toFixed(1)}¢`,
    `  Edge: +${(signal.edge * 100).toFixed(1)}%`,
    `  剩余: ${signal.remSecs}s`,
    `  下单类型: ${signal.orderType}`,
    `  挂单价格: ${(signal.limitPrice * 100).toFixed(2)}¢`,
  ].join('\n');
}
