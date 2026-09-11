# install-0.9.1.ps1 — 把 project-nav 0.9.1 装进 profile（**需你在自己终端执行**）
#
# 为什么不由 agent 执行：profile 目录在本会话的 OS ACL 之外（实测 "Access to the path ... is denied"，
# 不是沙箱策略标记，批准也越不过）；且重启承载 GUI 的 dsh-web 被明确禁止由 agent 自行执行。
#
# ⚠ 为什么**不能**用 npm 装（实测两条都失败）：
#   profile 里有 "@dsh-external/dsh-motion": "link:D:/lk/deepseek/dsh-motion"，
#   npm 10.9.4 不接受 `link:` 协议（EUNSUPPORTEDPROTOCOL）。npm 在 reify 时会解析**整份** package.json，
#   因此 `npm install` 与 `npm install <tgz> --no-save` **都**会失败；
#   而 package-lock.json 不存在（只有 node_modules/.package-lock.json），也不能靠 `npm ci`。
#
#   对一个**本地 tarball 依赖**，npm 做的事本来就是"把包展开到 node_modules/<name>/"。
#   这里直接做这件事：确定、可预测、不需要 npm、也不会连坐其它依赖。
#   （声明仍需同步改写 —— 否则日后任何一次成功安装会把你静默退回旧版。）
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File D:\FF\project-nav\install-0.9.1.ps1
#      （可加 -ProfileDir <路径> 指定别的 profile；默认 web）

param(
  [string]$ProfileDir = 'C:\Users\lk\.dsh\profiles\web'
)

$ErrorActionPreference = 'Stop'

$ProfilePkg = Join-Path $ProfileDir 'package.json'
$PkgName    = '@dsh-external/project-nav'
$ScopeDir   = Join-Path $ProfileDir 'node_modules\@dsh-external'
$Dest       = Join-Path $ScopeDir 'project-nav'
$Tgz        = 'D:\FF\project-nav\dsh-external-project-nav-0.9.1.tgz'
$WantDecl   = 'file:' + ($Tgz -replace '\\','/')
$ScopeStamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $Tgz))        { Fail "找不到产物: $Tgz" }
if (-not (Test-Path $ProfilePkg)) { Fail "找不到 profile: $ProfilePkg" }

$sha = (Get-FileHash $Tgz -Algorithm SHA256).Hash
Write-Host "[1/5] 产物 $([IO.Path]::GetFileName($Tgz))"
Write-Host "      SHA256=$sha"

# ---- 备份：声明 + 旧实体（变更先判因备份） ----
$pkgBackup = "$ProfilePkg.bak-$ScopeStamp"
Copy-Item $ProfilePkg $pkgBackup -Force
Write-Host "[2/5] 声明已备份 -> $pkgBackup"

$oldVer = '(none)'
if (Test-Path (Join-Path $Dest 'package.json')) {
  $oldVer = ([System.IO.File]::ReadAllText((Join-Path $Dest 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version
  $oldBackup = "$Dest.bak-$ScopeStamp"
  Move-Item $Dest $oldBackup -Force
  Write-Host "[3/5] 旧实体 v$oldVer 已挪走 -> $oldBackup（确认无误后可删）"
} else {
  Write-Host "[3/5] 无旧实体，全新安装"
}

# ---- 展开 tarball 到 node_modules/<name>/ ----
Write-Host "[4/5] 展开 tarball..."
New-Item -ItemType Directory -Force -Path $ScopeDir | Out-Null
$stage = Join-Path $ScopeDir "project-nav.stage-$ScopeStamp"
New-Item -ItemType Directory -Force -Path $stage | Out-Null
& tar -xzf $Tgz -C $stage
if ($LASTEXITCODE -ne 0) { Fail "tar 解包失败（退出码 $LASTEXITCODE）" }
$inner = Join-Path $stage 'package'
if (-not (Test-Path $inner)) { Fail "tarball 结构异常：找不到 package/ 目录" }
Move-Item $inner $Dest -Force
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue

# ---- 改声明（只改那一行，不整组重写；无 BOM 写回） ----
$text = [System.IO.File]::ReadAllText($ProfilePkg, [System.Text.Encoding]::UTF8)
$m = [regex]::Match($text, '"@dsh-external/project-nav"\s*:\s*"[^"]*"')
if (-not $m.Success) { Fail '声明里找不到 @dsh-external/project-nav 依赖项' }
$newLine = '"@dsh-external/project-nav": "' + $WantDecl + '"'
if ($m.Value -ne $newLine) {
  $text2 = $text.Remove($m.Index, $m.Length).Insert($m.Index, $newLine)
  [System.IO.File]::WriteAllText($ProfilePkg, $text2, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[5/5] 声明已改 -> $WantDecl"
} else { Write-Host '[5/5] 声明已是 0.9.1' }

# ---- 自证（不靠"命令没报错"） ----
if (-not (Test-Path (Join-Path $Dest 'package.json'))) { Fail "实体未生成: $Dest" }
$ip = [System.IO.File]::ReadAllText((Join-Path $Dest 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if ($ip.version -ne '0.9.1') { Fail "实体版本 = $($ip.version)，不是 0.9.1" }
if (-not (Test-Path (Join-Path $Dest 'core'))) { Fail '实体缺 core/（0.9.x 特征）' }
foreach ($f in 'host\index.js','core\model.js','core\render.js','ARCHITECTURE.md') {
  if (-not (Test-Path (Join-Path $Dest $f))) { Fail "实体缺 $f" }
}
$repoModel = 'D:\FF\project-nav\core\model.js'
$sameHash = (Get-FileHash (Join-Path $Dest 'core\model.js') -Algorithm SHA256).Hash -eq (Get-FileHash $repoModel -Algorithm SHA256).Hash
if (-not $sameHash) { Fail 'core/model.js 与仓库源码不一致（装错了产物？）' }

Write-Host ''
Write-Host '=== 安装完成且自证通过 ===' -ForegroundColor Green
Write-Host "  旧版本 = $oldVer   ->   新版本 = $($ip.version)"
Write-Host '  含 core/ = True   已无 shared/ = ' + (-not (Test-Path (Join-Path $Dest 'shared')))
Write-Host ''
Write-Host '下一步（只有你能做）：重启 dsh-web。重启前可再跑独立校验：'
Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File D:\FF\project-nav\verify-0.9.1-install.ps1'
Write-Host ''
Write-Host "回滚：Remove-Item -Recurse '$Dest'；Move-Item '$Dest.bak-$ScopeStamp' '$Dest'；Copy-Item '$pkgBackup' '$ProfilePkg' -Force"
