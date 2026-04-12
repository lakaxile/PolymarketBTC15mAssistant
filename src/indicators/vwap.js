/**
 * 计算会话 VWAP（成交量加权平均价）
 * @param {Object[]} candles K 线数据数组
 * @returns {number|null}
 */
export function computeSessionVwap(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  let pv = 0;
  let v = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3; // 计算典型价格 (Typical Price)
    pv += tp * c.volume;
    v += c.volume;
  }
  if (v === 0) return null;
  return pv / v;
}

/**
 * 计算 VWAP 序列
 * @param {Object[]} candles K 线数据数组
 * @returns {number[]} 每个时间点对应的 VWAP 值
 */
export function computeVwapSeries(candles) {
  const series = [];
  for (let i = 0; i < candles.length; i += 1) {
    const sub = candles.slice(0, i + 1);
    series.push(computeSessionVwap(sub));
  }
  return series;
}

