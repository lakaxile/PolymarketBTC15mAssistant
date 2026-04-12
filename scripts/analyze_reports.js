const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'reports');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();

const buckets = {};
const dBuckets = { UP: {}, DOWN: {} };
const pBuckets = {};
const daily = [];

for (const file of files) {
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
  const dm = file.match(/report_(\d{4}-\d{2}-\d{2})/);
  const date = dm ? dm[1] : file;
  let dayPnL = 0, dayT = 0, dayW = 0;

  for (const line of lines) {
    const p = line.split('|').map(s => s.trim()).filter(s => s && s !== ':---' && s !== '---');
    if (p.length === 6 && /^\d{2}:\d{2}/.test(p[0])) {
      const dir_ = p[1];
      const confNum = parseFloat(p[2]);
      const pnlNum = parseFloat(p[4]);
      const priceNum = parseFloat(p[3].replace('$', ''));
      if (isNaN(confNum) || isNaN(pnlNum)) continue;

      const lo = Math.floor(confNum / 10) * 10;
      const b = lo + '%-' + (lo + 10) + '%';

      if (!buckets[b]) buckets[b] = { t: 0, w: 0, pnl: 0 };
      buckets[b].t++;
      if (pnlNum > 0) buckets[b].w++;
      buckets[b].pnl += pnlNum;

      if (!dBuckets[dir_]) dBuckets[dir_] = {};
      if (!dBuckets[dir_][b]) dBuckets[dir_][b] = { t: 0, w: 0, pnl: 0 };
      dBuckets[dir_][b].t++;
      if (pnlNum > 0) dBuckets[dir_][b].w++;
      dBuckets[dir_][b].pnl += pnlNum;

      const plo = Math.floor(priceNum * 10) / 10;
      const pb = plo.toFixed(1) + '-' + (plo + 0.1).toFixed(1);
      if (!pBuckets[pb]) pBuckets[pb] = { t: 0, w: 0, pnl: 0 };
      pBuckets[pb].t++;
      if (pnlNum > 0) pBuckets[pb].w++;
      pBuckets[pb].pnl += pnlNum;

      dayPnL += pnlNum;
      dayT++;
      if (pnlNum > 0) dayW++;
    }
  }
  if (dayT > 0) daily.push({ date, t: dayT, w: dayW, pnl: dayPnL });
}

const sb = Object.keys(buckets).sort((a, b) => parseInt(a) - parseInt(b));

console.log('=== 置信度挡位总体 ===');
for (const b of sb) {
  const d = buckets[b];
  const wr = (d.w / d.t * 100).toFixed(1);
  const avg = (d.pnl / d.t).toFixed(2);
  console.log(b + '\t' + d.t + '笔\t胜率' + wr + '%\t总PnL:' + d.pnl.toFixed(2) + 'u\t均:' + avg + 'u');
}

console.log('\n=== UP各挡位 ===');
for (const b of sb) {
  const d = dBuckets.UP[b];
  if (!d || !d.t) continue;
  const wr = (d.w / d.t * 100).toFixed(1);
  console.log(b + ': ' + d.t + '笔 胜率' + wr + '% 总:' + d.pnl.toFixed(2) + 'u 均:' + (d.pnl / d.t).toFixed(2) + 'u');
}

console.log('\n=== DOWN各挡位 ===');
for (const b of sb) {
  const d = dBuckets.DOWN[b];
  if (!d || !d.t) continue;
  const wr = (d.w / d.t * 100).toFixed(1);
  console.log(b + ': ' + d.t + '笔 胜率' + wr + '% 总:' + d.pnl.toFixed(2) + 'u 均:' + (d.pnl / d.t).toFixed(2) + 'u');
}

console.log('\n=== 价格区间 (0.1档) ===');
const spb = Object.keys(pBuckets).sort((a, b) => parseFloat(a) - parseFloat(b));
for (const b of spb) {
  const d = pBuckets[b];
  const wr = (d.w / d.t * 100).toFixed(1);
  console.log('$' + b + ': ' + d.t + '笔 胜率' + wr + '% PnL:' + d.pnl.toFixed(2) + 'u');
}

console.log('\n=== 日期汇总 ===');
let tot = 0;
for (const d of daily) {
  tot += d.pnl;
  const wr = (d.w / d.t * 100).toFixed(1);
  const sign = d.pnl >= 0 ? '+' : '';
  console.log(d.date + ': ' + d.t + '笔 胜率' + wr + '% PnL:' + sign + d.pnl.toFixed(2) + 'u');
}
console.log('累计总PnL: ' + tot.toFixed(2) + 'u');
