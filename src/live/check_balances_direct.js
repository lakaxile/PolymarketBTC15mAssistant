import { ethers } from "ethers";

async function checkBalancesDirect() {
    const rpc = "https://polygon-rpc.com";
    const provider = new ethers.JsonRpcProvider(rpc);

    // Poly ERC1155 Token Contract
    const tokenAddress = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
    const abi = ["function balanceOf(address account, uint256 id) view returns (uint256)"];
    const contract = new ethers.Contract(tokenAddress, abi, provider);

    const wallet = "0x7ff4ed1b51db2337bcbb0d4723357faa1e7d7a3a";

    // Tokens for 8:00 AM - 8:15 AM
    const upTokenId = "55458284534168051677353975005934526563604928221652431698226068940801311099195";
    const downTokenId = "27461805908927054366914594190848972879555127027376715019318357039014522437651";

    // Tokens for 8:15 AM - 8:30 AM
    const up2TokenId = "23498801738722213768297771746271953282210080614051052210815121406692233634150";
    const down2TokenId = "113697960307997380928091873837965903023846684705574744722881267571253013897368";

    try {
        const u1 = await contract.balanceOf(wallet, upTokenId);
        const d1 = await contract.balanceOf(wallet, downTokenId);
        console.log(`8:00 Market Balances -> UP: ${ethers.formatUnits(u1, 6)}, DOWN: ${ethers.formatUnits(d1, 6)}`);

        const u2 = await contract.balanceOf(wallet, up2TokenId);
        const d2 = await contract.balanceOf(wallet, down2TokenId);
        console.log(`8:15 Market Balances -> UP: ${ethers.formatUnits(u2, 6)}, DOWN: ${ethers.formatUnits(d2, 6)}`);
    } catch (e) {
        console.error(e.message);
    }
}
checkBalancesDirect();
