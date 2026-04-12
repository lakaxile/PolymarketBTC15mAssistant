import fs from "fs";

(async () => {
    const slug = "btc-updown-15m-1774065600";
    const res = await fetch(`https://polymarket.com/event/${slug}`, {
        headers: { "User-Agent": "Mozilla/5.0" }
    });
    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>(.*?)<\/script>/s);
    if (!match) { console.log("NO NEXT DATA"); return; }
    
    const data = JSON.parse(match[1]);
    fs.writeFileSync("next_data_dump.json", JSON.stringify(data, null, 2));
    
    // Find all occurrences of anything resembling "priceToBeat" or "strike"
    function findKey(obj, path, target) {
        if (!obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
            if (k.toLowerCase().includes(target) || (typeof v === 'number' && v > 60000 && v < 2000000)) {
                console.log(`[${path ? path + '.' : ''}${k}]: ${typeof v === 'number' ? v : typeof v === 'object' ? '(object)' : v}`);
            }
            if (v && typeof v === 'object') {
                findKey(v, path ? `${path}.${k}` : k, target);
            }
        }
    }
    console.log("Searching for priceToBeat/strike in JSON...");
    findKey(data, "", "price");
    
})();
