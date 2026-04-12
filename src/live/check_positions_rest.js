import { LIVE_CONFIG } from "./config.js";

async function checkRest() {
    const wallet = "0x7ff4Ed1B51DB2337BCbb0d4723357FaA1E7d7A3a";
    try {
        console.log(`Checking Gamma REST API for positions of ${wallet}...`);
        const res = await fetch(`https://clob.polymarket.com/positions?user=${wallet}`);
        const data = await res.json();

        let found = 0;
        for (const p of (data || [])) {
            const size = parseFloat(p.size);
            if (size > 0) {
                console.log(`Market: ${p.market}`);
                console.log(`Asset ID: ${p.asset_id}`);
                console.log(`Size: ${size}`);
                console.log("-------------------");
                found++;
            }
        }
        console.log(`Total active positions: ${found}`);
    } catch (e) {
        console.error(e.message);
    }
}
checkRest();
