#!/usr/bin/env bash
# free-nodes-sub — Linux VPS 一键部署
#
# 用法:
#   sudo bash deploy-vps.sh                 # 装到 /opt/free-nodes-sub，装完立刻跑一次
#   sudo bash deploy-vps.sh /srv/nodes      # 自定义目录
#   sudo bash deploy-vps.sh --update        # 只更新代码和内核，不重跑
#
# 环境变量:
#   REPO=https://...   覆盖仓库地址（fork 后改成自己的）
#   APP_DIR=/opt/...   覆盖安装目录
#   IPINFO_TOKEN=...   ipinfo 令牌（不填用代码内默认值）

set -euo pipefail

REPO="${REPO:-https://github.com/zmqdyx163/free-nodes-sub.git}"
APP_DIR="${APP_DIR:-/opt/free-nodes-sub}"
MODE="install"

for arg in "$@"; do
  case "$arg" in
    --update) MODE="update" ;;
    /*) APP_DIR="$arg" ;;
  esac
done

log() { printf '\033[36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root，请用 sudo 运行"

# ---------- 依赖 ----------
command -v curl >/dev/null 2>&1 || die "缺少 curl"
command -v git  >/dev/null 2>&1 || die "缺少 git"

if ! command -v node >/dev/null 2>&1; then
  log "安装 Node.js 20 ..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  else
    die "无法自动安装 Node.js，请手动装 >= 18 后重跑"
  fi
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node 版本 $NODE_MAJOR 太低，需要 >= 18（fetch API）"
log "Node: $(node -v)"

# ---------- 代码 ----------
if [ -d "$APP_DIR/.git" ]; then
  log "更新代码 ($APP_DIR) ..."
  git -C "$APP_DIR" pull --rebase --quiet || log "拉取失败，继续用现有代码"
else
  log "克隆到 $APP_DIR ..."
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 "$REPO" "$APP_DIR"
fi

cd "$APP_DIR"

# ---------- mihomo 内核 ----------
case "$(uname -m)" in
  x86_64|amd64)   ARCH=amd64 ;;
  aarch64|arm64)  ARCH=arm64 ;;
  armv7l)         ARCH=armv7 ;;
  *) die "不支持的架构: $(uname -m)" ;;
esac

# 用 302 重定向拿版本号，不消耗 GitHub API 额度
VER=$(curl -sI https://github.com/MetaCubeX/mihomo/releases/latest \
      | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}' | sed 's|.*/tag/||')
[ -n "${VER:-}" ] || die "取不到 mihomo 版本号（检查服务器能否访问 GitHub）"

if [ -x ./mihomo ] && ./mihomo -v 2>/dev/null | grep -q "${VER#v}"; then
  log "内核已是 $VER，跳过下载"
else
  log "下载 mihomo $VER ($ARCH) ..."
  curl -fsSL -o mihomo.gz \
    "https://github.com/MetaCubeX/mihomo/releases/download/${VER}/mihomo-linux-${ARCH}-${VER}.gz"
  gunzip -f mihomo.gz
  chmod +x mihomo
fi
log "内核: $(./mihomo -v 2>/dev/null | head -1)"

# ---------- 依赖包 ----------
log "安装 npm 依赖 ..."
npm install --no-audit --no-fund --silent

if [ "$MODE" = "update" ]; then
  log "更新完成（未重跑流水线）"
  exit 0
fi

# ---------- 跑一次 ----------
log "开始抓取 + 家宽判定 + 测速，约 25 分钟"
node scripts/harvest.mjs
node scripts/isp-scan.mjs || log "家宽扫描失败（跳过家宽组，其余不受影响）"
node scripts/probe.mjs
node scripts/geo-probe.mjs || log "亚洲验证失败（不影响主流程，节点按 mihomo 延迟排序）"
node scripts/build.mjs

log "产物:"
ls -lh sub/ 2>/dev/null || die "没有产出，检查上面的日志"

cat <<EOF

────────────────────────────────────────────────
下一步
────────────────────────────────────────────────

1) 定时任务（服务器时区为 UTC 时，0 4 * * * = 北京 12:00）

   crontab -e
   0 4 * * * cd $APP_DIR && { node scripts/harvest.mjs && (node scripts/isp-scan.mjs || true) && node scripts/probe.mjs && (node scripts/geo-probe.mjs || true) && node scripts/build.mjs; } >> /var/log/free-nodes.log 2>&1

2) 分发（三选一，详见 README「VPS 分发」）

   A. 有域名 + Caddy（自动 HTTPS + Basic Auth，最省心）
   B. 有域名 + nginx（auth_basic）
   C. 没域名：只绑 127.0.0.1，用 SSH 隧道取

   ⚠️ 不要直接把 sub/ 用 python -m http.server 暴露到公网。

EOF
