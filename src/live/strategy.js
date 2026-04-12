/**
 * strategy.js — 三层策略主控 (Memory → Signal → Defense)
 *
 * 完全替代原来的硬编码 absGap + 价格范围判断。
 * 现在通过三层系统得出方向和仓位系数，由 trade.js 通过 context 注入所需数据。
 */

import { runSignals } from './signals.js';
import { calcDefenseMultiplier, calcActualShares } from './defense.js';
import { getPriorBias } from './memory.js';
import { LIVE_CONFIG } from './config.js';
import { logAction } from "./ui.js";

let lastBlockedReason = null;

/**
 * 用户自定义交易策略 — 三层版本
 *
 * @param {Object} indicators  TA 指标 { adjustedUp, adjustedDown }
 * @param {Object} marketPrices { upPrice, downPrice }
 * @param {Object} context     完整上下文，包括 trade.js 注入的新字段
 *
 * @returns {Object|null} { side, confidence, type, actualShares } 或 null
 */
export function myCustomStrategy(indicators, marketPrices, context) {
    const {
        timeLeft, spotPrice, priceToBeat,
        marketId, positions,
        // 新增字段 (由 trade.js 注入)
        crossCount = 0,
        upPriceSeries = [],
        upBestBid = null,
        downBestBid = null,
        klines1m = [],
        memoryFeatures = null,
        cvd1m = 0, cvd5m = 0,
        mom30s = {}, mom60s = {}, obi = 0,
        oiDelta = 0,  // OI 净变化量
        natAbs = { type: 'NONE', strength: 0 }
    } = context;

    // --- 方向锁 (Direction Lock) — 同一个窗口内只建一个方向 ---
    const hasAnyUp = positions && marketId && (
        (positions.get(`${marketId}@STRATEGY_MOMENTUM@UP`)?.shares > 0) ||
        (positions.get(`${marketId}@STRATEGY_LOTTO@UP`)?.shares > 0) ||
        (positions.get(`${marketId}@STRATEGY_3LAYER@UP`)?.shares > 0)
    );
    const hasAnyDown = positions && marketId && (
        (positions.get(`${marketId}@STRATEGY_MOMENTUM@DOWN`)?.shares > 0) ||
        (positions.get(`${marketId}@STRATEGY_LOTTO@DOWN`)?.shares > 0) ||
        (positions.get(`${marketId}@STRATEGY_3LAYER@DOWN`)?.shares > 0)
    );

    // 已经有仓位了，不重复开仓
    if (hasAnyUp && hasAnyDown) return null;

    // --- 时间过滤 ---
    // 仅在 2-12 分钟剩余时间窗口内考虑开仓 (太早信号不稳，太晚防御层会否决)
    if (timeLeft === null || timeLeft > 12 || timeLeft < 2) return null;

    // --- Layer 1: Memory Layer 先验 ---
    let prior = { upProb: 0.5, downProb: 0.5, sampleCount: 0 };
    if (memoryFeatures) {
        try {
            prior = getPriorBias(memoryFeatures);
        } catch (e) {
            // silent fallback
        }
    }

    // --- Layer 2: Signal Layer ---
    const signalCtx = {
        spotPrice, priceToBeat,
        upPrice: marketPrices.upPrice,
        downPrice: marketPrices.downPrice,
        upBestBid, downBestBid,
        klines1m, timeLeft,
        upPriceSeries, prior,
        crossCount,
        cvd1m, cvd5m, mom30s, mom60s, obi,
        oiDelta,  // Natural Delta OI 验证
        natAbs    // Natural Absorption 墙体
    };

    const signal = runSignals(signalCtx);

    // 没有明确方向信号
    if (!signal.direction) {
        if (signal.confidence > 0) {
            console.log(`[STRATEGY] No signal: confidence=${signal.confidence}%, reason=${signal.reason || 'below_threshold'}`);
        }
        return { blocked: true, reason: 'no_direction', signal };
    }

    // --- 方向锁检查 (信号确定后) ---
    if (signal.direction === 'UP' && hasAnyUp) return { blocked: true, reason: 'has_up_pos', signal };
    if (signal.direction === 'DOWN' && hasAnyDown) return { blocked: true, reason: 'has_down_pos', signal };

    // --- Layer 3: Defense Layer ---
    const defCtx = {
        spotPrice, priceToBeat, timeLeft, crossCount,
        upPrice: marketPrices.upPrice,
        downPrice: marketPrices.downPrice,
        cvd1m, cvd5m, // Pass cvd1m/cvd5m to defense context for F1 checking
        natAbs
    };
    const defense = calcDefenseMultiplier(signal, defCtx);

    if (defense.blocked) {
        if (defense.reason !== lastBlockedReason) {
            logAction(`[DEFENSE VETO] Trade Blocked: ${defense.reason}`, "warn");
            lastBlockedReason = defense.reason;
        }
        return { blocked: true, reason: defense.reason, signal, defenseMultiplier: defense.multiplier };
    } else {
        lastBlockedReason = null; // reset if a clean signal passes
    }

    const actualShares = calcActualShares(LIVE_CONFIG.tradeSizeShares, defense.multiplier);
    if (actualShares === 0) {
        console.log(`[STRATEGY] actualShares=0 after defense (multiplier=${defense.multiplier})`);
        return { blocked: true, reason: 'shares_zero', signal, defenseMultiplier: defense.multiplier };
    }

    // 打印决策摘要
    console.log(
        `[STRATEGY] 📡 Signal: ${signal.direction} @ ${signal.confidence}% confidence | ` +
        `Defense: ${(defense.multiplier * 100).toFixed(0)}% | actualShares: ${actualShares} | ` +
        `${defense.reason ? '⚠️ ' + defense.reason : '✅ clean'}`
    );

    return {
        side: signal.direction,
        confidence: signal.confidence,
        type: 'STRATEGY_3LAYER',
        actualShares,      // 传给 executor 使用
        taProb: signal.direction === 'UP' ? indicators.adjustedUp : indicators.adjustedDown,
        marketOdds: signal.direction === 'UP' ? marketPrices.upPrice : marketPrices.downPrice,
        defenseMultiplier: defense.multiplier,
        ruleScores: signal.ruleScores,
    };
}
