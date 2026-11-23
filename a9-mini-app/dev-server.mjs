/**
 * a9mini 本地开发服务器（零依赖）
 *   - 静态托管 a9-mini-app
 *   - /api/* 同源转发到 A9_API_BASE（默认 http://127.0.0.1:8799，即 BAM demo worker）
 *
 * 为什么需要代理：BAM worker 的 ALLOWED_ORIGINS 只含 a9.lat 域名，本地跨源 fetch 会被 CORS 拦截。
 * 代理只用于本地/隔离环境演练，不改动 BAM 任何代码或配置。
 *
 * 运行：
 *   node dev-server.mjs            # http://127.0.0.1:8091（8089 常被旧的 http.server 占用）
 *   A9_PORT=8091 A9_API_BASE=http://127.0.0.1:8799 node dev-server.mjs
 * 打开：
 *   http://127.0.0.1:8089/                       -> 明确标识的演示模式
 *   http://127.0.0.1:8089/?mode=live             -> 真实 BAM 只读数据
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.A9_PORT || 8091);
const API_BASE = (process.env.A9_API_BASE || 'http://127.0.0.1:8799').replace(/\/+$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

function send(res, code, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function proxyApi(req, res, urlPath) {
  const target = `${API_BASE}${urlPath}`;
  try {
    const forwardHeaders = { accept: req.headers.accept || 'application/json' };
    for (const h of ['content-type', 'authorization', 'x-telegram-init-data', 'x-a9-admin-token', 'x-idempotency-key']) {
      if (req.headers[h]) forwardHeaders[h] = req.headers[h];
    }
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      body = Buffer.concat(chunks);
    }
    const upstream = await fetch(target, {
      method: req.method,
      headers: forwardHeaders,
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(15000)
    });
    const raw = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(raw);
  } catch (e) {
    send(res, 502, JSON.stringify({
      ok: false,
      error: { code: 'PROXY_UNREACHABLE', message: `Worker API 不可达：${API_BASE}（${e.message}）` }
    }), 'application/json; charset=utf-8');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/c/')) {
    await proxyApi(req, res, url.pathname + url.search);
    return;
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    send(res, 403, 'Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    send(res, 200, body, MIME[path.extname(filePath)] || 'application/octet-stream');
  } catch (_) {
    // hash 路由不走服务端；未找到静态资源时回 index.html 便于 TMA 深链直接进入
    try {
      const body = await readFile(path.join(ROOT, 'index.html'));
      send(res, 200, body, MIME['.html']);
    } catch (_) {
      send(res, 404, 'Not found');
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`a9mini dev server: http://127.0.0.1:${PORT}`);
  console.log(`BAM API proxy   : ${API_BASE}`);
  console.log('演示模式: /  |  只读实时模式: /?mode=live');
});
