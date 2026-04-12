import { ProxyAgent, setGlobalDispatcher } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

// 全局 Agent 缓存，防止内存泄漏和句柄爆炸
const agentCache = new Map();
const undiciCache = new Map();

/**
 * 从环境变量中读取值
 */
function readEnv(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : "";
}

/**
 * 根据目标 URL 获取对应的代理地址
 * @param {string} targetUrl 目标 URL
 * @returns {string} 代理 URL
 */
export function getProxyUrlFor(targetUrl) {
  const u = String(targetUrl || "");
  const isHttps = u.startsWith("https://") || u.startsWith("wss://");
  const isHttp = u.startsWith("http://") || u.startsWith("ws://");

  const all = readEnv("ALL_PROXY") || readEnv("all_proxy");
  const https = readEnv("HTTPS_PROXY") || readEnv("https_proxy");
  const http = readEnv("HTTP_PROXY") || readEnv("http_proxy");

  if (isHttps) return https || all || "";
  if (isHttp) return http || all || "";
  return all || https || http || "";
}

/**
 * 从环境变量应用全局代理设置（针对 undici / fetch）
 */
export function applyGlobalProxyFromEnv() {
  const proxyUrl = getProxyUrlFor("https://example.com");
  if (!proxyUrl) return false;

  try {
    let agent = undiciCache.get(proxyUrl);
    if (!agent) {
      agent = new ProxyAgent(proxyUrl);
      undiciCache.set(proxyUrl, agent);
    }
    setGlobalDispatcher(agent);
    return true;
  } catch {
    return false;
  }
}

/**
 * 为 WebSocket 获取对应的 Agent（支持 HTTP 和 SOCKS 代理）
 * @param {string} wsUrl WebSocket URL
 */
export function wsAgentForUrl(wsUrl) {
  const proxyUrl = getProxyUrlFor(wsUrl);
  if (!proxyUrl) return undefined;

  // 检查缓存
  if (agentCache.has(proxyUrl)) return agentCache.get(proxyUrl);

  const lower = proxyUrl.toLowerCase();
  let agent;
  if (lower.startsWith("socks://") || lower.startsWith("socks5://") || lower.startsWith("socks4://")) {
    agent = new SocksProxyAgent(proxyUrl);
  } else {
    agent = new HttpsProxyAgent(proxyUrl);
  }

  agentCache.set(proxyUrl, agent);
  return agent;
}

