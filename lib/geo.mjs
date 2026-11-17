/**
 * geo.js — ipinfo.io 地理/线路标注
 *
 * 批量: POST https://ipinfo.io/batch?token=TOKEN   body: ["1.1.1.1", ...]  (单次最多 1000)
 * 单条: GET  https://ipinfo.io/1.1.1.1/json?token=TOKEN
 */

const IPINFO_HOST = 'https://ipinfo.io';

/** 简易 IP 字面量判定（ipinfo batch 只接受 IP，不接受域名） */
export function isIpLiteral(host) {
  if (!host) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((x) => +x >= 0 && +x <= 255);
  }
  return /^[0-9a-f:]+$/i.test(host) && host.includes(':');
}

const flagOf = (cc) => {
  if (!cc || cc.length !== 2) return '🏴';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
};

export { flagOf };

/** 从 org 字段提取 ASN 与 ISP 短名 */
export function parseOrg(org) {
  if (!org) return { asn: '', isp: '' };
  const m = String(org).match(/^(AS\d+)\s+(.*)$/);
  if (m) {
    let isp = m[2];
    isp = isp
      .replace(/\b(Inc\.?|LLC|Ltd\.?|Limited|Corp\.?|Corporation|Co\.?|Company|GmbH|S\.A\.|B\.V\.|Pty|PTE\.?|LTD)\b/gi, '')
      .replace(/,\s*$/, '')
      .trim();
    if (isp.length > 22) isp = isp.slice(0, 22).trim();
    return { asn: m[1], isp };
  }
  return { asn: '', isp: String(org).slice(0, 22) };
}

/**
 * 批量查询。传入最多 1000 个 IP，返回 { ip: {cc, city, asn, isp} }
 * 失败时返回 {}，不抛异常（地理信息是增强项，不该阻断主流程）。
 */
export async function lookupBatch(ips, token, timeout = 12000) {
  if (!ips.length || !token) return {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(`${IPINFO_HOST}/batch?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(ips.slice(0, 1000)),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return {};
    const data = await r.json();
    const out = {};
    for (const [ip, info] of Object.entries(data || {})) {
      if (!info || typeof info !== 'object' || info.error) continue;
      const { asn, isp } = parseOrg(info.org);
      out[ip] = {
        cc: (info.country || '').toUpperCase().slice(0, 2),
        city: (info.city || '').slice(0, 18),
        asn,
        isp,
      };
    }
    return out;
  } catch {
    clearTimeout(timer);
    return {};
  }
}

/** 单条查询（兜底，用于增量少量新 IP） */
export async function lookupOne(ip, token, timeout = 6000) {
  if (!token) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(`${IPINFO_HOST}/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const info = await r.json();
    if (!info || info.bobo || info.error) return null;
    const { asn, isp } = parseOrg(info.org);
    return { cc: (info.country || '').toUpperCase().slice(0, 2), city: (info.city || '').slice(0, 18), asn, isp };
  } catch {
    clearTimeout(timer);
    return null;
  }
}
