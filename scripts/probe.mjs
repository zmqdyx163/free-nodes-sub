/**
 * probe.mjs — 用 mihomo 内核做真实代理测速
 *
 * TCP 握手只能证明端口开着，证明不了协议真的能通（密码错、协议不匹配、
 * 反代占位页都会让 TCP 通）。这里起一个真的 mihomo，对每个节点走
 * Clash API 的 /proxies/{name}/delay 发一次真实 HTTP 请求，
 * 只有真正拿到响应的节点才算活。
 *
 * 分批策略：mihomo 遇到一个坏节点就拒绝整份配置，而它的报错索引和数组位置
 * 对不上（内部有过滤），逐个剔除会死循环。所以每批 1000 个，某批校验不过就
 * 在批内剔几次，还不过就整批跳过——最多损失 1000 个，占比很小。
 */
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { proxyToYamlLines } from '../lib/parsers.mjs';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const WORK = path.join(ROOT, '.mihomo');
const CONFIG = path.join(WORK, 'config.yaml');
const MIHOMO = process.env.MIHOMO_BIN || path.join(ROOT, 'mihomo');

const API = 'http://127.0.0.1:19090';
// 以 ippure.com 的 Cloudflare trace 端点为测速基准（202 字节，
// 用首页 27KB 会让 8000 个节点白跑 200MB+ 流量）
const DELAY_URL = process.env.PROBE_URL || 'https://ippure.com/cdn-cgi/trace';
const TIMEOUT = +(process.env.PROBE_TIMEOUT || 5000);
const CONCURRENCY = +(process.env.PROBE_CONCURRENCY || 16);
const BATCH_SIZE = +(process.env.PROBE_BATCH || 1000);
const HTTP_PORT = 17890;
const API_PORT = 19090;

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 准备 ---------- */
fs.mkdirSync(WORK, { recursive: true });
const all = JSON.parse(fs.readFileSync(path.join(DATA, 'nodes.json'), 'utf8'));
const KNOWN = new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic']);

let targets = all.filter((n) => KNOWN.has(n.type)).map((n, i) => ({ idx: i, node: n }));
// ss 的 2022-* cipher 要求 key 是精确长度的 base64，免费节点里的几乎全是错的，
// mihomo 会直接拒绝整份配置，先剔掉
const before2022 = targets.length;
targets = targets.filter((t) => !(t.node.type === 'ss' && /^2022-/.test(String(t.node.cipher || ''))));
const dropped2022 = before2022 - targets.length;
const LIMIT = +(process.env.PROBE_LIMIT || 0);
if (LIMIT > 0) targets.length = Math.min(LIMIT, targets.length);
log(`待测 ${all.length} 个 → 剔除 ${dropped2022} 个 2022-cipher → 可测 ${targets.length} 个，每批 ${BATCH_SIZE}`);

function writeConfig(list) {
  const head = [
    `mixed-port: ${HTTP_PORT}`,
    'allow-lan: false',
    'mode: global',
    'log-level: warning',
    'ipv6: true',
    `external-controller: 127.0.0.1:${API_PORT}`,
    'tcp-concurrent: true',
    'unified-delay: false',
    '',
    'proxies:',
  ];
  const body = list.map((t) => proxyToYamlLines({ ...t.node, name: `n${t.idx}` })).join('\n');
  fs.writeFileSync(CONFIG, [...head, body, '', 'proxy-groups: []', '', 'rules:', '  - MATCH,DIRECT', ''].join('\n'));
}

