/**
 * signals.js — 信号层 (Signal Layer)
 * 
 * 基于 8-12 条细分规则对实时盘面进行切片打分。
 * 包括：CVD量差、Binance近期动量、预言机报价脱离度、订单簿 OBI、场内持仓比例。
 * 
 * 采用【加权独立投票模型(Weighted Ensemble)】:
 * 最终输出一个绝对方向 (UP/DOWN) 以及 0~1 的综合置信度。
 */

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

/**
 * 主入口 — 运行所有规则并返回综合信号
 * @param {Object} ctx 运行上下文
 * @returns {{ direction: string, confidence: number, ruleScores: Array }}
 */
export function runSignals(ctx) {
    const {
        cvd1m = 0, cvd5m = 0,
        mom30s = {}, mom60s = {},
        spotPrice = 0, priceToBeat = 0,
        obi = 0,
        upPrice = 0, downPrice = 0,
        oiDelta = 0,  // OI 净变化量 (BTC), 正=持仓扩张, 负=持仓收缩/爆仓
        natAbs = { type: 'NONE', strength: 0 },
        prior = { upProb: 0.5, downProb: 0.5, sampleCount: 0 }
    } = ctx;

    const rules = [];

    /**
     * 添加单条底层断言规则
     * @param {string} name 规则名
     * @param {number} direction 1 (UP), -1 (DOWN), 0 (Abstain)
     * @param {number} rawConfidence 强度 0.0 ~ 1.0
     * @param {number} weight 该规则在系统里的绝对话语权占比
     */
    function addRule(name, direction, rawConfidence, weight) {
        rules.push({
            rule: name,
            value: direction > 0 ? "UP" : direction < 0 ? "DOWN" : "NONE",
            contribution: (direction * clamp(rawConfidence, 0, 1) * weight).toFixed(3),
            vote: direction * clamp(rawConfidence, 0, 1),
            weight
        });
    }

    // ─── 模块 1: CVD 势能 (总权重 30%) ───
    // 逻辑：累计主动买卖量差是预测力最强的单一指标。
    // R1: 1分钟极短期流入 - 权重 18% (10 BTC 为满级)
    const cvd1mConf = clamp(Math.abs(cvd1m) / 10, 0, 1);
    addRule("R1_CVD1m", Math.sign(cvd1m), cvd1mConf, 0.18);
    // R2: 5分钟中期流入 - 权重 12% (20 BTC 为满级)
    const cvd5mConf = clamp(Math.abs(cvd5m) / 20, 0, 1);
    addRule("R2_CVD5m", Math.sign(cvd5m), cvd5mConf, 0.12);


    // ─── 模块 2: Binance 短期动量 (总权重 25%) ───
    // R3: 30s 极速动能 - 权重 15%
    const score30 = mom30s?.score || 0;
    addRule("R3_Mom30s", Math.sign(score30), Math.abs(score30) / 100, 0.15);
    // R4: 60s 延续动能 - 权重 10%
    const score60 = mom60s?.score || 0;
    addRule("R4_Mom60s", Math.sign(score60), Math.abs(score60) / 100, 0.10);


    // ─── 模块 3: 预言机现价脱离度 (总权重 20%) ───
    // 逻辑：现价如果不突破 PTB，一切都是空谈。距离 PTB 越远（超 30 刀）置信度越高。
    const dist = (spotPrice && priceToBeat) ? (spotPrice - priceToBeat) : 0;
    // R5 & R6: 直接用差值合成一条综合规则
    const distConf = clamp(Math.abs(dist) / 30, 0, 1);
    addRule("R5_OracleDist", Math.sign(dist), distConf, 0.20);


    // ─── 模块 4: 订单簿盘口失衡度 OBI (总权重 15%) ───
    // R7: OBI (-1 ~ +1) 倾斜
    const obiConf = Math.abs(obi || 0);
    addRule("R7_OBI", Math.sign(obi || 0), obiConf, 0.15);


    // ─── 模块 5: Polymarket 场内代币共识 (总权重 9%) ───
    // R8: Token 价差
    if (upPrice > 0 && downPrice > 0) {
        const priceDiff = upPrice - downPrice;
        const tokenConf = clamp(Math.abs(priceDiff) / 0.5, 0, 1);
        addRule("R8_TokenTrend", Math.sign(priceDiff), tokenConf, 0.09);
    } else {
        addRule("R8_TokenTrend", 0, 0, 0.09);
    }

    // ─── 模块 6: Natural Delta OI 验证 (总权重 11%) ───
    // 逻辑：区分「真实主动买盘」和「空头爆仓被动推升」
    //
    // 场景 1: CVD > 0 且 OI 增加   → 真实买盘涌入, 投 UP 高置信度
    // 场景 2: CVD > 0 但 OI 减少   → 空头平仓推升, 信号减弱 (投 0 = 弃权)
    // 场景 3: CVD < 0 且 OI 减少   → 多头爆仓踩踏, 投 DOWN 高置信度
    // 场景 4: CVD < 0 但 OI 增加   → 做空资金涌入, 投 DOWN 中置信度
    {
        const cvdDir = Math.sign(cvd1m);
        const oiDir  = Math.sign(oiDelta);
        const oiConf = clamp(Math.abs(oiDelta) / 80, 0, 1); // 修改: 满级从 300 缩紧至 80 BTC

        let r9Dir = 0;
        let r9Conf = 0;

        if (cvdDir === 1 && oiDir === 1) {
            // 真实买盘 + 新多头仓位建立 → 强 UP
            r9Dir = 1; r9Conf = oiConf;
        } else if (cvdDir === -1 && oiDir === -1) {
            // 真实卖盘 + 多头爆仓退出 → 强 DOWN
            r9Dir = -1; r9Conf = oiConf;
        } else if (cvdDir === 1 && oiDir === -1) {
            // 空头爆仓假上涨 → 投反向警告 (-1), 但置信度较低
            r9Dir = -1; r9Conf = oiConf * 0.6;
        } else if (cvdDir === -1 && oiDir === 1) {
            // 新空头涌入做空 → 投 DOWN, 中置信度
            r9Dir = -1; r9Conf = oiConf * 0.7;
        }
        
        // 修复：不让平常期微小的极化成为置信度的死权重分母
        const dynamicWeight = 0.11 * r9Conf;
        addRule("R9_NaturalDelta", r9Dir, 1.0, dynamicWeight);
    }
    
    // ─── 模块 7: Natural Absorption 逆向翻盘 (权重 12%) ───
    {
        const absConf = clamp(Math.abs(natAbs?.strength || 0) / 10, 0, 1); // 10 BTC 僵死吸收为满分
        const dynamicWeight = 0.12 * absConf; // 没有吸收墙时，0 权重
        
        if (natAbs?.type === 'BUY_WALL') {
            addRule("R10_NatAbs", 1, 1.0, dynamicWeight); // 底部买盘墙，强力投 UP
        } else if (natAbs?.type === 'SELL_WALL') {
            addRule("R10_NatAbs", -1, 1.0, dynamicWeight); // 顶部卖盘墙，强力投 DOWN
        } else {
            addRule("R10_NatAbs", 0, 0, 0); // 彻底消除 12% 的死权拖累！！
        }
    }

    // R11: Memory Layer Prior Bias (作为额外调制权重，不超过 100% 体系，但可独立加减分)
    // 如果想要纳入权重体系，可以按比例压缩上面，或者这里为了遵循严格的 100% 结构，将其融入基础打分。
    // 根据用户架构，Memory 层作为先验带入，这里我们不打破上方的物理指标权重。我们将 Memory 作为 baseline 微调。
    // 但是严格遵循用户“权重相加”模型，上方已分配 100% 权重。Memory 可以影响最终 confidence 的缩放。

    // ─── 汇 总统 计 ───
    let totalScore = 0;
    let totalWeight = 0;
    
    for (const r of rules) {
        totalScore += r.vote * r.weight;
        totalWeight += r.weight;
    }

    // 加入 Memory Bias 的加成 (在原有 100% 基础上，同向最多再加分，反向扣分)
    if (prior.sampleCount >= 15) {
        const priorBias = prior.upProb - 0.5; // -0.5 to +0.5
        totalScore += (priorBias * 0.1); // 最多影响 5% 绝对分数
    }

    // 赢家方向
    const direction = totalScore > 0 ? "UP" : totalScore < 0 ? "DOWN" : null;
    // 综合置信度 (0.0 ~ 1.0) -> 0 ~ 100
    const confidence = totalWeight > 0 ? Math.min(1.0, Math.abs(totalScore) / totalWeight) : 0;
    const confidencePct = Math.round(confidence * 100);

    return {
        direction,
        confidence: confidencePct,
        ruleScores: rules
    };
}
