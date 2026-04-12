import fs from "node:fs";
import path from "node:path";

/**
 * 将数值限制在 [min, max] 范围内
 */
export function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

/**
 * 异步等待指定的毫秒数
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 格式化数字，保留指定的小数位数
 */
export function formatNumber(x, digits = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(x);
}

/**
 * 格式化为百分比字符串
 */
export function formatPct(x, digits = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return "-";
  return `${(x * 100).toFixed(digits)}%`;
}

/**
 * 获取 K 线时间窗口的计时信息
 * @param {number} windowMinutes 窗口分钟数
 */
export function getCandleWindowTiming(windowMinutes) {
  const nowMs = Date.now();
  const windowMs = windowMinutes * 60_000;
  const startMs = Math.floor(nowMs / windowMs) * windowMs;
  const endMs = startMs + windowMs;
  const elapsedMs = nowMs - startMs;
  const remainingMs = endMs - nowMs;
  return {
    startMs,
    endMs,
    elapsedMs,
    remainingMs,
    elapsedMinutes: elapsedMs / 60_000,
    remainingMinutes: remainingMs / 60_000
  };
}

/**
 * 确保目录存在，如果不存在则递归创建
 */
export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * 向 CSV 文件追加一行数据
 * @param {string} filePath 文件路径
 * @param {string[]} header 表头
 * @param {any[]} row 数据行
 */
export function appendCsvRow(filePath, header, row) {
  ensureDir(path.dirname(filePath));
  const exists = fs.existsSync(filePath);
  const line = row
    .map((v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (s.includes(",") || s.includes("\n") || s.includes('"')) {
        return `"${s.replaceAll('"', '""')}"`;
      }
      return s;
    })
    .join(",");

  if (!exists) {
    fs.writeFileSync(filePath, `${header.join(",")}\n${line}\n`, "utf8");
    return;
  }

  fs.appendFileSync(filePath, `${line}\n`, "utf8");
}

/**
 * 自动轮转 CSV 文件（防止单个文件过大）
 * @param {string} filePath 文件路径
 * @param {number} maxBytes 最大字节数 (默认 500MB)
 */
export function rotateCsvFile(filePath, maxBytes = 500 * 1024 * 1024) {
  if (!fs.existsSync(filePath)) return;
  const stats = fs.statSync(filePath);
  if (stats.size > maxBytes) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = path.extname(filePath);
    const base = path.join(path.dirname(filePath), path.basename(filePath, ext));
    const newPath = `${base}_${timestamp}${ext}`;
    fs.renameSync(filePath, newPath);
    console.log(`[UTILS] Rotated log file: ${filePath} -> ${newPath} (Size: ${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
  }
}
