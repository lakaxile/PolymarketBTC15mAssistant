import http from 'node:http';
import { URL } from 'node:url';
import { CONFIG } from '../config.js';
import { getMarsedgeState, getMarsedgePrediction } from '../data/marsedgeWs.js';

let server = null;

/**
 * 启动 AI 预测 API 分发服务器
 */
export function startApiServer() {
  if (!CONFIG.apiServer.enabled) {
    console.log('[API Server] Disabled via configuration.');
    return;
  }

  const { port, allowedTokens } = CONFIG.apiServer;

  server = http.createServer((req, res) => {
    // 允许跨域请求 (CORS)，方便外部网页看板对接
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    // 预检请求直接返回 OK
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      // 解析请求路径和参数
      const reqUrl = req.url || '/';
      const parsedUrl = new URL(reqUrl, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;

      // 1. 安全校验 (Token-based Auth)
      // 允许通过 query 参数 中的 token 或 apikey，或者 Authorization Header 传入令牌
      const queryToken = parsedUrl.searchParams.get('token') || parsedUrl.searchParams.get('apikey');
      const authHeader = req.headers.authorization || '';
      const headerToken = authHeader.replace(/^Bearer\s+/i, '').trim();

      const requestToken = queryToken || headerToken;

      // 如果未配置任何 token，则默认允许访问；否则必须匹配其中之一
      if (allowedTokens.length > 0 && (!requestToken || !allowedTokens.includes(requestToken))) {
        res.writeHead(401);
        res.end(JSON.stringify({
          ok: false,
          error: 'Unauthorized: Invalid or missing access token. Please provide token via ?token=xxx or Authorization header.'
        }));
        return;
      }

      // 2. 路由处理
      // 路由 1: 实时 AI 预测分发 (/prediction 或 /p)
      if (pathname === '/prediction' || pathname === '/p') {
        const symbol = parsedUrl.searchParams.get('symbol');

        if (symbol) {
          // 针对单个币种查询预测 (如 ?symbol=BTC)
          const prediction = getMarsedgePrediction(symbol.toUpperCase());
          res.writeHead(prediction.ok ? 200 : 400);
          res.end(JSON.stringify(prediction));
        } else {
          // 获取完整的预测面板状态
          const state = getMarsedgeState();
          res.writeHead(200);
          res.end(JSON.stringify({
            ok: true,
            connected: state.connected,
            updatedAt: state.updatedAt,
            items: state.items,
            error: state.error
          }));
        }
        return;
      }

      // 路由 2: 健康与连接状态检查 (/status 或 /health)
      if (pathname === '/status' || pathname === '/health') {
        const state = getMarsedgeState();
        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true,
          service: 'Polymarket Assistant API Distributor',
          marsedgeStream: {
            connected: state.connected,
            updatedAt: state.updatedAt,
            error: state.error
          },
          timestamp: Date.now()
        }));
        return;
      }

      // 路由 3: 未找到页面
      res.writeHead(404);
      res.end(JSON.stringify({
        ok: false,
        error: `Route ${pathname} not found. Valid endpoints are /prediction (or /p) and /status.`
      }));

    } catch (err) {
      console.error('[API Server] Request Error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({
        ok: false,
        error: `Internal Server Error: ${err.message}`
      }));
    }
  });

  server.on('error', (err) => {
    console.error('[API Server] Fatal Socket Error:', err);
  });

  server.listen(port, () => {
    console.log(`[API Server] 🚀 Sharing Marsedge AI predictions at http://0.0.0.0:${port}`);
    console.log(`[API Server] 🔒 Token Auth active with ${allowedTokens.length} allowed sub-tokens.`);
  });
}

/**
 * 停止服务器
 */
export function stopApiServer() {
  if (server) {
    server.close(() => {
      console.log('[API Server] Stopped.');
    });
  }
}
