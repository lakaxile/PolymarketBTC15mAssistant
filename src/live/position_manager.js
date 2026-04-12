import { getClobClient } from "./clob.js";
import { ethers } from "ethers";
import { LIVE_CONFIG } from "./config.js";

// Polygon 上原生 USDC 的合约地址
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];
/**
 * 仓位管理器
 * 负责从 CLOB 和链上获取真实的余额、CTF Token 数量。
 */
export class LivePositionManager {
    constructor() {
        // key: ${marketId}@${side}  => 例如: 123456@UP
        // value: { tokenID, shares, averagePrice, maxSize }
        this.positions = new Map();
        this.usdcBalance = 0;
        this.openOrders = []; // 当前活动的挂单情况
    }

    /**
     * 更新当前账号的真正的 USDC (Polygon) 余额。
     * 为了节省 RPC 资源，我们建议仅在程序启动时、以及在订单成功结算/卖出时调用此方法。
     */
    async fetchUsdcBalance() {
        try {
            if (LIVE_CONFIG.isDryRun) {
                if (this.usdcBalance === 0) {
                    this.usdcBalance = 1000;
                }
                return this.usdcBalance;
            }

            if (!LIVE_CONFIG.walletKey) return this.usdcBalance;

            if (!LIVE_CONFIG.proxyAddress) {
                console.warn("[LIVE] WARN: POLY_PROXY_ADDRESS is missing in .env! USDC balance may reflect your base EOA instead of Polymarket Wallet.");
            }

            const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            const wallet = new ethers.Wallet(LIVE_CONFIG.walletKey, provider);

            const targetAddress = LIVE_CONFIG.proxyAddress || wallet.address;

            const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
            const rawBalance = await usdcContract.balanceOf(targetAddress);

            // USDC 精度是 6
            this.usdcBalance = parseFloat(ethers.formatUnits(rawBalance, 6));
            return this.usdcBalance;

        } catch (e) {
            console.error("[LIVE] Error fetching USDC balance via RPC:", e.message);
            return this.usdcBalance; // 失败时返回上一次缓存的值
        }
    }

