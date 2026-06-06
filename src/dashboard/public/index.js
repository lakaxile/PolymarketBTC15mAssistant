// Polymarket Trading Performance Dashboard - Frontend Controller (BTC 5m & ETH 5m)

let rawData = {
  wallet: { eoa: '加载中...', proxy: '加载中...' },
  trades5m: [],
  trades15m: []
};

let currentTab = 'btc5m'; // Default is btc5m
let filterExactStartMs = 0; // Precise timestamp filter (e.g. for "from recent trade")
let pnlChart = null; // Chart.js instance

// Helper function to safely escape strings for HTML
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}

// Convert date string/number to localized Beijing Time string
function formatBeijingTime(dateInput) {
  if (!dateInput) return '-';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return dateInput;
  
  const pad = (n) => String(n).padStart(2, '0');
  
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  
  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
}

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  fetchStats(true); // First load
  
  // Poll every 5 seconds for live updates
  setInterval(fetchStats, 5000);
});

// Setup Event Listeners
function setupEventListeners() {
  // Tabs toggle
  document.getElementById('toggle-btc5m').addEventListener('click', () => {
    switchTab('btc5m');
  });
  
  document.getElementById('toggle-eth5m').addEventListener('click', () => {
    switchTab('eth5m');
  });
  
  // Date filter inputs
  document.getElementById('filter-start-date').addEventListener('change', () => {
    filterExactStartMs = 0; // Clear precise timestamp when user picks a calendar date
    updateDashboard();
  });
  
  document.getElementById('filter-strategy').addEventListener('change', updateDashboard);
  document.getElementById('filter-side').addEventListener('change', updateDashboard);
  
  // Filter action buttons
  document.getElementById('btn-reset-date').addEventListener('click', () => {
    filterExactStartMs = 0;
    const defaultDate = currentTab === 'btc5m' ? '2026-05-19' : '2026-05-21';
    document.getElementById('filter-start-date').value = defaultDate;
    updateDashboard();
  });
  
  document.getElementById('btn-recent-trade').addEventListener('click', () => {
    setFilterToRecentTrade();
  });
  
  document.getElementById('btn-all-date').addEventListener('click', () => {
    filterExactStartMs = 0;
    document.getElementById('filter-start-date').value = '';
    updateDashboard();
  });

  // Config selectors for Amplitude
  const btcConfigSelect = document.getElementById('config-btc-amplitude');
  const ethConfigSelect = document.getElementById('config-eth-amplitude');
  
  if (btcConfigSelect) {
    btcConfigSelect.addEventListener('change', () => {
      const val = parseFloat(btcConfigSelect.value);
      updateStrategyOnServer(val, null);
    });
  }
  
  if (ethConfigSelect) {
    ethConfigSelect.addEventListener('change', () => {
      const val = parseFloat(ethConfigSelect.value);
      updateStrategyOnServer(null, val);
    });
  }
}

// Set start date filter precisely to the timestamp of the most recent trade in active timeframe
function setFilterToRecentTrade() {
  const symbol = currentTab === 'btc5m' ? 'BTC' : 'ETH';
  const settled = rawData.trades5m.filter(t => 
    (t.symbol || 'BTC').toUpperCase() === symbol &&
    t.mode === 'LIVE' &&
    (t.status === 'WIN' || t.status === 'LOSS')
  );
  
  if (settled.length > 0) {
    // Sort descending by time to find the newest
    const sorted = [...settled].sort((a, b) => new Date(b.ts || b.Time) - new Date(a.ts || a.Time));
    const mostRecent = sorted[0];
    const tradeTime = new Date(mostRecent.ts || mostRecent.Time).getTime();
    
    filterExactStartMs = tradeTime;
    document.getElementById('filter-start-date').value = ''; // Clear date input text to show exact status
    updateDashboard();
    console.log(`精准过滤起点: ${tradeTime} (${new Date(tradeTime).toLocaleString()})`);
  } else {
    alert('当前无可计算的实盘交易记录！');
  }
}

