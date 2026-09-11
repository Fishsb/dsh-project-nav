# verify-0.9.0-install.ps1 — 独立校验 0.9.0 是否真的装上（**只读**，可在重启前跑）
#
# 为什么需要它：本仓历史上有"接口成功≠达成"的教训（假绿），
# 装插件至少要证四件事：产物指纹、声明、实体、装配副本内容。
# 任一条不过就红字退出 1。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File verify-0.9.0-install.ps1
#       ... -TgzSha256 <打包时记下的哈希>   ... -ProfileDir <别的 profile 路径>

param(
  [string]$TgzSha256 = '9A7FAF772CD2FC44299746B0EEEBE007DB0E8D41D35CA5F01D420FAF57644385',   # 打包时算的 SHA256
  [string]$ProfileDir = 'C:\Users\lk\.dsh\profiles\web'
)

$ErrorActionPreference = 'Continue'
$ok = $true

$ProfilePkg = Join-Path $ProfileDir 'package.json'
$Installed  = Join-Path $ProfileDir 'node_modules\@dsh-external\project-nav'
$Tgz        = 'D:\FF\project-nav\dsh-external-project-nav-0.9.0.tgz'

function Check($name, $cond, $detail) {
  if ($cond) { Write-Host ("  [PASS] {0} — {1}" -f $name, $detail) -ForegroundColor Green }
  else       { Write-Host ("  [FAIL] {0} — {1}" -f $name, $detail) -ForegroundColor Red; $script:ok = $false }
}

Write-Host '=== project-nav 0.9.0 安装校验（只读） ==='

# 1) 产物存在 + 即安装过的那一份（哈希不符 = 你手上的产物不是这次校验的目标）
if (Test-Path $Tgz) {
  $sha = (Get-FileHash $Tgz -Algorithm SHA256).Hash
  Check '产物存在' $true "$Tgz"
  Check '产物 SHA256 与预期一致' ($sha -eq $TgzSha256) "actual=$sha  expected=$TgzSha256"
} else {
  Check '产物存在' $false $Tgz
}

# 2) profile 声明
$decl = ''
if (Test-Path $ProfilePkg) {
  $j = [System.IO.File]::ReadAllText($ProfilePkg, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $decl = [string]$j.dependencies.'@dsh-external/project-nav'
  Check '声明指向 0.9.0' ($decl -like '*0.9.0*') "dependencies = $decl"
  Check 'bundles 列表仍含该包' ([bool]($j.dsh.profile.bundles -contains '@dsh-external/project-nav')) 'dsh.profile.bundles'
} else { Check 'profile package.json' $false '文件不存在' }

# 3) 安装实体身份（0.9.0 的特征：有 core/、没有 shared/）
if (Test-Path (Join-Path $Installed 'package.json')) {
  $ip = [System.IO.File]::ReadAllText((Join-Path $Installed 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  Check '实体版本 = 0.9.0' ($ip.version -eq '0.9.0') "已装版本 = $($ip.version)"
  Check '实体含 core/' (Test-Path (Join-Path $Installed 'core')) 'core/ 目录'
  Check '实体已无 shared/' (-not (Test-Path (Join-Path $Installed 'shared'))) 'shared/ 目录应已消失（0.9.0 用 core/）'
  Check '实体含 ARCHITECTURE.md' (Test-Path (Join-Path $Installed 'ARCHITECTURE.md')) '架构契约随包分发'
  # 4) 内容与仓库源码一致（防"声明新、实体旧"的静默退化）
  #    ⚠ 必须比对**全部** core/*.js + host/*，不能只比一个文件：
  #    只比 core/model.js 时，改在 core/legacy.js 里的修复会被漏掉 —— 校验器自己就成了假绿。
  $repoPkg = 'D:\FF\project-nav'
  $pairs = @()
  foreach ($d in 'core', 'host') {
    $srcDir = Join-Path $repoPkg $d
    if (-not (Test-Path $srcDir)) { continue }
    foreach ($f in Get-ChildItem $srcDir -File) {
      $pairs += , @{ rel = "$d\$($f.Name)"; inst = Join-Path $Installed "$d\$($f.Name)"; repo = $f.FullName }
    }
  }
  $diff = @()
  $missing = @()
  foreach ($p in $pairs) {
    if (-not (Test-Path $p.inst)) { $missing += $p.rel; continue }
    if ((Get-FileHash $p.inst -Algorithm SHA256).Hash -ne (Get-FileHash $p.repo -Algorithm SHA256).Hash) { $diff += $p.rel }
  }
  Check '实体不再缺文件' ($missing.Count -eq 0) $(if ($missing.Count) { "缺: $($missing -join ', ')" } else { "共 $($pairs.Count) 个源文件" })
  Check '实体与仓库源码逐字节一致（全部 core/host）' ($diff.Count -eq 0) $(if ($diff.Count) { "不一致 $($diff.Count) 个: $($diff -join ', ') —— 说明装的是旧一版 0.9.0，需重新安装" } else { "全部 $($pairs.Count) 个文件一致" })
} else { Check '安装实体存在' $false $Installed }

Write-Host ''
if ($ok) {
  Write-Host '结论：安装面全绿。剩余一步是**重启 dsh-web**（禁 agent 自行重启），重启后新会话才会加载 0.9.0。' -ForegroundColor Green
  Write-Host '重启后验证：新会话里应有 6 个工具 nav_graph/nav_commit/nav_decide/nav_node/nav_render/nav_set（旧版是 11 个）。'
  exit 0
} else {
  Write-Host '结论：有未通过项，**先别重启**。回滚：用 package.json.bak-* 覆盖回去，再 npm install。' -ForegroundColor Red
  exit 1
}
