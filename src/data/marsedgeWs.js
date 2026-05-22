import { CONFIG } from '../config.js';
import fs from 'fs';

let latestMarsedgeData = {
  items: [],
  updatedAt: null,
  connected: false,
  error: null
};

let abortController = null;

export function startMarsedgeStream() {
  if (!CONFIG.marsedge.apiKey) {
    latestMarsedgeData.error = "No API Key configured. Please set MARSEDGE_API_KEY in .env.";
    return;
  }

  if (abortController) abortController.abort();
  abortController = new AbortController();

  const url = 'https://marsedge.vip/api/probboard/stream';

  async function connect() {
    try {
      const response = await fetch(url, {
        headers: {
          'X-API-Key': CONFIG.marsedge.apiKey,
          'Accept': 'text/event-stream'
        },
        signal: abortController.signal
      });

      if (!response.ok) {
        latestMarsedgeData.connected = false;
        latestMarsedgeData.error = `HTTP Error: ${response.status} ${response.statusText}`;
        try {
          fs.writeFileSync('./logs/marsedge_error.log', `HTTP Error: ${response.status}\n`);
        } catch(e) {}
        setTimeout(connect, 5000);
        return;
      }

      latestMarsedgeData.connected = true;
      latestMarsedgeData.error = null;

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep the incomplete line

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const dataStr = line.slice(5).trim();
            if (dataStr && dataStr !== '[DONE]') {
              try {
                const data = JSON.parse(dataStr);
                if (data.items) {
                   latestMarsedgeData.items = data.items;
                   latestMarsedgeData.updatedAt = Date.now();
                }
              } catch (e) {
                // ignore parse error
              }
            }
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      latestMarsedgeData.connected = false;
      latestMarsedgeData.error = `Connection failed: ${err.message}`;
    }
    
    // Auto reconnect if stream ends
    setTimeout(connect, 3000);
  }

  connect();
}

export function getMarsedgePrediction(symbol = "BTC") {
  if (!latestMarsedgeData.connected && latestMarsedgeData.items.length === 0) {
    return { error: latestMarsedgeData.error || "Connecting..." };
  }
  
  const item = latestMarsedgeData.items.find(i => i.symbol === symbol);
  if (!item) {
    return { error: `No data for ${symbol}` };
  }
  
  return {
    ok: true,
    data: item
  };
}
