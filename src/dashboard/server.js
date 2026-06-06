import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { STRATEGY } from '../engine/signal.js';

// Get current directory path in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');

const PORT = 3030;

// Simple .env parser to get keys
function getEnv() {
  const env = {};
  try {
    const envPath = path.join(PROJECT_ROOT, '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        const match = trimmed.match(/^([^#\s][^=]*)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          let val = match[2].trim();
          if (val.includes('#')) {
            val = val.split('#')[0].trim();
          }
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1).trim();
          }
          env[key] = val;
        }
      });
    }
  } catch (e) {
    console.error('Error reading .env file:', e.message);
  }
  return env;
}

// Derive EOA address from private key
function getWalletDetails(env) {
  let eoaAddress = 'Unknown EOA';
  const proxyAddress = env.POLY_PROXY_ADDRESS || '';
  
  try {
    const pKey = env.POLY_WALLET_KEY || env.POLYGON_PRIVATE_KEY;
    if (pKey) {
      const wallet = new ethers.Wallet(pKey);
      eoaAddress = wallet.address;
    }
  } catch (e) {
    console.error('Error deriving wallet address:', e.message);
  }
  
  return { eoa: eoaAddress, proxy: proxyAddress };
}

// Parse CSV line, respecting double quotes
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Parse live_trades.csv (15m trades)
function getTrades15m() {
  const filePath = path.join(PROJECT_ROOT, 'logs/live_trades.csv');
  if (!fs.existsSync(filePath)) {
    return [];
  }
  
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim().length > 0);
    if (lines.length < 2) return [];
    
    const headers = parseCsvLine(lines[0]);
    const trades = [];
    
    for (let i = 1; i < lines.length; i++) {
      const row = parseCsvLine(lines[i]);
      if (row.length < headers.length) continue;
      
      const trade = {};
      headers.forEach((h, index) => {
        let val = row[index];
        // Parse numbers if applicable
        if (val && !isNaN(val) && val.trim() !== '') {
          val = parseFloat(val);
        }
        trade[h] = val;
      });
      trades.push(trade);
    }
    
    return trades;
  } catch (e) {
    console.error('Error parsing live_trades.csv:', e.message);
    return [];
  }
}

// Parse orders.jsonl (5m trades)
function getTrades5m() {
  const filePath = path.join(PROJECT_ROOT, 'logs/orders.jsonl');
  if (!fs.existsSync(filePath)) {
    return [];
  }
  
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim().length > 0);
    const trades = [];
    
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // We are interested in actual settlements or filled entries
        trades.push(entry);
      } catch (err) {
        // Skip malformed lines
      }
    }
    return trades;
  } catch (e) {
    console.error('Error parsing orders.jsonl:', e.message);
    return [];
  }
}

// Main API Handler
function handleApiStats(req, res) {
  const env = getEnv();
  const wallet = getWalletDetails(env);
  const trades15m = getTrades15m();
  const trades5m = getTrades5m();
  
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({
    ok: true,
    wallet,
    trades15m,
    trades5m,
    strategy: STRATEGY,
  }));
}

