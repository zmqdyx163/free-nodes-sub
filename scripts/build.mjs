/**
 * build.mjs — 每国 Top N → 生成订阅文件
 *
 * 排序优先级：
 *   1. 香港/日本/新加坡三地探测到的最低 TCP 延迟（贴近国内实际体验）
 *   2. 没有亚洲探测结果的，排在后面，用 mihomo 的海外延迟兜底
 */
import fs from 'fs';
import path from 'path';
import { renderClashYaml, renderBase64Sub, renderUriList } from '../lib/parsers.mjs';
import { flagOf } from '../lib/geo.mjs';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'sub');
fs.mkdirSync(OUT, { recursive: true });

const TOP_N = +(process.env.TOP_PER_COUNTRY || 5);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const live = JSON.parse(fs.readFileSync(path.join(DATA, 'live.json'), 'utf8'));
const harvest = JSON.parse(fs.readFileSync(path.join(DATA, 'harvest-meta.json'), 'utf8'));

let asia = {};
let asiaMeta = null;
try {
  asia = JSON.parse(fs.readFileSync(path.join(DATA, 'asia.json'), 'utf8'));
  asiaMeta = JSON.parse(fs.readFileSync(path.join(DATA, 'asia-meta.json'), 'utf8'));
} catch {
  log('没有 asia.json，按 mihomo 延迟排序');
}

/* ---------- 融合亚洲探测结果 ---------- */
const UDP_TYPES = new Set(['hysteria', 'hysteria2', 'tuic']);
let asiaHit = 0;
let udpKept = 0;
for (const n of live) {
  const g = asia[`${n.server}:${n.port}`] || {};
  n._geo = g;
  const pick = (...keys) => {
    for (const k of keys) if (typeof g[k] === 'number') return g[k];
    return null;
  };
  // check-host 只能测 TCP，UDP 协议（hysteria/tuic）必然判不可达，
  // 这类不参与亚洲筛选，按 mihomo 结果保留
  if (UDP_TYPES.has(n.type)) {
    n._udp = true;
    n._asia = null;
    udpKept++;
    continue;
  }
  // 评分优先用香港视角：国内 → 香港约 30–50ms，香港 → 目标才是真实绕路
  // 直接取 min(hk,jp,sg) 会取到同城 2ms 的假数据（JP 节点由 jp1 测出来就是 2ms）
  let s = null;
  const hk = pick('hk', 'hk1');
  const jp = pick('jp', 'jp1');
  const sg = pick('sg', 'sg1');
  if (hk != null) s = hk;
  else if (jp != null) s = jp + 40;
  else if (sg != null) s = sg + 40;
  n._asia = s;
  if (s != null) asiaHit++;
}
log(`真活 ${live.length} 个：${asiaHit} 个可从港/日/新到达，${udpKept} 个 UDP 协议保留（不参与 TCP 探测）`);

const score = (n) =>
  n._asia != null ? n._asia : n._udp ? 20000 + (n._latency || 9999) : 100000 + (n._latency || 9999);
const reachable = (n) => n._asia != null || n._udp === true;

/* ---------- 分组取 TopN ---------- */
const groups = new Map();
for (const n of live) {
  const cc = n._cc || 'ZZ';
  if (!groups.has(cc)) groups.set(cc, []);
  groups.get(cc).push(n);
}

const selected = [];
const idxByCc = {};
for (const [cc, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  list.sort((a, b) => score(a) - score(b) || (a._latency || 0) - (b._latency || 0));
  // 有可达节点的国家只留可达的；整国都不可达时保留 3 个兜底，避免分组消失
  const ok = list.filter(reachable);
  const pick = ok.length ? ok.slice(0, TOP_N) : list.slice(0, 3);
  for (const n of pick) {
    idxByCc[cc] = (idxByCc[cc] || 0) + 1;
    selected.push({
      ...n,
      name: `${flagOf(cc === 'ZZ' ? '' : cc)}${cc}-${String(idxByCc[cc]).padStart(2, '0')}`,
    });
  }
}

selected.sort((a, b) => a._cc.localeCompare(b._cc) || score(a) - score(b));
log(`筛选后 ${selected.length} 个，覆盖 ${groups.size} 个国家`);

/* ---------- 生成 ---------- */
const updated = new Date().toISOString();
const clash = renderClashYaml(selected, {
  updated,
  sources: 'xinshoucun.net + blog.kuaiyu.cc',
  topPerCountry: TOP_N,
});

const byCountry = {};
const byType = {};
for (const n of selected) {
  byCountry[n._cc] = (byCountry[n._cc] || 0) + 1;
  byType[n.type] = (byType[n.type] || 0) + 1;
}

const finalAsia = selected.filter((n) => n._asia != null);

const stats = {
  updated,
  live: selected.length,
  alive: live.length,
  topPerCountry: TOP_N,
  countries: groups.size,
  raw: harvest.raw,
  unique: harvest.unique,
  posts: harvest.posts,
  subs: harvest.subs,
  asiaVerified: asiaMeta ? asiaMeta.checked : 0,
  asiaReachable: asiaHit,
  finalAsiaReachable: finalAsia.length,
  avgLatency: Math.round(finalAsia.reduce((s, n) => s + n._asia, 0) / Math.max(finalAsia.length, 1)),
  latencySource: finalAsia.length ? 'hk tcp hop (excl. cn->hk)' : 'mihomo overseas',
  byCountry,
  byType,
  ranking: [...groups.entries()]
    .map(([cc, l]) => {
      const a = l.filter((n) => n._asia != null);
      return { cc, alive: l.length, asia: a.length, bestAsia: a.length ? Math.min(...a.map((n) => n._asia)) : null };
    })
    .sort((a, b) => b.asia - a.asia || b.alive - a.alive),
};

fs.writeFileSync(path.join(OUT, 'clash.yaml'), clash);
fs.writeFileSync(path.join(OUT, 'base64.txt'), renderBase64Sub(selected));
fs.writeFileSync(path.join(OUT, 'uri.txt'), renderUriList(selected).join('\n'));
fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(stats, null, 2));

// 仓库里只提交这个「无节点信息」的状态文件，供 workflow 的 gate 判断当天是否已跑过。
// 订阅本体（sub/）通过 Actions Artifact 分发，不进 Git。
fs.writeFileSync(
  path.join(ROOT, 'status.json'),
  JSON.stringify(
    {
      updated,
      live: stats.live,
      alive: stats.alive,
      countries: stats.countries,
      topPerCountry: stats.topPerCountry,
      byType: stats.byType,
      avgLatency: stats.avgLatency,
      latencySource: stats.latencySource,
    },
    null,
    2
  )
);
fs.writeFileSync(
  path.join(OUT, 'nodes.json'),
  JSON.stringify(
    selected.map((n) => ({
      name: n.name,
      type: n.type,
      server: n.server,
      port: n.port,
      country: n._cc,
      city: n._city,
      isp: n._isp,
      latency: n._latency,
      asia: n._asia,
    })),
    null,
    1
  )
);

log('产出：');
log(`  sub/clash.yaml   ${(clash.length / 1024).toFixed(1)} KB`);
log(`  亚洲可达 ${finalAsia.length}/${selected.length}`);
log('协议分布:', JSON.stringify(byType));
log('Top 国家:', JSON.stringify(stats.ranking.slice(0, 8).map((r) => `${r.cc}:${r.asia}/${r.alive}`)));
