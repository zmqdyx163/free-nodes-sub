/**
 * sources.mjs — 两个站点的抓取与节点提取（Node / GitHub Actions 版）
 *
 * xinshoucun.net : WordPress REST API 分页 -> 正文里的 Clash YAML 链接 -> 拉 YAML
 * blog.kuaiyu.cc : RSS 全量文章 -> 文章页里的 /tree/xxxx.{txt,yaml} -> 拉订阅
 */
import { parseClashProxies, parseUri, normalizeNode, b64decode } from './parsers.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const XS_CATEGORY = 76; // freenode
const KY_HOST = 'https://blog.kuaiyu.cc';

export async function httpGet(url, { timeout = 25000, retry = 1 } = {}) {
  let lastErr;
  for (let i = 0; i <= retry; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!r.ok) {
        if (r.status === 404) return null;
        throw new Error(`HTTP ${r.status}`);
      }
      return await r.text();
    } catch (e) {
      lastErr = e;
      if (i < retry) await new Promise((res) => setTimeout(res, 400));
    }
  }
  throw lastErr;
}

/** 新手村某一页（100 篇），正文里就带订阅链接 */
export async function fetchXinshoucunPage(page, perPage = 100) {
  const api = `https://xinshoucun.net/wp-json/wp/v2/posts?categories=${XS_CATEGORY}&per_page=${perPage}&page=${page}&_fields=id,date,link,content`;
  const txt = await httpGet(api);
  if (!txt) return { posts: [] };
  let arr;
  try {
    arr = JSON.parse(txt);
  } catch {
    return { posts: [] };
  }
  if (!Array.isArray(arr)) return { posts: [] };
  return {
    posts: arr.map((p) => {
      const html = String(p.content?.rendered || '').replace(/&amp;/g, '&');
      return { url: p.link, date: p.date, subs: extractSubLinks(html, 'xinshoucun') };
    }),
  };
}

/** 块鱼全量文章 URL */
export async function fetchKuaiyuIndex() {
  const rss = await httpGet(`${KY_HOST}/rss.xml`);
  if (!rss) return [];
  const urls = [...rss.matchAll(/<link>(https?:\/\/[^<]*\/posts\/[^<]+)<\/link>/g)].map((m) =>
    m[1].replace('https://fuwari.vercel.app', KY_HOST).replace('http://fuwari.vercel.app', KY_HOST)
  );
  return [...new Set(urls)];
}

export function extractSubLinks(html, kind) {
  const out = new Set();
  if (!html) return [];
  const decoded = html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\\\//g, '/');
  if (kind === 'xinshoucun') {
    for (const m of decoded.matchAll(/https:\/\/xinshoucun\.net\/sub\/[A-Za-z0-9._-]+\.ya?ml/g)) out.add(m[0]);
    for (const m of decoded.matchAll(/https:\/\/xinshoucun\.net\/sub\/[A-Za-z0-9._-]+\.txt/g)) out.add(m[0]);
  } else {
    for (const m of decoded.matchAll(/https:\/\/blog\.kuaiyu\.cc\/tree\/[A-Za-z0-9._-]+\.(?:ya?ml|txt)/g)) out.add(m[0]);
  }
  return [...out];
}

export function parseSubscription(body, url) {
  const nodes = [];
  if (!body) return nodes;
  const text = body.trim();
  const isYaml = /\.ya?ml$/i.test(url) || /^proxies\s*:/m.test(text) || /^\s*-\s*name\s*:/m.test(text);

  if (isYaml) {
    for (const n of parseClashProxies(text)) {
      const nn = normalizeNode(n);
      if (nn) nodes.push(nn);
    }
    return nodes;
  }

  let plain = text;
  if (!/^[a-z0-9]+:\/\//im.test(text.slice(0, 500))) plain = b64decode(text);
  if (!plain) return nodes;
  for (const line of plain.split(/\r?\n/)) {
    const t = line.trim();
    if (!/^[a-z0-9]+:\/\//i.test(t)) continue;
    const n = parseUri(t);
    const nn = n && normalizeNode(n);
    if (nn) nodes.push(nn);
  }
  return nodes;
}
