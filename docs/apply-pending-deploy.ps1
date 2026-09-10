<#
  apply-pending-deploy.ps1 — 把已打包好的 project-nav 新版本装进 profile，并推送本地提交。

  为什么需要这个脚本（2026-09-11 实测）：
    * 被治理会话（DSH file policy = workspace-write）**写不了** ~/.dsh/profiles/web
      （锁文件 / 依赖声明 / 安装副本都在会话工作区之外）→ EPERM。
    * 同一个会话里 **git push 也过不去**：HTTPS 走 schannel 报
      SEC_E_NO_CREDENTIALS；换 http.sslBackend=openssl 后 TLS 通了，但凭据助手与传输
      子进程都需要 piped-stdio 的 msys 子进程（sh.exe / ssh.exe: couldn't create
      signal pipe, Win32 error 5）。
  在**你自己登录的、未被治理的**窗口里，这两步都正常 —— 本脚本就是把它们串起来。

  用法（普通 PowerShell 窗口即可，无需管理员）：
      powershell -ExecutionPolicy Bypass -File D:\FF\project-nav\docs\apply-pending-deploy.ps1
  选项：
      -Old 0.8.5 -New 0.8.6     指定版本对（缺省即此）
      -NoInstall                只推送，不安装
      -NoPush                   只安装，不推送
  装完记得**重启一次 dsh-web**，新代码才会被加载（Node 按 URL 缓存模块，换副本不重载）。
#>

[CmdletBinding()]
param(
  [string]$Old = '0.8.5',
  [string]$New = '0.8.6',
  [switch]$NoInstall,
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'

$repo = 'D:\FF\project-nav'
$node = 'D:\lk\hermes\0.20.0\win-x64\node\node.exe'
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$dest = Join-Path $profileDir 'node_modules\@dsh-external\project-nav'
$tgz  = Join-Path $repo "dsh-external-project-nav-$New.tgz"

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    PASS  $m" -ForegroundColor Green }
function Die($m)  { Write-Host "`n    FAIL  $m" -ForegroundColor Red; exit 1 }

Step "前置检查"
if (-not (Test-Path $node)) { Die "node 不存在：$node" }
if (-not (Test-Path $dest)) { Die "安装副本目录不存在：$dest" }
Ok "node / 安装副本都在位（$New 的 tgz：$(Test-Path $tgz)）"

if (-not $NoInstall) {
  if (-not (Test-Path $tgz)) { Die "缺少 tgz：$tgz（先 `npm pack --cache <工作区内目录>`）" }

  Step "① 三处对齐（锁文件 + profile 依赖 + 安装副本）"
  & $node (Join-Path $repo 'docs\install-into-profile.cjs') $Old $New
  if ($LASTEXITCODE -ne 0) { Die "install-into-profile.cjs 失败（exit $LASTEXITCODE）" }
  Ok "install-into-profile.cjs 完成"

  Step "② 覆盖安装副本"
  & tar -xzf $tgz -C $dest --strip-components=1
  if ($LASTEXITCODE -ne 0) { Die "tar 解包失败（exit $LASTEXITCODE）" }
  Ok "tar 解包完成"

  Step "③ 逐字节核验（工作树 vs 安装副本）"
  foreach ($f in 'host\index.js', 'shared\index.js', 'package.json') {
    $a = (Get-FileHash (Join-Path $repo $f) -Algorithm SHA256).Hash
    $b = (Get-FileHash (Join-Path $dest $f) -Algorithm SHA256).Hash
    if ($a -ne $b) { Die "$f 不一致（工作树 $($a.Substring(0,12))… vs 副本 $($b.Substring(0,12))…）" }
    Ok "$f MATCH"
  }
  $dep = (Select-String -Path (Join-Path $profileDir 'package.json') -Pattern "project-nav-$New").Count
  if ($dep -lt 1) { Die "profile 依赖未指向 $New" }
  Ok "profile 依赖已指向 $New —— 重启 dsh-web 后生效"
}

if (-not $NoPush) {
  Step "④ 推送本地提交"
  Push-Location $repo
  try {
    $ahead = (git log --oneline origin/main..HEAD | Measure-Object).Count
    Write-Host "    待推送：$ahead 个提交"
    if ($ahead -eq 0) { Ok "已与 origin/main 同步，无需推送" }
    else {
      & git push origin main
      if ($LASTEXITCODE -ne 0) { Die "git push 失败（exit $LASTEXITCODE）—— 若为凭据问题，请在交互式窗口重试以便弹出凭据提示" }
      $left = (git log --oneline origin/main..HEAD | Measure-Object).Count
      if ($left -ne 0) { Die "推送后仍领先 $left 个提交" }
      Ok "推送完成，已与 origin/main 同步"
    }
  } finally { Pop-Location }
}

Write-Host "`n全部完成。若安装了新版本，请重启 dsh-web 使其加载。" -ForegroundColor Green
