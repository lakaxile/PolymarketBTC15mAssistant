import { fetchExactPriceToBeat, fetchPtbFromInternalApi, resolveCurrentBtc15mMarket } from "./src/data/polymarket.js";

(async () => {
    console.log("--- STARTING PTB DIAGNOSTIC ---");
    
    console.log("1. Resolving current 15m market...");
    const market = await resolveCurrentBtc15mMarket();
    if (!market) {
        console.log("❌ Failed to resolve current market.");
        return;
    }
    console.log(`✅ Current Market Slug: ${market.slug}`);
    
    console.log("\n2. Testing internal crypto-price API...");
    try {
        const internalPtb = await fetchPtbFromInternalApi("BTC", "fifteen");
        console.log(`Internal API Result: ${internalPtb}`);
    } catch (e) {
        console.log(`❌ Internal API Error: ${e.message}`);
    }

    console.log("\n3. Testing __NEXT_DATA__ web scraping (fetchExactPriceToBeat)...");
    try {
        const exactPtb = await fetchExactPriceToBeat(market.slug, market.conditionId);
        console.log(`Web Scraping Result: ${exactPtb}`);
    } catch (e) {
        console.log(`❌ Web Scraping Error: ${e.message}`);
    }
    
    console.log("\n4. Raw Fetch Test to Polymarket Event Page (Checking for Cloudflare block)...");
    try {
        const res = await fetch(`https://polymarket.com/event/${market.slug}`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        });
        console.log(`Status: ${res.status}`);
        const text = await res.text();
        if (text.includes("Just a moment...") || text.includes("cloudflare")) {
            console.log("❌ CLOUDFLARE IS BLOCKING THE REQUEST!");
        } else if (text.includes("__NEXT_DATA__")) {
            console.log("✅ HTML contains __NEXT_DATA__.");
        } else {
            console.log("❌ HTML returned but NO __NEXT_DATA__ found.");
        }
    } catch (e) {
        console.log(`❌ Raw Fetch Error: ${e.message}`);
    }
})();