function validate() {
  const r = spawnSync(MIHOMO, ['-t', '-f', CONFIG, '-d', WORK], { encoding: 'utf8', timeout: 300000 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/**
 * 二分找出让 mihomo 拒绝配置的节点，最多找 6 个。
 * 不用 mihomo 报的 "proxy N" 索引——那是内部过滤后的位置，和数组下标对不上。
 */
function findBad(list, acc, depth) {
  if (acc.length >= 6 || depth > 11) return acc;
  writeConfig(list);
  if (validate().ok) return acc;
  if (list.length === 1) {
    acc.push(list[0]);
    return acc;
  }
  const mid = list.length >> 1;
  findBad(list.slice(0, mid), acc, depth + 1);
  if (acc.length < 6) findBad(list.slice(mid), acc, depth + 1);
  return acc;
}

/* ---------- 测速 ---------- */
async function delayOf(name) {
  const url = `${API}/proxies/${encodeURIComponent(name)}/delay?timeout=${TIMEOUT}&url=${encodeURIComponent(DELAY_URL)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT + 3000) });
    if (!r.ok) return null;
    const d = await r.json();
    return typeof d.delay === 'number' && d.delay > 0 ? d.delay : null;
  } catch {
    return null;
  }
}

async function waitReady(proc, maxMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (proc.exitCode !== null) return false;
    try {
      const r = await fetch(`${API}/version`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(800);
  }
  return false;
}

const alive = [];
let tested = 0;
let skippedBatches = 0;
const t0 = Date.now();

for (let bi = 0; bi * BATCH_SIZE < targets.length; bi++) {
  const chunk = targets.slice(bi * BATCH_SIZE, (bi + 1) * BATCH_SIZE);
  const tag = `[批 ${bi + 1}/${Math.ceil(targets.length / BATCH_SIZE)}]`;

  // 批内二分定位坏节点（mihomo 报的索引不可靠），最多找 6 个
  let cur = chunk;
  let ready = false;
  for (let round = 0; round < 4; round++) {
    writeConfig(cur);
    const v = validate();
    if (v.ok) {
      ready = true;
      break;
    }
    const bad = [];
    findBad(cur, bad, 0);
    if (!bad.length) {
      log(`${tag} 校验失败但二分没定位到，原始输出：`);
      console.log(v.out.slice(0, 600));
      break;
    }
    log(`${tag} 剔除 ${bad.length} 个坏节点：${bad.map((t) => `${t.node.type}@${t.node.server}:${t.node.port}`).join(' ')}`);
    const badSet = new Set(bad);
    cur = cur.filter((t) => !badSet.has(t));
  }
  if (!ready) {
    log(`${tag} 跳过（${chunk.length} 个）`);
    skippedBatches++;
    continue;
  }

  // 启动 mihomo 测这一批
  if (process.env.PROBE_DRYRUN === '1') {
    log(`${tag} 校验通过 ${cur.length} 个（dry-run）`);
    continue;
  }
  log(`${tag} 启动 mihomo，测 ${cur.length} 个`);
  const proc = spawn(MIHOMO, ['-f', CONFIG, '-d', WORK], { stdio: ['ignore', 'pipe', 'pipe'] });
  let procOut = '';
  proc.stdout.on('data', (d) => (procOut += d.toString()));
  proc.stderr.on('data', (d) => (procOut += d.toString()));

  if (!(await waitReady(proc))) {
    log(`${tag} mihomo 启动失败：${procOut.slice(0, 400)}`);
    try {
      proc.kill('SIGKILL');
    } catch {}
    skippedBatches++;
    continue;
  }

  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= cur.length) break;
        const t = cur[i];
        const ms = await delayOf(`n${t.idx}`);
        tested++;
        if (ms !== null) alive.push({ ...t.node, _latency: ms });
        if (tested % 500 === 0) {
          log(`  ${tested}/${targets.length} 存活 ${alive.length} 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        }
      }
    })
  );

  try {
    proc.kill('SIGKILL');
  } catch {}
  await sleep(1200);
}

const secs = ((Date.now() - t0) / 1000).toFixed(0);
log(`测速完成：${alive.length}/${tested} 真活，跳过 ${skippedBatches} 批，用时 ${secs}s`);

/* ---------- 输出 ---------- */
fs.writeFileSync(path.join(DATA, 'live.json'), JSON.stringify(alive));
fs.writeFileSync(
  path.join(DATA, 'probe-meta.json'),
  JSON.stringify(
    { at: new Date().toISOString(), tested, alive: alive.length, skippedBatches, durationSec: +secs, timeoutMs: TIMEOUT, concurrency: CONCURRENCY },
    null,
    2
  )
);
log('已写出 data/live.json');
