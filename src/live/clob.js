import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { LIVE_CONFIG } from "./config.js";

let _client = null;

// 记录机器人自己下的所有订单 ID，清道夫仅清理这里记录的 ID，不碰用户网页手动挂的单
export const _botOrderIds = new Set();

export function getClobClient() {
    if (_client) return _client;

    if (LIVE_CONFIG.isDryRun) {
        console.log("[DRY RUN] Bypassing real CLOB Client initialization.");
        _client = {
            createOrder: async (o) => o,
            postOrder: async () => ({ success: true, orderID: "mock" }),
            getAllowance: async () => 1000
        };
        return _client;
    }

    if (!LIVE_CONFIG.walletKey) {
        throw new Error("POLY_WALLET_KEY is missing from environment variables.");
    }

    // 初始化 Provider 和 Signer
    const provider = new ethers.JsonRpcProvider(LIVE_CONFIG.polygonRpc);
    const signer = new ethers.Wallet(LIVE_CONFIG.walletKey, provider);

    // Ethers v6 compatibility patch for Polymarket SDK (it expects v5's _signTypedData)
    if (typeof signer._signTypedData !== "function") {
        signer._signTypedData = signer.signTypedData.bind(signer);
    }

    // 签名类型: 2 = GNOSIS_SAFE (内置钱包), 1 = POLY_PROXY, 0 = EOA
    const signatureType = LIVE_CONFIG.proxyAddress ? 2 : 0;
    const funderAddress = LIVE_CONFIG.proxyAddress || undefined;

    // 初始化 CLOB Client
    _client = new ClobClient(
        "https://clob.polymarket.com/",
        137, // Polygon Chain ID
        signer,
        LIVE_CONFIG.apiKey ? {
            key: LIVE_CONFIG.apiKey,
            secret: LIVE_CONFIG.apiSecret,
            passphrase: LIVE_CONFIG.apiPassphrase
        } : undefined,
        signatureType,
        funderAddress
    );

    return _client;
}

/**
 * 快速创建并且挂出限价单
 * @param {string} tokenId 目标选项的 Token ID
 * @param {string} side "buy" 或 "sell"
 * @param {number} price 价格 (美分，例如 0.52)
 * @param {number} size 想要买卖的份额 (Tokens Amount)
 * @param {string} orderType "FOK", "FAK", "GTC", "IOC"
 */
export async function placeLimitOrder(tokenId, side, price, size, orderType = "FOK") {
    const client = getClobClient();

    try {
        const order = await client.createOrder({
            tokenID: tokenId,
            price: price,
            side: side.toUpperCase(),
            size: size,
        });

        // 干跑模式拦截: 不实际向 Polygon 和 CLOB 签名发送交易
        if (LIVE_CONFIG.isDryRun) {
            console.log(`[DRY RUN SAFE] Simulated placing ${side} FOK order for ${size} shares @ $${price}`);
            return {
                success: true,
                orderID: `dry_run_mock_id_${Date.now()}`,
                sizeMatched: size,
                fillPrice: price
            };
        }

        // 增加 15s 超时控制，防止 API 挂起导致整个机器人卡死
        const response = await Promise.race([
            client.postOrder(order, orderType),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Order placement timed out (15s, ${orderType})`)), 15000))
        ]);

        if (response && response.success && response.orderID) {
            // 注册到机器人订单集合，供清道夫精确定向清扫
            _botOrderIds.add(response.orderID);
            try {
                // 等待索引器同步
                await new Promise(r => setTimeout(r, 600));
                const orderStatus = await client.getOrder(response.orderID);
                response.sizeMatched = parseFloat(orderStatus.size_matched || "0");
                response.isFullyMatched = response.sizeMatched >= size;
                response.status = orderStatus.status;

                // 从链上获取真实成交均价 (avg_price 是 Polymarket API 标准字段)
                const rawFillPrice = parseFloat(orderStatus.avg_price || orderStatus.price || "0");
                response.fillPrice = rawFillPrice > 0 ? rawFillPrice : null; // null 代表链上暂时还没回传

                // 如果已经确认成交 / 取消，从追踪集合移除（不再需要清扫它）
                if (response.status === "MATCHED" || response.status === "CANCELLED") {
                    _botOrderIds.delete(response.orderID);
                }
            } catch (err) {
                console.warn(`[CLOB] Could not fetch order status for ${response.orderID}:`, err.message);
                response.sizeMatched = 0; // 防御性归零，防止本地虚假记账
            }
        }

        return response;
    } catch (e) {
        const errorDetail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error(`[CLOB ERROR] Failed to place ${side} order:`, errorDetail);
        return null;
    }
}

/**
 * 取消指定 Token 上的所有挂单
 * @param {string} tokenId 目标选项的 Token ID
 */
export async function cancelOrdersForToken(tokenId) {
    const client = getClobClient();
    try {
        // getOpenOrders() 直接返回 Order[]，不是 { orders: [] }
        const orders = await client.getOpenOrders();
        if (!Array.isArray(orders) || orders.length === 0) return;

        // 只取消：1. 匹配 tokenId，2. 是机器人自己挂的单
        const matching = orders.filter(o => o.asset_id === tokenId && _botOrderIds.has(o.id));
        if (matching.length === 0) return;

        const orderIds = matching.map(o => o.id);
        await client.cancelOrders(orderIds);
        orderIds.forEach(id => _botOrderIds.delete(id));
        console.log(`[CLOB] Canceled ${matching.length} bot orders for token ${tokenId}`);
    } catch (e) {
        const errorDetail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error(`[CLOB ERROR] Failed to cancel orders for token ${tokenId}:`, errorDetail);
    }
}

/**
 * 后台清道夫: 取消账户下所有挂单
 * 供定时轮询调用，彻底清除任何 IOC 未完全取消的残留废单
 * @returns {number} 取消数量
 */
export async function cancelAllOpenOrders() {
    const client = getClobClient();
    try {
        // getOpenOrders() 直接返回 Order[]，不是 { orders: [] }
        const orders = await client.getOpenOrders();
        if (!Array.isArray(orders) || orders.length === 0) return 0;

        // 只清扫机器人自己下的挂单，用户网页手动挂的单子一律不碰
        const botOrders = orders.filter(o => _botOrderIds.has(o.id));
        if (botOrders.length === 0) return 0;

        const orderIds = botOrders.map(o => o.id);
        await client.cancelOrders(orderIds);
        orderIds.forEach(id => _botOrderIds.delete(id));

        console.log(`[CLOB] 🧹 Order Janitor: Swept ${botOrders.length} bot orders (${orders.length - botOrders.length} manual orders preserved).`);
        return botOrders.length;
    } catch (e) {
        const errorDetail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error(`[CLOB ERROR] Order Janitor failed:`, errorDetail);
        return 0;
    }
}