// Update strategy parameters API handler
function handleUpdateStrategy(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const btc = parseFloat(urlObj.searchParams.get('btc'));
    const eth = parseFloat(urlObj.searchParams.get('eth'));
    
    let updated = false;
    if (!isNaN(btc)) {
      STRATEGY.minPriceChangePct = btc;
      updated = true;
    }
    if (!isNaN(eth)) {
      STRATEGY.minPriceChangePctEth = eth;
      updated = true;
    }
    
    if (updated) {
      // Persist to logs/strategy_config.json
      const configPath = path.join(PROJECT_ROOT, 'logs/strategy_config.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        minPriceChangePct: STRATEGY.minPriceChangePct,
        minPriceChangePctEth: STRATEGY.minPriceChangePctEth,
      }, null, 2), 'utf8');
      
      console.log(`[Dashboard] Strategy updated via UI: BTC=${STRATEGY.minPriceChangePct}%, ETH=${STRATEGY.minPriceChangePctEth}%`);
      res.end(JSON.stringify({ ok: true, strategy: STRATEGY }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid btc or eth parameters' }));
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}

// Wallet analysis: fetch on-chain history and compute per-price win rates
const WALLET_ADDRESS = '0x17deA5a4fCC9056eDC127Bb6b0aC931c87aCcB7B';
const ACTIVITY_API = `https://data-api.polymarket.com/activity?user=${WALLET_ADDRESS}&limit=500`;

// Simple in-memory cache to avoid hammering the API
let walletCache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 60_000; // 60 seconds

async function fetchWalletActivity() {
  const now = Date.now();
  if (walletCache.data && (now - walletCache.fetchedAt) < CACHE_TTL_MS) {
    return walletCache.data;
  }
  const res = await fetch(ACTIVITY_API, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Activity API responded ${res.status}`);
  const data = await res.json();
  walletCache = { data, fetchedAt: Date.now() };
  return data;
}

function analyzeWallet(activities) {
  // Separate TRADEs and REDEEMs
  const trades = activities.filter(a => a.type === 'TRADE' && a.side === 'BUY');
  const redeems = new Set(activities.filter(a => a.type === 'REDEEM').map(a => a.conditionId));

  // Filter BTC and ETH by slug or title
  function getSymbol(item) {
    const slug = (item.slug || '').toLowerCase();
    const title = (item.title || '').toLowerCase();
    if (slug.startsWith('btc') || title.includes('bitcoin')) return 'BTC';
    if (slug.startsWith('eth') || title.includes('ethereum')) return 'ETH';
    return null;
  }

  // Build per-symbol result
  const result = { BTC: { trades: [], priceBreakdown: [] }, ETH: { trades: [], priceBreakdown: [] } };

  for (const t of trades) {
    const symbol = getSymbol(t);
    if (!symbol) continue;

    const hasRedeem = redeems.has(t.conditionId);
    // Treat as unresolved if timestamp is within last 10 minutes
    const ageSecs = Math.floor(Date.now() / 1000) - (t.timestamp || 0);
    const isUnresolved = ageSecs < 600 && !hasRedeem;

    const entry = {
      timestamp: t.timestamp,
      conditionId: t.conditionId,
      title: t.title || '',
      slug: t.slug || '',
      outcome: t.outcome || '',
      price: t.price || 0,
      size: t.size || 0,
      usdcSize: t.usdcSize || 0,
      won: hasRedeem,
      unresolved: isUnresolved,
      pnl: hasRedeem
        ? parseFloat(((1 - t.price) * t.size).toFixed(4))
        : (isUnresolved ? null : parseFloat((-(t.price * t.size)).toFixed(4)))
    };
    result[symbol].trades.push(entry);
  }

  // Compute price breakdown for each symbol
  for (const symbol of ['BTC', 'ETH']) {
    const settled = result[symbol].trades.filter(t => !t.unresolved);
    const priceMap = {};
    for (const t of settled) {
      const key = t.price.toFixed(2);
      if (!priceMap[key]) priceMap[key] = { price: t.price, total: 0, wins: 0, totalUsdc: 0 };
      priceMap[key].total++;
      priceMap[key].totalUsdc += t.usdcSize;
      if (t.won) priceMap[key].wins++;
    }
    result[symbol].priceBreakdown = Object.values(priceMap)
      .sort((a, b) => a.price - b.price)
      .map(p => ({
        price: p.price,
        total: p.total,
        wins: p.wins,
        losses: p.total - p.wins,
        winRate: p.total > 0 ? parseFloat(((p.wins / p.total) * 100).toFixed(1)) : 0,
        totalUsdc: parseFloat(p.totalUsdc.toFixed(2))
      }));

    // Summary stats
    const s = settled;
    const wins = s.filter(t => t.won).length;
    const pnl = s.reduce((acc, t) => acc + (t.pnl || 0), 0);
    result[symbol].summary = {
      total: s.length,
      wins,
      losses: s.length - wins,
      unresolved: result[symbol].trades.filter(t => t.unresolved).length,
      winRate: s.length > 0 ? parseFloat(((wins / s.length) * 100).toFixed(1)) : 0,
      totalPnl: parseFloat(pnl.toFixed(4))
    };
  }

  return result;
}

async function handleWalletAnalysis(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const activities = await fetchWalletActivity();
    const analysis = analyzeWallet(activities);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, address: WALLET_ADDRESS, ...analysis }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}

// File server handler (with directory traversal protection)
function handleStaticFile(req, res) {
  let reqPath = req.url === '/' ? '/index.html' : req.url;
  
  // Basic query param stripper
  if (reqPath.includes('?')) {
    reqPath = reqPath.split('?')[0];
  }
  
  const publicDir = path.join(__dirname, 'public');
  const safeFilePath = path.normalize(path.join(publicDir, reqPath));
  
  // Security check: prevent directory traversal
  if (!safeFilePath.startsWith(publicDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden: Access Denied');
    return;
  }
  
  if (!fs.existsSync(safeFilePath) || fs.statSync(safeFilePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found: File does not exist');
    return;
  }
  
  // Get content type
  let ext = path.extname(safeFilePath).toLowerCase();
  let contentType = 'text/html';
  switch (ext) {
    case '.css':
      contentType = 'text/css';
      break;
    case '.js':
      contentType = 'application/javascript';
      break;
    case '.json':
      contentType = 'application/json';
      break;
    case '.png':
      contentType = 'image/png';
      break;
    case '.jpg':
    case '.jpeg':
      contentType = 'image/jpeg';
      break;
    case '.svg':
      contentType = 'image/svg+xml';
      break;
    case '.ico':
      contentType = 'image/x-icon';
      break;
  }
  
  try {
    const fileStream = fs.createReadStream(safeFilePath);
    res.writeHead(200, { 'Content-Type': contentType });
    fileStream.pipe(res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`500 Internal Server Error: ${e.message}`);
  }
}

// Create HTTP server and export as a startable function
export function startDashboardServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/stats')) {
      handleApiStats(req, res);
    } else if (req.url.startsWith('/api/update-strategy')) {
      handleUpdateStrategy(req, res);
    } else if (req.url.startsWith('/api/wallet-analysis')) {
      handleWalletAnalysis(req, res);
    } else {
      handleStaticFile(req, res);
    }
  });

  server.on('error', (err) => {
    console.error(`[Dashboard] Server error: ${err.message}`);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Polymarket Trading Performance Dashboard is running!`);
    console.log(`👉 Access URL: http://0.0.0.0:${PORT}`);
    console.log(`======================================================\n`);
  });
}
