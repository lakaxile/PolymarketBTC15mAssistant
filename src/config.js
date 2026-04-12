/**
 * 配置文件：包含交易对、API 终端、轮询间隔、指标参数等
 */
export const CONFIG = {
  symbol: "BTCUSDT", // 交易对符号
  binanceBaseUrl: "https://api.binance.com", // 币安 API 基础地址
  gammaBaseUrl: "https://gamma-api.polymarket.com", // Polymarket Gamma API 基础地址
  clobBaseUrl: "https://clob.polymarket.com", // Polymarket CLOB API 基础地址

  pollIntervalMs: 1_000, // 轮询间隔（毫秒）
  candleWindowMinutes: 15, // K 线时间窗口（15分钟）

  vwapSlopeLookbackMinutes: 5, // VWAP 斜率回溯分钟数
  rsiPeriod: 14, // RSI 周期
  rsiMaPeriod: 14, // RSI 移动平均周期

  macdFast: 12, // MACD 快线周期
  macdSlow: 26, // MACD 慢线周期
  macdSignal: 9, // MACD 信号线周期

  polymarket: {
    marketSlug: process.env.POLYMARKET_SLUG || "", // 市场标识符
    seriesId: process.env.POLYMARKET_SERIES_ID || "10192", // 系列 ID
    seriesSlug: process.env.POLYMARKET_SERIES_SLUG || "btc-up-or-down-15m", // 系列标识符
    autoSelectLatest: (process.env.POLYMARKET_AUTO_SELECT_LATEST || "true").toLowerCase() === "true", // 是否自动选择最新市场
    liveDataWsUrl: process.env.POLYMARKET_LIVE_WS_URL || "wss://ws-live-data.polymarket.com", // Polymarket 实时数据 WebSocket 地址
    upOutcomeLabel: process.env.POLYMARKET_UP_LABEL || "Up", // 看涨结果标签
    downOutcomeLabel: process.env.POLYMARKET_DOWN_LABEL || "Down" // 看跌结果标签
  },

  chainlink: {
    polygonRpcUrls: (process.env.POLYGON_RPC_URLS || "").split(",").map((s) => s.trim()).filter(Boolean), // Polygon RPC URL 列表
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com", // Polygon RPC 基础地址
    polygonWssUrls: (process.env.POLYGON_WSS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean), // Polygon WSS URL 列表
    polygonWssUrl: process.env.POLYGON_WSS_URL || "", // Polygon WSS 基础地址
    btcUsdAggregator: process.env.CHAINLINK_BTC_USD_AGGREGATOR || "0xc907E116054Ad103354f2D350FD2514433D57F6f" // Chainlink BTC/USD 聚合器合约地址
  }
};

