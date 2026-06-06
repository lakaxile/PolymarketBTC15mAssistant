#!/bin/bash
# ============================================================
# Polymarket BTC Assistant — 永久后台运行启动脚本
# 用法:
#   首次启动:   bash start_bot.sh
#   查看面板:   tmux attach -t polybot
#   停止机器人: tmux kill-session -t polybot
# ============================================================

set -e

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="polybot"
LOG_FILE="$BOT_DIR/logs/bot_restart.log"

# 确保 logs 目录存在
mkdir -p "$BOT_DIR/logs"

# 如果 tmux 会话已存在则先杀掉
if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "⚠️  检测到已有 '$SESSION' 会话，正在停止..."
    tmux kill-session -t "$SESSION"
    sleep 1
fi

echo "🚀 正在后台启动 polybot (tmux session: $SESSION)..."

# 在后台 tmux 里运行带自动重启的循环
tmux new-session -d -s "$SESSION" -x 220 -y 50 \
    "cd '$BOT_DIR' && while true; do
        echo \"[$(date '+%Y-%m-%d %H:%M:%S')] 🟢 启动 node src/index.js\" >> '$LOG_FILE'
        node src/index.js 2>> '$LOG_FILE'
        EXIT_CODE=\$?
        echo \"[$(date '+%Y-%m-%d %H:%M:%S')] 🔴 进程退出 (exit code: \$EXIT_CODE)，5秒后重启...\" >> '$LOG_FILE'
        sleep 5
    done"

sleep 1

if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo ""
    echo "✅ polybot 已在后台运行！"
    echo ""
    echo "  查看实时面板:  tmux attach -t polybot"
    echo "  退出面板:      Ctrl+B 然后按 D"
    echo "  停止机器人:    tmux kill-session -t polybot"
    echo "  查看重启日志:  tail -f logs/bot_restart.log"
    echo ""
else
    echo "❌ 启动失败，请检查 tmux 是否正常安装。"
    exit 1
fi
