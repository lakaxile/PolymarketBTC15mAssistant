# Polymarket BTC/ETH 5m Automated Trading Assistant

一个专为 Polymarket **"Bitcoin/Ethereum Up or Down" 5分钟** 预测市场设计的实时命令行智能交易助手与自动托管交易机器人。

该系统深度集成了 Polymarket CLOB（限价订单簿协议）、MarsEdge 机器学习预测源、Polygon 链上 Chainlink 预言机以及 Binance 实时行情，实现了全自动的交易决策与订单生命周期托管。

---

## 🚀 核心功能特色

- **多资产双向监控**：同时支持 **BTC** 与 **ETH** 的 5分钟 预测市场，自动定位最新一期的期权市场（Auto-Select Latest）。
- **极速双源价格同步**：
  - 首选连接 Polymarket Live WS 以秒级同步最新的 Chainlink BTC/USD 与 ETH/USD CURRENT PRICE（与官方前端 UI 保持绝对一致）。
  - 具备健壮的 **链上 Chainlink 预言机降级回退机制**：当 Polymarket WebSocket 出现抖动或离线时，系统自动切换至 Polygon 链上 RPC 节点直接拉取聚合器合约数据。
- **MarsEdge ML 预测流集成**：实时连接 MarsEdge SSE 预测流，根据模型胜率（Probability）、数学期望值（Edge）、剩余时间（Remaining Time）及行情振幅进行多维度联合信号评估。
- **智能双模下单策略**：
  - **限价挂单模式（LIMIT）**：使用挂单偏移量（如比 Ask 价格低 1¢），争取更优的买入价，最大化交易盈亏比。
  - **市价扫单模式（MARKET）**：在倒计时临界点（如剩余时间极短且模型胜率极高时）触发市价单，确保高确定性信号完美成交。
- **自愈型订单生命周期管理**：
  - 自动检测并修复因 Polymarket API 503 异常、网络超时或未成交导致的订单滞留。
  - 自动纠错机制：任何未成功上链或失败的 `PENDING` 挂单在启动和对账时会自动归入 `MISSED`（失手）状态并以红字显示，拒绝账目混乱。
- **工业级代理支持**：原生支持 HTTP/HTTPS 以及 SOCKS5 代理（包含用户名及密码认证，并自动处理特殊字符 URL 编码），适合各种复杂网络环境。
- **进程级守护与一键部署**：内置 `start_bot.sh` 脚本，基于 `tmux` 快速创建后台持久化会话，支持崩溃后 5 秒自动重启，并提供极佳的实时监控命令行面板。

---

## 📂 项目模块架构

```text
PolymarketBTC15mAssistant/
├── logs/                      # 运行日志与订单账本目录
│   ├── bot_restart.log        # 守护进程重启与标准输出日志
│   └── orders.jsonl           # 结构化订单历史账本 (JSON Lines)
├── src/
│   ├── config.js              # 全局系统配置文件 (包含参数、RPC、聚合器地址)
│   ├── index.js               # 机器人主入口 (负责主循环、实时命令行 UI 渲染与数据订阅)
│   ├── data/
│   │   ├── binanceWs.js       # 订阅 Binance 现货 Websocket
│   │   ├── marsedgeWs.js      # 订阅 MarsEdge ML 预测流 (SSE/WS)
│   │   └── polymarket.js      # 封装 Polymarket CLOB 与 Gamma 交互
│   ├── engine/
│   │   ├── executor.js        # 订单执行器 (处理撮合、自愈对账、限价与市价订单)
│   │   └── signal.js          # 信号评估器 (量化决策与挂单偏置逻辑)
│   └── net/
│       └── proxy.js           # 动态代理加载层
├── start_bot.sh               # tmux 后台守护与一键启动脚本
├── package.json               # 项目依赖与启动命令
└── README.md                  # 本说明文档
```

---

## 📊 策略配置参数 (`src/engine/signal.js`)

系统策略参数可在 `src/engine/signal.js` 的 `STRATEGY` 对象中进行微调：

| 参数项 | 当前设定值 | 说明 |
| :--- | :---: | :--- |
| `minModelProb` | `0.85` | **最低模型胜率要求**：模型预测方向概率低于 85% 时不操作。 |
| `minEdge` | `0.10` | **最低数学期望 (Edge)**：模型预测概率 - 市场 Ask 价格须 $\ge 10\%$。 |
| `minRemSecs` | `15` | **最少剩余交易秒数**：临近期权结束 15 秒内不再挂限价单。 |
| `maxRemSecs` | `180` | **最多剩余交易秒数**：距离期权结束大于 180 秒时，因不确定性大不予操作。 |
| `minPriceChangePct`| `0.09` | **最小价格振幅过滤 (0.09%)**：BTC 5分钟价格波动低于该比例则判定为横盘，不予以交易。 |
| `minPriceChangePctEth`| `0.12` | **最小价格振幅过滤 (0.12%)**：ETH 5分钟价格波动低于该比例则判定为横盘，不予以交易。 |
| `limitOrderOffset` | `0.01` | **限价单挂单偏移量 (1¢)**：挂单买入价格设为 `Ask - 0.01$` 争取更好成本。 |
| `marketOrderMinProb`| `0.93` | **市价单最低胜率**：在倒计时冲刺阶段，胜率需达到 93% 才会触发市价买入。 |
| `marketOrderMinEdge`| `0.15` | **市价单最低 Edge**：在倒计时冲刺阶段，期望空间需达到 15% 才会触发市价买入。 |
| `marketOrderMaxRemSecs`| `45` | **市价单时间窗口**：倒计时低于 45 秒时方可评估市价买入。 |

