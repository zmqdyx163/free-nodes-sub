/**
 * geo-scan.mjs — 用 ip-api 批量标注每个节点的所属国家
 *
 * 为什么需要这一步：harvest 用 ipinfo 标国家，免费额度只有 50k/月，
 * 每天扫 8600 个 IP 半个月就用完了。一旦 429，所有节点会被标成 ZZ，
 * 「每国 Top N」就退化成只取 N 个，订阅直接空掉（实测 live 从 117 掉到 6）。
 *
 * ip-api 的批量接口免费不限量（100 IP/次，15 次/分钟），用它拿 countryCode
 * 回填 n._cc，作为 ipinfo 失败时的兜底。
 *
 * 输出 data/geo-scan.json:
 *   { "1.2.3.4": { "cc": "US", "country": "United States" } }
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const BATCH = 100;
const GAP_MS = +(process.env.GEO_SCAN_GAP || 4200); // ip-api 免费版批量 15 次/分钟
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nodesPath = path.join(DATA, 'nodes.json');
if (!fs.existsSync(nodesPath)) {
  console.error('找不到 data/nodes.json，先跑 harvest');
  process.exit(1);
}
const nodes = JSON.parse(fs.readFileSync(nodesPath, 'utf8'));

const isIp = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s || ''));
const ips = [...new Set(nodes.map((n) => n.server).filter(isIp))];

// 只查那些 ipinfo 没标出来的（已经有国家的不浪费请求）
const needCc = new Set(nodes.filter((n) => !n._cc || n._cc === 'ZZ').map((n) => n.server).filter(isIp));
const targets = ips.filter((ip) => needCc.has(ip));

log(`节点 ${nodes.length} 个，唯一 IP ${ips.length} 个，需要补国家 ${targets.length} 个`);

if (!targets.length) {
  log('所有节点都已有国家标注，跳过');
  fs.writeFileSync(path.join(DATA, 'geo-scan.json'), '{}');
  process.exit(0);
}

const result = {};
let done = 0;
const t0 = Date.now();

for (let i = 0; i < targets.length; i += BATCH) {
  const batch = targets.slice(i, i + BATCH);
  let rows = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch('http://ip-api.com/batch?fields=status,query,countryCode,country', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(25000),
      });
      if (r.status === 429) {
        log(`  限流，退避 ${5 * (attempt + 1)}s`);
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (!r.ok) break;
      rows = await r.json();
      break;
    } catch {
      await sleep(1500);
    }
  }

  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row.query) continue;
      result[row.query] =
        row.status === 'success' && row.countryCode
          ? { cc: String(row.countryCode).toUpperCase(), country: row.country || '' }
          : { cc: '', country: '' };
    }
  }

  done += batch.length;
  if (done % 500 === 0 || done >= targets.length) {
    log(`  ${done}/${targets.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  if (i + BATCH < targets.length) await sleep(GAP_MS);
}

/* ---------- 回填国家 ---------- */
let fixed = 0;
const byCc = {};
for (const n of nodes) {
  const r = result[n.server];
  if (r?.cc && /^[A-Z]{2}$/.test(r.cc) && r.cc !== n._cc) {
    n._cc = r.cc;
    if (r.country && !n._country) n._country = r.country;
    fixed++;
  }
  byCc[n._cc] = (byCc[n._cc] || 0) + 1;
}
fs.writeFileSync(nodesPath, JSON.stringify(nodes));
fs.writeFileSync(path.join(DATA, 'geo-scan.json'), JSON.stringify(result));
fs.writeFileSync(
  path.join(DATA, 'geo-scan-meta.json'),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      queried: Object.keys(result).length,
      fixed,
      countries: Object.keys(byCc).length,
      durationSec: Math.round((Date.now() - t0) / 1000),
    },
    null,
    2
  )
);

log(`国家标注修正 ${fixed} 个，覆盖 ${Object.keys(byCc).length} 个国家`);
log('已写回 data/nodes.json');
