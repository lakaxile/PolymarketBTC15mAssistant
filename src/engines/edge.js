import { clamp } from "../utils.js";

/**
 * 计算模型概率与市场概率之间的“优势”（Edge）
 * @param {Object} params 输入参数
 * @param {number} params.modelUp 模型预测涨的概率
 * @param {number} params.modelDown 模型预测跌的概率
 * @param {number} params.marketYes 市场 YES（看涨）价格
 * @param {number} params.marketNo 市场 NO（看跌）价格
 * @returns {Object} 包含市场概率和优势值
 */
export function computeEdge({ modelUp, modelDown, marketYes, marketNo }) {
  if (marketYes === null || marketNo === null) {
    return { marketUp: null, marketDown: null, edgeUp: null, edgeDown: null };
  }

  const sum = marketYes + marketNo;
  const marketUp = sum > 0 ? marketYes / sum : null;
  const marketDown = sum > 0 ? marketNo / sum : null;

  // 优势 = 模型预测概率 - 市场隐含概率
  const edgeUp = marketUp === null ? null : modelUp - marketUp;
  const edgeDown = marketDown === null ? null : modelDown - marketDown;

  return {
    marketUp: marketUp === null ? null : clamp(marketUp, 0, 1),
    marketDown: marketDown === null ? null : clamp(marketDown, 0, 1),
    edgeUp,
    edgeDown
  };
}

/**
 * 根据剩余时间、优势值等决定交易动作
 * @returns {Object} 交易决策结果（ENTER 或 NO_TRADE）
 */
export function decide({ remainingMinutes, edgeUp, edgeDown, modelUp = null, modelDown = null }) {
  // 根据剩余时间划分阶段（早期、中期、晚期）
  const phase = remainingMinutes > 10 ? "EARLY" : remainingMinutes > 5 ? "MID" : "LATE";

  // 不同阶段对应不同的优势阈值和最低概率要求
  const threshold = phase === "EARLY" ? 0.05 : phase === "MID" ? 0.1 : 0.2;
  const minProb = phase === "EARLY" ? 0.55 : phase === "MID" ? 0.6 : 0.65;

  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data" };
  }

  // 选择优势较大的一侧
  const bestSide = edgeUp > edgeDown ? "UP" : "DOWN";
  const bestEdge = bestSide === "UP" ? edgeUp : edgeDown;
  const bestModel = bestSide === "UP" ? modelUp : modelDown;

  // 如果优势不足，不交易
  if (bestEdge < threshold) {
    return { action: "NO_TRADE", side: null, phase, reason: `edge_below_${threshold}` };
  }

  // 如果模型预测概率不足，不交易
  if (bestModel !== null && bestModel < minProb) {
    return { action: "NO_TRADE", side: null, phase, reason: `prob_below_${minProb}` };
  }

  // 根据优势大小判断交易强度
  const strength = bestEdge >= 0.2 ? "STRONG" : bestEdge >= 0.1 ? "GOOD" : "OPTIONAL";
  return { action: "ENTER", side: bestSide, phase, strength, edge: bestEdge };
}

