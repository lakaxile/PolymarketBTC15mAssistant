import fs from "fs";

(async () => {
    const slug = "btc-updown-15m-1774065600";
    const data = JSON.parse(fs.readFileSync("next_data_dump.json", "utf8"));
    
    let pathFound = null;
    let exactPtb = null;
    
    function searchObj(obj, path = "") {
        if (!obj || typeof obj !== 'object') return;
        
        if (obj.slug === slug) {
            console.log(`Found object with slug at path: ${path}`);
            if (obj.eventMetadata?.priceToBeat || obj.priceToBeat) {
                exactPtb = obj.eventMetadata?.priceToBeat || obj.priceToBeat;
                pathFound = path + " -> priceToBeat";
            } else {
                console.log(`Object has slug but NO priceToBeat! keys: ${Object.keys(obj)}`);
            }
        }
        
        for (const [k, v] of Object.entries(obj)) {
            if (v && typeof v === 'object') {
                searchObj(v, path ? `${path}.${k}` : k);
            }
        }
    }
    
    searchObj(data);
    
    if (pathFound) {
        console.log(`✅ EXACT PTB FOUND: ${exactPtb} at ${pathFound}`);
    } else {
        console.log(`❌ PTB NOT FOUND FOR SLUG ${slug}`);
        
        // Search for any slug containing 'btc-updown-15m'
        console.log("Searching for ANY btc-updown-15m slug...");
        function searchAny(obj, path = "") {
            if (!obj || typeof obj !== 'object') return;
            if (typeof obj.slug === 'string' && obj.slug.includes("btc-updown-15m")) {
                console.log(`Found related slug: ${obj.slug} at ${path}`);
                if (obj.eventMetadata?.priceToBeat || obj.priceToBeat) {
                    console.log(`  -> PTB: ${obj.eventMetadata?.priceToBeat || obj.priceToBeat}`);
                }
            }
            for (const [k, v] of Object.entries(obj)) {
                if (v && typeof v === 'object') {
                    searchAny(v, path ? `${path}.${k}` : k);
                }
            }
        }
        searchAny(data);
    }
})();
