/**
 * parsers.js — 节点协议解析与序列化
 * 支持: ss / ssr / vmess / vless / trojan / hysteria / hysteria2 / tuic
 *
 * 内部统一结构使用 Clash 字段名（type/name/server/port/...），
 * 便于直接序列化输出 Clash 订阅；URI 输出走 proxyToUri()。
 */

import * as yaml from 'js-yaml';

/* ---------------- base64 helpers (Workers 无 Buffer) ---------------- */

export function b64decode(str) {
  let s = String(str).trim().replace(/\s+/g, '');
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  try {
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

export function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

export const b64url = (str) => b64encode(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* ---------------- 小工具 ---------------- */

function safeDecodeURIComponent(v) {
  if (v == null) return '';
  try {
    return decodeURIComponent(String(v));
  } catch {
    return String(v);
  }
}

function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  for (const part of qs.split('&')) {
    if (!part) continue;
    const idx = part.indexOf('=');
    const k = idx === -1 ? part : part.slice(0, idx);
    const v = idx === -1 ? '' : part.slice(idx + 1);
    out[safeDecodeURIComponent(k)] = safeDecodeURIComponent(v);
  }
  return out;
}

/** host:port 拆分，兼容 [IPv6]:port */
function splitHostPort(hostport) {
  if (!hostport) return { host: '', port: 0 };
  const s = hostport.trim();
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    const host = s.slice(1, close);
    const rest = s.slice(close + 1).replace(/^:/, '');
    return { host, port: parseInt(rest, 10) || 0 };
  }
  const i = s.lastIndexOf(':');
  if (i === -1) return { host: s, port: 0 };
  return { host: s.slice(0, i), port: parseInt(s.slice(i + 1), 10) || 0 };
}

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

const ccFlag = (cc) => {
  if (!cc || cc.length !== 2 || cc === 'ZZ') return '🏴';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
};

/* ---------------- 传输层映射 (Clash network -> 通用) ---------------- */

function applyTransport(node, net, q) {
  net = (net || '').toLowerCase();
  if (!net) return node;
  if (net === 'ws') {
    node._net = 'ws';
    node['ws-opts'] = {
      path: q.path || '/',
      ...(q.host ? { headers: { Host: q.host } } : {}),
    };
    if (q.ed) node['ws-opts'].headers = { ...(node['ws-opts'].headers || {}), 'Early-Data': '1' };
  } else if (net === 'grpc') {
    node._net = 'grpc';
    node['grpc-opts'] = { 'grpc-service-name': q.serviceName || q.path || '' };
  } else if (net === 'h2' || net === 'http') {
    node._net = 'h2';
    node['h2-opts'] = {
      path: q.path || '/',
      ...(q.host ? { host: [q.host] } : {}),
    };
  } else if (net === 'tcp') {
    node._net = 'tcp';
    if (q.headerType === 'http' || q.type === 'http') {
      node['http-opts'] = { path: [q.path || '/'], ...(q.host ? { headers: { Host: [q.host] } } : {}) };
    }
  }
  return node;
}

function applyTls(node, q, scheme) {
  const sec = (q.security || '').toLowerCase();
  const tlsOn = sec === 'tls' || sec === 'reality' || sec === 'xtls' || (scheme === 'trojan' && sec !== 'none');
  if (sec === 'reality') {
    node._reality = true;
    node['reality-opts'] = { 'public-key': q.pbk || '', 'short-id': q.sid || '' };
    node.tls = true;
    if (q.sni) node.servername = q.sni;
    if (q.fp) node['client-fingerprint'] = q.fp;
  } else if (tlsOn) {
    node.tls = true;
    if (q.sni) node.servername = q.sni;
    else if (q.host) node.servername = q.host;
    if (q.alpn) node.alpn = q.alpn.split(',').map((x) => x.trim()).filter(Boolean);
    if (q.fp) node['client-fingerprint'] = q.fp;
  }
  if (truthy(q.allowInsecure) || truthy(q.insecure) || truthy(q.skipCertVerify)) node['skip-cert-verify'] = true;
  return node;
}

/* ---------------- URI -> node ---------------- */

export function parseUri(uri) {
  const raw = String(uri || '').trim();
  const scheme = (raw.match(/^([a-z0-9]+):\/\//i) || [])[1];
  if (!scheme) return null;
  const s = scheme.toLowerCase();
  try {
    switch (s) {
      case 'ss':
        return parseSS(raw);
      case 'ssr':
        return parseSSR(raw);
      case 'vmess':
        return parseVMess(raw);
      case 'vless':
        return parseVLESS(raw);
      case 'trojan':
        return parseTrojan(raw);
      case 'hysteria':
        return parseHysteria(raw, 'hysteria');
      case 'hysteria2':
      case 'hy2':
        return parseHysteria(raw, 'hysteria2');
      case 'tuic':
        return parseTuic(raw);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function fragmentName(raw) {
  const i = raw.indexOf('#');
  return i === -1 ? '' : safeDecodeURIComponent(raw.slice(i + 1));
}

function parseSS(raw) {
  // SIP002: ss://base64(method:pass)@host:port?plugin=..#name
  // legacy: ss://base64(method:pass@host:port)#name
  let body = raw.slice(5);
  const name = fragmentName(body);
  const hashIdx = body.indexOf('#');
  if (hashIdx !== -1) body = body.slice(0, hashIdx);
  let query = '';
  const qi = body.indexOf('?');
  if (qi !== -1) {
    query = body.slice(qi + 1);
    body = body.slice(0, qi);
  }
  const q = parseQuery(query);

  let method, password, host, port;
  const at = body.lastIndexOf('@');
  if (at !== -1) {
    const cred = body.slice(0, at);
    const hp = body.slice(at + 1);
    const dec = cred.includes(':') ? cred : b64decode(cred);
    const ci = dec.indexOf(':');
    method = dec.slice(0, ci);
    password = dec.slice(ci + 1);
    ({ host, port } = splitHostPort(hp));
  } else {
    const dec = b64decode(body);
    const at2 = dec.lastIndexOf('@');
    if (at2 === -1) return null;
    const cred = dec.slice(0, at2);
    ({ host, port } = splitHostPort(dec.slice(at2 + 1)));
    const ci = cred.indexOf(':');
    method = cred.slice(0, ci);
    password = cred.slice(ci + 1);
  }
  if (!host || !port || !method) return null;

  const node = { type: 'ss', name: name || `${host}:${port}`, server: host, port, cipher: method, password, udp: true };
  if (q.plugin) {
    const p = safeDecodeURIComponent(q.plugin);
    const parts = p.split(';');
    const pname = parts[0];
    const opts = {};
    for (const kv of parts.slice(1)) {
      const [k, v] = kv.split('=');
      if (k) opts[k] = v ?? true;
    }
    if (pname === 'obfs-local' || pname === 'simple-obfs') {
      node.plugin = 'obfs';
      node['plugin-opts'] = { mode: opts.obfs || 'http', host: opts['obfs-host'] || '' };
    } else if (pname === 'v2ray-plugin') {
      node.plugin = 'v2ray-plugin';
      node['plugin-opts'] = { mode: opts.mode || 'websocket', host: opts.host || '', path: opts.path || '/', tls: !!opts.tls };
    }
  }
  return node;
}

function parseSSR(raw) {
  const body = raw.slice(6).split('#')[0];
  const dec = b64decode(body);
  if (!dec) return null;
  const [main, paramStr] = dec.split('/?');
  const parts = main.split(':');
  if (parts.length < 6) return null;
  const [server, portStr, protocol, method, obfs, pwB64] = parts;
  const q = parseQuery(paramStr || '');
  const password = b64decode(pwB64);
  if (!server || !portStr) return null;
  return {
    type: 'ssr',
    name: q.remarks ? b64decode(q.remarks) : `${server}:${portStr}`,
    server,
    port: +portStr,
    cipher: method,
    password,
    protocol,
    obfs,
    'protocol-param': q.protoparam ? b64decode(q.protoparam) : '',
    'obfs-param': q.obfsparam ? b64decode(q.obfsparam) : '',
    udp: true,
  };
}

function parseVMess(raw) {
  const body = raw.slice(8).split('#')[0];
  let json;
  try {
    json = JSON.parse(b64decode(body));
  } catch {
    try {
      json = JSON.parse(safeDecodeURIComponent(body));
    } catch {
      return null;
    }
  }
  if (!json || !json.add || !json.port) return null;
  const node = {
    type: 'vmess',
    name: json.ps || `${json.add}:${json.port}`,
    server: String(json.add),
    port: +json.port,
    uuid: json.id,
    alterId: +(json.aid || 0),
    cipher: json.scy || 'auto',
    udp: true,
  };
  applyTransport(node, json.net, {
    path: json.path,
    host: json.host,
    serviceName: json.path,
    headerType: json.type,
  });
  if (json.tls === 'tls' || json.tls === true) {
    node.tls = true;
    if (json.sni) node.servername = json.sni;
    else if (json.host) node.servername = json.host;
    if (json.alpn) node.alpn = String(json.alpn).split(',').map((x) => x.trim()).filter(Boolean);
    if (json.fp) node['client-fingerprint'] = json.fp;
  }
  if (json.verify_cert === false) node['skip-cert-verify'] = true;
  return node;
}

function parseVLESS(raw) {
  const rest = raw.slice(8);
  const name = fragmentName(rest);
  const [beforeHash] = rest.split('#');
  const qi = beforeHash.indexOf('?');
  const q = parseQuery(qi === -1 ? '' : beforeHash.slice(qi + 1));
  const authority = (qi === -1 ? beforeHash : beforeHash.slice(0, qi)).replace(/\/$/, '');
  const at = authority.lastIndexOf('@');
  if (at === -1) return null;
  const uuid = safeDecodeURIComponent(authority.slice(0, at));
  const { host, port } = splitHostPort(authority.slice(at + 1));
  if (!host || !port) return null;

  const node = { type: 'vless', name: name || `${host}:${port}`, server: host, port, uuid, udp: true };
  if (q.flow) node.flow = q.flow;
  if (q.encryption && q.encryption !== 'none') node.encryption = q.encryption;
  applyTransport(node, q.type, q);
  applyTls(node, q, 'vless');
  return node;
}

function parseTrojan(raw) {
  const rest = raw.slice(9);
  const name = fragmentName(rest);
  const [beforeHash] = rest.split('#');
  const qi = beforeHash.indexOf('?');
  const q = parseQuery(qi === -1 ? '' : beforeHash.slice(qi + 1));
  const authority = (qi === -1 ? beforeHash : beforeHash.slice(0, qi)).replace(/\/$/, '');
  const at = authority.lastIndexOf('@');
  if (at === -1) return null;
  const password = safeDecodeURIComponent(authority.slice(0, at));
  const { host, port } = splitHostPort(authority.slice(at + 1));
  if (!host || !port) return null;

  const node = { type: 'trojan', name: name || `${host}:${port}`, server: host, port, password, udp: true };
  if (q.sni) node.sni = q.sni;
  if (q.alpn) node.alpn = q.alpn.split(',').map((x) => x.trim()).filter(Boolean);
  if (q.fp) node['client-fingerprint'] = q.fp;
  if (truthy(q.allowInsecure) || truthy(q.insecure)) node['skip-cert-verify'] = true;
  applyTransport(node, q.type, q);
  if (node._net === 'ws') node.network = 'ws';
  return node;
}

function parseHysteria(raw, version) {
  const schemeLen = raw.indexOf('://') + 3;
  const rest = raw.slice(schemeLen);
  const name = fragmentName(rest);
  const [beforeHash] = rest.split('#');
  const qi = beforeHash.indexOf('?');
  const q = parseQuery(qi === -1 ? '' : beforeHash.slice(qi + 1));
  let authority = (qi === -1 ? beforeHash : beforeHash.slice(0, qi)).replace(/\/$/, '');

  let authStr = '';
  const at = authority.lastIndexOf('@');
  if (at !== -1) {
    authStr = safeDecodeURIComponent(authority.slice(0, at));
    authority = authority.slice(at + 1);
  }
  const { host, port } = splitHostPort(authority);
  if (!host || !port) return null;

  if (version === 'hysteria2') {
    const node = {
      type: 'hysteria2',
      name: name || `${host}:${port}`,
      server: host,
      port,
      password: authStr || q.auth || q.password || '',
    };
    if (q.sni) node.sni = q.sni;
    else if (q.peer) node.sni = q.peer;
    if (truthy(q.insecure)) node['skip-cert-verify'] = true;
    if (q.obfs) node.obfs = q.obfs;
    if (q['obfs-password']) node['obfs-password'] = q['obfs-password'];
    if (q.alpn) node.alpn = q.alpn.split(',').map((x) => x.trim()).filter(Boolean);
    if (q.upmbps || q.downmbps) {
      node.up = q.upmbps ? q.upmbps : undefined;
      node.down = q.downmbps ? q.downmbps : undefined;
    }
    return node;
  }

  const node = {
    type: 'hysteria',
    name: name || `${host}:${port}`,
    server: host,
    port,
    'auth-str': authStr || q.auth || '',
    protocol: q.protocol || 'udp',
  };
  if (q.peer) node.sni = q.peer;
  if (q.sni) node.sni = q.sni;
  if (truthy(q.insecure)) node['skip-cert-verify'] = true;
  if (q.alpn) node.alpn = q.alpn.split(',').map((x) => x.trim()).filter(Boolean);
  if (q.upmbps) node.up = q.upmbps;
  if (q.downmbps) node.down = q.downmbps;
  if (q.obfsParam) node.obfs = q.obfsParam;
  return node;
}

function parseTuic(raw) {
  const rest = raw.slice(7);
  const name = fragmentName(rest);
  const [beforeHash] = rest.split('#');
  const qi = beforeHash.indexOf('?');
  const q = parseQuery(qi === -1 ? '' : beforeHash.slice(qi + 1));
  const authority = (qi === -1 ? beforeHash : beforeHash.slice(0, qi)).replace(/\/$/, '');
  const at = authority.lastIndexOf('@');
  if (at === -1) return null;
  const cred = safeDecodeURIComponent(authority.slice(0, at));
  const { host, port } = splitHostPort(authority.slice(at + 1));
  if (!host || !port) return null;

  let uuid = cred;
  let password = '';
  if (cred.includes(':')) {
    const ci = cred.indexOf(':');
    uuid = cred.slice(0, ci);
    password = cred.slice(ci + 1);
  }
  const node = {
    type: 'tuic',
    name: name || `${host}:${port}`,
    server: host,
    port,
    uuid,
    password,
    'udp-relay-mode': q.udp_relay_mode || 'native',
    'congestion-controller': q.congestion_control || 'bbr',
  };
  if (q.sni) node.sni = q.sni;
  if (q.alpn) node.alpn = q.alpn.split(',').map((x) => x.trim()).filter(Boolean);
  if (truthy(q.allow_insecure) || truthy(q.insecure)) node['skip-cert-verify'] = true;
  if (q.disable_sni === '1') node['disable-sni'] = true;
  return node;
}

/* ---------------- node -> URI ---------------- */

export function proxyToUri(node) {
  const t = node.type;
  const name = encodeURIComponent(node.name || `${node.server}:${node.port}`);
  if (t === 'ss') {
    const cred = b64url(`${node.cipher}:${node.password}`);
    return `ss://${cred}@${node.server}:${node.port}#${name}`;
  }
  if (t === 'vmess') {
    const o = {
      v: '2',
      ps: node.name || '',
      add: node.server,
      port: String(node.port),
      id: node.uuid,
      aid: String(node.alterId || 0),
      scy: node.cipher || 'auto',
      net: node._net || 'tcp',
      type: node._net === 'tcp' ? 'none' : 'none',
      host: (node['ws-opts']?.headers?.Host) || (node['h2-opts']?.host?.[0]) || '',
      path: node['ws-opts']?.path || node['h2-opts']?.path || node['grpc-opts']?.['grpc-service-name'] || '',
      tls: node.tls ? 'tls' : '',
      sni: node.servername || '',
      alpn: (node.alpn || []).join(','),
      fp: node['client-fingerprint'] || '',
    };
    return `vmess://${b64encode(JSON.stringify(o))}`;
  }
  if (t === 'vless') {
    const p = new URLSearchParams();
    p.set('encryption', node.encryption || 'none');
    p.set('type', node._net || 'tcp');
    if (node.tls) p.set('security', node._reality ? 'reality' : 'tls');
    if (node.servername) p.set('sni', node.servername);
    if (node.flow) p.set('flow', node.flow);
    if (node['ws-opts']?.path) p.set('path', node['ws-opts'].path);
    if (node['ws-opts']?.headers?.Host) p.set('host', node['ws-opts'].headers.Host);
    if (node['grpc-opts']?.['grpc-service-name']) p.set('serviceName', node['grpc-opts']['grpc-service-name']);
    if (node.alpn) p.set('alpn', node.alpn.join(','));
    if (node['client-fingerprint']) p.set('fp', node['client-fingerprint']);
    if (node['reality-opts']) {
      p.set('pbk', node['reality-opts']['public-key'] || '');
      p.set('sid', node['reality-opts']['short-id'] || '');
    }
    if (node['skip-cert-verify']) p.set('allowInsecure', '1');
    return `vless://${node.uuid}@${node.server}:${node.port}?${p.toString()}#${name}`;
  }
  if (t === 'trojan') {
    const p = new URLSearchParams();
    p.set('type', node._net || 'tcp');
    if (node.sni) p.set('sni', node.sni);
    if (node.alpn) p.set('alpn', node.alpn.join(','));
    if (node['ws-opts']?.path) p.set('path', node['ws-opts'].path);
    if (node['ws-opts']?.headers?.Host) p.set('host', node['ws-opts'].headers.Host);
    if (node['skip-cert-verify']) p.set('allowInsecure', '1');
    return `trojan://${encodeURIComponent(node.password)}@${node.server}:${node.port}?${p.toString()}#${name}`;
  }
  if (t === 'hysteria2') {
    const p = new URLSearchParams();
    if (node.sni) p.set('sni', node.sni);
    if (node['skip-cert-verify']) p.set('insecure', '1');
    if (node.obfs) p.set('obfs', node.obfs);
    if (node['obfs-password']) p.set('obfs-password', node['obfs-password']);
    if (node.alpn) p.set('alpn', node.alpn.join(','));
    return `hysteria2://${encodeURIComponent(node.password || '')}@${node.server}:${node.port}?${p.toString()}#${name}`;
  }
  if (t === 'hysteria') {
    const p = new URLSearchParams();
    p.set('auth', node['auth-str'] || '');
    if (node.sni) p.set('peer', node.sni);
    if (node['skip-cert-verify']) p.set('insecure', '1');
    if (node.up) p.set('upmbps', String(node.up));
    if (node.down) p.set('downmbps', String(node.down));
    return `hysteria://${node.server}:${node.port}?${p.toString()}#${name}`;
  }
  if (t === 'tuic') {
    const p = new URLSearchParams();
    if (node.sni) p.set('sni', node.sni);
    p.set('congestion_control', node['congestion-controller'] || 'bbr');
    p.set('udp_relay_mode', node['udp-relay-mode'] || 'native');
    if (node.alpn) p.set('alpn', node.alpn.join(','));
    if (node['skip-cert-verify']) p.set('allow_insecure', '1');
    return `tuic://${node.uuid}:${encodeURIComponent(node.password || '')}@${node.server}:${node.port}?${p.toString()}#${name}`;
  }
  if (t === 'ssr') {
    const pw = b64url(node.password || '');
    const main = `${node.server}:${node.port}:${node.protocol}:${node.cipher}:${node.obfs}:${pw}`;
    const params = new URLSearchParams();
    params.set('remarks', b64url(node.name || ''));
    if (node['obfs-param']) params.set('obfsparam', b64url(node['obfs-param']));
    if (node['protocol-param']) params.set('protoparam', b64url(node['protocol-param']));
    return `ssr://${b64url(`${main}/?${params.toString()}`)}`;
  }
  return null;
}

/* ---------------- Clash YAML 解析（轻量子集解析器） ---------------- */

function unquote(v) {
  let s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
    if (v.trim().startsWith('"')) {
      s = s.replace(/\\U([0-9a-fA-F]{8})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
      s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  return s;
}

function scalar(v) {
  const s = unquote(v);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return +s;
  return s;
}

/** 解析 "key: value" 顶层 map（缩进无关，取 : 前空白） */
function parseFlatMap(lines) {
  const out = {};
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (v === '' || v === '|' || v === '>') out[k] = null;
    else out[k] = scalar(v);
  }
  return out;
}

/**
 * 解析 Clash proxies 列表。
 * 主路径用 js-yaml（可靠，能处理任意 key 顺序 / 嵌套 / \U 转义）；
 * 站点偶尔产出残缺 YAML，失败时回退到宽松的行解析器。
 */
export function parseClashProxies(text) {
  if (!text) return [];
  const src = text.replace(/\r\n/g, '\n');

  // --- 主路径 ---
  try {
    const doc = yaml.load(src);
    if (doc && Array.isArray(doc.proxies) && doc.proxies.length) {
      return normalizeProxyList(doc.proxies);
    }
    // proxies 不在顶层（有些订阅把整份配置塞在嵌套结构里）
    if (doc && typeof doc === 'object') {
      for (const v of Object.values(doc)) {
        if (v && typeof v === 'object' && Array.isArray(v.proxies)) return normalizeProxyList(v.proxies);
      }
    }
    if (!doc) return [];
  } catch {
    /* 落到宽松解析 */
  }

  // --- 宽松回退 ---
  const out = [];
  const start = src.search(/^proxies:[ \t]*$/m);
  if (start === -1) return out;
  let seg = src.slice(start).replace(/^proxies:[ \t]*\n?/, '');
  const endM = seg.search(/^\S[^\n]*:[ \t]*$/m);
  if (endM !== -1) seg = seg.slice(0, endM);

  const blocks = [];
  let cur = null;
  for (const line of seg.split('\n')) {
    if (/^ {0,4}-[ \t]+[A-Za-z0-9_.-]+:/.test(line)) {
      if (cur) blocks.push(cur);
      cur = [line];
    } else if (cur) cur.push(line);
  }
  if (cur) blocks.push(cur);

  for (const bl of blocks) {
    const node = {};
    let lastKey = null;
    for (const line of bl) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const kv = line.replace(/^\s*-\s+/, (m) => (m.length <= 5 ? '' : m)).match(/^\s*([A-Za-z0-9_.-]+):\s*(.*)$/);
      const item = line.match(/^\s*-\s+(?![\w.-]+:\s)(.*)$/);
      if (kv) {
        const [, k, v] = kv;
        if (v === '') {
          node[k] = null;
          lastKey = k;
        } else {
          node[k] = scalar(v);
          lastKey = null;
        }
      } else if (item && lastKey) {
        if (node[lastKey] === null) node[lastKey] = [];
        if (Array.isArray(node[lastKey])) node[lastKey].push(scalar(item[1]));
      }
    }
    if (node.type && node.server && node.port) out.push(node);
  }
  return normalizeProxyList(out);
}

function normalizeProxyList(list) {
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const node = { ...raw };
    if (!node.type || !node.server || !node.port) continue;
    node.type = String(node.type).toLowerCase();
    node.port = +node.port;
    if (!node.name) node.name = `${node.server}:${node.port}`;
    if (node.network && !node._net) node._net = String(node.network).toLowerCase();
    else if (node['ws-opts'] && !node._net) node._net = 'ws';
    else if (node['grpc-opts'] && !node._net) node._net = 'grpc';
    if (node['skip-cert-verify'] === undefined && node['skip-cert-verify'] === null) delete node['skip-cert-verify'];
    out.push(node);
  }
  return out;
}

/* ---------------- node -> Clash YAML ---------------- */

const NEED_QUOTE = /[:#{}[\],&*?|<>=!%@`"']|^\s|\s$|^[\d.]+$/;

function yamlVal(v, key) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return null;
  const s = String(v);
  if (s === '') return "''";
  // IP / 域名 / 路径类裸值不加引号，保持可读
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s;
  if (/^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){2,7}$/i.test(s)) return s;
  if (/^[A-Za-z0-9._\-\/]+$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 单节点 -> YAML 行（2 空格缩进）。所有 `_` 前缀字段都是内部标记，不输出。 */
/** 递归输出 YAML 节点，数组里是标量就写成 "- x"，是对象就内联 JSON */
function emitYaml(obj, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      out.push(`${pad}${k}:`);
      for (const item of v) {
        if (item && typeof item === 'object') out.push(`${pad}  - ${JSON.stringify(item)}`);
        else out.push(`${pad}  - ${yamlVal(item)}`);
      }
    } else if (typeof v === 'object') {
      const sub = emitYaml(v, indent + 2);
      if (!sub.length) continue;
      out.push(`${pad}${k}:`, ...sub);
    } else {
      const s = yamlVal(v);
      if (s !== null) out.push(`${pad}${k}: ${s}`);
    }
  }
  return out;
}

export function proxyToYamlLines(node) {
  // URI 解析来的节点只带 _net，Clash 需要显式的 network 字段
  const src = node._net && !node.network ? { ...node, network: node._net } : node;

  const clean = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'name' || k.startsWith('_')) continue;
    if (v === undefined || v === null) continue;
    clean[k] = v;
  }

  // type / server / port 固定在最前，其余按字母序，diff 才稳定
  const ordered = {};
  for (const k of ['type', 'server', 'port']) if (clean[k] !== undefined) ordered[k] = clean[k];
  for (const k of Object.keys(clean).sort()) if (!(k in ordered)) ordered[k] = clean[k];

  return [`  - name: ${yamlVal(node.name)}`, ...emitYaml(ordered, 4)].join('\n');
}

/* ---------------- 归一化 / 去重键 ---------------- */

export const SUPPORTED = new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic']);

export function normalizeNode(n) {
  if (!n || !SUPPORTED.has(n.type)) return null;
  const server = String(n.server || '').trim();
  const port = parseInt(n.port, 10);
  if (!server || !port || port < 1 || port > 65535) return null;
  if (!/^[A-Za-z0-9.\-:\[\]]+$/.test(server)) return null;
  n.server = server;
  n.port = port;
  n.name = String(n.name || `${server}:${port}`).trim().slice(0, 60);
  // Clash Meta 兼容: vmess cipher 只允许 auto/aes-128-gcm/chacha20-poly1305/none
  if (n.type === 'vmess') {
    const ok = ['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none'];
    if (!ok.includes(String(n.cipher || '').toLowerCase())) n.cipher = 'auto';
    else n.cipher = String(n.cipher).toLowerCase();
  }
  if (n.type === 'ssr' && !n.protocol) return null;
  return n;
}

export function dedupeKey(n) {
  const auth = n.password ?? n.uuid ?? n['auth-str'] ?? '';
  return `${n.type}|${n.server}|${n.port}|${String(auth).slice(0, 80)}`;
}

/* ---------------- 订阅渲染 ---------------- */

export function renderClashYaml(nodes, opts = {}) {
  const head = [
    '# ============================================',
    `# Free Nodes Aggregator  ·  updated ${opts.updated || new Date().toISOString()}`,
    `# nodes: ${nodes.length}   per-country top: ${opts.topPerCountry || 10}`,
    `# sources: ${opts.sources || 'xinshoucun.net, blog.kuaiyu.cc'}`,
    '# ============================================',
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: warning',
    'ipv6: false',
    'external-controller: 127.0.0.1:9090',
    '',
    'proxies:',
  ];

  // 按国家分组名
  const groups = new Map();
  for (const n of nodes) {
    const g = n._cc || 'ZZ';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(n.name);
  }
  const allNames = nodes.map((n) => n.name);

  const body = nodes.map(proxyToYamlLines).join('\n');

  const groupDefs = [
    { name: '🚀 节点选择', type: 'select', proxies: ['♻️ 自动选择', 'DIRECT', ...allNames] },
    {
      name: '♻️ 自动选择',
      type: 'url-test',
      proxies: allNames,
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
    },
  ];
  for (const [cc, names] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (!names.length) continue;
    groupDefs.push({
      name: `${ccFlag(cc)} ${cc} 地区`,
      type: 'url-test',
      proxies: names,
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
    });
  }
  groupDefs.push({ name: '🐟 漏网之鱼', type: 'select', proxies: ['🚀 节点选择', 'DIRECT'] });
  groupDefs.push({ name: '🛑 广告拦截', type: 'select', proxies: ['REJECT', 'DIRECT'] });

  const gLines = ['', 'proxy-groups:'];
  for (const g of groupDefs) {
    gLines.push(`  - name: ${yamlVal(g.name)}`);
    gLines.push(`    type: ${g.type}`);
    if (g.url) {
      gLines.push(`    url: ${g.url}`);
      gLines.push(`    interval: ${g.interval}`);
      gLines.push(`    tolerance: ${g.tolerance}`);
    }
    gLines.push('    proxies:');
    for (const p of g.proxies) gLines.push(`      - ${yamlVal(p)}`);
  }

  const rules = [
    '',
    'rules:',
    // 本机回环必须直连，且不能带 no-resolve：
    // HTTP 代理入站时 Clash 拿到的是 Host=127.0.0.1，
    // no-resolve 会让 IP-CIDR 规则跳过匹配，请求落到最后的 MATCH 被送去代理，
    // 远端连不到你的 localhost，于是 502 / 超时（Codex 走 magpie:40000 就是这么挂的）
    '  - DOMAIN,127.0.0.1,DIRECT',
    '  - DOMAIN-SUFFIX,local,DIRECT',
    '  - IP-CIDR,127.0.0.0/8,DIRECT',
    '  - IP-CIDR,10.0.0.0/8,DIRECT',
    '  - IP-CIDR,172.16.0.0/12,DIRECT',
    '  - IP-CIDR,192.168.0.0/16,DIRECT',
    '  - GEOIP,CN,DIRECT',
    '  - MATCH,🐟 漏网之鱼',
  ];

  return [...head, body, ...gLines, ...rules, ''].join('\n');
}

export function renderBase64Sub(nodes) {
  const uris = [];
  for (const n of nodes) {
    const u = proxyToUri(n);
    if (u) uris.push(u);
  }
  return b64encode(uris.join('\n'));
}

export function renderUriList(nodes) {
  return nodes.map(proxyToUri).filter(Boolean);
}
