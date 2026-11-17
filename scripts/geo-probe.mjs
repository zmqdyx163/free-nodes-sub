/**
 * geo-probe.mjs — 用 check-host.net 的香港/日本/新加坡节点做「亚洲视角」连通性验证
 *
 * 为什么需要这一步：mihomo 是在 GitHub Runner（美国）上测的，
 * "对美西可达"不等于"对亚洲可达"。免费节点里大量 VPS 只对特定区域开放，
 * 用香港视角再筛一遍，能砍掉一批海外能通、回国不通的。
 *
 * check-host 没有中国大陆节点，香港 hk1 是最接近的替代。
 * 注意：这里只测 TCP 端口可达，不测代理协议本身（那一步由 mihomo 做）。
 */
import fs from 'fs';
import path from 'path';

const DATA = path.join(process.cwd(), 'data');
const CHECK_NODES = ['hk1.node.check-host.net', 'jp1.node.check-host.net', 'sg1.node.check-host.net'];
const CONCURRENCY = +(process.env.GEO_CONCURRENCY || 2);
const GAP_MS = +(process.env.GEO_GAP || 900);
const LIMIT = +(process.env.GEO_LIMIT || 0);

const H = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const live = JSON.parse(fs.readFileSync(path.join(DATA, 'live.json'), 'utf8'));

// 每国按 mihomo 实测延迟取前 N 个作为候选，只验这些。
// check-host 每次请求约 4 秒，509 个要跑 33 分钟；按国家截断后是 1/3。
// UDP 协议（hysteria/tuic）check-host 测不了，直接跳过不浪费请求。
const UDP_TYPES = new Set(['hysteria', 'hysteria2', 'tuic']);
const GEO_TOP = +(process.env.GEO_TOP_PER_COUNTRY || 5);

const byCc = new Map();
for (const n of live) {
  if (UDP_TYPES.has(n.type)) continue;
  const cc = n._cc || 'ZZ';
  if (!byCc.has(cc)) byCc.set(cc, []);
  byCc.get(cc).push(n);
}
let targets = [];
for (const [, list] of byCc) {
  list.sort((a, b) => (a._latency ?? 99999) - (b._latency ?? 99999));
  targets.push(...list.slice(0, GEO_TOP));
}
if (LIMIT > 0) targets = targets.slice(0, LIMIT);
log(`亚洲视角验证：${targets.length} / ${live.length} 个（每国 Top${GEO_TOP}，跳过 UDP）`);

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) {
        await sleep(4000 * (i + 1));
        continue;
      }
      if (!r.ok) return null;
      return await r.json();
    } catch {
      await sleep(800);
    }
  }
  return null;
}

async function checkOne(node) {
  const target = `${node.server}:${node.port}`;
  const q = new URLSearchParams({ host: target });
  for (const n of CHECK_NODES) q.append('node', n);

  const start = await fetchJson(`https://check-host.net/check-tcp?${q}`);
  if (!start?.request_id) return { target, ok: false, reason: 'no-request-id' };
  const id = start.request_id;

  for (let i = 0; i < 10; i++) {
    await sleep(1200);
    const res = await fetchJson(`https://check-host.net/check-result/${id}`);
    if (!res) continue;
    const vals = Object.values(res);
    if (!vals.length || vals.some((v) => v === null)) continue;

    const out = {};
    for (const [host, v] of Object.entries(res)) {
      const key = host.split('.')[0];
      const first = Array.isArray(v) ? v[0] : null;
      if (first && !first.error) out[key] = Math.round((first.time || 0) * 1000);
    }
    return { target, ok: Object.keys(out).length > 0, geo: out };
  }
  return { target, ok: false, reason: 'result-timeout' };
}

const result = {};
let cursor = 0;
let done = 0;
let reachable = 0;
const t0 = Date.now();

await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= targets.length) break;
      const n = targets[i];
      const r = await checkOne(n);
      result[r.target] = r.geo || {};
      if (r.ok) reachable++;
      done++;
      if (done % 25 === 0) {
        log(`  ${done}/${targets.length}  亚洲可达 ${reachable}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
      await sleep(GAP_MS);
    }
  })
);

const secs = ((Date.now() - t0) / 1000).toFixed(0);
log(`完成：${reachable}/${done} 个可从港/日/新到达（${secs}s）`);

fs.writeFileSync(path.join(DATA, 'asia.json'), JSON.stringify(result, null, 0));
fs.writeFileSync(
  path.join(DATA, 'asia-meta.json'),
  JSON.stringify({ at: new Date().toISOString(), checked: done, reachable, nodes: CHECK_NODES, durationSec: +secs }, null, 2)
);
log('已写出 data/asia.json');