// Switch between BTC 5m and ETH 5m timeframes
function switchTab(tab) {
  if (currentTab === tab) return;
  currentTab = tab;
  
  // Update UI tabs
  document.getElementById('toggle-btc5m').classList.toggle('active', tab === 'btc5m');
  document.getElementById('toggle-eth5m').classList.toggle('active', tab === 'eth5m');
  
  // Strategy dropdown updates
  populateStrategyDropdown();
  
  // Set default filters based on tab
  const btnReset = document.getElementById('btn-reset-date');
  if (tab === 'btc5m') {
    filterExactStartMs = 0;
    document.getElementById('filter-start-date').value = '2026-05-19'; // Default BTC: May 19th
    btnReset.textContent = '从5/19起';
    btnReset.title = '重置为5月19号';
  } else if (tab === 'eth5m') {
    filterExactStartMs = 0;
    document.getElementById('filter-start-date').value = '2026-05-21'; // Default ETH: May 21st
    btnReset.textContent = '从5/21起';
    btnReset.title = '重置为5月21号';
  }
  
  updateDashboard();
}

// Fetch statistics from backend
async function fetchStats(isFirstLoad = false) {
  try {
    const response = await fetch('/api/stats');
    if (!response.ok) throw new Error('Network error fetching stats');
    const data = await response.json();
    
    if (data && data.ok) {
      rawData.wallet = data.wallet;
      rawData.trades5m = data.trades5m || [];
      rawData.trades15m = data.trades15m || []; // kept in background, unused by tabs now
      
      // Update header details
      updateWalletHeader();
      
      // Update strategy configuration UI selects
      if (data.strategy) {
        updateStrategyUI(data.strategy);
      }

      // Handle dropdown initialisation
      const currentStrategiesCount = document.getElementById('filter-strategy').options.length;
      if (currentStrategiesCount <= 1 || isFirstLoad) {
        populateStrategyDropdown();
      }
      
      // If first load of ETH 5m tab, auto-snap to most recent trade
      if (isFirstLoad && currentTab === 'eth5m') {
        switchTab('eth5m');
      } else {
        updateDashboard();
      }
    }
  } catch (err) {
    console.error('Error fetching statistics:', err);
  }
}

// Update settings selectors on load / sync
function updateStrategyUI(strategy) {
  const btcSelect = document.getElementById('config-btc-amplitude');
  const ethSelect = document.getElementById('config-eth-amplitude');
  
  if (btcSelect && strategy.minPriceChangePct !== undefined) {
    const targetVal = strategy.minPriceChangePct.toFixed(2);
    if (btcSelect.value !== targetVal) {
      btcSelect.value = targetVal;
    }
  }
  
  if (ethSelect && strategy.minPriceChangePctEth !== undefined) {
    const targetVal = strategy.minPriceChangePctEth.toFixed(2);
    if (ethSelect.value !== targetVal) {
      ethSelect.value = targetVal;
    }
  }
}

// Submit setting changes to server
async function updateStrategyOnServer(btcVal, ethVal) {
  try {
    let url = '/api/update-strategy?';
    if (btcVal !== null && btcVal !== undefined) {
      url += `btc=${btcVal}&`;
    }
    if (ethVal !== null && ethVal !== undefined) {
      url += `eth=${ethVal}&`;
    }
    
    if (url.endsWith('&') || url.endsWith('?')) {
      url = url.slice(0, -1);
    }
    
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to update strategy settings');
    const data = await response.json();
    if (data.ok) {
      console.log('Strategy updated:', data.strategy);
      showToast('⚠️ 交易参数已修改，机器人运行策略即时生效！');
    }
  } catch (err) {
    console.error('Error updating strategy settings:', err);
    alert('修改设置失败，请检查控制台或稍后重试。');
  }
}

