# verify-install.ps1 — 独立校验安装面（**只读**，重启前就能跑）
#
# ⚠ 版本无关：版本号与产物名都从本仓 package.json 派生 —— 不再"每版一份脚本"。
#
# 与 install.ps1 的自证**不重复**：那份在装的过程中顺带验，这份是事后独立复核，
# 而且刻意不依赖安装脚本的任何中间状态 —— 只读磁盘现状。
#
# 校验五件事：
#   ① 声明面：profile 的 dependencies 指向本版产物
#   ② 实体面：node_modules 里那份的版本与结构正确
#   ③ 一致面：树 = 包 = 装（仓库源码 / tarball 内清单 / 安装实体 三方对得上）
#   ④ 架构面：当前架构的能力锚点在位、已删机制确实不在位
#   ⑤ 运行时面：对安装实体做加载 + 真跑（verify-runtime.mjs）
#      —— 为什么要有这一级：静态校验只能证明**字节对得上**。打包错误、缺依赖、
#         导出被改名、语法在目标 Node 上不合法 —— 静态全看不见。静态对得上 ≠ 能加载。
#
# ⚠ 本脚本与 verify-runtime.mjs **都不进 tgz**（package.json 的 files 只有
#   host/core/三份契约），所以改它们不产生"树 ≠ 装"漂移、不需要重打包。
#   反过来：**任何进包的文件（core/ host/ *.md）在安装后被改，③ 就会报红** ——
#   那是设计内信号（提示重新 pack+install），不是故障。实测抓到过一次。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File D:\FF\project-nav\verify-install.ps1
#      （可加 -ProfileDir <路径>；默认 web）

param(
  [string]$ProfileDir = 'C:\Users\lk\.dsh\profiles\web'
)

$ErrorActionPreference = 'Stop'

$RepoDir    = 'D:\FF\project-nav'
$ProfilePkg = Join-Path $ProfileDir 'package.json'
$Dest       = Join-Path $ProfileDir 'node_modules\@dsh-external\project-nav'

$script:problems = 0
function Ok($msg)   { Write-Host "  [ OK ] $msg" -ForegroundColor Green }
function Bad($msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red; $script:problems++ }
function Note($msg) { Write-Host "         $msg" -ForegroundColor DarkGray }

function ReadUtf8($p) { [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) }
function Sha256($p)   { (Get-FileHash $p -Algorithm SHA256).Hash }

# ---- 版本：单一来源（package.json） ----
$repoJson = ReadUtf8 (Join-Path $RepoDir 'package.json') | ConvertFrom-Json
$WantVer  = $repoJson.version
$Tgz      = Join-Path $RepoDir "dsh-external-project-nav-$WantVer.tgz"

Write-Host ''
Write-Host "verify-install — profile: $ProfileDir   目标版本: v$WantVer" -ForegroundColor Cyan

# ---------- ① 声明面 ----------
Write-Host '① 声明面'
if (-not (Test-Path $ProfilePkg)) { Bad "找不到 profile 声明: $ProfilePkg" }
else {
  $decl = [regex]::Match((ReadUtf8 $ProfilePkg), '"@dsh-external/project-nav"\s*:\s*"([^"]*)"')
  if (-not $decl.Success) { Bad '声明里没有 @dsh-external/project-nav' }
  else {
    Note "声明 = $($decl.Groups[1].Value)"
    if ($decl.Groups[1].Value -match [regex]::Escape($WantVer)) { Ok "声明指向 v$WantVer" }
    else { Bad "声明不是 v$WantVer —— 重启后仍会加载旧版" }
  }
}

# ---------- ② 实体面 ----------
Write-Host '② 实体面'
if (-not (Test-Path (Join-Path $Dest 'package.json'))) { Bad "实体不存在: $Dest（先跑 install.ps1）" }
else {
  $ip = ReadUtf8 (Join-Path $Dest 'package.json') | ConvertFrom-Json
  if ($ip.version -eq $WantVer) { Ok "实体版本 = v$WantVer" } else { Bad "实体版本 = $($ip.version)，期望 $WantVer" }

  $missing = @()
  foreach ($f in 'host\index.js','core\scope.js','core\model.js','core\gates.js','core\format.js','core\render.js','core\log.js','core\lock.js','core\paths.js','core\commit.js','ARCHITECTURE.md','AGENTS.md','README.md','package.json') {
    if (-not (Test-Path (Join-Path $Dest $f))) { $missing += $f }
  }
  if ($missing.Count -eq 0) { Ok '实体结构完整（core 9 个文件 + 契约档）' } else { Bad ('实体缺: ' + ($missing -join ', ')) }
}

