import { getClobClient } from "./clob.js";

async function checkSpecificTokens() {
    const client = getClobClient();
    // 8:00 AM - 8:15 AM Market
    const p1Up = "55458284534168051677353975005934526563604928221652431698226068940801311099195";
    const p1Down = "27461805908927054366914594190848972879555127027376715019318357039014522437651";

    // 8:15 AM - 8:30 AM Market
    const p2Up = "23498801738722213768297771746271953282210080614051052210815121406692233634150";
    const p2Down = "113697960307997380928091873837965903023846684705574744722881267571253013897368";

    try {
        const [u1, d1, u2, d2] = await Promise.all([
            client.getBalanceAllowance({ asset_type: "CONDITIONAL", token_id: p1Up }),
            client.getBalanceAllowance({ asset_type: "CONDITIONAL", token_id: p1Down }),
            client.getBalanceAllowance({ asset_type: "CONDITIONAL", token_id: p2Up }),
            client.getBalanceAllowance({ asset_type: "CONDITIONAL", token_id: p2Down }),
        ]);

        console.log(`8:00 Market Balances -> UP: ${parseInt(u1.balance) / 1e6}, DOWN: ${parseInt(d1.balance) / 1e6}`);
        console.log(`8:15 Market Balances -> UP: ${parseInt(u2.balance) / 1e6}, DOWN: ${parseInt(d2.balance) / 1e6}`);
    } catch (e) {
        console.error("API error:", e.response?.data || e.message);
    }
}

checkSpecificTokens();
