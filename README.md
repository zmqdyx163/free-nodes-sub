# free-nodes-sub

每天自动抓取 [xinshoucun.net](https://xinshoucun.net/category/freenode) 和 [blog.kuaiyu.cc](https://blog.kuaiyu.cc/) 的免费节点，去重后用 **mihomo 内核做真实代理测速**，按国家保留延迟最低的 Top 10，输出订阅。

## 订阅地址

```
Clash / Clash.Meta   https://zmqdyx163.github.io/free-nodes-sub/sub/clash.yaml
v2rayN / 小火箭      https://zmqdyx163.github.io/free-nodes-sub/sub/base64.txt
明文 URI             https://zmqdyx163.github.io/free-nodes-sub/sub/uri.txt
统计                 https://zmqdyx163.github.io/free-nodes-sub/sub/stats.json

备用（raw，无 Pages 缓存）
https://raw.githubusercontent.com/zmqdyx163/free-nodes-sub/main/sub/clash.yaml
https://cdn.jsdelivr.net/gh/zmqdyx163/free-nodes-sub@main/sub/clash.yaml
```

每日北京时间 12:00（UTC 04:00）由 GitHub Actions 自动更新。

### 最近一次结果

| 指标 | 数值 |
|---|---|
| 文章 / 订阅 | 849 篇 / 422 个 |
| 原始节点 | 57,676 条 |
| 去重后 | 8,635 条 |
| mihomo 实测真活 | **477 条**（5.5%） |
| 每国 Top10 筛出 | **197 条，覆盖 36 个国家** |
| 平均代理延迟 | 517 ms（最快 US 14ms） |

协议分布：ss 124 / vless 26 / hysteria2 23 / vmess 12 / trojan 12。

> 存活率 5.5% 看起来低，但这是**真实代理延迟**——必须走完 TLS/加密握手并成功拿到 HTTP 响应。之前的 TCP 握手方案测出 21.8%「存活」，实际能用的是 0，就是这个差别。
>
> `hysteria2` 那 23 个是 TCP 探测根本测不出来的（QUIC/UDP 协议），只有 mihomo 能验。

---

## 三道验证

```
mihomo 协议测活  →  check-host 亚洲可达  →  每国 Top10
（真走加密握手）    （港/日/新三地 TCP）    （按亚洲延迟排序）
```

**第一道 mihomo**：起真内核，`/proxies/{name}/delay` 发真实 HTTP 请求，必须走完加密握手拿到响应。这一步砍掉密码错、协议不匹配、端口挂占位页的假活。

**第二道 check-host**：GitHub Runner 在美国，"对美西通"不等于"对亚洲通"。用 [check-host.net](https://check-host.net) 的 `hk1` / `jp1` / `sg1` 三个节点再做一次 TCP 可达性检测。实测 197 个节点里 90% 能从香港到达，砍掉的那 10% 就是典型的"海外能连、回国不通"。

**排序**：Top10 不再按 mihomo 的美西延迟排，而是按**港/日/新三地的最低 TCP 延迟**——这才是国内用户实际感受到的。

> check-host 没有中国大陆节点，香港 `hk1` 是最接近的替代。它只测 TCP 端口可达，不测代理协议本身（那一步由 mihomo 保证）。

### 为什么不用 `cfproxy-tester` 的优选 IP

`D:\DSH\搭建代理\cfproxy-tester-1.1-universal\ip.txt` 里那批香港/广州/杭州 IP 是 **CF SNI 反代入口**——它们只能把流量转发到 Cloudflare 网络（`--resolve zmq.kdns.fr:443:IP` 这种用法）。

而这批订阅节点里 **187/197 是裸 IP 直连的 VPS**（Melbikomas、GTHost、OVH、Oracle、DigitalOcean 等），ISP 是 Cloudflare 的是 **0 个**。优选 IP 转发不到这些服务器，所以对它们无能为力。

只有当节点 server 本身就是 CF 上的域名（vless/vmess/trojan + ws + tls 走 CF CDN）时，才能用优选 IP 替换 server 提速。当前节点池里这类只有 10 个域名节点，且不一定是 CF。

---

## 为什么用 mihomo 而不是 TCP 探测

之前用 `connect()` 做 TCP 握手来判断存活，结论是错的：**TCP 能握手只说明端口开着**。密码错了、协议不匹配、端口上挂着 Nginx 占位页，握手一样成功。结果订阅发出去全军覆没。

现在改成起一个真的 mihomo 内核，逐个节点走 `GET /proxies/{name}/delay` 发一次真实 HTTP 请求（目标 `gstatic.com/generate_204`），只有**真的通过代理拿到响应**的节点才算活。这一步也顺带解决了 `hysteria` / `hysteria2` / `tuic` 这些 UDP 协议——TCP 探测对它们必然失败，mihomo 能真测。

---

## 流程

```
harvest.mjs   抓 843 篇文章 → 415 个订阅 → 解析去重 → ipinfo 标注国家
     ↓  data/nodes.json
probe.mjs     生成临时 clash 配置 → 起 mihomo → 并发调 delay API → 真实延迟
     ↓  data/live.json
build.mjs     按国家排序取 Top10 → 重命名 🇺🇸US-01 → 生成 yaml/base64/uri
     ↓
sub/          提交回仓库，GitHub Pages 自动发布
```

无 Durable Object、无 KV、无 Cron Trigger——全部在 Actions runner 里跑完，结果 commit 进仓库。

---

## 部署（自己的副本）

1. **Fork 或新建仓库**，把本项目推上去（必须 **public**，否则 Actions 分钟数会烧光）。
2. **开启 GitHub Pages**：Settings → Pages → Source 选 `Deploy from a branch`，Branch 选 `main`、目录 `/ (root)`，保存。
3. **（可选）配置 ipinfo token**：Settings → Secrets and variables → Actions → New repository secret，名字 `IPINFO_TOKEN`。不配也能跑（代码里有默认值，但公开仓库建议换自己的）。
4. **手动跑一次**：Actions → update-subscription → Run workflow。
5. 等 Actions 跑完，`sub/` 目录会有产出，Pages 地址即可用。

### 定时

`.github/workflows/update.yml`：

```yaml
on:
  schedule:
    - cron: '0 4 * * *'   # UTC 04:00 = 北京时间 12:00
  workflow_dispatch:
```

> GitHub 的 schedule 在高峰期可能延迟 10–30 分钟，不保证准点。要精确可以用外部 cron 打 `workflow_dispatch` API。
>
> **仓库连续 60 天无提交，GitHub 会自动停用 schedule**。本工作流每天都会 commit `sub/`，正常不会触发；但如果某天所有节点都挂了导致 commit 失败，注意检查。

---

## 参数

workflow 里的 `env`：

| 变量 | 默认 | 说明 |
|---|---|---|
| `TOP_PER_COUNTRY` | 10 | 每国保留节点数 |
| `PROBE_TIMEOUT` | 5000 | 单节点测速超时 ms |
| `PROBE_CONCURRENCY` | 16 | 测速并发 |
| `IPINFO_TOKEN` | — | ipinfo.io token，免费 50k/月 |

单次跑的耗时：抓取 3–5 分钟，测速 20–40 分钟（视节点数和存活率），总计 30–50 分钟。Actions 单 job 上限 6 小时，充裕。

---

## 文件

```
scripts/harvest.mjs   抓取 + 解析 + 去重 + geo 标注
scripts/probe.mjs     mihomo 真实测速
scripts/build.mjs     TopN 筛选 + 订阅生成
lib/parsers.mjs       8 种协议解析 + Clash/URI 双向转换
lib/sources.mjs       两站抓取
lib/geo.mjs           ipinfo 批量查询
sub/                  产出（自动提交）
data/                 中间产物（gitignore）
```

支持的协议：`ss` `ssr` `vmess` `vless` `trojan` `hysteria` `hysteria2` `tuic`

---

## 排错

**所有节点都测不出来**
Runner 到节点的网络本身受限，或者节点确实全死。先看 `sub/stats.json` 的 `alive`；如果是 0，检查 mihomo 是否启动成功（日志里会有 `mihomo ready`）。

**mihomo 启动失败**
`probe.mjs` 会先用 `mihomo -t -f config.yaml` 校验配置，从报错里提取坏节点名并剔除重试。如果重试 6 次还失败，日志会打印 mihomo 的原始输出。

**Pages 访问 404**
Pages 部署要比 push 晚 1–2 分钟。另外 `sub/` 目录必须真的被提交了（Actions 的 Commit step 有 `git diff --cached --quiet` 判断，没变化就不 commit）。

**订阅内容不更新**
jsDelivr 对 `@main` 有 12 小时缓存，按需换成 raw 或 Pages 地址。
