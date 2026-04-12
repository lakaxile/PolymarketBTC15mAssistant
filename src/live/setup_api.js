import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { LIVE_CONFIG } from "./config.js";

// 加载环境变量 (主要为了读取 POLYGON_RPC_URL)
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
                    if (!process.env[key]) {
                        process.env[key] = val;
                    }
                }
            });
        }
    } catch (e) {
        // ignore
    }
}

async function generateKeys() {
    loadEnv();

    // 1. 获取传入的私钥 (不要写死在代码里)
    const privateKey = process.argv[2];

    if (!privateKey) {
        console.error("\n❌ 错误: 缺少私钥参数！");
        console.error("👉 请使用以下命令运行此脚本：");
        console.error("node src/live/setup_api.js <你的_POLYGON_钱包私钥>\n");
        process.exit(1);
    }

    try {
        console.log("⏳ 正在连接 Polygon 网络...");
        const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const signer = new ethers.Wallet(privateKey, provider);

        // 兼容性修复: @polymarket/clob-client 内部某些依赖还在使用 ethers v5 的 API
        // 在 ethers v6 中, _signTypedData 变成了 signTypedData
        // 所以我们手动给 signer 打个补丁
        if (typeof signer._signTypedData !== "function") {
            signer._signTypedData = signer.signTypedData.bind(signer);
        }

        console.log(`✅ 钱包连接成功！地址: ${signer.address}`);
        console.log("⏳ 正在向 Polymarket CLOB 申请 API 凭证 (这可能需要几秒钟，需对消息进行签名)...");

        // 还原：API Key 必须以 EOA 的身份去申请，不能带 Proxy Wallet 的环境配置
        const clobClient = new ClobClient("https://clob.polymarket.com/", 137, signer);

        // 生成并拉取 API Credentials
        const creds = await clobClient.createApiKey();

        if (creds && creds.apiKey) {
            console.log("\n🎉 API Keys 生成成功！请务必妥善保管，绝对不要泄露给任何人！");
            console.log("=========================================");
            console.log(`POLY_API_KEY=${creds.apiKey}`);
            console.log(`POLY_API_SECRET=${creds.secret}`);
            console.log(`POLY_PASSPHRASE=${creds.passphrase}`);
            console.log("=========================================\n");

            console.log("👉 操作指南：");
            console.log("1. 将根目录下的 .env.example 重命名为 .env");
            console.log("2. 打开 .env 文件，将上面的三行凭证连同你的 POLY_WALLET_KEY 填进去。");
            console.log("3. 填好后，你就可以彻底删除这段命令历史，保护私钥安全。\n");
        } else {
            console.error("❌ 生成失败，未返回预期的凭证数据。");
        }

    } catch (error) {
        console.error("\n❌ 生成过程中发生错误:");
        console.error(error.message);
        console.error("提示: 确保你的网络能正常访问 polymarket 的 clob 接口，或者检查私钥格式是否正确 (包含/不包含 0x 前缀均可)。\n");
    }
}

generateKeys();
