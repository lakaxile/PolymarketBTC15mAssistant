import { CONFIG } from '../config.js';
import fs from 'fs';

let latestMarsedgeData = {
  items: [],
  updatedAt: null,
  connected: false,
  error: null
};

let marsedgeHistory = [];
const HISTORY_LIMIT_MS = 15 * 60 * 1000; // retain up to 15 mins by default

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
                   const now = Date.now();
                   latestMarsedgeData.updatedAt = now;
                   
                   // Record to history buffer
                   marsedgeHistory.push({
                       timestamp: now,
                       items: data.items
                   });
                   
                   // Auto prune old data to prevent memory leak
                   const cutoff = now - HISTORY_LIMIT_MS;
                   while (marsedgeHistory.length > 0 && marsedgeHistory[0].timestamp < cutoff) {
                       marsedgeHistory.shift();
                   }
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

export function getMarsedgePredictionAtTime(symbol = "BTC", targetTimestampSec) {
  const targetTimeMs = targetTimestampSec * 1000;
  
  if (marsedgeHistory.length === 0) {
     return getMarsedgePrediction(symbol); // fallback to latest if no history
  }

  // Only use records at or before the trade timestamp (no future data)
  const validRecords = marsedgeHistory.filter(r => r.timestamp <= targetTimeMs);

  let closestRecord;
  if (validRecords.length > 0) {
    // Pick the most recent past record
    closestRecord = validRecords.reduce((best, r) =>
      r.timestamp > best.timestamp ? r : best, validRecords[0]);
  } else {
    // No past records available, fallback to oldest
    closestRecord = marsedgeHistory.reduce((oldest, r) =>
      r.timestamp < oldest.timestamp ? r : oldest, marsedgeHistory[0]);
    console.warn('[getMarsedgePredictionAtTime] No past record found, using oldest as fallback');
  }

  const item = closestRecord.items.find(i => i.symbol === symbol);
  if (!item) {
    return { error: `No data for ${symbol} at the given time` };
  }
  
  return {
    ok: true,
    data: item,
    recordTimestamp: closestRecord.timestamp,
    timeDiffSec: (closestRecord.timestamp - targetTimeMs) / 1000
  };
}

export function clearMarsedgeHistoryBefore(timestampSec) {
  if (!timestampSec) {
      marsedgeHistory = [];
      return;
  }
  const targetMs = timestampSec * 1000;
  marsedgeHistory = marsedgeHistory.filter(h => h.timestamp > targetMs);
}

export function getMarsedgeState() {
  return latestMarsedgeData;
}
