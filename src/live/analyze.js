import { LIVE_CONFIG } from "./config.js";

async function analyze() {
    try {
        const address = LIVE_CONFIG.proxyAddress || LIVE_CONFIG.walletKey; // Need actual address, let's use the public one if we know it
        // Actually, LIVE_CONFIG.proxyAddress is the proxy wallet.
        console.log(`Fetching trades for ${LIVE_CONFIG.proxyAddress}...`);
        const res = await fetch(`https://clob.polymarket.com/trades?maker_address=${LIVE_CONFIG.proxyAddress}`);
        const data = await res.json();

        const orders = data || [];
        if (!orders.length) {
            console.log("No orders found.");
            return;
        }

        const sinceMs = Date.parse("2026-02-26T17:00:00+08:00");

        orders.forEach(o => {
            const timeMs = parseInt(o.timestamp) * 1000;
            if (timeMs >= sinceMs) {
                const dateStr = new Date(timeMs).toLocaleTimeString();
                console.log(`[${dateStr}] M: ${o.asset_id} | Side: ${o.side} | Price: ${o.price} | Size: ${o.size}`);
            }
        });

    } catch (e) {
        console.error("Error analyzing:", e.message);
    }
}

analyze();
