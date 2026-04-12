/**
 * 模拟交易引擎：负责资产核算和订单记录
 */
export class SimulationEngine {
    constructor(initialBalance = 1000) {
        this.balance = initialBalance; // 虚拟美元余额
        this.activeTrades = new Map(); // 记录正在进行的交易 { marketId: { side, entryPrice, size, timestamp } }
        this.history = []; // 历史交易记录
        this.stats = { wins: 0, losses: 0, totalProfit: 0 };
    }

    /**
     * 模拟下单
     * @param {string} marketId 市场 ID
     * @param {string} side 方向 (UP/DOWN)
     * @param {number} price 价格 (单位: cents, 如 0.52)
     * @param {number} size 投入金额 (美元)
     * @param {string} strategyType 策略名称
     */
    enterPosition(marketId, side, price, size = 100, strategyType = "STRATEGY", extra = {}) {
        if (!price || price <= 0) return;
        const tradeKey = `${marketId}@${strategyType}`;
        if (this.activeTrades.has(tradeKey)) return;
        if (this.balance < size) return;

        this.balance -= size;
        this.activeTrades.set(tradeKey, {
            marketId,
            side,
            entryPrice: price,
            size,
            strategyType,
            timestamp: Date.now(),
            question: extra.question || "",
            taProb: extra.taProb,
            marketOdds: extra.marketOdds
        });
    }

    /**
     * 结算交易
     * @param {string} marketId 市场 ID
     * @param {string} winningSide 获胜的方向 (UP/DOWN)
     */
    settle(marketId, winningSide) {
        const keysToSettle = [];
        for (const [key, trade] of this.activeTrades.entries()) {
            if (trade.marketId === marketId || key === marketId) {
                keysToSettle.push(key);
            }
        }

        let totalProfit = 0;
        let anyWin = false;

        for (const key of keysToSettle) {
            const trade = this.activeTrades.get(key);
            const isWin = trade.side === winningSide;
            // 赔率简化算法：1 美元买入 price 价格的份额，获胜时 1 份额赔付 1 美元
            // 获得份额 = 投入金额 / 价格
            const shares = trade.size / trade.entryPrice;
            const payout = isWin ? shares : 0;

            const profit = payout - trade.size;
            this.balance += payout;

            this.history.push({ ...trade, profit, isWin, closedAt: Date.now(), winningSide, exitType: "SETTLEMENT" });
            if (isWin) this.stats.wins++; else this.stats.losses++;
            this.stats.totalProfit += profit;

            this.activeTrades.delete(key);
            totalProfit += profit;
            if (isWin) anyWin = true;
        }

        if (keysToSettle.length === 0) return undefined;
        return { profit: totalProfit, isWin: anyWin, balance: this.balance };
    }

    /**
     * 提前平仓 (利好于套利策略，锁定利润)
     * @param {string} tradeKey 交易 Key (marketId@strategy)
     * @param {number} currentPrice 当前可以卖出的价格 (Bid 价格)
     */
    closePosition(tradeKey, currentPrice) {
        if (!this.activeTrades.has(tradeKey)) return null;
        const trade = this.activeTrades.get(tradeKey);

        // 获得份额 = 投入金额 / 买入价格
        const shares = trade.size / trade.entryPrice;
        // 卖出价值 = 份额 * 当前卖出价格
        const payout = shares * currentPrice;
        const profit = payout - trade.size;

        this.balance += payout;
        const isWin = profit > 0;

        this.history.push({
            ...trade,
            profit,
            isWin,
            closedAt: Date.now(),
            exitPrice: currentPrice,
            exitType: "EARLY_EXIT"
        });

        if (isWin) this.stats.wins++; else this.stats.losses++;
        this.stats.totalProfit += profit;
        this.activeTrades.delete(tradeKey);

        return { profit, isWin, balance: this.balance };
    }

    /**
     * 获取当前状态摘要
     */
    getSummary() {
        return {
            balance: this.balance,
            activeCount: this.activeTrades.size,
            wins: this.stats.wins,
            losses: this.stats.losses,
            totalProfit: this.stats.totalProfit,
            winRate: (this.stats.wins + this.stats.losses) > 0
                ? (this.stats.wins / (this.stats.wins + this.stats.losses) * 100).toFixed(1) + "%"
                : "0%"
        };
    }
}
