/**
 * 检测市场环境（Regime）
 * 根据价格、VWAP 及其斜率、成交量等指标判断当前是趋势还是震荡
 * @returns {{ regime: "TREND_UP" | "TREND_DOWN" | "RANGE" | "CHOP", reason: string }}
 */
export function detectRegime({ price, vwap, vwapSlope, vwapCrossCount, volumeRecent, volumeAvg }) {
  if (price === null || vwap === null || vwapSlope === null) return { regime: "CHOP", reason: "missing_inputs" };

  const above = price > vwap; // 价格是否在 VWAP 之上

  // 低成交量且价格紧贴 VWAP 时视为震荡（CHOP）
  const lowVolume = volumeRecent !== null && volumeAvg !== null ? volumeRecent < 0.6 * volumeAvg : false;
  if (lowVolume && Math.abs((price - vwap) / vwap) < 0.001) {
    return { regime: "CHOP", reason: "low_volume_flat" };
  }

  // 价格在 VWAP 之上且 VWAP 斜率向上：看涨趋势
  if (above && vwapSlope > 0) {
    return { regime: "TREND_UP", reason: "price_above_vwap_slope_up" };
  }

  // 价格在 VWAP 之下且 VWAP 斜率向下：看跌趋势
  if (!above && vwapSlope < 0) {
    return { regime: "TREND_DOWN", reason: "price_below_vwap_slope_down" };
  }

  // VWAP 穿回次数较多：区间震荡
  if (vwapCrossCount !== null && vwapCrossCount >= 3) {
    return { regime: "RANGE", reason: "frequent_vwap_cross" };
  }

  // 默认视为区间震荡
  return { regime: "RANGE", reason: "default" };
}

/**
 * 计算波动率状态指标 (Vol Regime Metrics)
 * 基于 1m K 线数组，直接在内存中计算，无需额外数据源。
 *
 * @param {Array} klines1m  { open, high, low, close, volume } 数组
 * @param {number} atrPeriod  ATR 周期（默认 14）
 * @param {number} hvPeriod   历史波动率周期（默认 20）
 * @param {number} bbPeriod   布林带周期（默认 20）
 * @returns {{
 *   atr: number,          ATR 绝对值（美元）
 *   atrPct: number,       ATR 占当前价格的百分比（趋势性更强）
 *   hv: number,           历史波动率（年化，百分比）
 *   bbWidth: number,      布林带带宽（占中轨百分比）
 *   regime: 'LOW'|'MID'|'HIGH',  综合判断
 * }|null}
 */
export function calcVolRegimeMetrics(klines1m, atrPeriod = 14, hvPeriod = 20, bbPeriod = 20) {
    if (!klines1m || klines1m.length < Math.max(atrPeriod, hvPeriod, bbPeriod) + 1) return null;

    const closes = klines1m.map(k => k.close);
    const highs  = klines1m.map(k => k.high);
    const lows   = klines1m.map(k => k.low);

    // ─── ATR (Average True Range) ───────────────────────────────────────────
    const trueRanges = [];
    for (let i = 1; i < klines1m.length; i++) {
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        trueRanges.push(Math.max(hl, hc, lc));
    }
    const recentTR = trueRanges.slice(-atrPeriod);
    const atr = recentTR.reduce((s, v) => s + v, 0) / recentTR.length;
    const lastClose = closes[closes.length - 1];
    const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : 0;

    // ─── Historical Volatility (log returns std dev, annualized) ───────────
    const recentCloses = closes.slice(-hvPeriod - 1);
    const logReturns = [];
    for (let i = 1; i < recentCloses.length; i++) {
        if (recentCloses[i - 1] > 0) {
            logReturns.push(Math.log(recentCloses[i] / recentCloses[i - 1]));
        }
    }
    const hvMean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
    const hvVariance = logReturns.reduce((s, v) => s + (v - hvMean) ** 2, 0) / logReturns.length;
    // 1分钟K线 → 年化乘数 = sqrt(525600) ≈ 725 (全年分钟数)
    const hv = Math.sqrt(hvVariance) * Math.sqrt(525600) * 100;

    // ─── Bollinger Bands Width ───────────────────────────────────────────────
    const bbCloses = closes.slice(-bbPeriod);
    const bbMid = bbCloses.reduce((s, v) => s + v, 0) / bbCloses.length;
    const bbStd = Math.sqrt(bbCloses.reduce((s, v) => s + (v - bbMid) ** 2, 0) / bbCloses.length);
    const bbUpper = bbMid + 2 * bbStd;
    const bbLower = bbMid - 2 * bbStd;
    const bbWidth = bbMid > 0 ? ((bbUpper - bbLower) / bbMid) * 100 : 0;

    // ─── 综合判断 ───────────────────────────────────────────────────────────
    // ATR% 基准：BTC 1m 一般 0.02%-0.05% 正常，>0.08% 高波
    let regime = "MID";
    if (atrPct < 0.025 && bbWidth < 0.3) regime = "LOW";
    else if (atrPct > 0.07 || bbWidth > 0.8) regime = "HIGH";

    return {
        atr:    parseFloat(atr.toFixed(2)),
        atrPct: parseFloat(atrPct.toFixed(4)),
        hv:     parseFloat(hv.toFixed(2)),
        bbWidth: parseFloat(bbWidth.toFixed(4)),
        regime,
    };
}
