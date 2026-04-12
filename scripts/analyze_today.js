import fs from 'fs';

const data = fs.readFileSync('/tmp/today_trades.csv', 'utf-8');
const lines = data.split('\n').filter(l => l.trim().length > 0);

let totalProfit = 0;
let totalTrades = 0;
let wins = 0;
let losses = 0;

const strategyStats = {};

for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 11) continue;

    // Use from back because of commas in the title string
    const strategy = parts[parts.length - 8];
    const result = parts[parts.length - 2];
    const pnl = parseFloat(parts[parts.length - 1]);

    if (isNaN(pnl)) continue;

    totalProfit += pnl;
    totalTrades++;

    if (pnl > 0) wins++;
    else if (pnl < 0) losses++;

    if (!strategyStats[strategy]) {
        strategyStats[strategy] = { pnl: 0, trades: 0, wins: 0, losses: 0 };
    }

    strategyStats[strategy].pnl += pnl;
    strategyStats[strategy].trades++;
    if (pnl > 0) strategyStats[strategy].wins++;
    else if (pnl < 0) strategyStats[strategy].losses++;
}

console.log("=== TODAY'S PNL REPORT ===");
console.log(`Total Trades: ${totalTrades}`);
console.log(`Gross PnL: $${totalProfit.toFixed(2)}`);
console.log(`Overall Win Rate: ${((wins / (wins + losses)) * 100).toFixed(1)}% (${wins}W / ${losses}L)`);
console.log("\n=== BY STRATEGY ===");
for (const [strat, stats] of Object.entries(strategyStats)) {
    console.log(`[${strat}] Trades: ${stats.trades} | PnL: $${stats.pnl.toFixed(2)} | WR: ${((stats.wins / (stats.wins + stats.losses || 1)) * 100).toFixed(1)}%`);
}