# ---------- ③ 一致面：树 = 包 = 装 ----------
Write-Host '③ 一致面（树 = 包 = 装）'
if (-not (Test-Path $Tgz)) { Bad "找不到产物: $Tgz" }
else {
  Note "产物 SHA256 = $(Sha256 $Tgz)"

  # 包 vs 装：整包解一次到临时目录再逐文件比（Windows tar 逐成员取件不可靠，别用）
  $listed = & tar -tzf $Tgz
  if ($LASTEXITCODE -ne 0) { Bad "tar 读取产物失败（退出码 $LASTEXITCODE）" }
  else {
    $members = $listed | Where-Object { $_ -like 'package/*' } | Where-Object { $_ -ne 'package/' }
    $tmp = Join-Path $env:TEMP ("pnverify-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    & tar -xzf $Tgz -C $tmp 2>$null
    $pkgRoot = Join-Path $tmp 'package'
    if (-not (Test-Path $pkgRoot)) { Bad "解包后找不到 package/"; Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    else {
      $diff = @(); $diffSrc = @()
      foreach ($member in $members) {
        $rel = $member.Substring(8)
        $a = Join-Path $pkgRoot ($rel -replace '/','\')
        $b = Join-Path $Dest ($rel -replace '/','\')
        $s = Join-Path $RepoDir ($rel -replace '/','\')
        if (-not (Test-Path $a)) { $diff += "包缺 $rel"; continue }
        if (-not (Test-Path $b)) { $diff += "实体缺 $rel"; continue }
        if ((Sha256 $a) -ne (Sha256 $b)) { $diff += "内容不一致 $rel" }
        if (Test-Path $s) { if ((Sha256 $s) -ne (Sha256 $a)) { $diffSrc += $rel } }
      }
      if ($diffSrc.Count -eq 0) { Ok '树 = 包（仓库源码与产物逐字节一致）' }
      else { Bad ('仓库与产物不一致（忘了 repack？）: ' + ($diffSrc -join ', ')) }
      if ($diff.Count -eq 0) { Ok "包 = 装（$($members.Count) 个文件逐字节一致）" } else { Bad ('包与装不一致: ' + ($diff -join '; ')) }
      Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
  }
}

# ---------- ④ 架构面（能力锚点 + 已删机制） ----------
Write-Host '④ 架构面（能力锚点 + 已删机制）'
$checks = @(
  @{ f='core\scope.js';  has='export function scanImports';   msg='scanImports 在位（依赖图数据源）' },
  @{ f='core\scope.js';  has='function isCodeFile';           msg='isCodeFile 在位（.d.ts 排除）' },
  @{ f='core\scope.js';  has='export function isTestPath';    msg='isTestPath 在位（告警闸纪律）' },
  @{ f='core\model.js';  has='function buildEdges';           msg='buildEdges 在位（磁盘实况层）' },
  @{ f='core\model.js';  has='function projectDirsOf';        msg='projectDirsOf 在位（扫描边界）' },
  @{ f='core\model.js';  has='function isPatchRecord';        msg='isPatchRecord 在位（计数闸只数真补丁）' },
  @{ f='core\model.js';  has='export function impactOf';      msg='impactOf 在位（文件精度影响面）' },
  @{ f='core\gates.js';  has='export function impactGate';    msg='impactGate 在位（第七闸）' },
  @{ f='core\model.js';  has='export function filePressure';  msg='filePressure 在位（文件职责只读信号）' },
  @{ f='core\model.js';  has='const direct = model.nodes.get'; msg='锚点归一支持完整节点 id（0.10.2 修）' }
)
foreach ($c in $checks) {
  $p = Join-Path $Dest $c.f
  if (-not (Test-Path $p)) { Bad "缺文件 $($c.f)"; continue }
  if ((ReadUtf8 $p) -match [regex]::Escape($c.has)) { Ok $c.msg } else { Bad "缺 $($c.has)" }
}
foreach ($gone in @('core\legacy.js')) {
  if (Test-Path (Join-Path $Dest $gone)) { Bad "$gone 仍在 —— 已删机制不该存在" } else { Ok "$gone 已消失（迁移器随换代删除）" }
}
if (Test-Path (Join-Path $Dest 'core\render.js')) {
  if ((ReadUtf8 (Join-Path $Dest 'core\render.js')) -match 'stampArchDoc|listArchDocs|parseArchCache') { Bad 'core/render.js 仍带架构档指纹机制' }
  else { Ok '架构档指纹/新鲜度机制已移除（§2 降级为投影）' }
}

# ---------- ⑤ 运行时面（静态对得上 ≠ 能加载） ----------
Write-Host '⑤ 运行时面（对安装实体做加载 + 真跑）'
$runtime = Join-Path $RepoDir 'verify-runtime.mjs'
if (-not (Test-Path $runtime)) { Bad "找不到运行时校验: $runtime" }
else {
  & node $runtime $Dest
  if ($LASTEXITCODE -eq 0) { Ok '运行时冒烟通过（安装实体可加载、可运行、契约完整）' }
  else { Bad "运行时冒烟未通过（退出码 $LASTEXITCODE）—— 见上方明细" }
}

# ---------- 汇总 ----------
Write-Host ''
if ($script:problems -eq 0) {
  Write-Host "=== 全部通过（v$WantVer）：重启 dsh-web 即生效 ===" -ForegroundColor Green
  Write-Host '  重启后自检：nav_graph mode=health 不应出现「架构档」段；' -ForegroundColor DarkGray
  Write-Host '              nav_graph mode=impact target=core/model.js 应给出「我引用谁 / 谁引用我」。' -ForegroundColor DarkGray
  exit 0
} else {
  Write-Host "=== $($script:problems) 项未通过：**先别重启** ===" -ForegroundColor Red
  exit 1
}
