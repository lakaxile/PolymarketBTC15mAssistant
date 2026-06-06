/**
 * 下单执行器 - 通过 Polymarket CLOB API 下单
 * 支持 DRY_RUN 模式（只打印，不真实下单）
 */
import { ethers } from 'ethers';
import { Side, OrderType } from '@polymarket/clob-client-v2';
import fs from 'fs';
import { getClobClient } from '../live/clob.js';
import { fetchMarketBySlug } from '../data/polymarket.js';

const DRY_RUN = (process.env.DRY_RUN || 'true').split('#')[0].trim().toLowerCase() !== 'false';
const rawOrderSize = (process.env.ORDER_SIZE_USDC || '5').split('#')[0].trim();
const ORDER_SIZE_USDC = Number(rawOrderSize) || 5;
const CLOB_BASE = 'https://clob.polymarket.com';
const LOG_FILE = './logs/orders.jsonl';

/**
 * 记录订单到日志（每条记录包含完整快照数据）
 */
function logOrder(entry) {
  try {
    fs.mkdirSync('./logs', { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {}
}

/**
 * 读取最近 N 条订单记录（供终端面板显示）
 */
export function loadRecentOrders(n = 8) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(l => JSON.parse(l)).reverse();
  } catch {
    return [];
  }
}

/**
 * 主下单函数
 * @param {Object} signal       - 来自 signal.js evaluateSignal() 的信号对象
 * @param {Object} marketContext - 市场上下文 { marketTitle, marketSlug, priceToBeat, priceChangePct }
 */
export async function executeOrder(signal, marketContext = {}) {
  const {
    direction,
    symbol,
    tokenId,
    modelProb,
    askPrice,
    bidPrice,
    edge,
    remSecs,
    orderType,
    limitPrice
  } = signal;

  const { marketTitle = '-', marketSlug = '-', priceToBeat = null, priceChangePct = 0 } = marketContext;

  const now = new Date();
  const currentOrderSize = 15;

  // ── DRY RUN 模式 ──────────────────────────────────────────────────────────
  if (DRY_RUN) {
    const size = Math.max(5, Math.round(currentOrderSize / Number(limitPrice)));
    const price = Number(limitPrice).toFixed(4);
    const entry = {
      ts: now.toISOString(),
      time: now.toLocaleTimeString('en-US', { hour12: false }),
      marketTitle,
      marketSlug,
      symbol,
      direction,
      orderType,
      price: Number(price),
      size,
      modelProb: Number((modelProb * 100).toFixed(1)),
      askPrice: Number((askPrice * 100).toFixed(1)),
      edge: Number((edge * 100).toFixed(1)),
      remSecs,
      priceToBeat,
      priceChangePct: Number(priceChangePct.toFixed(3)),
      status: 'SIMULATED',
      mode: 'DRY_RUN'
    };
    logOrder(entry);
    return { ok: true, ...entry };
  }

  // ── 真实下单 ──────────────────────────────────────────────────────────────
  try {
    const privateKey = process.env.POLY_WALLET_KEY;
    if (!privateKey) throw new Error('POLY_WALLET_KEY not set');

    const clobClient = getClobClient();

    // 动态获取市场的 tickSize
    let tickSize = '0.0001';
    try {
      tickSize = await clobClient.getTickSize(tokenId);
    } catch (err) {
      console.warn(`[EXEC] Failed to get tick size for token ${tokenId}:`, err.message);
    }
    const decimalPlaces = tickSize.includes('.') ? tickSize.split('.')[1].length : 0;
    const priceFormatted = Number(limitPrice).toFixed(decimalPlaces);
    
    // 计算满足最少 $5.00 USDC 的份额 (避免由于 low price 导致总额低于交易所限制而被拒单)
    const sizeCalculated = Math.max(5, Math.round(currentOrderSize / Number(priceFormatted)));

    const order = await clobClient.createOrder({
      tokenID: tokenId,
      price: Number(priceFormatted),
      side: Side.BUY,
      size: sizeCalculated,
    });

    const clobOrderType = orderType === 'MARKET' ? OrderType.IOC : OrderType.GTC;
    const response = await clobClient.postOrder(order, clobOrderType);
    const orderId = response?.orderID || response?.id || '-';

    let filledShares = 0;
    let isMatched = false;
    let finalStatus = (orderId && orderId !== '-') ? 'PENDING' : 'MISSED';

    if (orderId && orderId !== '-') {
      try {
        console.log(`[EXEC] Order posted successfully. ID: ${orderId}. Waiting 1s for initial matching status check...`);
        // 等待 1 秒，让 Polymarket CLOB 完成撮合以及索引同步
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const orderStatus = await clobClient.getOrder(orderId);
        if (orderStatus) {
          const statusUpper = (orderStatus.status || '').toUpperCase();
          filledShares = Number(orderStatus.size_matched || 0);
          const totalSize = Number(orderStatus.original_size || orderStatus.size || sizeCalculated);
          isMatched = statusUpper === 'MATCHED' || filledShares >= totalSize;
          
          if (isMatched) {
            finalStatus = 'FILLED';
          } else if (statusUpper === 'CANCELLED') {
            finalStatus = filledShares > 0 ? 'PARTIAL' : 'MISSED';
          } else if (filledShares > 0) {
            finalStatus = 'PARTIAL';
          } else {
            finalStatus = 'PENDING';
          }
          console.log(`[EXEC] Initial match result check: status=${statusUpper}, matched=${filledShares}/${totalSize} -> ${finalStatus}`);
        }
      } catch (err) {
        console.warn(`[EXEC] Failed to get initial status for ${orderId}:`, err.message);
      }
    }

    const entry = {
      ts: now.toISOString(),
      time: now.toLocaleTimeString('en-US', { hour12: false }),
      marketTitle,
      marketSlug,
      symbol,
      direction,
      orderType,
      price: Number(priceFormatted),
      size: sizeCalculated,
      modelProb: Number((modelProb * 100).toFixed(1)),
      askPrice: Number((askPrice * 100).toFixed(1)),
      edge: Number((edge * 100).toFixed(1)),
      remSecs,
      priceToBeat,
      priceChangePct: Number(priceChangePct.toFixed(3)),
      mode: 'LIVE',
      orderId,
      status: finalStatus,
      filledShares,
      response: { status: response?.status, orderId, sizeMatched: filledShares },
    };
    logOrder(entry);
    return { ok: true, ...entry };

  } catch (err) {
    const fallbackSize = Math.max(5, Math.round(ORDER_SIZE_USDC / Number(limitPrice)));
    const fallbackPrice = Number(limitPrice).toFixed(4);
    const entry = {
      ts: now.toISOString(),
      time: now.toLocaleTimeString('en-US', { hour12: false }),
      marketTitle,
      marketSlug,
      symbol,
      direction,
      orderType,
      price: Number(fallbackPrice),
      size: fallbackSize,
      modelProb: Number((modelProb * 100).toFixed(1)),
      askPrice: Number((askPrice * 100).toFixed(1)),
      edge: Number((edge * 100).toFixed(1)),
      remSecs,
      priceToBeat,
      priceChangePct: Number(priceChangePct.toFixed(3)),
      mode: 'LIVE',
      status: 'ERROR',
      error: err.message,
    };
    logOrder(entry);
    return { ok: false, error: err.message };
  }
}

let isUpdating = false;
let lastUpdateTs = 0;
const UPDATE_THROTTLE_MS = 5000; // 每 5 秒最多执行一次状态同步，防止高频请求 API 导致限频

export async function updatePendingOrderStatus(currentMarketSlugs = null, force = false) {
  if (DRY_RUN) return;

  const now = Date.now();
  if (!force && (now - lastUpdateTs < UPDATE_THROTTLE_MS)) return;

  if (isUpdating) return;
  isUpdating = true;
  lastUpdateTs = now;

  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    let updated = false;

    const clobClient = getClobClient();

    const updatedLines = await Promise.all(
      lines.map(async (line) => {
        try {
          const entry = JSON.parse(line);

          // 1. 如果订单状态是 FILLED 或 PARTIAL，查询结算结果 (WIN / LOSS)
          if (entry.status === 'FILLED' || entry.status === 'PARTIAL') {
            // 防限频保护：订单成交/挂单后 3 分钟内先不查询结果
            const orderTime = new Date(entry.ts).getTime();
            if (Date.now() - orderTime < 3 * 60 * 1000) {
              return line;
            }

            try {
              const market = await fetchMarketBySlug(entry.marketSlug, true);
              if (market && market.closed) {
                const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
                const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;

                if (Array.isArray(outcomes) && Array.isArray(prices)) {
                  const targetOutcome = entry.direction === 'UP' ? 'Up' : 'Down';
                  const outcomeIndex = outcomes.findIndex(o => o.toLowerCase() === targetOutcome.toLowerCase());

                  if (outcomeIndex !== -1) {
                    const finalPrice = parseFloat(prices[outcomeIndex]);
                    // 如果是 PARTIAL，结算份数必须使用实际成交份额 filledShares
                    const shares = entry.status === 'PARTIAL' ? Number(entry.filledShares || 0) : Number(entry.filledShares || entry.size || 0);

                    // 如果是部分成交，但成交份额为 0，视为未成交 (MISSED) 不进行计算
                    if (entry.status === 'PARTIAL' && shares === 0) {
                      entry.status = 'MISSED';
                      updated = true;
                      return JSON.stringify(entry);
                    }

                    if (finalPrice === 1) {
                      const oldStatus = entry.status;
                      entry.status = 'WIN';
                      entry.pnl = (1.0 - entry.price) * shares;
                      entry.pnlPct = ((1.0 - entry.price) / entry.price) * 100;
                      updated = true;
                      console.log(`[EXEC Status Checker] Market resolved (${oldStatus}): ${entry.marketSlug} -> WIN! PnL: +$${entry.pnl.toFixed(2)} (${entry.pnlPct.toFixed(1)}%)`);
                      return JSON.stringify(entry);
                    } else if (finalPrice === 0) {
                      const oldStatus = entry.status;
                      entry.status = 'LOSS';
                      entry.pnl = -entry.price * shares;
                      entry.pnlPct = -100.0;
                      updated = true;
                      console.log(`[EXEC Status Checker] Market resolved (${oldStatus}): ${entry.marketSlug} -> LOSS! PnL: -$${Math.abs(entry.pnl).toFixed(2)} (-100%)`);
                      return JSON.stringify(entry);
                    }
                  }
                }
              }
            } catch (err) {
              console.error(`[EXEC Status Checker] Error fetching resolution for ${entry.marketSlug}:`, err.message);
            }
            
            // 如果是已完全成交 (FILLED) 状态，它是最终状态，直接返回行（无需后续 CLOB 状态轮询）
            if (entry.status === 'FILLED') {
              return line;
            }
            // 如果是 PARTIAL 但市场还未结算，我们不在这里中断，继续往下走，让 CLOB 接口查询更新成交份额
          }

          // 仅检查 PENDING 或 PARTIAL 的真实订单
          if (entry.status !== 'PENDING' && entry.status !== 'PARTIAL') {
            return line;
          }

          // 如果订单没有有效的 orderId，则直接修正为 MISSED
          if (!entry.orderId || entry.orderId === '-') {
            const correctedStatus = entry.filledShares > 0 ? 'PARTIAL' : 'MISSED';
            if (entry.status !== correctedStatus) {
              console.log(`[EXEC Status Checker] Order with missing ID found. Correcting status: ${entry.status} -> ${correctedStatus}`);
              entry.status = correctedStatus;
              updated = true;
              return JSON.stringify(entry);
            }
            return line;
          }

          // 依据 entry.symbol 自动映射当前活跃市场的 Slug
          let currentMarketSlug = null;
          if (currentMarketSlugs) {
            if (typeof currentMarketSlugs === 'string') {
              currentMarketSlug = currentMarketSlugs;
            } else if (entry.symbol) {
              currentMarketSlug = currentMarketSlugs[entry.symbol] || currentMarketSlugs[entry.symbol.toUpperCase()];
            }
          }

          // 1. 从 Polymarket CLOB 获取该订单的最新真实状态
          let orderStatus;
          try {
            orderStatus = await clobClient.getOrder(entry.orderId);
          } catch (err) {
            console.error(`[EXEC Status Checker] Error fetching order ${entry.orderId}:`, err.message);
            
            // 如果这个订单属于过去的轮次，且接口查询报错（通常是因为订单已过期/从撮合引擎中归档归零）
            // 我们不能让它永远卡在 PENDING 状态。直接安全标记为 MISSED 或 PARTIAL
            if (currentMarketSlug && entry.marketSlug && entry.marketSlug !== currentMarketSlug) {
              console.log(`[EXEC Status Checker] Order ${entry.orderId} from past market is no longer queryable. Falling back to default past state.`);
              const finalFallbackStatus = entry.filledShares > 0 ? 'PARTIAL' : 'MISSED';
              if (entry.status !== finalFallbackStatus) {
                entry.status = finalFallbackStatus;
                updated = true;
                return JSON.stringify(entry);
              }
            }
            return line; // 维持当前行，等待下次重试
          }

          if (!orderStatus) {
            // 如果订单状态为 null (Polymarket 中已被归档/删除)，且属于过去的轮次，不能留为 PENDING
            if (currentMarketSlug && entry.marketSlug && entry.marketSlug !== currentMarketSlug) {
              console.log(`[EXEC Status Checker] Order ${entry.orderId} from past market is not found (null). Mapping to fallback status.`);
              const finalFallbackStatus = entry.filledShares > 0 ? 'PARTIAL' : 'MISSED';
              if (entry.status !== finalFallbackStatus) {
                entry.status = finalFallbackStatus;
                updated = true;
                return JSON.stringify(entry);
              }
            }
            return line;
          }

          const statusUpper = (orderStatus.status || '').toUpperCase();
          const sizeMatched = parseFloat(orderStatus.size_matched || '0');
          const totalSize = parseFloat(orderStatus.original_size || orderStatus.size || entry.size || '0');

          // 更新成交份额
          if (sizeMatched !== entry.filledShares) {
            entry.filledShares = sizeMatched;
            updated = true;
          }

          // 2. 根据 CLOB 状态执行状态判断
          let newStatus = entry.status;

          if (statusUpper === 'MATCHED' || sizeMatched >= totalSize) {
            newStatus = 'FILLED';
          } else if (statusUpper === 'CANCELLED') {
            newStatus = sizeMatched > 0 ? 'PARTIAL' : 'MISSED';
          } else {
            // 订单仍处于活跃状态 (LIVE/OPEN/PENDING)
            // 如果市场已经改变 (意味着上一轮的 5 分钟周期已经结束，新一轮已经开始)
            if (currentMarketSlug && entry.marketSlug && entry.marketSlug !== currentMarketSlug) {
              console.log(`[EXEC Status Checker] Order ${entry.orderId} belongs to past market ${entry.marketSlug}. Active market is ${currentMarketSlug}. Cancelling order...`);
              
              // 自动撤单保护资金安全，防止在新轮次中产生意外成交
              try {
                await clobClient.cancelOrders([entry.orderId]);
                console.log(`[EXEC Status Checker] Successfully cancelled past order ${entry.orderId}`);
              } catch (cancelErr) {
                console.error(`[EXEC Status Checker] Failed to cancel order ${entry.orderId}:`, cancelErr.message);
              }

              // 撤单后再检查一次，或直接以当前的 sizeMatched 确定状态
              newStatus = sizeMatched > 0 ? 'PARTIAL' : 'MISSED';
            } else {
              // 仍处于当前轮次且未完全成交
              newStatus = sizeMatched > 0 ? 'PARTIAL' : 'PENDING';
            }
          }

          if (newStatus !== entry.status) {
            console.log(`[EXEC Status Checker] Order ${entry.orderId} status updated: ${entry.status} -> ${newStatus} (Matched: ${sizeMatched}/${totalSize})`);
            entry.status = newStatus;
            updated = true;
          }

          return JSON.stringify(entry);
        } catch (innerErr) {
          console.error(`[EXEC Status Checker] Failed to process log line:`, innerErr.message);
          return line;
        }
      })
    );

    if (updated) {
      fs.writeFileSync(LOG_FILE, updatedLines.join('\n') + '\n');
    }
  } catch (e) {
    console.error("[EXEC Status Checker] Fatal error updating status:", e);
  } finally {
    isUpdating = false;
  }
}