// Show premium glassmorphic toast notification
function showToast(message) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  
  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  toast.textContent = message;
  
  container.appendChild(toast);
  
  // Trigger entry animation
  setTimeout(() => {
    toast.classList.add('show');
  }, 10);
  
  // Remove toast after duration
  setTimeout(() => {
    toast.classList.remove('show');
    toast.classList.add('hide');
    setTimeout(() => {
      toast.remove();
    }, 400);
  }, 3500);
}

// Update Wallet details
function updateWalletHeader() {
  const w = rawData.wallet;
  const proxyText = document.getElementById('wallet-proxy-text');
  const proxyLink = document.getElementById('wallet-proxy-link');
  
  if (w.proxy) {
    const shortened = `${w.proxy.slice(0, 6)}...${w.proxy.slice(-4)}`;
    proxyText.textContent = shortened;
    proxyLink.href = `https://polygonscan.com/address/${w.proxy}`;
    proxyLink.style.display = 'flex';
  } else {
    proxyText.textContent = '未配置 Proxy';
    proxyLink.removeAttribute('href');
  }
  
  const eoaText = document.getElementById('wallet-eoa-text');
  eoaText.textContent = w.eoa || '未知';
}

// Populate Strategy Dropdown based on active dataset
function populateStrategyDropdown() {
  const select = document.getElementById('filter-strategy');
  const currentValue = select.value;
  
  select.innerHTML = '<option value="ALL">全部策略</option>';
  
  const targetSymbol = currentTab === 'btc5m' ? 'BTC' : 'ETH';
  const dataset = rawData.trades5m.filter(t => (t.symbol || 'BTC').toUpperCase() === targetSymbol);
  
  const strategies = new Set();
  
  dataset.forEach(t => {
    const strat = t.Strategy || t.strategyType || 'MarsEdge 5m';
    strategies.add(strat);
  });
  
  Array.from(strategies).sort().forEach(s => {
    const option = document.createElement('option');
    option.value = s;
    option.textContent = s;
    select.appendChild(option);
  });
  
  if (Array.from(strategies).includes(currentValue)) {
    select.value = currentValue;
  }
}

// Parse and update stats, chart and log table
function updateDashboard() {
  const targetSymbol = currentTab === 'btc5m' ? 'BTC' : 'ETH';
  
  // Filter active dataset based on symbol
  const dataset = rawData.trades5m.filter(t => (t.symbol || 'BTC').toUpperCase() === targetSymbol);
  
  // Get filter inputs
  const filterStartDateStr = document.getElementById('filter-start-date').value;
  const filterStrategy = document.getElementById('filter-strategy').value;
  const filterSide = document.getElementById('filter-side').value;
  
  let filterStartMs = 0;
  if (filterStartDateStr) {
    filterStartMs = new Date(`${filterStartDateStr}T00:00:00+08:00`).getTime();
  }
  
  // Filter trades
  const filteredSettled = [];
  const filteredPending = [];
  
  dataset.forEach(t => {
    // 1. Time Filter
    const tradeTime = t.ts ? new Date(t.ts).getTime() : (t.Time ? new Date(t.Time).getTime() : 0);
    
    if (filterExactStartMs > 0) {
      // Precise timestamp filter
      if (tradeTime < filterExactStartMs) return;
    } else if (filterStartMs > 0) {
      // Day-level filter
      if (tradeTime < filterStartMs) return;
    }
    
    // 2. Strategy Filter
    const strat = t.Strategy || t.strategyType || 'MarsEdge 5m';
    if (filterStrategy !== 'ALL' && strat !== filterStrategy) return;
    
    // 3. Side Filter
    const side = (t.Side || t.direction || '').toUpperCase();
    if (filterSide !== 'ALL' && side !== filterSide) return;
    
    // Filter by LIVE mode (we only analyze real money transactions)
    if (t.mode === 'LIVE') {
      if (t.status === 'WIN' || t.status === 'LOSS') {
        filteredSettled.push(t);
      } else if (t.status === 'PENDING' || t.status === 'PARTIAL' || t.status === 'FILLED') {
        filteredPending.push(t);
      }
    }
  });
  
  // Sort chronologically for chart
  filteredSettled.sort((a, b) => {
    const timeA = a.ts ? new Date(a.ts).getTime() : (a.Time ? new Date(a.Time).getTime() : 0);
    const timeB = b.ts ? new Date(b.ts).getTime() : (b.Time ? new Date(b.Time).getTime() : 0);
    return timeA - timeB;
  });
  
  // Compute Stats
  calculateStats(filteredSettled);
  
  // Draw Chart
  drawPnLChart(filteredSettled);
  
  // Render Trades Log Table (descending chronological)
  const allFiltered = [...filteredPending, ...filteredSettled].sort((a, b) => {
    const timeA = a.ts ? new Date(a.ts).getTime() : (a.Time ? new Date(a.Time).getTime() : 0);
    const timeB = b.ts ? new Date(b.ts).getTime() : (b.Time ? new Date(b.Time).getTime() : 0);
    return timeB - timeA;
  });
  renderTradesTable(allFiltered);
  
  // Update date range header display
  updateDateRangeHeader(filteredSettled);
}

