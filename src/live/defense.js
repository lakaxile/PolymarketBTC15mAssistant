/**
 * defense.js — 防御层 (Defense Layer)
 * 
 * 包含的六大防御因子：
 * 1. CVD 否决/压缩：Signal方向必须拥有 CVD 净势能的支撑（在混乱期一票否决）。
 * 2. 距离压缩：现价和 PTB 咬得太紧时，压缩仓位防范随机跳动反杀。
 * 3. 时间剥夺风险：最后 3 分钟内避险窗口几乎关闭，极度压缩仓位。
 * 4. 市场混乱度 (Chaos)：当前 session 预言机现价反复穿越 PTB 超过 5 次，激进缩仓。
 * 5. 利润空间高压线：入场价与置信度分级匹配，高价区强制拦截。
 * 6. DOWN 方向中低置信度高价保护：40%-60% conf 的 DOWN 单价格必须 ≤ $0.65。
 *
 * 全局规则：
 * - 置信度 < 30% → 一票否决（数据回测亏损 900u+）
 * - 入场价 > $0.70 → 一票否决（高价赔率陷阱，$0.70+ 区间总亏 -300u+）
 */

/**
 * 计算防御层系数
 *
 * @param {Object} signal  来自信号层: { direction: 'UP'|'DOWN', confidence: 0-100 }
 * @param {Object} ctx     市场上下文 (含 cvd1m)
 * @returns {{ multiplier: number, factors: Object, blocked: boolean, reason: string|null }}
 */
