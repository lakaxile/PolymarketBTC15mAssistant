import fs from "fs";
import path from "path";

// 简单的 .env 加载器，不依赖外部库
function loadEnv() {
    try {
        const envPath = path.resolve(process.cwd(), ".env");
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, "utf-8");
            content.split("\n").forEach(line => {
                const match = line.match(/^([^#\s][^=]*)=(.*)$/);
                if (match) {
                    const key = match[1].trim();
                    const val = match[2].trim();
                    // 仅当值非空时才覆盖，防止 .env 里的空变量覆盖了 shell 里的全局代理
                    if (val) {
                        process.env[key] = val;
                    }
                }
            });
        }
    } catch (e) {
        console.warn("Failed to load .env file:", e.message);
    }
}

loadEnv();

export const LIVE_CONFIG = {
    // 钱包与 API 设置
    walletKey: process.env.POLY_WALLET_KEY || "",
    proxyAddress: process.env.POLY_PROXY_ADDRESS || "",
    apiKey: process.env.POLY_API_KEY || "",
    apiSecret: process.env.POLY_API_SECRET || "",
    apiPassphrase: process.env.POLY_PASSPHRASE || "",

    // 网络终端
    polygonRpc: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",

    // 交易参数
    tradeSizeShares: 50, // 每次下单固定买入 50 份
    scalpThresholdPct: 0.12, // 12% 提前止盈剥头皮
    maxSharesPerMarket: 50, // 单个方向最大允许持有的总份额上限 (锁定为只有50份底仓，绝不允许补仓)

    // 套利平仓模型：固定绝对分价差目标
    // 数学依据：二元市场中，固定 cents 收益 > 固定 % 收益
    // 20¢入：+0.12 = +60%，胜率需求 62.5%（vs 固定15% 需要 87%）
    // 40¢入：+0.12 = +30%，胜率需求 76.9%
    // 55¢入：+0.12 = +22%，胜率需求 82%
    arbiTargetCents: 0.12, // 目标绝对分价差 (+12分成本)，可单独调整

    // 安全开关: 干跑模式 (Dry Run)
    // 如果为 true，程序在抵达真正向 CLOB 发送签名请求前的一秒会自动中止，只在控制台输出"假装下单"的字样。
    // 设置为 false 接入实盘交易
    isDryRun: false,

    // Telegram 通知配置
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
};
