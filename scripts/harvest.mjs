/**
 * harvest.mjs — 抓取 → 解析 → 去重 → ipinfo 标注，产出 data/nodes.json
 */
import fs from 'fs';
import path from 'path';
import { dedupeKey } from '../lib/parsers.mjs';
import { httpGet, fetchXinshoucunPage, fetchKuaiyuIndex, extractSubLinks, parseSubscription } from '../lib/sources.mjs';
import { lookupBatch, isIpLiteral } from '../lib/geo.mjs';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

const IPINFO_TOKEN = process.env.IPINFO_TOKEN || 'e557c8316268c7';
const CONC = 10;
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function mapPool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

const pool = new Map();
let rawCount = 0;
let subCount = 0;
let postCount = 0;

/* ---------- 1. 新手村 ---------- */
log('新手村：REST API 分页');
const subUrls = new Set();
for (let page = 1; page <= 20; page++) {
  let res;
  try {
    res = await fetchXinshoucunPage(page);
  } catch (e) {
    log(`  page ${page} 失败: ${e.message}`);
    break;
  }
  const posts = res.posts;
  if (!posts.length) break;
  postCount += posts.length;
  for (const p of posts) for (const s of p.subs) subUrls.add(s);
  log(`  page ${page}: +${posts.length} 篇，累计订阅 ${subUrls.size}`);
  if (posts.length < 100) break;
}

/* ---------- 2. 块鱼 ---------- */
log('块鱼：RSS 索引');
const kyList = await fetchKuaiyuIndex();
postCount += kyList.length;
log(`  ${kyList.length} 篇`);

await mapPool(kyList, CONC, async (u) => {
  const html = await httpGet(u, { timeout: 20000 }).catch(() => null);
  if (!html) return;
  for (const s of extractSubLinks(html, 'kuaiyu')) subUrls.add(s);
});
log(`  文章页解析完成，订阅总数 ${subUrls.size}`);

/* ---------- 3. 下载订阅 ---------- */
const subs = [...subUrls];
log(`下载 ${subs.length} 个订阅文件`);
let done = 0;
await mapPool(subs, CONC, async (u) => {
  try {
    const body = await httpGet(u, { timeout: 25000 });
    if (!body) return;
    const nodes = parseSubscription(body, u);
    rawCount += nodes.length;
    subCount++;
    for (const n of nodes) {
      const k = dedupeKey(n);
      if (!pool.has(k)) pool.set(k, n);
    }
  } catch {
    /* 单个订阅失败不阻断 */
  } finally {
    done++;
    if (done % 100 === 0) log(`  订阅 ${done}/${subs.length}，去重池 ${pool.size}`);
  }
});

log(`抓取完成：文章 ${postCount} 篇，订阅 ${subCount} 个，原始 ${rawCount} 条，去重 ${pool.size}`);

/* ---------- 4. ipinfo ---------- */
const nodes = [...pool.values()];
const ips = [...new Set(nodes.map((n) => n.server).filter(isIpLiteral))];
log(`ipinfo 查询 ${ips.length} 个 IP`);
const geo = {};
for (let i = 0; i < ips.length; i += 500) {
  const batch = ips.slice(i, i + 500);
  const r = await lookupBatch(batch, IPINFO_TOKEN);
  Object.assign(geo, r);
  if (i % 2000 === 0) log(`  ${Math.min(i + 500, ips.length)}/${ips.length}`);
}

for (const n of nodes) {
  const g = geo[n.server];
  n._cc = g?.cc || 'ZZ';
  n._city = g?.city || '';
  n._isp = g?.isp || '';
  n._asn = g?.asn || '';
}

fs.writeFileSync(path.join(DATA, 'nodes.json'), JSON.stringify(nodes));
fs.writeFileSync(
  path.join(DATA, 'harvest-meta.json'),
  JSON.stringify({ raw: rawCount, unique: nodes.length, posts: postCount, subs: subCount, at: new Date().toISOString() }, null, 2)
);

const byType = {};
for (const n of nodes) byType[n.type] = (byType[n.type] || 0) + 1;
const byCc = {};
for (const n of nodes) byCc[n._cc] = (byCc[n._cc] || 0) + 1;
log('节点类型:', JSON.stringify(byType));
log(`国家数: ${Object.keys(byCc).length}`);
log(`已写出 data/nodes.json（${nodes.length} 条）`);
