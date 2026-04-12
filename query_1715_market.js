(async () => {
    try {
        const res = await fetch("https://gamma-api.polymarket.com/events?market_id=1858289");
        const json = await res.json();
        console.log(JSON.stringify(json, null, 2));

        const marketRes = await fetch("https://gamma-api.polymarket.com/markets/1858289");
        const marketJson = await marketRes.json();
        console.log("MARKET:", JSON.stringify(marketJson, null, 2));
    } catch(e) {
        console.error(e);
    }
})();
