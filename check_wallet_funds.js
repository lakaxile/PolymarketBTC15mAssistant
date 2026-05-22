import { ethers } from "ethers";
import fs from "fs";
import path from "path";

// Simple .env parser to get keys
function getEnv() {
    const env = {};
    try {
        const envPath = path.resolve(process.cwd(), ".env");
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, "utf-8");
            content.split("\n").forEach(line => {
                const trimmed = line.trim();
                const match = trimmed.match(/^([^#\s][^=]*)=(.*)$/);
                if (match) {
                    const key = match[1].trim();
                    const val = match[2].trim();
                    env[key] = val;
                }
            });
        }
    } catch (e) {}
    return env;
}

async function check() {
    const env = getEnv();
    const rpc = env.POLYGON_RPC_URL || "https://polygon-rpc.com";
    const provider = new ethers.JsonRpcProvider(rpc);
    
    const eoaKey = env.POLY_WALLET_KEY;
    if (!eoaKey) {
        console.error("POLY_WALLET_KEY is missing!");
        return;
    }
    const eoaWallet = new ethers.Wallet(eoaKey, provider);
    const proxyAddress = env.POLY_PROXY_ADDRESS;

    const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

    console.log("=== WALLET INFORMATION ===");
    console.log(`EOA Address:   ${eoaWallet.address}`);
    console.log(`Proxy Address: ${proxyAddress || "None"}`);
    console.log("==========================\n");

    // Check EOA MATIC
    const eoaMatic = await provider.getBalance(eoaWallet.address);
    console.log(`EOA MATIC Balance:   ${ethers.formatEther(eoaMatic)} MATIC`);

    // Check EOA USDC
    const eoaUsdc = await usdc.balanceOf(eoaWallet.address);
    console.log(`EOA USDC Balance:    $${ethers.formatUnits(eoaUsdc, 6)} USDC`);

    if (proxyAddress) {
        // Check Proxy MATIC
        const proxyMatic = await provider.getBalance(proxyAddress);
        console.log(`Proxy MATIC Balance: ${ethers.formatEther(proxyMatic)} MATIC`);

        // Check Proxy USDC
        const proxyUsdc = await usdc.balanceOf(proxyAddress);
        console.log(`Proxy USDC Balance:  $${ethers.formatUnits(proxyUsdc, 6)} USDC`);
    }
}

check().catch(console.error);
