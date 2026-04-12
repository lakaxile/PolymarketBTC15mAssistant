import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { LIVE_CONFIG } from "./config.js";

// Polygon USDC address
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"; // Polymarket CTF Exchange on Polygon

const ERC20_ABI = [
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)"
];

async function main() {
    console.log("=========================================");
    console.log("   Polymarket Live Trading - Pre-flight  ");
    console.log("           USDC Approval Tool            ");
    console.log("=========================================\n");

    if (!LIVE_CONFIG.walletKey) {
        console.error("❌ Error: POLY_WALLET_KEY is missing in your .env file!");
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(LIVE_CONFIG.polygonRpc || "https://polygon-rpc.com");
    const wallet = new ethers.Wallet(LIVE_CONFIG.walletKey, provider);

    console.log(`📡 Connected Wallet: ${wallet.address}`);

    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

    try {
        const balance = await usdcContract.balanceOf(wallet.address);
        console.log(`💵 Current USDC Balance: ${ethers.formatUnits(balance, 6)}`);

        if (balance === 0n) {
            console.log("\n⚠️ Warning: Your USDC balance is 0. You need USDC on Polygon to trade.");
        }

        const currentAllowance = await usdcContract.allowance(wallet.address, CTF_EXCHANGE_ADDRESS);
        console.log(`\n🔍 Current CTF Exchange Allowance: $${ethers.formatUnits(currentAllowance, 6)}`);

        // If allowance is less than $10,000, approve MaxUint256
        const minAllowance = ethers.parseUnits("10000", 6);

        if (currentAllowance < minAllowance) {
            console.log("⏳ Allowance is too low. Sending approve transaction...");
            const tx = await usdcContract.approve(CTF_EXCHANGE_ADDRESS, ethers.MaxUint256);
            console.log(`🔗 Transaction sent! Hash: ${tx.hash}`);
            console.log("⏳ Waiting for confirmation...");
            await tx.wait();
            console.log("✅ USDC explicitly approved for Polymarket trading!");
        } else {
            console.log("✅ USDC is already approved for Polymarket trading. No action needed.");
        }

        console.log("\n🚀 You are ready to disable isDryRun in config.js and trade!");
    } catch (e) {
        console.error("\n❌ Error checking/approving allowance:");
        console.error(e.message);
    }
}

main();
