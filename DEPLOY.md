# 部署说明（给自动化 Agent）

> 本文档自包含。执行方不需要任何额外上下文，按步骤做即可。
> 目标机器：一台长期在线的 Linux VPS 或 Windows 云电脑。

---

## 0. 这个项目做什么

每天定时执行一条流水线，产出一份可用的代理订阅：

```
抓取  →  去重  →  真实测速  →  亚洲可达性  →  每国 Top5  →  生成订阅
```

| 阶段 | 脚本 | 做什么 |
|---|---|---|
| 抓取 | `scripts/harvest.mjs` | 拉 850+ 篇文章 / 420+ 个订阅，解析出 8000+ 个节点 |
| 国家标注 | `scripts/geo-scan.mjs` | 用 ip-api 批量补国家码（ipinfo 额度耗尽时的兜底） |
| 测速 | `scripts/probe.mjs` | 起真 mihomo 内核，逐个调 `/proxies/{name}/delay` 测真实延迟 |
| 亚洲验证 | `scripts/geo-probe.mjs` | check-host 的香港/日本/新加坡节点做 TCP 可达检测 |
| 生成 | `scripts/build.mjs` | 按亚洲延迟排序，每国取 Top5，输出 clash/base64/uri |

**产出**：`sub/clash.yaml`（Clash 系）、`sub/base64.txt`（v2rayN/小火箭）、`sub/uri.txt`（明文）。

---

## 1. 环境要求

| 项 | 要求 |
|---|---|
| Node.js | **20 或以上**（低于 20 直接退出） |
| 内存 | 1 GB 可用 |
| 磁盘 | 200 MB（不含 node_modules 时约 50MB，装完约 150MB） |
| 网络 | 能访问 github.com、xinshoucun.net、blog.kuaiyu.cc、ip-api.com、check-host.net、ippure.com |
| 权限 | 能写安装目录；Windows 装计划任务需要管理员 |

**不需要**：数据库、Docker、Python、任何云服务账号。

---

## 2. 文件清单

仓库：`https://github.com/zmqdyx163/free-nodes-sub`（public，只放代码，**不含任何订阅数据**）

```
.
├── package.json              只有一个依赖 js-yaml
├── status.json               每次运行后写入（时间戳 + 统计，无节点信息）
├── lib/
│   ├── parsers.mjs           8 种协议的解析与序列化（ss/ssr/vmess/vless/trojan/hysteria/hysteria2/tuic）
│   ├── sources.mjs           两个抓取源的实现
│   └── geo.mjs               ipinfo 批量查询（可选，失败不影响）
├── scripts/
│   ├── harvest.mjs           抓取 + 解析 + 去重
│   ├── geo-scan.mjs          ip-api 批量补国家标注
│   ├── probe.mjs             mihomo 真实测速（核心）
│   ├── geo-probe.mjs         check-host 亚洲可达性
│   ├── build.mjs             生成订阅
│   └── serve.mjs             可选：带令牌的订阅 HTTP 服务
├── tools/
│   ├── deploy-vps.sh         Linux 一键部署
│   └── deploy-win.ps1        Windows 一键部署
└── 运行时生成（不进 Git）
    ├── data/                 中间数据：nodes.json / live.json / asia.json
    ├── sub/                  订阅产物
    ├── logs/                 运行日志
    └── mihomo(.exe)          内核，脚本自动下载
```

---

## 3. 部署 · Linux

```bash
# 3.1 装 Node 20（Debian/Ubuntu）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git curl jq
node -v          # 预期：v20.x 或更高

# 3.2 拉代码
sudo git clone https://github.com/zmqdyx163/free-nodes-sub.git /opt/free-nodes-sub
sudo chown -R $USER:$USER /opt/free-nodes-sub

# 3.3 一键部署（自动下 mihomo、装依赖、跑一次完整流水线）
cd /opt/free-nodes-sub
bash tools/deploy-vps.sh
```

**3.3 的预期输出**（末尾几行）：

```
[HH:MM:SS] 下载 mihomo v1.x.x ...
Mihomo Meta v1.x.x linux amd64 ...
[HH:MM:SS] 测速完成：NNN/XXXX 真活
[HH:MM:SS] 筛选后 NNN 个，覆盖 NN 个国家
[HH:MM:SS] 产物:
-rw-r--r-- 1 user user  60K ... sub/clash.yaml
...
```

耗时约 **25 分钟**（测速 20 分钟 + 亚洲验证 3 分钟 + 抓取 1 分钟）。

---

## 4. 部署 · Windows

```powershell
# 4.1 以管理员身份打开 PowerShell
# 4.2 拉代码（没装 git 的话脚本会退化成下 zip）
git clone https://github.com/zmqdyx163/free-nodes-sub.git C:\free-nodes-sub
cd C:\free-nodes-sub

# 4.3 一键部署 + 注册每天 12:00 的计划任务
powershell -ExecutionPolicy Bypass -File .\tools\deploy-win.ps1 -InstallTask
```

