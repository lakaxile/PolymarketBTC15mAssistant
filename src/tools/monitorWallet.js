import { startMarsedgeStream, getMarsedgePredictionAtTime, clearMarsedgeHistoryBefore } from '../data/marsedgeWs.js';
import { fetchLivePriceFromFun, fetchExactPriceToBeat } from '../data/polymarket.js';
import { fetchChainlinkPriceAtTimestamp } from '../data/chainlink.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_FILE = path.resolve(__dirname, '../../logs/wallet_monitor_btc_90.log');
const DATA_FILE = path.resolve(__dirname, '../../logs/wallet_monitor_data.jsonl');
const ALL_ACTIVITY_FILE = path.resolve(__dirname, '../../logs/all_wallet_activities.jsonl');

const WALLET = '0x17deA5a4fCC9056eDC127Bb6b0aC931c87aCcB7B';
const API_URL = `https://data-api.polymarket.com/activity?user=${WALLET}&limit=100`;

let seenIds = new Set();

function logMsg(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}`;
    console.log(line);
    fs.appendFileSync(LOG_FILE, line + '\n');
}

async function checkWalletActivity() {
    try {
        const res = await fetch(API_URL, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) return;
        const activities = await res.json();
        // console.log(`[DEBUG] Fetched ${activities.length} activities. Top: ${activities[0]?.title}`);
        fs.writeFileSync('debug_titles.txt', activities.map(a => `${a.type} | ${a.side} | ${a.title} | ${a.price}`).join('\n'));
        
        for (let i = activities.length - 1; i >= 0; i--) {
            const a = activities[i];
            const uniqueId = a.transactionHash || `${a.timestamp}-${a.conditionId}`;
            if (seenIds.has(uniqueId)) continue;
            seenIds.add(uniqueId);
            
            // 保存所有新抓取到的原始活动记录
            fs.appendFileSync(ALL_ACTIVITY_FILE, JSON.stringify(a) + '\n');
            
            if (a.type !== 'TRADE' || a.side !== 'BUY') continue;
            
            const slug = (a.slug || '').toLowerCase();
            const title = (a.title || '').toLowerCase();
            // Also match 'X:XXam-X:XXam' time window format (e.g. '5:40AM-5:45AM ET')
            const hasFiveMinWindow = /\d{1,2}:\d{2}[ap]m-\d{1,2}:\d{2}[ap]m/i.test(a.title || '');
            const isBtc5m = (slug.startsWith('btc') || title.includes('bitcoin')) &&
                            (slug.includes('5m') || title.includes('5m') || title.includes('5 min') || hasFiveMinWindow);
            const isEth5m = (slug.startsWith('eth') || title.includes('ethereum')) &&
                            (slug.includes('5m') || title.includes('5m') || title.includes('5 min') || hasFiveMinWindow);
            
            if (!isBtc5m && !isEth5m) continue;
            if (a.price <= 0.85) continue;
            
            // 满足条件：买入，且价格 > 0.85
            const symbol = isEth5m ? "ETH" : "BTC";
            console.log(`[DEBUG] Found matching ${symbol} trade: ${a.title} - Price: ${a.price}`);
            await processTrade(a);
        }
        // console.log(`[DEBUG] Fetched ${activities.length} activities, seen ${seenIds.size} so far.`);
    } catch (e) {
        console.error("Error fetching activity:", e.message);
    }
}

async function processTrade(a) {
    // 等待 1 秒以确保拿到最新的 Marsedge 推流数据 (或让历史缓存累积)
    await new Promise(r => setTimeout(r, 1000));
    
    const slug = (a.slug || '').toLowerCase();
    const title = (a.title || '').toLowerCase();
    const isEth = slug.startsWith('eth') || title.includes('ethereum');
    const symbol = isEth ? "ETH" : "BTC";
    
    const pred = getMarsedgePredictionAtTime(symbol, a.timestamp);
    let modelProb = "N/A";
    let polyPrice = "N/A";
    
    const slugMatch = (a.slug || '').match(/-(\d{10})$/);
    const tradeSlot = slugMatch ? Number(slugMatch[1]) : null;

    if (pred.ok && pred.data) {
        if (tradeSlot && pred.data.slot && tradeSlot !== Number(pred.data.slot)) {
            modelProb = "N/A (历史补录单，Marsedge推流已进入下一轮市场)";
            polyPrice = "N/A";
        } else {
            const isUp = (a.outcome || '').toLowerCase() === 'up' || (a.outcome || '').toLowerCase() === 'yes';
            modelProb = isUp ? pred.data.p_up_pct : pred.data.p_down_pct;
            if (modelProb !== undefined) modelProb = Number(modelProb).toFixed(2) + '%';
            
            // Marsedge board Polymarket price 
            polyPrice = isUp ? pred.data.up_ask : pred.data.down_ask;
        }
    }
    
    const ptb = await fetchExactPriceToBeat(a.slug);
    
    // 获取下注瞬间的精确 BTC / ETH 链上价格，而非当前最新价格
    const curPrice = await fetchChainlinkPriceAtTimestamp(a.timestamp, symbol);
    
    let diff = "N/A";
    if (ptb && curPrice) {
        diff = (curPrice - ptb).toFixed(2);
    }
    
    const betTime = new Date(a.timestamp * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET';
    const match = (a.title || '').match(/(\d{1,2}:\d{2}[AP]M-\d{1,2}:\d{2}[AP]M ET)/i);
    const timeRange = match ? match[1] : 'Unknown';
    
    const delaySec = Math.floor(Date.now() / 1000) - a.timestamp;
    const modelTimeDiff = pred.timeDiffSec !== undefined ? pred.timeDiffSec.toFixed(1) : "N/A";
    const delayTag = delaySec > 30 ? ` (API延迟: ${delaySec}秒 | Model匹配时差: ${modelTimeDiff}秒)` : ` (Model匹配时差: ${modelTimeDiff}秒)`;
    
    const msg = `
