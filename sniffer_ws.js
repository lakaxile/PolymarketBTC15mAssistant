import WebSocket from "ws";
const wsUrl = "wss://ws-live-data.polymarket.com";
const ws = new WebSocket(wsUrl);
ws.on("open", () => {
  console.log("Connected to " + wsUrl);
  ws.send(JSON.stringify({
    action: "subscribe",
    subscriptions: [{ topic: "crypto_prices_chainlink", type: "*", filters: "" }]
  }));
});
ws.on("message", (buf) => {
  try {
    const data = JSON.parse(buf.toString());
    if (data.topic === "crypto_prices_chainlink") {
      const p = data.payload;
      if (p.symbol.toLowerCase().includes("btc")) {
          console.log(`Symbol: ${p.symbol}, Price: ${p.value || p.price}, TS: ${p.timestamp}`);
      }
    }
  } catch (e) {}
});
setTimeout(() => { console.log("Done"); process.exit(0); }, 3000);
