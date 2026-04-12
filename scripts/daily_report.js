import fs from 'fs';
import path from 'path';

/**
 * 自动生成每日交易诊断报告 (超轻量版，无依赖)
 * 修复了 CSV 解析器对引号中逗号的处理
 */
async function generateDailyReport() {
    const logFile = './logs/live_trades.csv';
    const reportDir = './reports';
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir);

    if (!fs.existsSync(logFile)) {
        console.log("No log file found.");
        return;
    }

    const raw = fs.readFileSync(logFile, 'utf-8');
    const lines = raw.trim().split('\n');
    if (lines.length < 2) return;

    const parseCsvLine = (line) => {
        const result = [];
        let cur = '';
        let inQuote = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuote = !inQuote;
            } else if (char === ',' && !inQuote) {
                result.push(cur.trim());
                cur = '';
            } else {
                cur += char;
            }
        }
        result.push(cur.trim());
        return result;
    };

    const header = parseCsvLine(lines[0]);
    const records = lines.slice(1).map(line => {
        const parts = parseCsvLine(line);
        const obj = {};
        header.forEach((h, i) => {
            if (h) obj[h] = parts[i];
        });
        return obj;
    });

    // --- 按日期分组交易 ---
    const tradesByDate = {};
    records.forEach(r => {
        if (!r.Time) return;
        // 提取日期部分 (YYYY-MM-DD 或 YYYY/MM/DD)
        const datePart = r.Time.split(' ')[0].replace(/\//g, '-');
        if (!tradesByDate[datePart]) tradesByDate[datePart] = [];
        tradesByDate[datePart].push(r);
    });

    const dates = Object.keys(tradesByDate).sort();
    let summaryList = [];

    for (const dateStr of dates) {
        const dayTrades = tradesByDate[dateStr];
        let totalPnL = 0;
        let wins = 0;
        const bucketStats = {};

        dayTrades.forEach(t => {
            const pnlStr = t.Profit || t.profit || "0";
            const pnl = parseFloat(pnlStr.replace(/[^0-9.-]/g, '')) || 0;
            totalPnL += pnl;

            const result = (t.Result || t.result || "").toUpperCase();
            const isWin = result.includes("WIN") || result.includes("SCALPED") || pnl > 0;
            if (isWin) wins++;

            const confStr = t.EntryConf || t.TAProb || t.MarketOdds || "-";
            const conf = parseFloat(confStr);
            if (isNaN(conf)) return;

            const bucket = Math.floor(conf / 10) * 10;
            const bucketKey = `${bucket}% - ${bucket + 10}%`;

            if (!bucketStats[bucketKey]) {
                bucketStats[bucketKey] = { count: 0, wins: 0, pnl: 0, prices: [] };
            }
            bucketStats[bucketKey].count++;
            if (isWin) bucketStats[bucketKey].wins++;
            bucketStats[bucketKey].pnl += pnl;
            
            const priceStr = t.EntryPrice || t.price || "0";
            bucketStats[bucketKey].prices.push(parseFloat(priceStr) || 0);
        });

        // 统一文件名格式: report_YYYY-MM-DD.md
        // 处理日期兼容性: MM-DD-YYYY 转换为 YYYY-MM-DD
        let formattedDate;
        if (dateStr.includes(',')) {
            // 格式: 04-09-2026, -> 2026-04-09
            const parts = dateStr.replace(',', '').split('-');
            formattedDate = `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
        } else {
            // 格式: YYYY-MM-DD 或 YYYY-M-D -> YYYY-MM-DD
            formattedDate = dateStr.split('-').map(p => p.padStart(2, '0')).join('-');
        }
        const reportPath = path.join(reportDir, `report_${formattedDate}.md`);

        let md = `# Polymarket BTC 15m 交易诊断报告 (${formattedDate})\n\n`;
        md += `## 🕒 概览\n`;
        md += `- **当日总成交笔数**: ${dayTrades.length}\n`;
        md += `- **当日总盈亏 (PnL)**: **${totalPnL.toFixed(2)}u**\n`;
        md += `- **当日胜率**: ${((wins / dayTrades.length) * 100).toFixed(1)}%\n\n`;

        md += `## 📊 分置信度表现\n`;
        md += `| 置信度区间 | 笔数 | 胜率 | 平均价 | 净盈亏 |\n`;
        md += `| :--- | :--- | :--- | :--- | :--- |\n`;

        Object.keys(bucketStats).sort((a,b) => parseInt(a) - parseInt(b)).forEach(k => {
            const s = bucketStats[k];
            const wr = ((s.wins / s.count) * 100).toFixed(1);
            const ap = (s.prices.length ? (s.prices.reduce((a, b) => a + b, 0) / s.prices.length) : 0).toFixed(4);
            md += `| ${k} | ${s.count} | ${wr}% | $${ap} | **${s.pnl.toFixed(2)}u** |\n`;
        });

        md += `\n## 📄 当日所有交易明细\n`;
        md += `| 时间 | 方向 | 置信度 | 价格 | 盈亏 | 结果 |\n`;
        md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
        dayTrades.reverse().forEach(t => {
            const timeVal = t.Time?.split(' ')[1] || (t.Time?.includes('T') ? t.Time.split('T')[1].slice(0,8) : '-');
            const confVal = t.EntryConf || t.TAProb || t.MarketOdds || '-';
            const priceVal = t.EntryPrice || t.price || '-';
            md += `| ${timeVal} | ${t.Side} | ${confVal}% | $${priceVal} | ${t.Profit}u | ${t.Result} |\n`;
        });

        fs.writeFileSync(reportPath, md);
        summaryList.push(`✅ 已更新 [${formattedDate}]: ${dayTrades.length} 笔交易, PnL: ${totalPnL.toFixed(2)}u`);
    }

    return summaryList.join('\n');
}

if (process.argv[1]?.endsWith('daily_report.js')) {
    generateDailyReport().then(console.log).catch(console.error);
}

export { generateDailyReport };
