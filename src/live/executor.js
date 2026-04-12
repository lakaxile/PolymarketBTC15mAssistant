import { placeLimitOrder, cancelOrdersForToken } from "./clob.js";
import { LIVE_CONFIG } from "./config.js";
import { sendTelegramMessage } from "../utils/telegram.js";
import { logAction } from "./ui.js";

function execLog(msg, level="info") {
    let cleanMsg = msg.replace("[EXEC] ", "");
    if (cleanMsg.includes("✅") || cleanMsg.includes("🟢") || cleanMsg.includes("SUCCESS")) level = "success";
    else if (cleanMsg.includes("🔴") || cleanMsg.includes(" Failed")) level = "error";
    else if (cleanMsg.includes("⛔") || cleanMsg.includes("⚠️") || cleanMsg.includes("Skip") || cleanMsg.includes("🟡")) level = "warn";
    
    logAction(cleanMsg, level);
}

/**
 * 实盘执行引擎：
 * 将策略信号转化为 CLOB 上的限价单操作。
 */
export class LiveExecutor {
    constructor(positionManager) {
        this.pm = positionManager;
        this.pendingEntries = new Set(); // 正在飞行的建仓请求，防止并发超募
        this.pendingScalps = new Set(); // 正在飞行的平仓请求，防止并发超募
        this.lastEntryTimes = new Map(); // 防连发冷却机制 (Cooldown)
    }

