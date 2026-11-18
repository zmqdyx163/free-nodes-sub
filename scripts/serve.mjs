#!/usr/bin/env node
/**
 * serve.mjs — 带令牌的订阅静态服务（零依赖）
 *
 * 为什么要它：GitHub 的 raw / Pages / jsDelivr 都是无鉴权静态地址，
 * 只要 URL 能 GET 到就一定会被扫。自己起一个带令牌的服务，
 * 扫描器没有令牌就拿不到内容。
 *
 * 用法：
 *   SUB_TOKEN=$(openssl rand -hex 16) node scripts/serve.mjs
 *   SUB_TOKEN=xxxx PORT=8080 SUB_DIR=./sub node scripts/serve.mjs
 *
 * 访问：
 *   http://<host>:8080/<SUB_TOKEN>/clash.yaml
 *   http://<host>:8080/<SUB_TOKEN>            # 按 User-Agent 自动选 yaml 或 base64
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PORT = +(process.env.PORT || 8080);
const BIND = process.env.BIND || '0.0.0.0';
const TOKEN = (process.env.SUB_TOKEN || '').trim();
const DIR = path.resolve(process.env.SUB_DIR || 'sub');

if (!TOKEN || TOKEN.length < 8) {
  console.error('[serve] 必须设置 SUB_TOKEN（至少 8 位）。例如：');
  console.error('        SUB_TOKEN=$(openssl rand -hex 16) node scripts/serve.mjs');
  process.exit(1);
}

const FILES = {
  'clash.yaml': 'text/yaml; charset=utf-8',
  'base64.txt': 'text/plain; charset=utf-8',
  'uri.txt': 'text/plain; charset=utf-8',
  'stats.json': 'application/json; charset=utf-8',
};

/** 常量时间比较，避免通过响应时间逐字节猜令牌 */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** 客户端 UA 决定默认格式：Clash 系给 yaml，其余给 base64 */
function pickByUA(ua = '') {
  const u = String(ua).toLowerCase();
  if (/clash|meta|mihomo|stash|verge|flclash|surfboard/.test(u)) return 'clash.yaml';
  return 'base64.txt';
}

function deny(res, code = 404, msg = 'not found') {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`${msg}\n`);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return deny(res, 400, 'bad request');
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return deny(res);
  if (!safeEqual(parts[0], TOKEN)) return deny(res);

  const want = parts[1] || pickByUA(req.headers['user-agent']);
  if (!FILES[want]) return deny(res);

  const fp = path.resolve(DIR, want);
  // 双保险：即使 FILES 白名单被绕过，也不允许跳出目录
  if (!fp.startsWith(DIR + path.sep) && fp !== path.join(DIR, want)) return deny(res, 403, 'forbidden');

  let stat;
  try {
    stat = fs.statSync(fp);
  } catch {
    return deny(res, 503, 'subscription not ready');
  }
  if (!stat.isFile()) return deny(res);

  res.writeHead(200, {
    'Content-Type': FILES[want],
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Profile-Update-Interval': '12', // 小时，部分客户端会读
    'Subscription-Userinfo': 'upload=0; download=0; total=0; expire=0',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(fp).pipe(res);
});

server.listen(PORT, BIND, () => {
  console.log(`[serve] 监听 http://${BIND}:${PORT}`);
  console.log(`[serve] 目录 ${DIR}`);
  console.log(`[serve] 订阅地址 http://<你的IP>:${PORT}/${TOKEN}/clash.yaml`);
});
