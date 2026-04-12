import WebSocket from "ws";
const wsUrl = "wss://ws-live-data.polymarket.com";
const ws = new WebSocket(wsUrl);
ws.on("open", () => {
    ws.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [{ topic: "crypto_prices_chainlink", type: "*", filters: "" }]
    }));
});
ws.on("message", (buf) => {
    const data = JSON.parse(buf.toString());
    if (data.topic === "crypto_prices_chainlink") {
        console.log(JSON.stringify(data.payload));
    }
});
setTimeout(() => process.exit(0), 5000);