参数：

```powershell
.\tools\deploy-win.ps1                    # 装完跑一次，不注册任务
.\tools\deploy-win.ps1 -Dir D:\nodes      # 换目录
.\tools\deploy-win.ps1 -Update            # 只更新代码和内核，不重跑
.\tools\deploy-win.ps1 -InstallTask       # 额外注册每天 12:00 的计划任务
.\tools\deploy-win.ps1 -TaskTime 08:30    # 自定义时间
```

脚本会依次做：检查 Node（没有就用 winget 装）→ 拉代码 → 下 `mihomo-windows-amd64-compatible` → `npm install` → 跑完整流水线 → 可选注册计划任务。

---

## 5. 定时任务

### Linux

```bash
crontab -e
```

加一行（`deploy-vps.sh` 也会打印这段提示）：

```cron
0 4 * * * cd /opt/free-nodes-sub && { node scripts/harvest.mjs && node scripts/geo-scan.mjs && node scripts/probe.mjs && (node scripts/geo-probe.mjs || true) && node scripts/build.mjs; } >> /var/log/free-nodes.log 2>&1
```

`0 4 * * *` 是 UTC，即北京时间 12:00。**如果机器时区不是 UTC，改成对应本地时间**（`timedatectl` 查看）。

确认 cron 在跑：

```bash
systemctl status cron      # Debian/Ubuntu
systemctl status crond     # CentOS/RHEL
```

### Windows

`-InstallTask` 已经建好了（默认每天 12:00）。手动改：

```powershell
schtasks /query /tn "free-nodes-sub" /v /fo list
schtasks /change /tn "free-nodes-sub" /st 08:30
schtasks /delete /tn "free-nodes-sub" /f
```

> **注意**：`schtasks` 默认用当前用户身份，**需要该用户处于登录状态**才执行。云电脑如果会自动注销，改用「任务计划程序」GUI 勾选「不管用户是否登录都要运行」并保存密码。

---

## 6. 产出与分发

产物在 `<安装目录>/sub/`。**关键限制：大多数云电脑没有公网 IP**，机器能跑但外部拉不到订阅。

| 场景 | 做法 |
|---|---|
| 只在本机用 | 客户端直接导入 `sub/clash.yaml` |
| 要跨设备 | 远程桌面把文件复制出来 |
| 有公网 IP | 起服务：`SUB_TOKEN=xxx PORT=8080 node scripts/serve.mjs`，访问 `http://IP:8080/<SUB_TOKEN>/clash.yaml` |
| 有域名 | 前面挂 Caddy/Nginx 上 HTTPS，反代到 8080 |
| 没公网 IP 但要走隧道 | cloudflared / frp 打出去 |

**不要把 `sub/` 目录直接用 `python -m http.server` 或 IIS 裸奔到公网**，那是无鉴权静态地址，会被扫描器批量抓走。

---

## 7. 验收标准（可编程判断）

部署完成后，用这几条判断是否成功：

```bash
# 7.1 产物存在且非空
test -s sub/clash.yaml && echo OK1

# 7.2 节点数量 > 50
[ "$(grep -c '^  - name:' sub/clash.yaml)" -gt 50 ] && echo OK2

# 7.3 YAML 能被解析，且 proxies 是数组
node -e "const y=require('js-yaml'),f=require('fs');const d=y.load(f.readFileSync('sub/clash.yaml','utf8'));if(!Array.isArray(d.proxies)||!d.proxies.length)process.exit(1);console.log('OK3',d.proxies.length)"

# 7.4 国家数 > 20，存活节点 > 50
jq -e '.countries > 20 and .live > 50' status.json > /dev/null && echo OK4
```

四条都通过才算部署成功。

**`status.json` 里值得关注的字段**：

| 字段 | 正常范围 | 说明 |
|---|---|---|
| `alive` | 300–600 | mihomo 实测活着（走完加密握手） |
| `live` | 100–200 | 最终输出节点数 |
| `countries` | 30–40 | 覆盖国家数 |
| `avgLatency` | 200–400 | 亚洲视角平均延迟 ms |
| `raw` / `unique` | 55000+ / 8500+ | 抓取与去重后的量 |

**如果 `countries` 只有 1–3**，说明国家标注失败，看第 8 节第一条。

---

## 8. 故障处理

### 8.1 `countries` 只有 1，`live` 只有几个

**原因**：`harvest.mjs` 用 ipinfo 标国家，免费额度（50k/月）耗尽后返回 429，所有节点变成 `ZZ`，「每国 Top5」退化成只取 5 个。

**处理**：
- 确认 `geo-scan.mjs` 在流水线里（Windows 的 `$cmd` 变量、Linux 的 crontab 行都要有）
- 看日志有没有 `国家标注修正 NNN 个`
- ip-api 限流时把 `GEO_SCAN_GAP` 从 4200 提到 6000

