<#
  enable-sandbox-backend.ps1 — 让 DSH 的 Windows 沙箱后端可用（一次性、可回滚）

  背景：dsh-web 现以 LocalSystem 运行，其令牌没有 logon SID，导致
  dsh-sandbox-windows-acl 的 CreateRestrictedToken 前置条件不满足：
      "CreateRestrictedToken prerequisite failed: no logon SID found among 4 token groups"
  后果：会话一旦绑定 workspace-write，pwsh 直接 fail-closed（拒绝执行）。
  修法：让 dsh-web 以真实用户账户运行（该账户的登录会话自带 logon SID）。

  为什么需要你亲自跑：
    * 切换服务账户需要该账户的密码 —— agent 不代持密码。
    * 脚本会重启 dsh-web，而 agent 就运行在那个进程里，自行重启会中断自身。

  用法（**以管理员身份**打开 PowerShell）：
      powershell -ExecutionPolicy Bypass -File D:\FF\project-nav\docs\enable-sandbox-backend.ps1
#>

[CmdletBinding()]
param(
  [string]$Service   = 'dsh-web',
  [string]$Account   = "$env:COMPUTERNAME\lk",
  [string]$Nssm      = 'D:\lk\tools\nssm\nssm.exe',
  [int]   $Port      = 3080,
  [switch]$NoRestart,
  [switch]$Rollback
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $env:USERPROFILE ".dsh\backups\sandbox-backend-$stamp"
$regBackup = Join-Path $backupDir "$Service-service.reg"
$infBackup = Join-Path $backupDir 'user-rights-export.inf'

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)       { Write-Host "    PASS  $msg" -ForegroundColor Green }
function Warn($msg)     { Write-Host "    WARN  $msg" -ForegroundColor Yellow }
function Die($msg)      { Write-Host "`n    FAIL  $msg" -ForegroundColor Red; exit 1 }

function Wait-State([string]$want, [int]$timeoutSec = 60) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  do {
    $s = (Get-Service -Name $Service -ErrorAction SilentlyContinue).Status
    if ("$s" -eq $want) { return $true }
    Start-Sleep -Milliseconds 700
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Restore-Service([string]$why) {
  Warn "回滚中（$why）"
  if (Test-Path $regBackup) {
    & reg.exe import $regBackup | Out-Null
    Ok "服务注册表已从备份还原：$regBackup"
  } else { Warn "没有注册表备份，无法自动回滚账户设置" }
  if ((Get-Service -Name $Service -ErrorAction SilentlyContinue).Status -ne 'Running') {
    & sc.exe start $Service | Out-Null
    if (Wait-State 'Running' 45) { Ok "服务已重新启动" } else { Warn "服务仍未启动，请检查 nssm 日志" }
  }
  Write-Host "`n已完成回滚。下一步：检查 $backupDir 并在需要时手工介入。" -ForegroundColor Yellow
  exit 1
}

# ---------------------------------------------------------------- 0. 前置
Step 0 '前置检查'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Die '需要管理员权限。请以管理员身份打开 PowerShell 后重跑。'
}
Ok '以管理员身份运行'
if (-not (Test-Path $Nssm)) { Die "找不到 nssm：$Nssm（用 -Nssm 指定正确路径）" }
$acctSid = (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
Ok "目标账户 $Account (SID $acctSid) 可解析"

# ---------------------------------------------------------------- 1. 备份
Step 1 '备份（可回滚的前提）'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
& reg.exe export "HKLM\SYSTEM\CurrentControlSet\Services\$Service" $regBackup /y | Out-Null
if (-not (Test-Path $regBackup)) { Die '注册表导出失败' }
Ok "服务注册表 -> $regBackup"
$infTmp = Join-Path $env:TEMP "userrights-$stamp.inf"
& secedit /export /areas USER_RIGHTS /cfg $infTmp | Out-Null
Copy-Item $infTmp $infBackup -Force
Ok "用户权限策略导出 -> $infBackup"

# ---------------------------------------------------------------- 2. 回滚模式
if ($Rollback) {
  Step 2 '回滚模式'
  & reg.exe import $regBackup | Out-Null
  Ok '服务账户已还原'
  & sc.exe stop $Service | Out-Null; [void](Wait-State 'Stopped' 45)
  & sc.exe start $Service | Out-Null
  if (Wait-State 'Running' 60) { Ok '服务已重启' } else { Warn '服务未启动，请检查 nssm 日志' }
  exit 0
}

# ---------------------------------------------------------------- 3. 切换账户
Step 2 "切换服务账户 -> $Account"
$before = (& sc.exe qc $Service | Select-String 'SERVICE_START_NAME').ToString().Trim()
Write-Host "    当前: $before"

$sec = Read-Host -Prompt "    请输入 $Account 的密码（输入不回显，仅传给 nssm）" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  if ([string]::IsNullOrEmpty($plain)) { Die '密码为空，已中止（未做任何修改）' }
  & $Nssm set $Service ObjectName $Account $plain | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "nssm set 失败（exit $LASTEXITCODE）" }
} finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  $plain = $null
  $sec = $null
}
$after = (& sc.exe qc $Service | Select-String 'SERVICE_START_NAME').ToString().Trim()
Write-Host "    之后: $after"
if ($after -notmatch [regex]::Escape($Account)) { Restore-Service '服务账户未按预期写入' }
Ok '服务账户已写入'

