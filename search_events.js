import { CONFIG } from "./src/config.js";

(async () => {
    const url = new URL("/events", CONFIG.gammaBaseUrl);
    url.searchParams.set("limit", "10");
    url.searchParams.set("active", "true");
    url.searchParams.set("query", "Bitcoin Up or Down");
    
    console.log("Fetching:", url.toString());
    const res = await fetch(url);
    const data = await res.json();
    console.log("Found events:", data.length);
    for (const e of data) {
        console.log(`- ${e.title} (ID: ${e.id}, Slug: ${e.slug}, Series: ${e.series_id})`);
    }
})();
