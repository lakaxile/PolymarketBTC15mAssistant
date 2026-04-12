import { CONFIG } from "./src/config.js";
import { startBinanceTradeStream } from "./src/data/binanceWs.js";
import { startPolymarketChainlinkPriceStream } from "./src/data/polymarketLiveWs.js";
import { fetchPolymarketSnapshot, resolveCurrentBtc15mMarket } from "./src/data/polymarket.js";
import { appendCsvRow, sleep } from "./src/utils.js";
import { applyGlobalProxyFromEnv } from "./src/net/proxy.js";

const LOG_FILE = "./logs/tick_data.csv";
const HEADER = [
    "Timestamp",
    "SpotPrice",
    "LivePrice",
    "Premium",
    "PremiumChange1s",
    "UpBestBid",
    "UpBestAsk",
    "DownBestBid",
    "DownBestAsk"
];

async function collectTicks() {
    applyGlobalProxyFromEnv();
    console.log("Starting high-frequency tick collection...");
    console.log(`Logging to: ${LOG_FILE}\n`);

    const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
    const polymarketLiveStream = startPolymarketChainlinkPriceStream({});

    // warm up
    await sleep(2000);

    let lastPremium = 0;

    // We will poll every 500ms
    while (true) {
        try {
            const spotPrice = binanceStream.getLast()?.price || null;
            const livePrice = polymarketLiveStream.getLast()?.price || null;

            if (spotPrice && livePrice) {
                const premium = spotPrice - livePrice;
                const premiumChange = premium - lastPremium;
                lastPremium = premium;

                // If premium changes rapidly or is large, we fetch book snapshot
                // To avoid spamming Polymarket API, we only fetch when we see significant moves
                // Let's just fetch it every 500ms for accurate correlation though for a minute

                const poly = await fetchPolymarketSnapshot();

                if (poly.ok && poly.orderbook) {
                    const upBid = poly.orderbook.up.bestBid;
                    const upAsk = poly.orderbook.up.bestAsk;
                    const downBid = poly.orderbook.down.bestBid;
                    const downAsk = poly.orderbook.down.bestAsk;

                    appendCsvRow(LOG_FILE, HEADER, [
                        Date.now(),
                        spotPrice.toFixed(2),
                        livePrice.toFixed(2),
                        premium.toFixed(2),
                        premiumChange.toFixed(2),
                        upBid,
                        upAsk,
                        downBid,
                        downAsk
                    ]);

                    console.log(`[Tick] Binance $${spotPrice.toFixed(2)} | Chainlink $${livePrice.toFixed(2)} | Premium $${premium.toFixed(2)}`);

                    if (Math.abs(premium) > 10) {
                        console.log(` ---> Large Premium: UP ${upBid}/${upAsk} | DOWN ${downBid}/${downAsk}`);
                    }

                }
            }
        } catch (e) {
            console.error(e);
        }
        await sleep(500);
    }
}

collectTicks();