    /**
     * 将本地持仓与 Polymarket CLOB 的真实余额进行同步。
     * 防止因为手动操作、交易失败或程序重启导致的本地状态与远程不一致。
     */
    async syncWithClob(polySnap) {
        if (LIVE_CONFIG.isDryRun) return;
        if (!polySnap || !polySnap.tokens) return;

        const client = getClobClient();
        const { upTokenId, downTokenId } = polySnap.tokens;

        try {
            // 获取 UP 和 DOWN Token 的真实余额 (由 SDK 返回的原始 balance 字符串通常是 6 位精度)
            const [upData, downData] = await Promise.all([
                client.getBalanceAllowance({ asset_type: "CONDITIONAL", token_id: upTokenId }),
                client.getBalanceAllowance({ asset_type: "CONDITIONAL", token_id: downTokenId })
            ]);

            // 根据以太坊标准，Polymarket CTF 代币通常使用 6 位小数 (如同 USDC)
            const realUpShares = parseFloat(upData.balance || "0") / 1_000_000;
            const realDownShares = parseFloat(downData.balance || "0") / 1_000_000;

            if (realUpShares > 0 || realDownShares > 0) {
                console.log(`[STATE] Raw Clob Balance - UP: ${upData.balance}, DOWN: ${downData.balance}`);
            }

            // 统计本地属于该市场的所有 UP/DOWN 总和，防止多策略共享时误判
            let localUpTotal = 0;
            let localDownTotal = 0;
            const marketPositions = [];

            for (const [key, pos] of this.positions.entries()) {
                if (pos.marketId !== polySnap.market.id) continue;
                marketPositions.push({ key, pos });
                if (pos.side === "UP") localUpTotal += pos.shares;
                else if (pos.side === "DOWN") localDownTotal += pos.shares;
            }

            // 1. 同步 UP 仓位
            if (realUpShares <= 0.000001) {
                // 如果链上真的一点都没了，那本地全清
                for (const item of marketPositions) {
                    if (item.pos.side === "UP") {
                        console.log(`[STATE] Sync: Clearing ghost UP for ${item.pos.strategyType}`);
                        this.positions.delete(item.key);
                    }
                }
            } else if (Math.abs(localUpTotal - realUpShares) > 0.05) {
                if (realUpShares < localUpTotal) {
                    // 链上比本地少 (可能发生部分被吃单/外部卖出) => 按比例缩减本地份额
                    const factor = localUpTotal > 0 ? (realUpShares / localUpTotal) : 0;
                    for (const item of marketPositions) {
                        if (item.pos.side === "UP") {
                            const old = item.pos.shares;
                            item.pos.shares = item.pos.shares * factor;
                            item.pos.totalCost = item.pos.totalCost * factor;
                            if (item.pos.shares > 0) {
                                item.pos.averagePrice = item.pos.totalCost / item.pos.shares;
                            }
                            console.log(`[STATE] Sync: Scaled DOWN UP position for ${item.pos.strategyType}: ${old.toFixed(2)} -> ${item.pos.shares.toFixed(2)}`);
                        }
                    }
                } else {
                    // 链上比本地多 => 把多出来的部分作为一个新的 MANUAL 仓位记录
                    const extraShares = realUpShares - localUpTotal;
                    if (extraShares > 0.99) {
                        // 将插入的额外份额限制在允许范围内，防止链上旧数据导致本地记录爆仓
                        const cappedExtra = Math.min(extraShares, Math.max(0, LIVE_CONFIG.maxSharesPerMarket - localUpTotal));
                        if (cappedExtra > 0.99) {
                            console.warn(`[STATE] Sync: Found ${extraShares.toFixed(2)} extra UP shares on chain. Recording ${cappedExtra.toFixed(2)} as MANUAL (cap: ${LIVE_CONFIG.maxSharesPerMarket}).`);
                            this.recordEntry(polySnap.market.id, "UP", upTokenId, polySnap.prices.up || 0.5, cappedExtra, "MANUAL", true);
                        } else {
                            console.warn(`[STATE] Sync: Extra UP shares (${extraShares.toFixed(2)}) would exceed maxSharesPerMarket=${LIVE_CONFIG.maxSharesPerMarket}. Skipping MANUAL injection to avoid local overflow.`);
                        }
                    }
                }
            }

            // 2. 同步 DOWN 仓位
            if (realDownShares <= 0.000001) {
                for (const item of marketPositions) {
                    if (item.pos.side === "DOWN") {
                        console.log(`[STATE] Sync: Clearing ghost DOWN for ${item.pos.strategyType}`);
                        this.positions.delete(item.key);
                    }
                }
            } else if (Math.abs(localDownTotal - realDownShares) > 0.05) {
                if (realDownShares < localDownTotal) {
                    const factor = localDownTotal > 0 ? (realDownShares / localDownTotal) : 0;
                    for (const item of marketPositions) {
                        if (item.pos.side === "DOWN") {
                            const old = item.pos.shares;
                            item.pos.shares = item.pos.shares * factor;
                            item.pos.totalCost = item.pos.totalCost * factor;
                            if (item.pos.shares > 0) {
                                item.pos.averagePrice = item.pos.totalCost / item.pos.shares;
                            }
                            console.log(`[STATE] Sync: Scaled DOWN DOWN position for ${item.pos.strategyType}: ${old.toFixed(2)} -> ${item.pos.shares.toFixed(2)}`);
                        }
                    }
                } else {
                    const extraShares = realDownShares - localDownTotal;
                    if (extraShares > 0.99) {
                        // 将插入的额外份额限制在允许范围内
                        const cappedExtra = Math.min(extraShares, Math.max(0, LIVE_CONFIG.maxSharesPerMarket - localDownTotal));
                        if (cappedExtra > 0.99) {
                            console.warn(`[STATE] Sync: Found ${extraShares.toFixed(2)} extra DOWN shares on chain. Recording ${cappedExtra.toFixed(2)} as MANUAL (cap: ${LIVE_CONFIG.maxSharesPerMarket}).`);
                            this.recordEntry(polySnap.market.id, "DOWN", downTokenId, polySnap.prices.down || 0.5, cappedExtra, "MANUAL", true);
                        } else {
                            console.warn(`[STATE] Sync: Extra DOWN shares (${extraShares.toFixed(2)}) would exceed maxSharesPerMarket=${LIVE_CONFIG.maxSharesPerMarket}. Skipping MANUAL injection.`);
                        }
                    }
                }
            }

            // 3. 获取当前挂单 (Open Orders) - getOpenOrders() 直接返回数组
            const openOrdersArr = await client.getOpenOrders();
            this.openOrders = Array.isArray(openOrdersArr) ? openOrdersArr : [];
            if (this.openOrders.length > 0) {
                console.log(`[STATE] Sync: Detected ${this.openOrders.length} OPEN ORDERS. (Preserving user's manual Web UI orders)`);
            }

        } catch (e) {
            console.error("[STATE] Error syncing with CLOB:", e.message);
        }
    }

