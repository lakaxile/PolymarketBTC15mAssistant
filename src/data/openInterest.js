/**
 * openInterest.js — Binance Futures Open Interest 轮询与滑动窗口
 *
 * 用途：检测"真实资金驱动"还是"空/多头爆仓挤压"。
 * 端口: https://fapi.binance.com/fapi/v1/openInterest (无需 API Key)
 */

const SYMBOL = "BTCUSDT";
const HISTORY_MAX = 720; // 最多保留 3600s = 60 分钟 (每 5s 一条)

/** @type {{ ts: number, oi: number }[]} */
const oiHistory = [];

/**
 * 拉取最新 OI 并追加到滑动窗口
 */
export async function fetchAndRecordOI() {
    try {
        const res = await fetch(
            `https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL}`,
            { signal: AbortSignal.timeout(4000) }
        );
        if (!res.ok) {
            console.warn(`[OI] Fetch failed: ${res.status}`);
            return;
        }
        const d = await res.json();
        const oi = parseFloat(d.openInterest);
        if (!Number.isFinite(oi)) return;

        oiHistory.push({ ts: Date.now(), oi });
        if (oiHistory.length > HISTORY_MAX) oiHistory.shift();
    } catch (e) {
        // 打印错误以便排查，但不阻断主循环
        console.warn(`[OI] fetchAndRecordOI error: ${e.message}`);
    }
}

/**
 * 计算最近 windowSec 秒内的 OI 净变化量（单位：BTC）
 * 正值 = OI 扩张（新仓涌入）
 * 负值 = OI 收缩（仓位平掉 → 可能是爆仓）
 *
 * @param {number} windowSec 时间窗口（秒）
 * @returns {number} OI 变化量（BTC）
 */
export function getOIDelta(windowSec = 60) {
    if (oiHistory.length < 2) return 0;
    const cutoff = Date.now() - windowSec * 1000;
    const recent = oiHistory.filter(h => h.ts >= cutoff);
    if (recent.length < 2) return 0;
    return recent[recent.length - 1].oi - recent[0].oi;
}

/**
 * 获取最新 OI（BTC 合约张数）
 * @returns {number|null}
 */
export function getLatestOI() {
    if (!oiHistory.length) return null;
    return oiHistory[oiHistory.length - 1].oi;
}