    /**
     * 进入新仓位 (支持深度优先逻辑)
     * @param {string} marketId 市场 ID
     * @param {string} side "UP" 或 "DOWN"
     * @param {string} tokenID 目标代币的 Clob Token ID
     * @param {number} expectedPrice 预期的买入单价 (信号价格)
     * @param {string} strategyType 触发的策略名称
     * @param {object} orderbook 该 Token 的当前订单簿摘要 (由 fetchPolymarketSnapshot 提供)
     */
    async executeEntry(marketId, side, tokenID, expectedPrice, strategyType, orderbook = null, actualShares = null) {
        const lockKey = `${marketId}@${strategyType}@${side}`;
        if (this.pendingEntries.has(lockKey)) return;

        // --- 连发限制 (Cooldown 防御) ---
        // 限制同一个策略在极短时间内连续满仓，增加 30 秒的缓冲期。
        const now = Date.now();
        const lastEntryTime = this.lastEntryTimes.get(lockKey) || 0;
        if (now - lastEntryTime < 30000) {
            return; // 暂处于冷却期，静默忽略重复建仓信号
        }

        this.pendingEntries.add(lockKey);

        try {
            // 0. ⚡ 全局方向性总仓位硬上限检查 (最高优先级)
            // 跨所有策略，只要该方向累计持仓 >= maxSharesPerMarket，立即拒绝任何新建仓
            const totalBySide = this.pm.getTotalSharesBySide(marketId, side);
            const size = actualShares ?? LIVE_CONFIG.tradeSizeShares;
            if (totalBySide + size > LIVE_CONFIG.maxSharesPerMarket) {
                execLog(`[EXEC] ⛔ Skip entry: Global ${side} cap reached. Total ${side} shares across all strategies: ${totalBySide.toFixed(2)} + ${size} > ${LIVE_CONFIG.maxSharesPerMarket}.`);
                return;
            }

            // 1. 防御检查：是否已经达到该策略的仓位上限 或 反向追高
            const existingPos = this.pm.getPosition(marketId, side, strategyType);

            if (existingPos && existingPos.shares > 0) {
                // 检查：加上即将买入的份额后，是否会突破该策略的额度上限
                if (existingPos.shares + size > LIVE_CONFIG.maxSharesPerMarket) {
                    execLog(`[EXEC] Skip entry: Max strategy exposure reached (${existingPos.shares} + ${size} > ${LIVE_CONFIG.maxSharesPerMarket}) for ${strategyType}.`);
                    return;
                }

                // 检查：如果已经触发过部分止盈（进入了零成本安全期），坚决不再加仓破坏成本
                if (existingPos.hasReducedPosition) {
                    execLog(`[EXEC] Skip entry: Position already partially scalped for ${strategyType}. Holding free ride shares securely.`);
                    return;
                }

                // 检查逻辑 (用户需求)：如果同策略的第一单已经进场，除非新信号价格比我们目前的均价更低(便宜)，否则不予补仓
                if (expectedPrice >= existingPos.averagePrice) {
                    execLog(`[EXEC] Skip entry: Anti-chase triggered. New signal price $${expectedPrice} is NOT better than current average $${existingPos.averagePrice.toFixed(3)}.`);
                    return;
                }
            }

            // 2. 价格天花板检查：防止在高价位 (如 0.99) 建仓，导致盈亏比极差且容易陷入秒买秒卖的死循环 // Remove the maxEntryPrice check because STRATEGY_MOMENTUM now intentionally buys up to 0.85

            // 3. 动态流动性检测 (深度优先策略)
            // 如果提供了订单簿，我们尝试扫描前三档，找到深度最厚且价格尚可的一档去撞单。
            let executionPrice = expectedPrice;
            if (orderbook && orderbook.topAsks && orderbook.topAsks.length > 0) {
                // 买入时看 Asks (卖方挂单)
                executionPrice = this.pickBestExecutionPrice(orderbook.topAsks, size, "BUY", expectedPrice);
            }

            // ⛔ 二次价格确认：防止深度不足时爬升到高价档位
            // 如果最终执行价比策略信号价格高出 25% 以上，说明市场流动性在信号触发和订单提交之间已经干涸。
            // 直接取消下单，避免用彩票策略 (信号触发于 0.20¢) 的逻辑去成交一个 0.55¢ 的高价单，
            // 彻底破坏策略的赔率数学模型。
            if (executionPrice > expectedPrice * 1.25) {
                execLog(`[EXEC] ⛔ Price Sanity Check FAILED for ${strategyType}: Execution price ${executionPrice.toFixed(3)} is ${((executionPrice / expectedPrice - 1) * 100).toFixed(0)}% above signal price ${expectedPrice.toFixed(3)}. Aborting to protect bet odds.`);
                return false;
            }

            execLog(`[EXEC] Submitting IOC Buy Order | Strategy: ${strategyType} | Side: ${side} | TargetPrice: ${expectedPrice} | ExecPrice: ${executionPrice} | Size: ${size}`);

            // 4. 执行下单前：清扫该 Token 所有的历史残留挂单，防止超出 15 份的整体风险敞口
            if (!LIVE_CONFIG.isDryRun) {
                await cancelOrdersForToken(tokenID);
            }

            const startTime = Date.now();
            // 买入通常使用 FOK (Fill-Or-Kill)，保证要么全买，要么不买
            const response = await placeLimitOrder(tokenID, "BUY", executionPrice, size, "IOC");
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);

            execLog(`[EXEC] Order API responded in ${duration}s`);

            if (response && response.success) {
                const matchedShares = response.sizeMatched || 0;

                if (matchedShares > 0) {
                    // 优先使用链上返回的真实成交均价 (response.fillPrice)，
                    // 如果链上暂时还没回传 (数据延迟)，则回退到我们提交的挂单价 executionPrice。
                    const actualFillPrice = response.fillPrice ?? executionPrice;

                    if (response.fillPrice) {
                        execLog(`[EXEC] ✅ On-chain fill price confirmed: $${response.fillPrice.toFixed(4)} (submitted: $${executionPrice.toFixed(4)})`);
                    } else {
                        execLog(`[EXEC] ⚠️ On-chain avg_price not yet available. Using submitted price $${executionPrice.toFixed(4)} as estimate.`);
                    }

                    // 记录到本地状态机，使用链上实际成交价作为成本基础
                    this.pm.recordEntry(marketId, side, tokenID, actualFillPrice, matchedShares, strategyType);

                    // 立即触发一次链上同步，消除 30s 盲区
                    // (不 await，不阻塞主流程，后台默默跑)
                    this.pm.syncWithClob(null).catch(e => console.warn("[EXEC] Post-fill sync failed:", e.message));

                    // 记录成功建仓冷却期 (30 秒)
                    this.lastEntryTimes.set(lockKey, Date.now());

                    // Telegram 推送 (显示链上真实成交价)
                    const fillPriceStr = response.fillPrice ? `$${response.fillPrice.toFixed(4)} ✅ (链上确认)` : `$${executionPrice.toFixed(4)} ⏳ (待链上确认)`;
                    sendTelegramMessage(`🚀 *建仓提醒* [${strategyType}]\n市场: \`${marketId}\`\n方向: *${side}*\n信号价: \`$${expectedPrice.toFixed(4)}\`\n成交价: \`${fillPriceStr}\`\n份数: \`${matchedShares}\` ${matchedShares < size ? '(部分成交)' : ''}`);
                    return true;
                } else {
                    execLog(`[EXEC] 🔴 Entry Failed: FOK/IOC placed, but 0 shares matched (Slippage or liquidity dried up).`);
                    this.lastEntryTimes.set(lockKey, Date.now() - 25000); // 惩罚短重试时间
                    return false;
                }
            } else {
                execLog(`[EXEC] 🔴 Entry Failed: API Error or timeout.`);
                this.lastEntryTimes.set(lockKey, Date.now() - 25000);
                return false;
            }
        } finally {
            this.pendingEntries.delete(lockKey);
        }
    }

    /**
     * 极速套利 (剥头皮) 离场
     * @param {string} marketId 
     * @param {string} strategyType 
     * @param {number} currentBid 信号参考价
     * @param {object} orderbook 当前订单簿摘要
     */
    async executeScalp(marketId, side, strategyType, currentBid, orderbook = null) {
        const lockKey = `${marketId}@${strategyType}@${side}_FULL`;
        if (this.pendingScalps.has(lockKey)) return false;
        this.pendingScalps.add(lockKey);

        try {
            const pos = this.pm.getPosition(marketId, side, strategyType);
            if (!pos || pos.shares <= 0) return false;

            let sellShares = pos.shares;
            let borrowedFrom = [];

            if (sellShares < 5) {
                let availableToBorrow = 0;
                const candidates = [];
                for (const [key, p] of this.pm.positions.entries()) {
                    if (p.marketId === marketId && p.side === pos.side && p.strategyType !== strategyType && !p.isSettling && !p.isDead) {
                        candidates.push(p);
                        availableToBorrow += p.shares;
                    }
                }

                if (availableToBorrow + sellShares < 5) {
                    if (pos.shares > 0) {
                        execLog(`[EXEC] 🔴 Full Scalp Failed: Pos has ${pos.shares.toFixed(4)} shares. Borrowable: ${availableToBorrow.toFixed(4)}. Total < 5.`);
                    }
                    return false;
                }

                const requiredBorrow = 5 - sellShares;
                sellShares = 5;

                let needed = requiredBorrow;
                for (const p of candidates) {
                    if (needed <= 0.0001) break;
                    const take = Math.min(needed, p.shares);
                    borrowedFrom.push({ strategyType: p.strategyType, side: p.side, taken: take });
                    needed -= take;
                }
                execLog(`[EXEC] 🤝 Borrowing ${requiredBorrow.toFixed(4)} shares from other strategies to meet minimum order size.`);
            }

            // 动态选择卖出价 (深度优先)
            let executionPrice = currentBid;
            if (orderbook && orderbook.topBids && orderbook.topBids.length > 0) {
                // 卖出时看 Bids (买方挂单)
                executionPrice = this.pickBestExecutionPrice(orderbook.topBids, pos.shares, "SELL", currentBid);
            }

            execLog(`[EXEC] Submitting IOC Scalp Sell | Strategy: ${strategyType} | TargetPrice: ${currentBid} | ExecPrice: ${executionPrice} | Size: ${sellShares}`);

            // 执行卖单：使用 IOC (Immediate-Or-Cancel) 模式，能成交多少是多少，增强成交率
            const response = await placeLimitOrder(pos.tokenID, "SELL", executionPrice, sellShares, "IOC");

            if (response && response.success) {
                const matchedShares = response.sizeMatched || 0;

                if (matchedShares > 0) {
                    let actualPosSold = Math.min(pos.shares, matchedShares);
                    let borrowedSold = matchedShares - actualPosSold;

                    if (actualPosSold >= pos.shares - 0.0001) {
                        const profit = (currentBid * pos.shares) - pos.totalCost;
                        const profitPct = pos.totalCost > 0 ? ((currentBid / pos.averagePrice) - 1) * 100 : 0;
                        execLog(`[EXEC] 🟢 SCALP SUCCESS! | Profit: $${profit.toFixed(2)} | Pct: ${profitPct.toFixed(2)}%`);
                        this.pm.recordExit(marketId, pos.side, strategyType);
                        sendTelegramMessage(`💰 *全仓止盈* [${strategyType}]\n市场: \`${marketId}\`\n卖出价: \`$${currentBid}\`\n持仓量: \`${pos.shares.toFixed(2)}\`\n盈利: *+$${profit.toFixed(2)}* (${profitPct.toFixed(2)}%)`);
                    } else {
                        execLog(`[EXEC] 🟡 PARTIAL SCALP (Due to liquidity)! Matched ${actualPosSold.toFixed(2)} out of ${pos.shares.toFixed(2)}`);
                        this.pm.recordPartialExit(marketId, pos.side, strategyType, actualPosSold, currentBid);
                    }

                    if (borrowedSold > 0) {
                        execLog(`[EXEC] 🤝 Deducting ${borrowedSold.toFixed(4)} borrowed shares from secondary strategies...`);
                        for (const b of borrowedFrom) {
                            if (borrowedSold <= 0.0001) break;
                            let take = Math.min(b.taken, borrowedSold);
                            const bp = this.pm.getPosition(marketId, b.side, b.strategyType);
                            if (bp) {
                                if (take >= bp.shares - 0.0001) {
                                    this.pm.recordExit(marketId, b.side, b.strategyType);
                                } else {
                                    this.pm.recordPartialExit(marketId, b.side, b.strategyType, take, currentBid);
                                }
                            }
                            borrowedSold -= take;
                        }
                    }
                    return actualPosSold;
                } else {
                    execLog(`[EXEC] 🔴 Scalp Failed: IOC created but 0 shares matched (Slippage / Ghost Liquidity).`);
                    return false;
                }
            } else {
                execLog(`[EXEC] 🔴 Scalp Failed: API rejected order.`);
                return false;
            }
        } finally {
            this.pendingScalps.delete(lockKey);
        }
    }

    /**
     * 部分止盈套利 (分层风控)
     * @param {string} marketId 
     * @param {string} strategyType 
     * @param {number} currentBid 卖出价格
     * @param {number} fraction 卖出比例 (0~1，例如 0.5 就是卖一半)
     * @param {object} orderbook 当前订单簿摘要
     */
    async executePartialScalp(marketId, side, strategyType, currentBid, fraction, orderbook = null) {
        const lockKey = `${marketId}@${strategyType}@${side}_PARTIAL`;
        if (this.pendingScalps.has(lockKey)) return false;
        this.pendingScalps.add(lockKey);

        try {
            const pos = this.pm.getPosition(marketId, side, strategyType);
            if (!pos || pos.shares <= 0 || fraction <= 0 || fraction >= 1) return false;

            let sellShares = Math.floor(pos.shares * fraction);
            let borrowedFrom = [];

            if (sellShares < 5) {
                let availableToBorrow = 0;
                const candidates = [];
                for (const [key, p] of this.pm.positions.entries()) {
                    if (p.marketId === marketId && p.side === pos.side && p.strategyType !== strategyType && !p.isSettling && !p.isDead) {
                        candidates.push(p);
                        availableToBorrow += p.shares;
                    }
                }

                if (availableToBorrow + sellShares < 5) {
                    execLog(`[EXEC] 🔴 Partial Scalp Failed: Target ${sellShares} shares. Borrowable: ${availableToBorrow.toFixed(4)}. Total < 5.`);
                    return false;
                }

                const requiredBorrow = 5 - sellShares;
                sellShares = 5;

                let needed = requiredBorrow;
                for (const p of candidates) {
                    if (needed <= 0.0001) break;
                    const take = Math.min(needed, p.shares);
                    borrowedFrom.push({ strategyType: p.strategyType, side: p.side, taken: take });
                    needed -= take;
                }
                execLog(`[EXEC] 🤝 Borrowing ${requiredBorrow.toFixed(4)} shares from other strategies for Partial Scalp.`);
            }

            // 动态选择部分卖出价 (深度优先)
            let executionPrice = currentBid;
            if (orderbook && orderbook.topBids && orderbook.topBids.length > 0) {
                executionPrice = this.pickBestExecutionPrice(orderbook.topBids, sellShares, "SELL", currentBid);
            }

            execLog(`[EXEC] Submitting IOC Partial Sell (${fraction * 100}%) | Strategy: ${strategyType} | TargetPrice: ${currentBid} | ExecPrice: ${executionPrice} | Size: ${sellShares}/${pos.shares}`);

            const response = await placeLimitOrder(pos.tokenID, "SELL", executionPrice, sellShares, "IOC");

            if (response && response.success) {
                const matchedShares = response.sizeMatched || 0;

                if (matchedShares > 0) {
                    let actualPosSold = Math.floor(pos.shares * fraction);
                    actualPosSold = Math.min(actualPosSold, matchedShares);
                    let borrowedSold = matchedShares - actualPosSold;

                    // 卖出成功
                    const costBasis = pos.averagePrice * actualPosSold;
                    const realizedProfit = (currentBid * actualPosSold) - costBasis;
                    this.pm.recordPartialExit(marketId, pos.side, strategyType, actualPosSold, currentBid);

                    execLog(`[EXEC] 🟢 PARTIAL SCALP SUCCESS! | Realized Profit: $${realizedProfit.toFixed(2)}`);
                    sendTelegramMessage(`🔪 *部分止盈* [${strategyType}]\n市场: \`${marketId}\`\n卖出价: \`$${currentBid}\`\n已卖出份数: \`${actualPosSold.toFixed(2)}\` / ${pos.shares.toFixed(2)}\n当前锁定盈利: *+$${realizedProfit.toFixed(2)}*`);

                    if (borrowedSold > 0) {
                        execLog(`[EXEC] 🤝 Deducting ${borrowedSold.toFixed(4)} borrowed shares from secondary strategies...`);
                        for (const b of borrowedFrom) {
                            if (borrowedSold <= 0.0001) break;
                            let take = Math.min(b.taken, borrowedSold);
                            const bp = this.pm.getPosition(marketId, b.side, b.strategyType);
                            if (bp) {
                                if (take >= bp.shares - 0.0001) {
                                    this.pm.recordExit(marketId, b.side, b.strategyType);
                                } else {
                                    this.pm.recordPartialExit(marketId, b.side, b.strategyType, take, currentBid);
                                }
                            }
                            borrowedSold -= take;
                        }
                    }

                    return actualPosSold;
                } else {
                    execLog(`[EXEC] 🔴 Partial Scalp Failed: IOC placed but 0 matched.`);
                    return false;
                }
            } else {
                execLog(`[EXEC] 🔴 Partial Scalp Failed: Order rejection.`);
                return false;
            }
        } finally {
            this.pendingScalps.delete(lockKey);
        }
    }

    /**
     * 核心流动性辅助逻辑 (深度优先核心)：
     * 从前 N 档订单簿中选出最适合的一档价格成交。
     * 目的是在快速变动的盘口中，尽可能在价格波动范围内吃到最厚的挡位，降低因盘口瞬变导致的 FOK 失败。
     * @param {Array} levels 深度档位数组 [{price, size}, ...]
     * @param {number} targetSize 我们想要成交的数量
     * @param {string} side "BUY" 或 "SELL"
     * @param {number} basePrice 参考价格（止盈价或策略价）
     */
    pickBestExecutionPrice(levels, targetSize, side, basePrice) {
        // 仅处理前 3 档（最优价格的 Top 3）
        const candidates = levels.slice(0, 3);

        // 逻辑：
        // 1. 寻找第一档（从价格最优开始）能单次满足 targetSize 的。
        // 2. 如果前三档都满足不了，则选择深度最大的一档，以求最大的部分成交机会。
        let bestCandidate = candidates[0];
        let maxVolume = 0;

        for (const lvl of candidates) {
            if (lvl.size > maxVolume) {
                maxVolume = lvl.size;
            }
            if (lvl.size >= targetSize) {
                // 找到第一个能吃饱的，直接锁定这档价格。
                // 这样既保证了成交，也保证了是能成交的价格里最优的一个。
                return lvl.price;
            }
        }

        // 如果没找到能完全满足的，找深度最大的一档（为了让 IOC 能成交尽可能多）
        const deepest = candidates.reduce((prev, curr) => (curr.size > prev.size) ? curr : prev, candidates[0]);

        return deepest.price;
    }

}