    /**
     * 强行记下一笔买入成功的仓位到本地状态机，用于剥头皮的快速判定。
     * 成本核算: 使用 fills[] 数组存储每笔成交记录，每次核算时直接从原始数据推导
     * 加权均价，彻底消除增量累加导致的浮点数漂移误差。
     */
    recordEntry(marketId, side, tokenID, matchedPrice, matchedSize, strategyType, isAbsolute = false) {
        const key = `${marketId}@${strategyType}@${side}`;
        const existing = this.positions.get(key) || {
            marketId, side, tokenID, strategyType,
            fills: [],           // ← 新: 每笔成交历史 [{shares, price}]
            shares: 0,
            totalCost: 0,
            averagePrice: 0,
            hasReducedPosition: false,
        };

        if (isAbsolute) {
            // 绝对覆盖模式 (MANUAL/syncWithClob 硬同步)
            // 清空历史 fills，用单条记录替代
            existing.fills = [{ shares: matchedSize, price: matchedPrice }];
        } else {
            // 增量模式: 仅追加一条成交记录
            existing.fills.push({ shares: matchedSize, price: matchedPrice });
        }

        // 从 fills 重新推导关键字段 — 永远准确，不依赖增量累加
        const totalShares = existing.fills.reduce((s, f) => s + f.shares, 0);
        const totalCost = existing.fills.reduce((s, f) => s + f.shares * f.price, 0);

        existing.shares = totalShares;
        existing.totalCost = totalCost;
        existing.averagePrice = totalShares > 0 ? totalCost / totalShares : 0;

        this.positions.set(key, existing);

        console.log(`[STATE] Recorded Entry -> ${key} | Fills: ${existing.fills.length} | Avg: ${existing.averagePrice.toFixed(3)} | Shares: ${existing.shares.toFixed(4)}`);
    }

    /**
     * 记录平仓并删除维护状态
     */
    recordExit(marketId, side, strategyType) {
        const key = `${marketId}@${strategyType}@${side}`;
        this.positions.delete(key);
        console.log(`[STATE] Recorded Exit & Cleared -> ${key}`);
    }

    /**
     * 记录部分平仓 (分步止盈)
     * 按比例缩减所有 fills，保持成本结构正确
     */
    recordPartialExit(marketId, side, strategyType, soldShares, soldPrice) {
        const key = `${marketId}@${strategyType}@${side}`;
        const existing = this.positions.get(key);
        if (!existing || !existing.fills) return;

        const remainRatio = existing.shares > 0 ? (existing.shares - soldShares) / existing.shares : 0;
        if (remainRatio <= 0) {
            this.positions.delete(key);
            console.log(`[STATE] Recorded Partial Exit (All Sold) -> Cleared ${key}`);
            return;
        }

        // 按比例缩减每条 fill 的 shares（保留成本结构）
        existing.fills = existing.fills.map(f => ({ ...f, shares: f.shares * remainRatio }));
        existing.shares = existing.fills.reduce((s, f) => s + f.shares, 0);
        existing.totalCost = existing.fills.reduce((s, f) => s + f.shares * f.price, 0);
        existing.averagePrice = existing.shares > 0 ? existing.totalCost / existing.shares : 0;
        existing.hasReducedPosition = true;

        this.positions.set(key, existing);
        console.log(`[STATE] Recorded Partial Exit -> ${key} | Remaining: ${existing.shares.toFixed(4)} shares @ avg ${existing.averagePrice.toFixed(3)}`);
    }

    /**
     * 获取指定策略的持仓
     */
    getPosition(marketId, side, strategyType) {
        return this.positions.get(`${marketId}@${strategyType}@${side}`);
    }

    /**
     * 获取该市场（不分策略）的总持仓量
     */
    getTotalMarketShares(marketId) {
        let total = 0;
        for (const pos of this.positions.values()) {
            if (pos.marketId === marketId) {
                total += pos.shares;
            }
        }
        return total;
    }

    /**
     * 获取该市场特定方向（跨所有策略）的总持仓量
     * 用于实施全局单方向仓位上限，防止多策略同向叠加超限
     */
    getTotalSharesBySide(marketId, side) {
        let total = 0;
        for (const pos of this.positions.values()) {
            if (pos.marketId === marketId && pos.side === side && !pos.isSettling && !pos.isDead) {
                total += pos.shares;
            }
        }
        return total;
    }

    /**
     * 获取当前所有仓位的汇总信息，用于 UI 显示
     */
    getSummary() {
        let totalShares = 0;
        let totalCost = 0;

        for (const pos of this.positions.values()) {
            totalShares += pos.shares;
            totalCost += pos.totalCost;
        }

        return {
            totalShares,
            totalCost,
            balance: this.usdcBalance
        };
    }
}
