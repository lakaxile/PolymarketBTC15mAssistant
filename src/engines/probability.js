import { clamp } from "../utils.js";

/**
 * 根据多种技术指标为方向（涨/跌）评分
 * @param {Object} inputs 技术指标输入
 * @returns {{ upScore: number, downScore: number, rawUp: number }}
 */
export function scoreDirection(inputs) {
  const {
    price,
    vwap,
    vwapSlope,
    rsi,
    rsiSlope,
    macd,
    heikenColor,
    heikenCount,
    failedVwapReclaim
  } = inputs;

  let up = 1; // 看涨初始分
  let down = 1; // 看跌初始分

  // 价格与 VWAP 的关系
  if (price !== null && vwap !== null) {
    if (price > vwap) up += 2;
    if (price < vwap) down += 2;
  }

  // VWAP 斜率
  if (vwapSlope !== null) {
    if (vwapSlope > 0) up += 2;
    if (vwapSlope < 0) down += 2;
  }

  // RSI 数值及斜率
  if (rsi !== null && rsiSlope !== null) {
    if (rsi > 55 && rsiSlope > 0) up += 2;
    if (rsi < 45 && rsiSlope < 0) down += 2;
  }

  // MACD 柱状图及变化趋势
  if (macd?.hist !== null && macd?.histDelta !== null) {
    const expandingGreen = macd.hist > 0 && macd.histDelta > 0;
    const expandingRed = macd.hist < 0 && macd.histDelta < 0;
    if (expandingGreen) up += 2;
    if (expandingRed) down += 2;

    if (macd.macd > 0) up += 1;
    if (macd.macd < 0) down += 1;
  }

  // Heikin Ashi 蜡烛图颜色及持续计数
  if (heikenColor) {
    if (heikenColor === "green" && heikenCount >= 2) up += 1;
    if (heikenColor === "red" && heikenCount >= 2) down += 1;
  }

  // 是否存在失败的 VWAP 突破回归
  if (failedVwapReclaim === true) down += 3;

  const rawUp = up / (up + down); // 计算原始看涨概率
  return { upScore: up, downScore: down, rawUp };
}

/**
 * 应用时间感知：随时间流逝（接近窗口结束）衰减评分
 * @param {number} rawUp 原始看涨概率
 * @param {number} remainingMinutes 剩余分钟数
 * @param {number} windowMinutes 窗口总分钟数
 */
export function applyTimeAwareness(rawUp, remainingMinutes, windowMinutes) {
  const timeDecay = clamp(remainingMinutes / windowMinutes, 0, 1);
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}
