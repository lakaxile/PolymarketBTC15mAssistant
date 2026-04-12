import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPORTS_DIR = path.join(__dirname, '../reports');

function parseReports() {
    const files = fs.readdirSync(REPORTS_DIR).filter(f => f === 'report_2026-04-08.md');
    const allTrades = [];

    files.forEach(file => {
        const content = fs.readFileSync(path.join(REPORTS_DIR, file), 'utf8');
        const lines = content.split('\n');
        let inTable = false;

        for (let line of lines) {
            if (line.includes('## 📄 当日所有交易明细')) {
                inTable = true;
                continue;
            }
            if (inTable && line.trim().startsWith('|')) {
                const parts = line.split('|').map(p => p.trim()).filter(p => p);
                // Skip header and separator
                if (parts[0] === '时间' || parts[0].includes('---')) continue;
                
                if (parts.length >= 5) {
                    const direction = parts[1]; // UP / DOWN
                    const confidenceStr = parts[2].replace('%', '');
                    const confidence = parseFloat(confidenceStr);
                    const pnlStr = parts[4].replace('u', '').replace('$', '').replace(/[, ]/g, '');
                    const pnl = parseFloat(pnlStr);
                    
                    if (!isNaN(confidence) && !isNaN(pnl)) {
                        allTrades.push({ direction, confidence, pnl });
                    }
                }
            } else if (inTable && line.trim() === '' && allTrades.length > 0) {
                // Potential end of table, but keep looking just in case
                // For simplicity, we just keep parsing if it looks like a table
            }
        }
    });

    return allTrades;
}

function analyze(trades) {
    const buckets = {};

    trades.forEach(t => {
        const bucketKey = Math.floor(t.confidence / 10) * 10;
        const dirKey = t.direction;
        const key = `${bucketKey}_${dirKey}`;

        if (!buckets[key]) {
            buckets[key] = {
                bucket: bucketKey,
                direction: dirKey,
                wins: 0,
                losses: 0,
                winSum: 0,
                lossSum: 0,
                count: 0
            };
        }

        const stats = buckets[key];
        stats.count++;
        if (t.pnl > 0) {
            stats.wins++;
            stats.winSum += t.pnl;
        } else if (t.pnl < 0) {
            stats.losses++;
            stats.lossSum += t.pnl;
        }
    });

    const results = Object.values(buckets).map(s => {
        const avgWin = s.wins > 0 ? s.winSum / s.wins : 0;
        const avgLoss = s.losses > 0 ? Math.abs(s.lossSum / s.losses) : 0;
        const pnlRatio = avgLoss > 0 ? avgWin / avgLoss : (s.wins > 0 ? Infinity : 0);
        const winRate = s.count > 0 ? (s.wins / s.count * 100).toFixed(1) + '%' : '0%';
        
        return {
            ...s,
            avgWin,
            avgLoss,
            pnlRatio,
            winRate
        };
    });

    // Sort by bucket descending, then direction
    results.sort((a, b) => {
        if (b.bucket !== a.bucket) return b.bucket - a.bucket;
        return a.direction.localeCompare(b.direction);
    });

    return results;
}

function printTable(results) {
    console.log('# UP/DOWN 盈亏比分析 (分置信度)');
    console.log('');
    console.log('| 置信度区间 | 方向 | 笔数 | 胜率 | 平均获利 | 平均亏损 | 盈亏比 |');
    console.log('| :--- | :--- | :--- | :--- | :--- | :--- | :--- |');

    results.forEach(r => {
        const bucketRange = `${r.bucket}% - ${r.bucket + 10}%`;
        const pnlRatioStr = r.pnlRatio === Infinity ? '∞' : r.pnlRatio.toFixed(2);
        console.log(`| ${bucketRange} | ${r.direction} | ${r.count} | ${r.winRate} | ${r.avgWin.toFixed(2)}u | ${r.avgLoss.toFixed(2)}u | **${pnlRatioStr}** |`);
    });
}

const trades = parseReports();
const results = analyze(trades);
printTable(results);