// Calculate statistical cards metrics
function calculateStats(settledTrades) {
  const total = settledTrades.length;
  let wins = 0;
  let totalPnl = 0;
  let grossWins = 0;
  let grossLosses = 0;
  
  settledTrades.forEach(t => {
    const pnl = parseFloat(t.pnl !== undefined ? t.pnl : 0);
    totalPnl += pnl;
    
    const isWin = t.status === 'WIN';
    if (isWin && pnl >= 0) {
      wins++;
      grossWins += pnl;
    } else {
      grossLosses += Math.abs(pnl);
    }
  });
  
  // 1. 笔数
  document.getElementById('stat-total-trades').textContent = total;
  
  // 2. 胜率
  const winRate = total > 0 ? (wins / total) * 100 : 0.0;
  document.getElementById('stat-win-rate').textContent = `${winRate.toFixed(1)}%`;
  
  // 3. 总盈亏
  const pnlCard = document.getElementById('stat-total-pnl');
  pnlCard.textContent = `${totalPnl >= 0 ? '+' : '-'}$${Math.abs(totalPnl).toFixed(2)}`;
  pnlCard.className = 'card-value ' + (totalPnl >= 0 ? 'value-green' : 'value-red');
  
  document.getElementById('chart-pnl-summary').textContent = `${totalPnl >= 0 ? '+' : '-'}$${Math.abs(totalPnl).toFixed(2)}`;
  document.getElementById('chart-pnl-summary').className = totalPnl >= 0 ? 'text-green' : 'text-red';
  
  // 4. 盈亏比 PF
  const pf = grossLosses > 0 ? (grossWins / grossLosses) : (grossWins > 0 ? Infinity : 1.00);
  const pfCard = document.getElementById('stat-profit-factor');
  pfCard.textContent = pf === Infinity ? '∞' : pf.toFixed(2);
  pfCard.className = 'card-value ' + (pf >= 1.0 ? 'value-green' : 'value-red');
  
  // 5. EV / TRADE
  const ev = total > 0 ? totalPnl / total : 0.0;
  const evCard = document.getElementById('stat-ev-trade');
  evCard.textContent = `${ev >= 0 ? '+' : '-'}$${Math.abs(ev).toFixed(4)}`;
  evCard.className = 'card-value ' + (ev >= 0 ? 'value-green' : 'value-red');
  
  // 6. 初始10U下单额的ROI
  const initialCapital = 10.0; // Both BTC 5m and ETH 5m have 10U order sizes
  const roi = (totalPnl / initialCapital) * 100;
  const roiCard = document.getElementById('stat-roi');
  roiCard.textContent = `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`;
  roiCard.className = 'card-value ' + (roi >= 0 ? 'value-green' : 'value-red');
}

