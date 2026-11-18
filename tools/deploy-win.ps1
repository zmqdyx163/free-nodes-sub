# free-nodes-sub — Windows 部署（云电脑 / 本机）
#
# 用法（管理员 PowerShell 7 或 5.1）:
#   .\deploy-win.ps1                      装到 C:\free-nodes-sub，装完跑一次
#   .\deploy-win.ps1 -Dir D:\nodes        自定义目录
#   .\deploy-win.ps1 -Update              只更新代码和内核，不重跑
#   .\deploy-win.ps1 -InstallTask         额外注册每天 12:00 的计划任务
#
# 云电脑注意：大多数云电脑没有公网 IP，产物只能在机器上用 / 复制出来 /
# 同步到对象存储。要对外提供订阅得走反向隧道或对象存储，见脚本末尾提示。

param(
  [string]$Dir = 'C:\free-nodes-sub',
  [string]$Repo = 'https://github.com/zmqdyx163/free-nodes-sub.git',
  [switch]$Update,
  [switch]$InstallTask,
  [string]$TaskTime = '12:00'
)

$ErrorActionPreference = 'Stop'

function Log($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -ForegroundColor Cyan }
function Warn($m) { Write-Host ("[warn] {0}" -f $m) -ForegroundColor Yellow }
function Die($m) { Write-Host ("[error] {0}" -f $m) -ForegroundColor Red; exit 1 }

$archive = Join-Path $Dir 'mihomo.zip'
$exe = Join-Path $Dir 'mihomo.exe'

# ---------- 目录 ----------
if (-not (Test-Path $Dir)) { Log "创建 $Dir"; New-Item -ItemType Directory -Path $Dir -Force | Out-Null }

# ---------- Node ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Warn "未找到 Node.js"
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Log "用 winget 安装 Node LTS ..."
    winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
    $node = Get-Command node -ErrorAction SilentlyContinue
  }
  if (-not $node) { Die "请手动安装 Node.js 18+ (https://nodejs.org) 后重跑" }
}
$ver = (& node -p 'process.versions.node')
$major = [int]($ver.Split('.')[0])
if ($major -lt 18) { Die "Node $ver 太低，需要 >= 18" }
Log "Node: v$ver"

# ---------- 代码 ----------
$isRepo = Test-Path (Join-Path $Dir '.git')
if ($isRepo) {
  Log "更新代码 ..."
  Push-Location $Dir
  try { & git pull --rebase --quiet 2>$null } catch { Warn "git pull 失败，继续用现有代码" }
  Pop-Location
} else {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    Log "克隆仓库 ..."
    $parent = Split-Path $Dir -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    & git clone --depth 1 $Repo $Dir
    if ($LASTEXITCODE -ne 0) { Die "git clone 失败" }
  } else {
    Log "没有 git，下载 zip ..."
    $zip = Join-Path $env:TEMP 'free-nodes-sub.zip'
    Invoke-WebRequest -Uri "$($Repo -replace '\.git$','')/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
    $tmp = Join-Path $env:TEMP ('fns-' + [guid]::NewGuid().ToString('N'))
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $Dir -Recurse -Force
    Remove-Item $tmp, $zip -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Push-Location $Dir
try {
  # ---------- mihomo ----------
  $headers = curl.exe -sI "https://github.com/MetaCubeX/mihomo/releases/latest"
  $loc = ($headers | Select-String -Pattern '^location:' -CaseSensitive:$false | Select-Object -First 1).ToString()
  $tag = if ($loc) { ($loc -split '/tag/')[-1].Trim() } else { '' }
  if (-not $tag) { Die "取不到 mihomo 版本号（检查能否访问 GitHub）" }

  $cur = ''
  if (Test-Path $exe) { $cur = (& $exe -v 2>$null | Select-Object -First 1) }
  if ($cur -and $cur -match [regex]::Escape($tag.TrimStart('v'))) {
    Log "内核已是 $tag"
  } else {
    Log "下载 mihomo $tag (windows-amd64) ..."
    $url = "https://github.com/MetaCubeX/mihomo/releases/download/$tag/mihomo-windows-amd64-$tag.zip"
    curl.exe -fsSL -o $archive $url
    if ($LASTEXITCODE -ne 0) { Die "下载失败: $url" }
    Expand-Archive -Path $archive -DestinationPath (Join-Path $Dir '_mihomo') -Force
    $found = Get-ChildItem (Join-Path $Dir '_mihomo') -Filter '*.exe' | Select-Object -First 1
    if (-not $found) { Die "压缩包里没有 exe" }
    Copy-Item $found.FullName $exe -Force
    Remove-Item $archive, (Join-Path $Dir '_mihomo') -Recurse -Force -ErrorAction SilentlyContinue
  }
  Log ("内核: " + ((& $exe -v 2>$null | Select-Object -First 1)))

  # ---------- 依赖 ----------
  Log "安装 npm 依赖 ..."
  & npm install --no-audit --no-fund --silent
  if ($LASTEXITCODE -ne 0) { Die "npm install 失败" }

  if (-not $Update) {
    # ---------- 跑流水线 ----------
    Log "开始抓取 + 国家标注 + 测速，约 25 分钟（可 Ctrl-C，之后用计划任务）"
    & node scripts/harvest.mjs;                if ($LASTEXITCODE -ne 0) { Die "harvest 失败" }
    & node scripts/geo-scan.mjs;               if ($LASTEXITCODE -ne 0) { Warn "国家标注兜底失败" }
    & node scripts/probe.mjs;                  if ($LASTEXITCODE -ne 0) { Die "probe 失败" }
    & node scripts/geo-probe.mjs;              if ($LASTEXITCODE -ne 0) { Warn "亚洲验证失败，按 mihomo 延迟排序" }
    & node scripts/build.mjs;                  if ($LASTEXITCODE -ne 0) { Die "build 失败" }

    Log "产物:"
    Get-ChildItem (Join-Path $Dir 'sub') -ErrorAction SilentlyContinue |
      Select-Object Name, @{n='KB';e={[math]::Round($_.Length/1KB,1)}} | Format-Table -AutoSize | Out-String | Write-Host
  }

  # ---------- 计划任务 ----------
  if ($InstallTask) {
    Log "注册计划任务（每天 $TaskTime）..."
    $cmd = "cd /d `"$Dir`" && node scripts\harvest.mjs && (node scripts\geo-scan.mjs || exit /b 0) && node scripts\probe.mjs && (node scripts\geo-probe.mjs || exit /b 0) && node scripts/build.mjs >> `"$Dir\run.log`" 2>&1"
    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $cmd"
    $trigger = New-ScheduledTaskTrigger -Daily -At $TaskTime
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    Register-ScheduledTask -TaskName 'free-nodes-sub' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Log "已注册：任务计划程序 → free-nodes-sub（日志 $Dir\run.log）"
  }
}
finally {
  Pop-Location
}

Write-Host ""
Write-Host "────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host " 分发（云电脑大多没有公网 IP，按情况选）" -ForegroundColor White
Write-Host "────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host @"

A. 有公网 IP  →  Caddy + Basic Auth，客户端填 https://user:pass@你的域名/clash.yaml
B. 没公网 IP  →  cloudflared / frp 打隧道出去，再用隧道域名配 Basic Auth
C. 不想对外   →  产物就在 $Dir\sub\，远程桌面复制出来用
D. 想同步走   →  推到私有仓库 / 对象存储（R2、OSS、S3），客户端从那边拉

⚠️ 别用 python -m http.server 或 IIS 直接把 sub\ 裸奔到公网。

"@ -ForegroundColor Gray
