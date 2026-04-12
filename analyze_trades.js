import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

async function getClient() {
    const creds = {
        key: process.env.POLY_API_KEY,
        secret: process.env.POLY_PASSPHRASE,
        passphrase: process.env.POLY_PASSPHRASE,
    };

    // Poly wallet
    const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(process.env.POLYGON_PRIVATE_KEY, provider);

    const client = new ClobClient("https://clob.polymarket.com", 137, wallet, creds);
    return client;
}

async function analyze() {
    try {
        const client = await getClient();
        console.log("Fetching order history...");
        const orders = await client.getOrders({ status: "ALL", limit: 300 }); // fetch recent orders
        if (!orders || !orders.length) {
            console.log("No orders found.");
            return;
        }

        const sinceMs = Date.parse("2026-02-26T17:00:00+08:00");
        let lossSum = 0;
        let winSum = 0;

        orders.forEach(o => {
            const timeMs = parseInt(o.create_time) * 1000;
            if (timeMs >= sinceMs && o.status === "MATCHED") {
                const dateStr = new Date(timeMs).toLocaleTimeString();
                console.log(`[${dateStr}] M: ${o.market} | Side: ${o.side} | Price: ${o.price} | Size: ${o.sizeMatched}`);
            }
        });

    } catch (e) {
        console.error("Error analyzing:", e.message);
    }
}

analyze();