// Update date range description in Header
function updateDateRangeHeader(settledTrades) {
  const display = document.getElementById('date-range-display');
  
  if (filterExactStartMs > 0) {
    if (settledTrades.length === 0) {
      display.textContent = '最新一笔交易起 (无后续成交) 北京';
      return;
    }
    const maxTrade = settledTrades[settledTrades.length - 1];
    const maxTime = maxTrade.ts ? new Date(maxTrade.ts) : new Date(maxTrade.Time);
    
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    display.textContent = `从最新单起 (${fmt(new Date(filterExactStartMs))}) ~ ${fmt(maxTime)} 北京`;
    return;
  }
  
  if (settledTrades.length === 0) {
    display.textContent = '无交易记录';
    return;
  }
  
  const minTrade = settledTrades[0];
  const maxTrade = settledTrades[settledTrades.length - 1];
  
  const minTime = minTrade.ts ? new Date(minTrade.ts) : new Date(minTrade.Time);
  const maxTime = maxTrade.ts ? new Date(maxTrade.ts) : new Date(maxTrade.Time);
  
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  display.textContent = `${fmt(minTime)} ~ ${fmt(maxTime)} 北京`;
}

// Draw the cumulative PnL Chart using Chart.js
function drawPnLChart(settledTrades) {
  const ctx = document.getElementById('pnlChart').getContext('2d');
  
  let runningPnl = 0;
  const chartLabels = [];
  const chartData = [];
  
  chartLabels.push('开始');
  chartData.push(0);
  
  settledTrades.forEach((t, i) => {
    const pnl = parseFloat(t.pnl !== undefined ? t.pnl : 0);
    runningPnl += pnl;
    
    const tStr = t.ts ? new Date(t.ts).toLocaleString() : t.Time;
    const dateObj = new Date(tStr);
    
    const shortLabel = isNaN(dateObj.getTime()) 
      ? tStr.slice(0, 10) 
      : `${String(dateObj.getMonth()+1).padStart(2,'0')}/${String(dateObj.getDate()).padStart(2,'0')} ${String(dateObj.getHours()).padStart(2,'0')}:${String(dateObj.getMinutes()).padStart(2,'0')}`;
    
    chartLabels.push(shortLabel);
    chartData.push(parseFloat(runningPnl.toFixed(2)));
  });
  
  if (pnlChart) {
    pnlChart.destroy();
  }
  
  const gradient = ctx.createLinearGradient(0, 0, 0, 400);
  gradient.addColorStop(0, 'rgba(0, 255, 135, 0.18)');
  gradient.addColorStop(1, 'rgba(0, 255, 135, 0)');
  
  const borderGradient = ctx.createLinearGradient(0, 0, 400, 0);
  borderGradient.addColorStop(0, '#00ff87');
  borderGradient.addColorStop(1, '#00e5ff');
  
  pnlChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: chartLabels,
      datasets: [{
        label: '累计 PnL ($)',
        data: chartData,
        borderColor: borderGradient,
        borderWidth: 3,
        fill: true,
        backgroundColor: gradient,
        tension: 0.25,
        pointBackgroundColor: '#07090e',
        pointBorderColor: '#00ff87',
        pointBorderWidth: 1.5,
        pointRadius: chartData.length > 80 ? 0 : 3,
        pointHoverRadius: 6,
        pointHoverBackgroundColor: '#00ff87',
        pointHoverBorderColor: '#ffffff',
        pointHoverBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#121824',
          titleColor: '#8e9bb0',
          titleFont: { family: 'Inter', size: 11 },
          bodyColor: '#ffffff',
          bodyFont: { family: 'Outfit', size: 14, weight: 'bold' },
          borderColor: 'rgba(255, 255, 255, 0.08)',
          borderWidth: 1,
          padding: 12,
          displayColors: false,
          callbacks: {
            label: function(context) {
              const val = context.parsed.y;
              return `累计盈亏: ${val >= 0 ? '+' : ''}$${val.toFixed(2)}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: 'rgba(255, 255, 255, 0.03)',
            borderColor: 'rgba(255, 255, 255, 0.05)'
          },
          ticks: {
            color: '#57657a',
            font: { family: 'Inter', size: 10 },
            maxRotation: 0,
            autoSkip: true,
            autoSkipPadding: 40
          }
        },
        y: {
          grid: {
            color: 'rgba(255, 255, 255, 0.03)',
            borderColor: 'rgba(255, 255, 255, 0.05)'
          },
          ticks: {
            color: '#8e9bb0',
            font: { family: 'Outfit', size: 11 },
            callback: function(value) {
              return `${value >= 0 ? '+' : ''}$${value}`;
            }
          }
        }
      }
    }
  });
}

// Render dynamic log table of trades
function renderTradesTable(trades) {
  const tbody = document.getElementById('trades-table-body');
  document.getElementById('log-count-text').textContent = `共 ${trades.length} 笔交易`;
  
  if (trades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="table-loading">未找到符合当前筛选条件的交易记录。</td></tr>';
    return;
  }
  
  let html = '';
  
  trades.forEach(t => {
    const rawTime = t.ts || t.Time;
    const timeFormatted = formatBeijingTime(rawTime);
    
    const mId = t.marketId || t.MarketID || '-';
    const question = t.marketTitle || t.Question || '手动订单 / 结算中';
    const strat = t.Strategy || t.strategyType || 'MarsEdge 5m';
    
    const side = t.Side || t.direction || '-';
    const sideColorClass = side.toUpperCase() === 'UP' ? 'text-profit' : (side.toUpperCase() === 'DOWN' ? 'text-loss' : 'text-neutral');
    
    const shares = t.Shares || t.size || 0;
    const sharesFormatted = parseFloat(shares).toFixed(2);
    
    const entryPrice = t.EntryPrice || t.price || 0;
    const entryFormatted = `$${parseFloat(entryPrice).toFixed(4)}`;
    
    const exitPrice = t.ExitPrice !== undefined ? t.ExitPrice : (t.sellPrice !== undefined ? t.sellPrice : null);
    let exitFormatted = '-';
    if (exitPrice !== null) {
      exitFormatted = `$${parseFloat(exitPrice).toFixed(4)}`;
    } else if (t.status === 'WIN' || t.status === 'LOSS') {
      exitFormatted = t.status === 'WIN' ? '$1.0000' : '$0.0000';
    }
    
    let status = t.Result || t.status || 'PENDING';
    status = status.toUpperCase();
    let badgeClass = 'badge-pending';
    
    if (status === 'WIN' || status === 'FILLED') {
      badgeClass = 'badge-win';
    } else if (status === 'LOSS' || status === 'ERROR') {
      badgeClass = 'badge-loss';
    } else if (status === 'SCALPED') {
      badgeClass = 'badge-scalped';
    } else if (status === 'MISSED' || status === 'CANCELLED') {
      badgeClass = 'badge-missed';
    }
    
    let statusText = status;
    if (status === 'WIN') statusText = '胜 (WIN)';
    if (status === 'LOSS') statusText = '负 (LOSS)';
    if (status === 'SCALPED') statusText = '提前平仓';
    if (status === 'PENDING') statusText = '挂单中';
    if (status === 'FILLED') statusText = '已成交';
    if (status === 'MISSED') statusText = '未成交';
    
    const profit = parseFloat(t.pnl !== undefined ? t.pnl : 0);
    let profitText = '-';
    let profitClass = 'text-neutral';
    
    const isCompleted = status === 'WIN' || status === 'LOSS';
      
    if (isCompleted) {
      profitText = `${profit >= 0 ? '+' : '-'}$${Math.abs(profit).toFixed(2)}`;
      profitClass = profit >= 0 ? 'text-profit' : 'text-loss';
    }
    
    html += `
      <tr>
        <td class="text-neutral">${escapeHtml(timeFormatted)}</td>
        <td class="text-neutral font-mono">${escapeHtml(mId)}</td>
        <td class="text-primary" style="max-width: 300px; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(question)}">${escapeHtml(question)}</td>
        <td class="text-neutral">${escapeHtml(strat)}</td>
        <td class="${sideColorClass} font-weight-bold font-mono">${escapeHtml(side)}</td>
        <td class="text-primary text-right">${escapeHtml(sharesFormatted)}</td>
        <td class="text-primary text-right font-mono">${escapeHtml(entryFormatted)}</td>
        <td class="text-primary text-right font-mono">${escapeHtml(exitFormatted)}</td>
        <td><span class="badge ${badgeClass}">${escapeHtml(statusText)}</span></td>
        <td class="${profitClass} text-right font-weight-bold font-mono">${escapeHtml(profitText)}</td>
      </tr>
    `;
  });
  
  tbody.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════
// Wallet On-Chain Analysis Module
// ═══════════════════════════════════════════════════════════════════
let waData = null;     // full response from /api/wallet-analysis
let waSymbol = 'BTC';  // active tab

function initWalletAnalysis() {
  document.getElementById('wa-tab-btc').addEventListener('click', () => switchWaTab('BTC'));
  document.getElementById('wa-tab-eth').addEventListener('click', () => switchWaTab('ETH'));
  loadWalletAnalysis();
  setInterval(loadWalletAnalysis, 60000); // refresh every 60s
}

function switchWaTab(sym) {
  waSymbol = sym;
  document.getElementById('wa-tab-btc').classList.toggle('active', sym === 'BTC');
  document.getElementById('wa-tab-eth').classList.toggle('active', sym === 'ETH');
  if (waData) renderWalletAnalysis();
}

async function loadWalletAnalysis() {
  const badge = document.getElementById('wa-loading-badge');
  badge.textContent = '更新中...';
  badge.style.display = 'inline-block';
  try {
    const res = await fetch('/api/wallet-analysis');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    waData = await res.json();
    badge.textContent = '已更新 ✓';
    badge.style.background = 'rgba(0,255,135,0.15)';
    badge.style.color = '#00ff87';
    setTimeout(() => { badge.style.display = 'none'; }, 3000);
    renderWalletAnalysis();
  } catch (err) {
    badge.textContent = '加载失败';
    badge.style.background = 'rgba(255,60,60,0.15)';
    badge.style.color = '#ff4d4d';
    console.error('[WalletAnalysis] Error:', err);
  }
}

function renderWalletAnalysis() {
  if (!waData || !waData.ok) return;
  const sym = waData[waSymbol];
  if (!sym) return;

  const s = sym.summary || {};

  // Summary cards
  document.getElementById('wa-total').textContent = (s.total || 0) + (s.unresolved ? ` (+${s.unresolved} 待)` : '');
  document.getElementById('wa-settled').textContent = s.total || 0;

  const wrEl = document.getElementById('wa-winrate');
  wrEl.textContent = `${s.winRate ?? '—'}%`;
  wrEl.className = 'wa-stat-val ' + (s.winRate >= 50 ? 'value-green' : 'value-red');

  document.getElementById('wa-wl').innerHTML =
    `<span style="color:#00ff87">${s.wins || 0}胜</span> / <span style="color:#ff4d4d">${s.losses || 0}负</span>`;

  const pnlEl = document.getElementById('wa-pnl');
  const pnl = s.totalPnl || 0;
  pnlEl.textContent = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
  pnlEl.className = 'wa-stat-val ' + (pnl >= 0 ? 'value-green' : 'value-red');

  document.getElementById('wa-unresolved').textContent = s.unresolved || 0;

  // Price breakdown table
  renderPriceBreakdown(sym.priceBreakdown || []);

  // Recent trades
  renderWaTrades((sym.trades || []).slice().sort((a, b) => b.timestamp - a.timestamp).slice(0, 50));
}

function renderPriceBreakdown(breakdown) {
  const tbody = document.getElementById('wa-price-tbody');
  if (!breakdown.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="table-loading">暂无数据</td></tr>';
    return;
  }
  // Sort by price desc
  const sorted = [...breakdown].sort((a, b) => b.price - a.price);
  let html = '';
  for (const row of sorted) {
    const pct = row.winRate;
    const barColor = pct >= 60 ? '#00ff87' : pct >= 50 ? '#f0c060' : '#ff4d4d';
    html += `<tr>
      <td class="font-mono" style="color:#e2e8f4;font-weight:600">${(row.price * 100).toFixed(0)}¢</td>
      <td style="color:#8e9bb0">${row.total}</td>
      <td style="color:#00ff87">${row.wins}</td>
      <td style="color:#ff4d4d">${row.losses}</td>
      <td style="color:${barColor};font-weight:700">${pct}%</td>
      <td style="color:#8e9bb0">$${row.totalUsdc.toFixed(2)}</td>
      <td>
        <div style="background:rgba(255,255,255,0.06);border-radius:4px;height:8px;width:120px;overflow:hidden">
          <div style="background:${barColor};height:100%;width:${pct}%;border-radius:4px;transition:width .4s"></div>
        </div>
      </td>
    </tr>`;
  }
  tbody.innerHTML = html;
}

function renderWaTrades(trades) {
  const tbody = document.getElementById('wa-trades-tbody');
  if (!trades.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-loading">暂无数据</td></tr>';
    return;
  }
  let html = '';
  for (const t of trades) {
    const dt = new Date(t.timestamp * 1000);
    const timeStr = `${dt.getUTCMonth()+1}/${dt.getUTCDate()} ${String(dt.getUTCHours()).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}`;
    const marketShort = (t.title || t.slug || '-').replace(/Bitcoin|Ethereum/i, '').replace('Up or Down -', '').trim().slice(0, 30);
    const outcomeColor = (t.outcome || '').toLowerCase() === 'up' ? '#00ff87' : '#ff4d4d';
    let resultBadge = '';
    let pnlText = '-';
    let pnlClass = 'color:#8e9bb0';
    if (t.unresolved) {
      resultBadge = '<span class="badge badge-pending">待结算</span>';
    } else if (t.won) {
      resultBadge = '<span class="badge badge-win">WIN ✓</span>';
      pnlText = `+$${(t.pnl || 0).toFixed(2)}`;
      pnlClass = 'color:#00ff87;font-weight:700';
    } else {
      resultBadge = '<span class="badge badge-loss">LOSS ✗</span>';
      pnlText = `-$${Math.abs(t.pnl || 0).toFixed(2)}`;
      pnlClass = 'color:#ff4d4d;font-weight:700';
    }
    html += `<tr>
      <td class="font-mono" style="color:#57657a;font-size:12px">${timeStr}</td>
      <td style="color:#8e9bb0;font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(t.title)}">${escapeHtml(marketShort)}</td>
      <td style="color:${outcomeColor};font-weight:700">${escapeHtml(t.outcome || '-')}</td>
      <td class="font-mono" style="color:#e2e8f4">${(t.price * 100).toFixed(0)}¢</td>
      <td style="color:#8e9bb0">${t.size}</td>
      <td style="color:#8e9bb0">$${(t.usdcSize || 0).toFixed(2)}</td>
      <td>${resultBadge}</td>
      <td class="font-mono" style="${pnlClass}">${pnlText}</td>
    </tr>`;
  }
  tbody.innerHTML = html;
}

// Initialize wallet analysis when DOM is ready
document.addEventListener('DOMContentLoaded', initWalletAnalysis);
