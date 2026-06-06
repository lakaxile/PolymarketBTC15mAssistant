#!/bin/bash
export NODE_ENV=production
# Load environment variables from .env
if [ -f .env ]; then
  export $(cat .env | grep -v '#' | awk '/=/ {print $1}')
fi

echo "🚀 Starting Wallet Monitor (BTC/ETH > $0.85) in tmux session 'wallet_monitor'..."
tmux new-session -d -s wallet_monitor 'node src/tools/monitorWallet.js'

echo "✅ Monitor started! To view logs in real-time, run:"
echo "tmux attach -t wallet_monitor"
echo "Or check the log file: tail -f logs/wallet_monitor_btc_90.log"
