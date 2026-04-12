import { clamp } from "../utils.js";

/**
 * 计算 RSI（相对强弱指数）
 * @param {number[]} closes 收盘价数组
 * @param {number} period 周期
 */
export function computeRsi(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    const diff = cur - prev;
    if (diff > 0) gains += diff;
    else losses += -diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return clamp(rsi, 0, 100);
}

/**
 * 计算 SMA（简单移动平均线）
 * @param {number[]} values 数值数组
 * @param {number} period 周期
 */
export function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(values.length - period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

/**
 * 计算最后 N 个点的斜率
 * @param {number[]} values 数值数组
 * @param {number} points 点数
 */
export function slopeLast(values, points) {
  if (!Array.isArray(values) || values.length < points) return null;
  const slice = values.slice(values.length - points);
  const first = slice[0];
  const last = slice[slice.length - 1];
  return (last - first) / (points - 1);
}

