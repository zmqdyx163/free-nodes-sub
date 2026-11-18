/**
 * isp-scan.mjs — 判断每个节点是不是 ISP 家宽（住宅 IP）
 *
 * 为什么不用第三方的 hosting 字段：ip-api 的 hosting 对 DNS/CDN 误判严重
 * （114.114.114.114 这种联通 DNS 都会被标成 hosting=true），ipinfo 免费额度
 * 又经常 429。所以只拿它的 isp / as 名称，自己按关键词分类。
 *
 * 输出 data/isp.json:
 *   { "1.2.3.4": { "cls": "isp" | "hosting" | "unknown", "isp": "Comcast Cable" } }
 *
 * 分类规则：先匹配机房关键词（强特征），再匹配家宽关键词，都不中记 unknown。
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const BATCH = 100;
const GAP_MS = +(process.env.ISP_GAP || 4200); // ip-api 免费版批量 15 次/分钟
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 机房 / 云厂商 / IDC 关键词（命中即判 hosting） */
const HOSTING_WORDS = [
  'amazon', 'aws', 'google', 'gcp', 'microsoft', 'azure', 'digitalocean', 'vultr',
  'linode', 'hetzner', 'ovh', 'oracle', 'alibaba', 'aliyun', 'tencent', 'huawei',
  'contabo', 'scaleway', 'upcloud', 'kamatera', 'ionos', 'hostinger', 'godaddy',
  'namecheap', 'cloudflare', 'fastly', 'akamai', 'leaseweb', 'equinix', 'datacamp',
  'm247', 'gthost', 'melbikomas', 'choopa', 'colocrossing', 'fdcservers', 'psychz',
  'quadranet', 'incero', 'hostwinds', 'bandwagon', 'racknerd', 'virmach', 'buyvm',
  'netcup', 'worldstream', 'serverius', 'zenlayer', 'cdn77', 'stackpath',
  'interserver', 'hosthatch', 'greencloud', 'cloudsigma', 'dreamhost', 'bluehost',
  'siteground', 'a2hosting', 'liquidweb', 'hostgator', 'linode', 'hosting',
  'datacenter', 'data center', 'server', 'vps', 'cloud', 'colocation', 'colo',
  'dedicated', 'idc', 'cdn', 'backbone', 'transit', 'peering',
];

/** 家宽 / 消费级 ISP 关键词（命中判 isp） */
const ISP_WORDS = [
  'comcast', 'verizon', 'at&t', 'charter', 'spectrum', 'cox communication',
  'centurylink', 'frontier', 'british telecom', 'virgin media', 'sky broadband',
  'talktalk', 'plusnet', 'deutsche telekom', 'vodafone', 'telekom', 'orange',
  'sfr', 'free sas', 'bouygues', 'telecom italia', 'fastweb', 'telefonica',
  'movistar', 'jazztel', 'china telecom', 'china unicom', 'china mobile',
  'chinanet', 'kddi', 'softbank', 'ntt', 'docomo', 'korea telecom',
  'sk broadband', 'lg u+', 'chunghwa', 'hinet', 'seednet', 'singtel', 'starhub',
  'telstra', 'optus', 'tpg internet', 'rogers', 'bell canada', 'telus', 'shaw',
  'videotron', 'claro', 'vivo', 'telmex', 'izzi', 'totalplay', 'turk telekom',
  'turkcell', 'superonline', 'rostelecom', 'mts', 'beeline', 'megafon',
  'ukrtelecom', 'kyivstar', 'orange polska', 'swisscom', 'sunrise', 'salt',
  'tele2', 't-mobile', 'eir', 'cable', 'broadband', 'fiber', 'ftth', 'dsl',
  'telecom', 'communications', 'cablevision', 'wideband',
];

function classify(isp, as) {
  const s = `${isp || ''} ${as || ''}`.toLowerCase();
  if (!s.trim()) return 'unknown';
  // 机房词优先：像 "China Telecom Cloud" 这种混合体应判 hosting
  for (const w of HOSTING_WORDS) if (s.includes(w)) return 'hosting';
  for (const w of ISP_WORDS) if (s.includes(w)) return 'isp';
  return 'unknown';
}

/* ---------- 读节点 ---------- */
const nodesPath = path.join(DATA, 'nodes.json');
if (!fs.existsSync(nodesPath)) {
  console.error('找不到 data/nodes.json，先跑 harvest');
  process.exit(1);
}
const nodes = JSON.parse(fs.readFileSync(nodesPath, 'utf8'));

const isIp = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s || ''));
const ips = [...new Set(nodes.map((n) => n.server).filter(isIp))];
log(`节点 ${nodes.length} 个，唯一 IP ${ips.length} 个，分 ${Math.ceil(ips.length / BATCH)} 批`);

/* ---------- 分批查 ip-api ---------- */
const result = {};
let done = 0;
const t0 = Date.now();

for (let i = 0; i < ips.length; i += BATCH) {
  const batch = ips.slice(i, i + BATCH);
  let rows = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch('http://ip-api.com/batch?fields=status,query,isp,as', {
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
      const q = row.query;
      if (!q) continue;
      result[q] =
        row.status === 'success'
          ? { cls: classify(row.isp, row.as), isp: row.isp || '', as: row.as || '' }
          : { cls: 'unknown', isp: '', as: '' };
    }
  }
  done += batch.length;
  if (done % 500 === 0 || done >= ips.length) {
    log(`  ${done}/${ips.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  if (i + BATCH < ips.length) await sleep(GAP_MS);
}

/* ---------- 回写到 nodes.json ---------- */
let ispCount = 0;
let hostingCount = 0;
let unknownCount = 0;
for (const n of nodes) {
  const r = result[n.server];
  n._res = r ? r.cls : 'unknown';
  if (r?.isp) n._ispDetail = r.isp;
  if (n._res === 'isp') ispCount++;
  else if (n._res === 'hosting') hostingCount++;
  else unknownCount++;
}
fs.writeFileSync(nodesPath, JSON.stringify(nodes));

fs.writeFileSync(path.join(DATA, 'isp.json'), JSON.stringify(result));
fs.writeFileSync(
  path.join(DATA, 'isp-meta.json'),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      scanned: Object.keys(result).length,
      nodes: { isp: ispCount, hosting: hostingCount, unknown: unknownCount },
      durationSec: Math.round((Date.now() - t0) / 1000),
    },
    null,
    2
  )
);

log(`分类完成：家宽 ${ispCount} / 机房 ${hostingCount} / 未知 ${unknownCount}`);
log(`已写回 data/nodes.json 与 data/isp.json`);
