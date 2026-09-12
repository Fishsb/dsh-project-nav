# install.ps1 — 把 project-nav 装进 profile（agent 在 `danger-full-access` 下可直接跑）
#
# ⚠ 版本无关：版本号从本仓 package.json 读，产物名由它派生 —— 不再"每版一份脚本"。
#   （旧做法 install-<ver>.ps1 每换代就多一份、旧的还留在仓里变成尾巴。脚本本身不该有版本。）
#
# ⚠ 谁能跑它：**agent 在 `danger-full-access` 策略下可以直接跑**（2026-09-12 实测通过：
#   profile 可写，安装 + 自证一次成功）。旧结论"profile 在会话 ACL 之外"是 `workspace-write`
#   时代的边界，已被策略变化作废 —— **别照抄历史结论，先试一次**。
#   若当前策略是 `workspace-write`，profile 不可写，才需要你自己跑。
#   唯一**只有用户能做**的事是**重启**：agent 不能重启承载自己的进程。
#
# ⚠ 为什么**不能**用 npm 装（实测两条都失败）：
#   profile 里有 "@dsh-external/dsh-motion": "link:..."，npm 10.9.4 不接受 `link:` 协议
#   （EUNSUPPORTEDPROTOCOL）。npm 在 reify 时会解析**整份** package.json，
#   因此 `npm install` 与 `npm install <tgz> --no-save` **都会**失败；又没有 package-lock.json
#   （只有 node_modules/.package-lock.json），也不能靠 `npm ci`。
#
#   对一个**本地 tarball 依赖**，npm 做的事本来就是"把包展开到 node_modules/<name>/"。
#   这里直接做这件事：确定、可预测、不需要 npm、也不会连坐其它依赖。
#   （声明仍需同步改写 —— 否则日后任何一次成功安装会把你静默退回旧版。）
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File D:\FF\project-nav\install.ps1
#      （可加 -ProfileDir <路径> 指定别的 profile；默认 web）

param(
  [string]$ProfileDir = 'C:\Users\lk\.dsh\profiles\web'
)

$ErrorActionPreference = 'Stop'

$RepoDir    = 'D:\FF\project-nav'
$ProfilePkg = Join-Path $ProfileDir 'package.json'
$ScopeDir   = Join-Path $ProfileDir 'node_modules\@dsh-external'
$Dest       = Join-Path $ScopeDir 'project-nav'
$ScopeStamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; exit 1 }

