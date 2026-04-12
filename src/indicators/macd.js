/**
 * 计算 EMA（指数移动平均线）
 * @param {number[]} values 数值数组
 * @param {number} period 周期
 */
export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;

  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

/**
 * 计算 MACD 指标
 * @param {number[]} closes 收盘价数组
 * @param {number} fast 快线周期
 * @param {number} slow 慢线周期
 * @param {number} signal 信号线周期
 * @returns {Object|null} 包含 macd, signal, hist, histDelta
 */
export function computeMacd(closes, fast, slow, signal) {
  if (!Array.isArray(closes) || closes.length < slow + signal) return null;

  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  if (fastEma === null || slowEma === null) return null;

  const macdLine = fastEma - slowEma; // MACD 线 (DIF)

  // 计算 MACD 线序列，用于后续计算信号线 (DEA)
  const macdSeries = [];
  for (let i = 0; i < closes.length; i += 1) {
    const sub = closes.slice(0, i + 1);
    const f = ema(sub, fast);
    const s = ema(sub, slow);
    if (f === null || s === null) continue;
    macdSeries.push(f - s);
  }

  const signalLine = ema(macdSeries, signal); // 信号线 (DEA)
  if (signalLine === null) return null;

  const hist = macdLine - signalLine; // 柱状图 (MACD 柱)

  const lastHist = hist;
  const prevHist = macdSeries.length >= signal + 1 ? (macdSeries[macdSeries.length - 2] - ema(macdSeries.slice(0, macdSeries.length - 1), signal)) : null;

  return {
    macd: macdLine,
    signal: signalLine,
    hist,
    histDelta: prevHist === null ? null : lastHist - prevHist // 柱状图变化趋势
  };
}

