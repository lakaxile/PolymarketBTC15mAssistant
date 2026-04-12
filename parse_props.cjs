const fs = require('fs');

try {
    const data = JSON.parse(fs.readFileSync('/tmp/pm_props.json', 'utf8'));
    
    const searchKeys = ['baseline', 'strike', 'priceToBeat', 'target', 'initial', 'startPrice', 'resolution', 'reference'];
    
    function deepSearch(obj, path = '') {
        if (!obj || typeof obj !== 'object') return;
        
        for (let [key, value] of Object.entries(obj)) {
            let lowerKey = String(key).toLowerCase();
            if (searchKeys.some(sk => lowerKey.includes(sk.toLowerCase()))) {
                if (typeof value !== 'object' || value === null) {
                    console.log(`Found matching key: ${path}.${key} = ${value}`);
                } else if (Array.isArray(value) && value.length < 5) {
                    console.log(`Found matching key: ${path}.${key} = [Array]`);
                } else {
                    console.log(`Found matching object key: ${path}.${key}`);
                }
            }
            
            if (value && typeof value === 'object') {
                deepSearch(value, path ? `${path}.${key}` : key);
            }
        }
    }
    
    deepSearch(data);
    console.log("Deep search finished.");
} catch (e) {
    console.error('Failed to parse:', e);
}
