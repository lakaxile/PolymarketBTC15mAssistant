/**
 * memory.js — 历史窗口记忆层 (Memory Layer)
 *
 * 功能:
 *  1. 在每个窗口结束时，将该窗口的特征 + 结果追加到 logs/window_history.json
 *  2. 在新窗口开始时，扫描历史找到最相近的 N 个窗口，推导先验 UP/DOWN 概率
 *
 * 特征向量维度:
 *  - openDevPct   : 开盘时现货价格偏离 PTB 的百分比  (spot-ptb)/ptb
 *  - volRegime    : 0=低波动, 1=中波动, 2=高波动 (用 ATR 估算)
 *  - binanceMom   : -1=下跌动量, 0=平, 1=上涨动量
 *  - upOddsOpen   : 开盘时 UP 合约的盘口价格
 */

import fs from 'fs';
import path from 'path';

const HISTORY_FILE = './logs/window_history.json';
const MAX_HISTORY = 500; // 最多保留最近 500 个窗口
const MIN_SAMPLE = 15;   // 少于此样本数时，先验退回 50/50

/** 加载历史数据 */
function loadHistory() {
    try {
        if (!fs.existsSync(HISTORY_FILE)) return [];
        const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

/** 保存历史数据 */
function saveHistory(history) {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-MAX_HISTORY)), 'utf-8');
    } catch (e) {
        console.warn('[MEMORY] Failed to save window history:', e.message);
    }
}

/**
 * 追加一个已完成窗口的记录
 * @param {Object} features { openDevPct, volRegime, binanceMom, upOddsOpen }
 * @param {string} result  'UP' | 'DOWN'  (窗口最终结果)
 */
export function recordWindow(features, result) {
    if (!features || !result) return;
    const history = loadHistory();
    history.push({ ...features, result, ts: Date.now() });
    saveHistory(history);
    console.log(`[MEMORY] Recorded window: ${JSON.stringify(features)} → ${result}. Total: ${history.length}`);
}

/**
 * 计算两个特征向量之间的加权欧氏距离
 */
function distance(a, b) {
    // 权重: openDevPct 最重要, binanceMom 次之
    const w = { openDevPct: 2.0, volRegime: 0.5, binanceMom: 1.0, upOddsOpen: 1.0 };
    let sum = 0;
    for (const k of Object.keys(w)) {
        const diff = (a[k] ?? 0) - (b[k] ?? 0);
        sum += w[k] * diff * diff;
    }
    return Math.sqrt(sum);
}

/**
 * 根据当前窗口特征，推导先验 UP/DOWN 概率
 * @param {Object} currentFeatures { openDevPct, volRegime, binanceMom, upOddsOpen }
 * @param {number} topK 使用最相近的 K 个历史窗口
 * @returns {{ upProb: number, downProb: number, sampleCount: number }}
 */
export function getPriorBias(currentFeatures, topK = 10) {
    const history = loadHistory();

    if (history.length < MIN_SAMPLE) {
        return { upProb: 0.5, downProb: 0.5, sampleCount: history.length };
    }

    // 计算每条历史数据与当前特征的距离
    const scored = history
        .filter(h => h.result === 'UP' || h.result === 'DOWN')
        .map(h => ({ ...h, dist: distance(currentFeatures, h) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, topK);

    if (scored.length === 0) return { upProb: 0.5, downProb: 0.5, sampleCount: 0 };

    // 用 inverse-distance 加权
    const eps = 1e-6;
    let upWeight = 0, totalWeight = 0;
    for (const s of scored) {
        const w = 1 / (s.dist + eps);
        if (s.result === 'UP') upWeight += w;
        totalWeight += w;
    }

    const upProb = totalWeight > 0 ? upWeight / totalWeight : 0.5;
    return {
        upProb: parseFloat(upProb.toFixed(3)),
        downProb: parseFloat((1 - upProb).toFixed(3)),
        sampleCount: history.length,
    };
}

/**
 * 计算波动率区间 (0=低, 1=中, 2=高)
 * 基于最近 klines 的 ATR 估算
 * @param {Array} klines1m  最近1分钟K线数组，每个元素有 {high, low, close}
 */
export function calcVolRegime(klines1m) {
    if (!klines1m || klines1m.length < 5) return 1;
    const recent = klines1m.slice(-10);
    const atr = recent.reduce((sum, k) => sum + (k.high - k.low), 0) / recent.length;
    const refClose = recent[recent.length - 1].close || 1;
    const atrPct = atr / refClose;
    if (atrPct < 0.0005) return 0; // <0.05% 低波动
    if (atrPct > 0.002) return 2;  // >0.2% 高波动
    return 1;
}

/**
 * 计算 Binance 动量方向 (-1/0/1)
 * 简单地看最近 5 根 1m 蜡烛的涨跌方向
 */
export function calcBinanceMom(klines1m) {
    if (!klines1m || klines1m.length < 5) return 0;
    const recent = klines1m.slice(-5);
    const first = recent[0].close;
    const last = recent[recent.length - 1].close;
    if (!first || !last) return 0;
    const changePct = (last - first) / first;
    if (changePct > 0.001) return 1;
    if (changePct < -0.001) return -1;
    return 0;
}
