import fs from "fs";

const html = fs.readFileSync('/tmp/pm_page.html', 'utf8');
const match = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>(.*?)<\/script>/s);

if (match && match[1]) {
    try {
        const data = JSON.parse(match[1]);
        
        // Let's do a deep search for keys containing 'baseline', 'strike', 'priceToBeat', etc.
        const searchKeys = ['baseline', 'strike', 'pricetobeat', 'target', 'initial', 'startprice'];
        
        function deepSearch(obj, path = '') {
            if (!obj || typeof obj !== 'object') return;
            
            for (let [key, value] of Object.entries(obj)) {
                let lowerKey = String(key).toLowerCase();
                if (searchKeys.some(sk => lowerKey.includes(sk))) {
                    console.log(`Found matching key: ${path}.${key} = ${JSON.stringify(value)}`);
                }
                
                if (typeof value === 'object') {
                    deepSearch(value, path ? `${path}.${key}` : key);
                }
            }
        }
        
        deepSearch(data);
        
        // Also look at the preloaded state for the specific market ID
        // Often found in props.pageProps.dehydratedState
        console.log("Deep search finished.");
        fs.writeFileSync('/tmp/pm_next_data.json', JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Failed to parse:', e);
    }
} else {
    console.error('__NEXT_DATA__ script tag not found.');
}
