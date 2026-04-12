/**
 * 计算 Heikin Ashi 蜡烛图
 * @param {Object[]} candles 原始 K 线数据
 * @returns {Object[]} Heikin Ashi K 线数组
 */
export function computeHeikenAshi(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const ha = [];
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    // HA 收盘价 = (开盘 + 最高 + 最低 + 收盘) / 4
    const haClose = (c.open + c.high + c.low + c.close) / 4;

    const prev = ha[i - 1];
    // HA 开盘价 = (前一根 HA 开盘 + 前一根 HA 收盘) / 2
    const haOpen = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;

    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);

    ha.push({
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
      isGreen: haClose >= haOpen,
      body: Math.abs(haClose - haOpen)
    });
  }
  return ha;
}

/**
 * 计算连续的同色蜡烛数量
 * @param {Object[]} haCandles Heikin Ashi K 线数组
 * @returns {{ color: "green" | "red" | null, count: number }}
 */
export function countConsecutive(haCandles) {
  if (!Array.isArray(haCandles) || haCandles.length === 0) return { color: null, count: 0 };

  const last = haCandles[haCandles.length - 1];
  const target = last.isGreen ? "green" : "red";

  let count = 0;
  for (let i = haCandles.length - 1; i >= 0; i -= 1) {
    const c = haCandles[i];
    const color = c.isGreen ? "green" : "red";
    if (color !== target) break;
    count += 1;
  }

  return { color: target, count };
}