# ---------------------------------------------------------------- 4. 服务登录权限
Step 3 '检查「作为服务登录」权限'
function Get-LogonRightSids {
  $f = Join-Path $env:TEMP "ur-check-$stamp.inf"
  & secedit /export /areas USER_RIGHTS /cfg $f | Out-Null
  $line = (Get-Content $f -Encoding Unicode | Select-String '^SeServiceLogonRight').Line
  Remove-Item $f -Force -ErrorAction SilentlyContinue
  if (-not $line) { return @() }
  return @(($line -split '=', 2)[1].Trim() -split '\s*,\s*' | Where-Object { $_ })
}
$sids = Get-LogonRightSids
if ($sids -contains "*$acctSid") {
  Ok "$Account 已具备该权限（nssm 已处理）"
} else {
  Warn "$Account 尚不具备该权限 -> 现在补授（仅增量追加，基于本次导出的策略）"
  $inf = $infTmp
  $content = Get-Content $inf -Encoding Unicode
  $patched = foreach ($l in $content) {
    if ($l -match '^SeServiceLogonRight') {
      if ($l.Trim() -match '=\s*$') { "$l*$acctSid" } else { "$l,*$acctSid" }
    } else { $l }
  }
  $patched | Set-Content -Path $inf -Encoding Unicode
  & secedit /configure /db (Join-Path $env:TEMP "secedit-$stamp.sdb") /cfg $inf /areas USER_RIGHTS | Out-Null
  if ($LASTEXITCODE -ne 0) { Restore-Service '用户权限策略应用失败' }
  $sids2 = Get-LogonRightSids
  if ($sids2 -contains "*$acctSid") { Ok '权限已授予' }
  else { Restore-Service '权限授予后仍未生效' }
}

# ---------------------------------------------------------------- 5. 重启
if ($NoRestart) {
  Step 4 '重启（已按 -NoRestart 跳过）'
  Warn "手工重启：sc.exe stop $Service ; sc.exe start $Service"
  Write-Host "`n完成（未重启）。重启后运行下面的验证。" -ForegroundColor Yellow
  exit 0
}
Step 4 '重启服务'
& sc.exe stop $Service | Out-Null
if (-not (Wait-State 'Stopped' 90)) { Restore-Service '服务未能在 90 秒内停止' }
Ok '已停止'
& sc.exe start $Service | Out-Null
if (-not (Wait-State 'Running' 90)) { Restore-Service '服务未能启动（账户/密码/权限问题）' }
Ok '已启动'

# ---------------------------------------------------------------- 6. 就绪
Step 5 '等待端口就绪并取新 token'
$deadline = (Get-Date).AddSeconds(90)
$listening = $false
while ((Get-Date) -lt $deadline) {
  if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { $listening = $true; break }
  Start-Sleep -Milliseconds 700
}
if ($listening) { Ok "端口 $Port 正在监听" } else { Warn "端口 $Port 尚未监听，请看 nssm 日志" }

# nssm 的控制台输出是 UTF-16，`nssm get` 抓回来会变成带空格的乱码；从注册表读才是干净字符串。
$outLog = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$Service" -Name AppStdout -ErrorAction SilentlyContinue).AppStdout
if (-not $outLog) { $outLog = Join-Path (Split-Path -Parent $Nssm) "logs\$Service-out.log" }
if (Test-Path $outLog) {
  try {
    # 服务正在写这个文件：用共享读，别用独占打开。
    $fs = [System.IO.File]::Open($outLog, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $sr = New-Object System.IO.StreamReader($fs)
    $tail = $sr.ReadToEnd()
    $sr.Close(); $fs.Close()
    $m = [regex]::Matches($tail, 'http://127\.0\.0\.1:\d+/\?token=\S+')
    if ($m.Count -gt 0) { Write-Host "    新访问地址: $($m[$m.Count - 1].Value)" -ForegroundColor Green }
    else { Warn "日志里暂时没有 token URL，稍后手工查看：$outLog" }
  } catch { Warn "读取日志失败（$($_.Exception.Message)）：$outLog" }
} else { Warn "日志不存在：$outLog" }

$summary = @"

==================== 接下来验证（实证，不看「应该好了」）====================
1) 服务身份
     sc.exe qc $Service | Select-String SERVICE_START_NAME     # 期望 $Account

2) 后端真的能用（在任意 DSH 会话里）
     /permission workspace-write
     Get-Date
   * 修复前：sandbox mode "workspace-write" is requested but no sandbox backend is usable
   * 修复后：命令正常执行  <-- 这就是 PASS 判据
   * 验完切回：/permission danger-full-access

3) 边界真的在拦（同样在受限会话里）
     Set-Content D:\FF\project-nav\.probe.tmp ok      # 工作区内，应成功
     Set-Content D:\FF\__probe.tmp bad                # 工作区外，应被拒

回滚：powershell -ExecutionPolicy Bypass -File $PSCommandPath -Rollback
备份：$backupDir
==========================================================================
"@
Write-Host $summary -ForegroundColor Cyan