export function calcDefenseMultiplier(signal, ctx) {
    const { direction, confidence } = signal;
    const { spotPrice, priceToBeat, timeLeft, crossCount = 0, upPrice, downPrice, cvd1m = 0, natAbs = null } = ctx;

    const factors = {};
    let reasons = [];
    let multiplier = 1.0;

    if (!direction) {
        return { multiplier: 0, factors, blocked: true, reason: 'no_signal_direction' };
    }

    // --- 全局前置过滤 1: 置信度过低 ---
    // 数据回测：0%-10% 挡位 163 笔亏损 -902u，直接切断。
    if (confidence < 30) {
        return { multiplier: 0, factors, blocked: true, reason: 'conf_too_low(<30%)' };
    }

    // --- 全局前置过滤 2: 分级入场价拦截 (Combined Tiered Veto) ---
    // Tier 1: 置信度 < 50% -> 价格上限 $0.55
    // Tier 2: 置信度 >= 50% -> 价格上限 $0.70 (全局最高上限)
    const entryPriceEarly = direction === 'UP' ? upPrice : downPrice;
    if (entryPriceEarly) {
        if (confidence < 50 && entryPriceEarly > 0.55) {
            return { multiplier: 0, factors, blocked: true, reason: `tier1_price_veto(conf<50% & price>${entryPriceEarly.toFixed(2)})` };
        }
        if (confidence >= 50 && entryPriceEarly > 0.70) {
            return { multiplier: 0, factors, blocked: true, reason: `tier2_price_veto(conf>=50% & price>${entryPriceEarly.toFixed(2)})` };
        }
    }

    // --- DOWN 方向专用专项保护: 30%-60% 置信度时，价格上限收紧至 $0.65 ---
    // 这会在上述全局规则基础上，对 DOWN 方向做进一步价格压缩。
    if (direction === 'DOWN' && confidence >= 30 && confidence < 60) {
        if (entryPriceEarly && entryPriceEarly > 0.65) {
            return { multiplier: 0, factors, blocked: true, reason: `down_special_ban(conf=${confidence}%,price=${entryPriceEarly.toFixed(2)}>0.65)` };
        }
    }

    // --- F1: CVD 同意度 (CVD Agreement Factor) ---
    // 如果方向是 UP，但 Binance CVD 出现净卖出 (CVD < -2)
    factors.F1 = 1.0;
    if (direction === "UP" && cvd1m < -2) {
        if (crossCount >= 5) {
            return { multiplier: 0, factors, blocked: true, reason: 'cvd_veto_up_in_chaos' };
        } else {
            factors.F1 = 0.5; // 不混乱时温和减半
            reasons.push('cvd_disagree_up');
        }
    } else if (direction === "DOWN" && cvd1m > 2) {
        if (crossCount >= 5) {
            return { multiplier: 0, factors, blocked: true, reason: 'cvd_veto_down_in_chaos' };
        } else {
            factors.F1 = 0.5;
            reasons.push('cvd_disagree_down');
        }
    }
    multiplier *= factors.F1;

    // --- F2: 距离基准价格 (Distance to PTB Compression) ---
    factors.F2 = 1.0;
    if (spotPrice && priceToBeat) {
        const dist = Math.abs(spotPrice - priceToBeat);
        if (dist < 15) {
            factors.F2 = 0.3; // 咬得太紧，激进压缩
            reasons.push(`gap_critical(${dist.toFixed(1)})`);
        } else if (dist < 30) {
            factors.F2 = 0.6; // 温和压缩
        }
    }
    multiplier *= factors.F2;

    // --- F3: 时间剥夺风险 (Time Decay Factor - HARD BAN) ---
    // 根据数据回测，70% 以上的爆仓和大幅折损发生于 15m 窗口的最后 3 分钟天价期。
    // 因此在最后 3.0 分钟内 (timeLeft <= 3.0)，强制一票否决所有建仓动作，安全度过结算期。
    factors.F3 = 1.0;
    if (timeLeft !== null && timeLeft <= 3.0) {
        return { multiplier: 0, factors, blocked: true, reason: 'time_veto_ban(<=3m)' };
    }

    // --- F4: 市场混乱度 (Cross Count Chaos) ---
    factors.F4 = 1.0;
    if (crossCount >= 5) {
        return { multiplier: 0, factors, blocked: true, reason: `chaos_veto(cross>=${crossCount})` };
    } else if (crossCount >= 3) {
        factors.F4 = 0.8; // 打8折
    }
    multiplier *= factors.F4;

    // --- F5: 入场价动态风险压缩 (Risk Scaling) ---
    // 注意：$0.70 以上已在全局前置过滤 2 中 hard ban，此处无需重复分级拦截。
    // 仅保留 $0.50-$0.70 区间的动态仓位压缩逻辑。
    factors.F5 = 1.0;
    const entryPrice = direction === "UP" ? upPrice : downPrice;
    if (entryPrice) {

        // 动态比例压缩 (Risk-Based Scaling)
        // $0.65~$0.70 区间仍允许进入，但主动缩仓控制风险。
        if (entryPrice > 0.65) {
            const riskScale = Math.max(0.6, 1.0 - (entryPrice - 0.65) * 2);
            factors.F5 *= riskScale;
            reasons.push(`risk_scale(${riskScale.toFixed(2)}x)`);
        }

        // 奖励区间: $0.20 ~ $0.50 黄金位 (赔率极佳，数据验证 $0.5-$0.6 总盈 +864u)
        if (entryPrice <= 0.50 && confidence > 30) {
            factors.F5 *= 1.25; // 放大 25% 仓位
        }
    }
    multiplier *= factors.F5;

    // --- F6: Natural Absorption 逆向墙体制衡 ---
    // 按用户要求：不直接归0一票否决，而是适度降低下单额度 (降至 0.5 倍)
    factors.F6 = 1.0;
    if (direction === "UP" && natAbs?.type === "SELL_WALL") {
        factors.F6 = 0.5;
        reasons.push('natabs_sell_wall(0.5x)');
    } else if (direction === "DOWN" && natAbs?.type === "BUY_WALL") {
        factors.F6 = 0.5;
        reasons.push('natabs_buy_wall(0.5x)');
    }
    multiplier *= factors.F6;

    multiplier = Math.max(0, Math.min(1.0, multiplier));

    return {
        multiplier: parseFloat(multiplier.toFixed(2)),
        factors,
        blocked: multiplier === 0,
        reason: reasons.length > 0 ? reasons.join(', ') : null,
    };
}

/**
 * 根据防御系数和配置，计算实际下单份数
 * @param {number} baseShares  配置中的基础份数 (tradeSizeShares)
 * @param {number} multiplier  防御层输出的系数 0-1
 * @param {number} minShares   最小可下单份数 (默认 5，低于此值不下单)
 * @returns {number} 实际下单份数，0 表示不下单
 */
export function calcActualShares(baseShares, multiplier, minShares = 5) {
    const raw = Math.round(baseShares * multiplier);
    return raw >= minShares ? raw : 0;
}