---

## ⚙️ 环境变量配置 (`.env`)

在项目根目录下创建 `.env` 文件，用于注入敏感凭证与网络端点：

```env
# ──────────────────────────────────────────────────────────────────────────────
# 1. POLYMARKET API 凭证 (用于实盘限价/市价下单)
# ──────────────────────────────────────────────────────────────────────────────
POLY_WALLET_KEY=your_wallet_private_key   # 托管钱包私钥 (例如 0x...)
POLY_PROXY_ADDRESS=0x...                  # 您的 Polymarket Gnosis 代理多签钱包地址
POLY_API_KEY=your_api_key                 # CLOB API KEY
POLY_API_SECRET=your_api_secret           # CLOB API SECRET
POLY_PASSPHRASE=your_passphrase           # CLOB API 密码密匙

# ──────────────────────────────────────────────────────────────────────────────
# 2. 网络节点配置 (Chainlink 降级防线)
# ──────────────────────────────────────────────────────────────────────────────
POLYGON_RPC_URL=https://polygon-rpc.com   # 默认 Polygon 快速 RPC
POLYGON_RPC_URLS=https://polygon-rpc.com,https://polygon.drpc.org # 备用 HTTP RPC 列表 (逗号分隔)
POLYGON_WSS_URLS=wss://polygon-bor-rpc.publicnode.com             # 备用 WSS RPC 列表 (逗号分隔)

# ──────────────────────────────────────────────────────────────────────────────
# 3. 代理设置 (如果需要)
# ──────────────────────────────────────────────────────────────────────────────
HTTPS_PROXY=socks5://username:password@127.0.0.1:1080 # 原生支持带账号密码的 SOCKS5/HTTP 代理
```

> 💡 **提示**：如果您的代理密码中包含特殊字符（例如 `@` 或 `:`），请对其进行标准的 URL-encode。例如，密码为 `p@ss:word` 时，应当编码输入为 `p%40ss%3Aword`。

---

## 🏁 安装与启动指南

### 1. 环境准备
确保您的运行环境已安装 **Node.js 18+** 并且安装了 `tmux`（用于后台持久化会话）：
```bash
# Ubuntu/Debian 安装 tmux
sudo apt-get update && sudo apt-get install -y tmux
```

### 2. 获取代码与依赖安装
```bash
# 克隆仓库
git clone https://github.com/FrondEnt/PolymarketBTC15mAssistant.git
cd PolymarketBTC15mAssistant

# 安装项目依赖
npm install
```

### 3. 一键后台守护运行 (强烈推荐)
项目附带了高可用的 `start_bot.sh` 脚本。该脚本会在后台创建一个名为 `polybot` 的 `tmux` 会话，并在机器人进程异常退出时提供 5 秒自动拉起重启服务。

- **启动后台机器人**：
  ```bash
  bash start_bot.sh
  ```
- **查看实时交互式监控面板**：
  ```bash
  tmux attach -t polybot
  ```
- **在监控面板中脱离（保持后台运行）**：
  在附着状态下，依次按下组合键 `Ctrl + B`，然后松开并按下键盘上的 `D` 键。
- **优雅停止后台机器人**：
  ```bash
  tmux kill-session -t polybot
  ```
- **查看进程重启与崩溃日志**：
  ```bash
  tail -f logs/bot_restart.log
  ```

---

## 📈 交互面板操控说明

当您附着（`tmux attach`）进入实时终端面板时，系统将渲染一个高保真的实时仪表盘：
- **核心行情数据**：直观展示 BTC/ETH 的当前价格、与期权平衡价格（Price to Beat）的偏移状态与最新波幅。
- **实时信号预警**：显示最新的 ML 评估状态，包括胜率、数学期望值以及下单动作（若信号触发）。
- **订单账本历史**：在底部实时渲染最近 5 笔交易的详细状态（包含委托时刻、方向、概率、成交价及 `FILLED` / `MISSED` 等状态）。
- **加载更多历史**：在终端面板激活状态下，直接按下键盘上的 **`L` 键** 可向上翻页加载更多的历史成交记录。

---

## 🛡️ 安全与免责声明

- 本项目开源且仅作为个人量化交易开发示例与辅助技术参考，**不构成任何投资建议或操盘诱导**。
- 加密货币期权与 Polymarket 预测市场具有极高的波动性与杠杆风险，使用本助手进行实盘托管前，请确保在测试网或小资金充分验证。
- 开发者与开源社区对任何由于代码 Bug、网络延迟、不可抗力、API 故障或滑点带来的财产损失**不承担任何赔偿及连带责任**。

---

*Created and maintained with ❤️ for state-of-the-art Polymarket trading.*
