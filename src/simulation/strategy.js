/**
 * 用户自定义交易策略
 * @param {Object} indicators 经过时间处理后的 TA 指标 { adjustedUp, adjustedDown, ... }
 * @param {Object} marketPrices 当前市场价格 { upPrice, downPrice }
 * @returns {Object|null} 返回 { side: 'UP' | 'DOWN', confidence: number } 或 null
 */
export function myCustomStrategy(indicators, marketPrices, context) {
    const { timeLeft, livePrice, spotPrice, priceToBeat } = context;

    // --- 策略 1: 剩余时间 < 5分钟，且 Live Price 距离目标价超过 100 ---
    if (timeLeft !== null && timeLeft < 5 && priceToBeat !== null && livePrice !== null) {
        if (livePrice > priceToBeat + 100) {
            return { side: "UP", confidence: 1.0, type: "STRATEGY_1", taProb: indicators.adjustedUp, marketOdds: marketPrices.upPrice };
        }
        if (livePrice < priceToBeat - 100) {
            return { side: "DOWN", confidence: 1.0, type: "STRATEGY_1", taProb: indicators.adjustedDown, marketOdds: marketPrices.downPrice };
        }
    }

    // --- 策略 2: 抢跑套利 (Premium Arbitrage) ---
    // Binance 价格通常领先 Polymarket，但由于基准价差常期在 $15 左右，所以我们对比 EMA 寻找“异动”
    const { premiumEma } = context;
    if (spotPrice !== undefined && spotPrice !== null && livePrice !== null && premiumEma !== undefined && premiumEma !== null) {
        const premium = spotPrice - livePrice;

        // 瞬间爆发的 Spike (减去日常差价后的净溢价突增值)
        const premiumSpike = premium - premiumEma;

        // 当 Binance 突然向上暴拉 $15 以上，抢买 UP
        if (premiumSpike > 15) {
            return { side: "UP", confidence: 1.0, type: "STRATEGY_2_PREMIUM", taProb: indicators.adjustedUp, marketOdds: marketPrices.upPrice };
        }

        // 当 Binance 突然向下暴砸 $15 以上，抢买 DOWN
        if (premiumSpike < -15) {
            return { side: "DOWN", confidence: 1.0, type: "STRATEGY_2_PREMIUM", taProb: indicators.adjustedDown, marketOdds: marketPrices.downPrice };
        }
    }


    // 默认：保持原有的 Edge 策略
    const { adjustedUp, adjustedDown } = indicators;
    const { upPrice, downPrice } = marketPrices;
    const edgeUp = adjustedUp - upPrice;
    const edgeDown = adjustedDown - downPrice;

    // 提高对 Edge 策略的出手门槛，原来是 0.12，这意味着只要觉得有十几美分的盈亏比就进。
    // 在急涨急跌行情里，这会导致它像接飞刀一样。我们将门槛提高到 0.20。
    // 并且如果出现了极端的反向溢价突变（例如我们在暴跌 premiumSpike < -10），那就禁止做多 (UP)。
    // 反之，如果当前现货正在大举拉盘 (premiumSpike > 10)，那就禁止做空 (DOWN)。

    const spikeSafeForUp = context.premiumEma !== undefined ? (spotPrice - livePrice - context.premiumEma > -10) : true;
    const spikeSafeForDown = context.premiumEma !== undefined ? (spotPrice - livePrice - context.premiumEma < 10) : true;

    if (edgeUp > 0.20 && spikeSafeForUp) {
        return { side: "UP", confidence: edgeUp, type: "EDGE", taProb: adjustedUp, marketOdds: upPrice };
    }

    if (edgeDown > 0.20 && spikeSafeForDown) {
        return { side: "DOWN", confidence: edgeDown, type: "EDGE", taProb: adjustedDown, marketOdds: downPrice };
    }

    // 无足够优势，不交易
    return null;
}