# ---- 版本从 package.json 读，产物名由它派生（单一来源，不会"脚本说 A、包是 B"） ----
if (-not (Test-Path (Join-Path $RepoDir 'package.json'))) { Fail "找不到 $RepoDir\package.json" }
$WantVer = ([System.IO.File]::ReadAllText((Join-Path $RepoDir 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version
$Tgz     = Join-Path $RepoDir "dsh-external-project-nav-$WantVer.tgz"
$WantDecl = 'file:' + ($Tgz -replace '\\','/')

if (-not (Test-Path $Tgz))        { Fail "找不到产物: $Tgz（先 npm pack --cache .npm-cache）" }
if (-not (Test-Path $ProfilePkg)) { Fail "找不到 profile: $ProfilePkg" }

$sha = (Get-FileHash $Tgz -Algorithm SHA256).Hash
Write-Host "[1/6] 目标版本 v$WantVer"
Write-Host "      产物 $([IO.Path]::GetFileName($Tgz))"
Write-Host "      SHA256=$sha"

# ---- 备份：声明 + 旧实体（变更先判因备份） ----
$pkgBackup = "$ProfilePkg.bak-$ScopeStamp"
Copy-Item $ProfilePkg $pkgBackup -Force
Write-Host "[2/6] 声明已备份 -> $pkgBackup"

$oldVer = '(none)'
if (Test-Path (Join-Path $Dest 'package.json')) {
  $oldVer = ([System.IO.File]::ReadAllText((Join-Path $Dest 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version
  $oldBackup = "$Dest.bak-$ScopeStamp"
  Move-Item $Dest $oldBackup -Force
  Write-Host "[3/6] 旧实体 v$oldVer 已挪走 -> $oldBackup"
} else {
  Write-Host "[3/6] 无旧实体，全新安装"
}

# ---- 展开 tarball 到 node_modules/<name>/ ----
Write-Host "[4/6] 展开 tarball..."
New-Item -ItemType Directory -Force -Path $ScopeDir | Out-Null
$stage = Join-Path $ScopeDir "project-nav.stage-$ScopeStamp"
New-Item -ItemType Directory -Force -Path $stage | Out-Null
& tar -xzf $Tgz -C $stage
if ($LASTEXITCODE -ne 0) { Fail "tar 解包失败（退出码 $LASTEXITCODE）" }
$inner = Join-Path $stage 'package'
if (-not (Test-Path $inner)) { Fail "tarball 结构异常：找不到 package/ 目录" }
Move-Item $inner $Dest -Force
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
Write-Host "[5/6] 实体已就位 -> $Dest"

# ---- 改声明（只改那一行，不整组重写；无 BOM 写回） ----
$text = [System.IO.File]::ReadAllText($ProfilePkg, [System.Text.Encoding]::UTF8)
$m = [regex]::Match($text, '"@dsh-external/project-nav"\s*:\s*"[^"]*"')
if (-not $m.Success) { Fail '声明里找不到 @dsh-external/project-nav 依赖项' }
$newLine = '"@dsh-external/project-nav": "' + $WantDecl + '"'
if ($m.Value -ne $newLine) {
  $text2 = $text.Remove($m.Index, $m.Length).Insert($m.Index, $newLine)
  [System.IO.File]::WriteAllText($ProfilePkg, $text2, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[6/6] 声明已改 -> $WantDecl"
} else { Write-Host "[6/6] 声明已是 v$WantVer" }

# ---- 自证（不靠"命令没报错"） ----
if (-not (Test-Path (Join-Path $Dest 'package.json'))) { Fail "实体未生成: $Dest" }
$ip = [System.IO.File]::ReadAllText((Join-Path $Dest 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if ($ip.version -ne $WantVer) { Fail "实体版本 = $($ip.version)，不是 $WantVer" }

# 树 = 装：实体与仓库源码逐文件一致（进包文件）
$pkgFiles = @((Get-Content (Join-Path $RepoDir 'package.json') -Raw | ConvertFrom-Json).files)
$checked = 0
foreach ($top in $pkgFiles) {
  $src = Join-Path $RepoDir $top
  if (Test-Path $src -PathType Container) {
    foreach ($f in (Get-ChildItem $src -Recurse -File)) {
      $rel = $f.FullName.Substring($RepoDir.Length + 1)
      $dst = Join-Path $Dest $rel
      if (-not (Test-Path $dst)) { Fail "实体缺 $rel" }
      if ((Get-FileHash $f.FullName -Algorithm SHA256).Hash -ne (Get-FileHash $dst -Algorithm SHA256).Hash) { Fail "$rel 与仓库源码不一致（装错了产物？）" }
      $checked++
    }
  } else {
    $dst = Join-Path $Dest $top
    if (-not (Test-Path $dst)) { Fail "实体缺 $top" }
    if ((Get-FileHash $src -Algorithm SHA256).Hash -ne (Get-FileHash $dst -Algorithm SHA256).Hash) { Fail "$top 与仓库源码不一致" }
    $checked++
  }
}

Write-Host ''
Write-Host '=== 安装完成且自证通过 ===' -ForegroundColor Green
Write-Host "  旧版本 = $oldVer   ->   新版本 = $($ip.version)"
Write-Host "  树 = 装（$checked 个进包文件逐文件 SHA256 一致）= True"
Write-Host ''
Write-Host '下一步（只有你能做）：重启 dsh-web。重启前可再跑独立校验：'
Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File D:\FF\project-nav\verify-install.ps1'
Write-Host ''
Write-Host "回滚：Remove-Item -Recurse '$Dest'；Move-Item '$Dest.bak-$ScopeStamp' '$Dest'；Copy-Item '$pkgBackup' '$ProfilePkg' -Force"
