import { fetchActiveMarkets } from "./src/data/polymarket.js";
import { getClobClient } from "./src/live/clob.js";

async function run() {
    const markets = await fetchActiveMarkets({ limit: 50 });
    const market = markets.find(m => m.question.includes("11:15AM-11:30AM ET") && m.question.includes("Bitcoin"));
    if (!market) {
        console.log("Market not found.");
        return;
    }
    console.log("Market ID:", market.market);
    console.log("Tokens:", market.tokens);
    const client = getClobClient();
    const upToken = market.tokens[0].token_id;
    const downToken = market.tokens[1].token_id;

    const u1 = await client.getBalanceAllowance({ asset_type: "CONDITIONAL", token_id: upToken });
    const d1 = await client.getBalanceAllowance({ asset_type: "CONDITIONAL", token_id: downToken });
    console.log(`UP Balance: ${u1.balance}, DOWN Balance: ${d1.balance}`);
}
run();
