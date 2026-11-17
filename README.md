# free-nodes-sub

每天自动抓取 [xinshoucun.net](https://xinshoucun.net/category/freenode) 和 [blog.kuaiyu.cc](https://blog.kuaiyu.cc/) 的免费节点，去重后用 **mihomo 内核做真实代理测速**（基准：`ippure.com`），再经香港/日本/新加坡三地可达性验证，每国保留 **Top5**。

> **订阅不在仓库里。** 产物只走 GitHub Actions 的 Artifact，仓库内只有代码和一个不含节点信息的 `status.json`。原因见下方「为什么不再公开订阅」。

---

## 获取订阅

1. 打开 [Actions](https://github.com/zmqdyx163/free-nodes-sub/actions/workflows/update.yml)
2. 点最新一次成功的运行
3. 页面底部 **Artifacts** → 下载 `subscription-NNN`
4. 解压得到 `clash.yaml` / `base64.txt` / `uri.txt`，直接导入客户端

Artifact 保留 7 天，每天由定时任务刷新。**需要登录 GitHub 才能下载**，正是这一点挡住了扫描器。

想随时手动跑一次：Actions → update-subscription → Run workflow。

---

## 为什么不再公开订阅

早期版本把 `sub/clash.yaml` 提交进仓库，配 GitHub Pages 和 raw 直链。三个漏洞：

1. **public 仓库的文件内容会被 GitHub 代码搜索直接索引** —— 用 `repo:xxx proxies:` 就能搜到
2. **raw 和 Pages 都是无鉴权静态地址** —— 拿到 URL 就能一直拉
3. **改路径没用** —— 文件树可以完整枚举，随机命名只挡顺手扫的人

更麻烦的是**历史**：就算从当前分支删掉，`git log` 里的每一个旧 commit 仍然能通过 `raw.githubusercontent.com/<repo>/<sha>/sub/clash.yaml` 取到完整订阅。

所以这一版把仓库删了重建（全新历史），并且从此不再提交任何节点数据。

> 如果之后要恢复「客户端自动更新」，需要一个带鉴权的分发层（Cloudflare Worker 校验 secret 后转发），单纯放在 GitHub 静态托管上是做不到的。

---

## 三道验证

```
mihomo 协议测活        →  check-host 亚洲可达       →  每国 Top5
（ippure 基准，真握手）    （港/日/新 TCP，只测候选）    （按亚洲延迟排序）
```

**第一道 mihomo**：起真内核，对每个节点调 `/proxies/{name}/delay`，目标是 `https://ippure.com/cdn-cgi/trace`。必须走完加密握手并拿到响应才算活。这一步砍掉密码错、协议不匹配、端口挂占位页的假活。

> 为什么用 `/cdn-cgi/trace` 而不是首页：首页 26.7 KB，8000 个节点要白跑 200 MB+ 流量；trace 端点只有 202 字节，是 Cloudflare 官方的连通性测试路径。

**第二道 check-host**：GitHub Runner 在美国，「对美西通」不等于「对亚洲通」。用 [check-host.net](https://check-host.net) 的 `hk1` / `jp1` / `sg1` 再做一次 TCP 可达性检测。**只测每国按 mihomo 延迟排出的前 5 个候选**，UDP 协议（hysteria/tuic）直接跳过——check-host 只能测 TCP，测它们纯属浪费请求。

**排序**：Top5 不按 mihomo 的美西延迟排，而是按**香港跳延迟**（国内 → 香港约 30–50ms，香港 → 目标才是真实绕路）。

> check-host 没有中国大陆节点，香港 `hk1` 是最接近的替代。它只测 TCP 端口可达，协议本身可用性由 mihomo 那一步保证。

---

## 流程

```
harvest.mjs     抓 850+ 篇文章 → 420+ 个订阅 → 解析去重 → ipinfo 标注国家
     ↓  data/nodes.json
probe.mjs       生成临时 clash 配置 → 起 mihomo → 并发调 delay → 真实延迟
     ↓  data/live.json
geo-probe.mjs   每国取 Top5 候选 → check-host 港/日/新 TCP 可达
     ↓  data/asia.json
build.mjs       按亚洲延迟排序 → 每国 Top5 → 生成 yaml/base64/uri
     ↓
upload-artifact   →  Actions Artifacts（保留 7 天）
commit status.json →  仓库里只留时间戳和统计
```

无 Durable Object、无 KV、无 Cron Trigger，全部在 Actions runner 里跑完。

---

## 耗时与额度

| 阶段 | 耗时 |
|---|---|
| 抓取（850 篇 + 420 订阅） | ~5 分钟 |
| mihomo 测速（8600 个，9 批） | ~20 分钟 |
| 亚洲验证（每国 Top5，约 180 个） | ~12 分钟 |
| 构建 + 提交 | <1 分钟 |
| **合计** | **~38 分钟** |

定时任务每天两次（`37 4` / `37 9` UTC），靠 gate 保证一天只真跑一次。

> 如果仓库改成 private，Actions 会从「免费无限」变成每月 2000 分钟额度。38 分钟 × 30 天 = 1140 分钟，有余量。

---

## 文件

```
scripts/harvest.mjs   抓取 + 解析 + 去重 + geo 标注
scripts/probe.mjs     mihomo 真实测速（基准 ippure.com）
scripts/geo-probe.mjs check-host 港/日/新可达性（每国 Top5）
scripts/build.mjs     排序 + 每国 Top5 + 生成订阅
lib/parsers.mjs       8 种协议解析 + Clash/URI 双向转换
lib/sources.mjs       两站抓取
lib/geo.mjs           ipinfo 批量查询
sub/                  产物目录（gitignore，只进 Artifact）
status.json           运行时写入，只有时间戳和统计，无节点信息
```

支持的协议：`ss` `ssr` `vmess` `vless` `trojan` `hysteria` `hysteria2` `tuic`

---

## 参数

workflow 的 `env`：

| 变量 | 默认 | 说明 |
|---|---|---|
| `TOP_PER_COUNTRY` | 5 | 每国保留节点数 |
| `GEO_TOP_PER_COUNTRY` | 5 | 每国送去亚洲验证的候选数 |
| `PROBE_TIMEOUT` | 5000 | 单节点测速超时 ms |
| `PROBE_URL` | `https://ippure.com/cdn-cgi/trace` | 测速目标 |
| `PROBE_CONCURRENCY` | 16 | 测速并发 |
| `GEO_CONCURRENCY` | 2 | check-host 并发（高了会 429）|
| `IPINFO_TOKEN` | — | ipinfo.io token，不配也能跑（代码内有默认值）|

---

## 排错

**一个节点都没测出来**
先看 `status.json` 的 `alive`。若为 0，检查 Probe 日志里 `mihomo ready` 是否出现——配置校验失败会打印 mihomo 的原始报错。

**mihomo 拒绝整份配置**
`probe.mjs` 会分批（每批 1000）校验，批内二分定位坏节点。已知会让 mihomo 拒启的：`ss` 的 `2022-*` cipher key 格式不对（已在生成前剔除）。

**check-host 返回 429**
把 `GEO_CONCURRENCY` 降到 1、`GEO_GAP` 提到 1500。这个 API 免费但有限流。

**Artifact 里没文件**
`if-no-files-found: error` 会让这一步直接失败，去看 Build 那步的日志。

**定时任务没按点跑**
GitHub 的 schedule 在整点最挤，实测 `0 4 * * *` 被延后过 7 小时 50 分。已改成 `37 4` 并加 `37 9` 兜底。

**测速目标换掉后全部超时**
ippure.com 走 Cloudflare。如果你的节点普遍不能访问 CF 网络，`/cdn-cgi/trace` 会全部失败——这时把 `PROBE_URL` 换成别的轻量地址（比如 `http://www.gstatic.com/generate_204`）再跑。