### 8.2 `alive = 0`，一个节点都没测出来

**原因**：mihomo 没起来，或配置被拒。

**处理**：
- 日志里搜 `mihomo ready`，没有就是没起来
- 搜 `configuration file ... test failed`，会打印 mihomo 的原始报错
- 常见：`ss` 的 `2022-*` cipher key 格式不对（`probe.mjs` 已预剔除）
- 分批校验（每批 1000）失败超过 6 次就跳过整批，损失可控

### 8.3 mihomo 下载失败

**原因**：`api.github.com` 未认证只有 60 次/小时，Actions 的共享出口 IP 经常被限流。

**处理**：`probe.mjs` 和部署脚本都用 **302 重定向**取版本号，不消耗 API 额度：

```bash
VER=$(curl -sI https://github.com/MetaCubeX/mihomo/releases/latest \
      | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}' | sed 's|.*/tag/||')
```

如果机器访问 GitHub 本身慢，手动下载对应版本放到项目根目录，命名 `mihomo`（Linux）/ `mihomo.exe`（Windows），脚本会直接用。

### 8.4 全部节点超时

**原因**：测速目标 `https://ippure.com/cdn-cgi/trace` 走 Cloudflare，如果当前网络/节点普遍不能访问 CF，会全判死。

**处理**：换目标

```bash
PROBE_URL="http://www.gstatic.com/generate_204" node scripts/probe.mjs
```

### 8.5 check-host 返回 429

**处理**：`GEO_CONCURRENCY` 降到 1、`GEO_GAP` 提到 1500。这一步失败不阻断主流程（`|| true`）。

### 8.6 计划任务没按点跑

GitHub 的 schedule 在整点最挤（实测被延后过 7 小时 50 分），**本地 cron/schtasks 不受影响**。如果用的是 GitHub Actions 版本，看仓库 `README.md` 里的说明。

---

## 9. 参数（环境变量）

| 变量 | 默认 | 作用 |
|---|---|---|
| `TOP_PER_COUNTRY` | `5` | 每国保留节点数 |
| `PROBE_TIMEOUT` | `5000` | 单节点测速超时 ms |
| `PROBE_CONCURRENCY` | `16` | 测速并发 |
| `PROBE_URL` | `https://ippure.com/cdn-cgi/trace` | 测速目标 |
| `PROBE_BATCH` | `1000` | 每批多少个节点重启一次内核 |
| `GEO_TOP_PER_COUNTRY` | `5` | 每国送多少个候选去做亚洲验证 |
| `GEO_CONCURRENCY` | `2` | check-host 并发（**别超过 2，会 429**）|
| `GEO_GAP` | `900` | check-host 请求间隔 ms |
| `GEO_SCAN_GAP` | `4200` | ip-api 批次间隔 ms（15 次/分钟）|
| `MIHOMO_BIN` | 自动探测 | 内核路径 |
| `IPINFO_TOKEN` | 代码内默认值 | ipinfo token，可选 |

Linux 临时覆盖：`TOP_PER_COUNTRY=8 node scripts/build.mjs`
Windows：`$env:TOP_PER_COUNTRY=8; node scripts/build.mjs`

---

## 10. 如果只需要跑一次

```bash
cd /opt/free-nodes-sub
node scripts/harvest.mjs          # ~1 分钟
node scripts/geo-scan.mjs         # ~4 分钟
node scripts/probe.mjs            # ~20 分钟
node scripts/geo-probe.mjs        # ~3 分钟（可跳过）
node scripts/build.mjs            # <1 秒
```

跳过亚洲验证：`node scripts/probe.mjs && node scripts/build.mjs`（少了 geo-probe，节点按 mihomo 延迟排序）。

---

## 11. 需要改代码时

仓库是 public 的，直接 fork 后改，然后把 `tools/deploy-*.sh/ps1` 里的 `REPO` 变量指到自己的仓库。

代码结构很薄，没有框架：

- 加协议支持 → `lib/parsers.mjs` 的解析分支 + `SUPPORTED` 集合
- 加抓取源 → `lib/sources.mjs`
- 改筛选规则 → `scripts/build.mjs` 的 `groups` 循环
- 改测速目标 → `PROBE_URL` 环境变量，不用改代码

---

## 12. 已知限制（诚实说明）

1. **测速视角取决于机器位置**。机器在美国测的就是美西延迟，在国内测的就是国内延迟。「亚洲可达性」那一步用 check-host 香港节点近似，**没有中国大陆节点可用**。
2. **存活率低是正常的**。免费节点池里 90% 以上是死的或协议不对，8000 个测出 400–600 个真活是常态。
3. **节点质量不稳定**。免费节点每天大量失效，订阅需要每天更新。
4. **`hysteria`/`hysteria2`/`tuic` 走 UDP**，check-host 的 TCP 探测测不了，这类节点只过 mihomo 那一道。
