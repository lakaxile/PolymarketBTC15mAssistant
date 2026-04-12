import { getClobClient } from "./clob.js";

async function check() {
    try {
        const client = getClobClient();
        console.log("Checking API keys loaded...");
        const openOrders = await client.getOpenOrders();
        console.log("Open orders:", openOrders ? openOrders.length : 0);

        // We cannot easily fetch 'all balances' via Clob API directly without knowing token IDs.
        // Let's at least print what the Clob sees for the current 15m markets to see if it's looking at the wrong one.
        console.log("To debug the 10 and 45 shares, we need to know WHICH market they belong to. They are likely from an older market (e.g., 8:00 AM - 8:15 AM) that the bot has already discarded tracking for, leaving them stranded on the UI.");
    } catch (e) {
        console.error(e);
    }
}
check();
