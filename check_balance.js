import { getClobClient } from "./src/live/clob.js";
import { fetchPolymarketSnapshot } from "./src/data/polymarket.js";

async function checkBalance() {
    console.log("Fetching market snapshot...");
    const polySnap = await fetchPolymarketSnapshot();
    if (!polySnap || !polySnap.tokens) {
        console.error("Failed to fetch market snapshot.");
        process.exit(1);
    }

    const { upTokenId, downTokenId } = polySnap.tokens;
    console.log(`Active Market ID: ${polySnap.market.id}`);
    console.log(`UP Token ID: ${upTokenId}`);
    console.log(`DOWN Token ID: ${downTokenId}`);

    const client = getClobClient();
    console.log("Querying balances from CLOB...");

    try {
        const [upData, downData] = await Promise.all([
            client.getBalanceAllowance({ asset_type: "CONDITIONAL", token_id: upTokenId }),
            client.getBalanceAllowance({ asset_type: "CONDITIONAL", token_id: downTokenId })
        ]);

        const realUpShares = parseFloat(upData.balance || "0") / 1_000_000;
        const realDownShares = parseFloat(downData.balance || "0") / 1_000_000;

        console.log(`\n--- WALLET BALANCES ---`);
        console.log(`UP Shares:   ${realUpShares} (Raw: ${upData.balance})`);
        console.log(`DOWN Shares: ${realDownShares} (Raw: ${downData.balance})`);

    } catch (e) {
        console.error("Error querying CLOB:", e.message);
    }
}

checkBalance();