=========================================
🚨 [NEW ${symbol} BET > 0.85] 🚨
钱包: ${WALLET}
下注时间: ${betTime}
抓取延迟: ${delaySec}秒
时间段: ${timeRange}
市场标题: ${a.title}
方向: ${a.outcome}
买入价格: ${a.price}
份数: ${a.size} (USDC: $${a.usdcSize.toFixed(2)})

[环境数据${delayTag}]
Model概率 (Marsdge): ${modelProb}
Poly价格 (Marsdge): ${polyPrice !== "N/A" ? polyPrice : (modelProb.includes('历史') ? 'N/A' : a.price)}
下注时${symbol}价格 (Exact Price): $${curPrice || 'N/A'}
Price to Beat: $${ptb || 'N/A'}
价格差值 (Exact - PTB): $${diff}
=========================================`;

    logMsg(msg);
    
    // 保存结构化数据以便后期分析
    const dataToSave = {
        wallet: WALLET,
        timestamp: a.timestamp,
        betTime: betTime,
        delaySec: delaySec,
        timeRange: timeRange,
        title: a.title,
        outcome: a.outcome,
        price: a.price,
        size: a.size,
        usdcSize: a.usdcSize,
        modelProb: modelProb,
        polyPrice: polyPrice !== "N/A" ? polyPrice : (modelProb.includes('历史') ? 'N/A' : a.price),
        curPrice: curPrice,
        ptb: ptb,
        diff: diff,
        transactionHash: a.transactionHash,
        conditionId: a.conditionId,
        slug: a.slug,
        modelTimeDiff: modelTimeDiff
    };
    fs.appendFileSync(DATA_FILE, JSON.stringify(dataToSave) + '\n');
    
    // 抓取完后删除历史缓存数据，节省内存
    clearMarsedgeHistoryBefore(a.timestamp);
}

// 初始化
console.log("启动钱包监控 (BTC/ETH > $0.85) ...");
startMarsedgeStream();

// 每 5 秒轮询一次
setInterval(checkWalletActivity, 5000);
checkWalletActivity();
