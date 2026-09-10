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

$sec  = Read-Host -Prompt "    请输入 $Account 的密码（输入不回显）" -AsSecureString
$sec2 = Read-Host -Prompt "    再输一次以确认" -AsSecureString
function ConvertFrom-Sec([Security.SecureString]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringAuto($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
$plain = ConvertFrom-Sec $sec
$plain2 = ConvertFrom-Sec $sec2
$sec = $null; $sec2 = $null
if ($plain -cne $plain2) { Die '两次输入不一致 —— 已中止，未做任何修改' }

# Verify the credential BEFORE touching the service. SCM performs a SERVICE logon, so test exactly
# that with LogonUser(LOGON32_LOGON_SERVICE): a wrong password then fails here, cleanly, instead of
# setting the account and discovering it at service start (which the event log reports as
# "The user name or password is incorrect" after a pointless rollback cycle).
if (-not ('LsaLogonCheck' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LsaLogonCheck {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool LogonUser(string user, string domain, string password, int logonType, int logonProvider, out IntPtr token);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  public static int ServiceLogon(string domain, string user, string password) {
    IntPtr token;
    bool ok = LogonUser(user, domain, password, 5 /* LOGON32_LOGON_SERVICE */, 0 /* DEFAULT */, out token);
    if (ok) { CloseHandle(token); return 0; }
    return Marshal.GetLastWin32Error();
  }
}
'@
}
$dom = if ($Account -match '\\') { ($Account -split '\\')[0] } else { $env:COMPUTERNAME }
if ($dom -eq '.') { $dom = $env:COMPUTERNAME }
$user = ($Account -split '\\')[-1]
$err = [LsaLogonCheck]::ServiceLogon($dom, $user, $plain)
if ($err -ne 0) {
  $hint = switch ($err) {
    1326 { '用户名或密码不正确。常见原因：你用 Windows Hello 的 PIN 登录，而 PIN ≠ 账户密码；微软账户请用账户密码。' }
    1327 { '账户受限 —— 典型原因是空密码账户默认禁止用于服务登录。' }
    1385 { '该账户没有「作为服务登录」权限。' }
    1331 { '账户已被禁用。' }
    1907 { '该账户需要先修改密码才能登录。' }
    default { "Win32 错误码 $err" }
  }
  $plain = $null; $plain2 = $null
  Write-Host ""
  Write-Host "    FAIL  凭据校验失败（服务登录被拒）：$hint" -ForegroundColor Red
  Write-Host "    未做任何修改 —— 服务仍在 $before 下运行。请用正确的账户密码重跑。" -ForegroundColor Yellow
  exit 1
}
Ok '凭据校验通过（LOGON32_LOGON_SERVICE 成功）'

& $Nssm set $Service ObjectName $Account $plain | Out-Null
if ($LASTEXITCODE -ne 0) { Die "nssm set 失败（exit $LASTEXITCODE）" }
$plain = $null; $plain2 = $null
$after = (& sc.exe qc $Service | Select-String 'SERVICE_START_NAME').ToString().Trim()
Write-Host "    之后: $after"
# Compare the ACCOUNT NAME only. SCM normalises the reference — it reports `.\lk` for a local
# account even when `MACHINE\lk` was set — so matching the full spelling is a FALSE NEGATIVE.
# That is exactly what made this script roll back a perfectly good account change once.
$acctName = ($Account -split '\\')[-1]
$afterName = ($after -split '\\')[-1]
if ($afterName.Trim().ToLower() -ne $acctName.Trim().ToLower()) { Restore-Service "服务账户未按预期写入（读到 '$afterName'，期望 '$acctName'）" }
Ok "服务账户已写入（SCM 回显 '$afterName'）"

# ---------------------------------------------------------------- 4. 服务登录权限
Step 3 '检查「作为服务登录」权限'
# secedit stores a right's holders EITHER as `*S-1-5-...` or as a plain ACCOUNT NAME (`lk`), so
# comparing the raw text against a SID string is a FALSE NEGATIVE -- which is exactly what made
# this script roll back twice on a host where the right was already present. Resolve every entry
# to a SID and compare those.
function Resolve-RightEntry([string]$e) {
  $t = $e.Trim()
  if (-not $t) { return $null }
  if ($t.StartsWith('*')) { return $t.Substring(1) }
  try { return (New-Object Security.Principal.NTAccount($t)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { return $null }
}
function Test-ServiceLogonRight([string]$sid) {
  $f = Join-Path $env:TEMP "ur-check-$stamp.inf"
  & secedit /export /areas USER_RIGHTS /cfg $f *> $null   # never pipe: $LASTEXITCODE must stay secedit's
  $line = (Get-Content $f -Encoding Unicode | Select-String '^SeServiceLogonRight').Line
  Remove-Item $f -Force -ErrorAction SilentlyContinue
  if (-not $line) { return $false }
  foreach ($e in (($line -split '=', 2)[1]).Split(',')) {
    if ((Resolve-RightEntry $e) -eq $sid) { return $true }
  }
  return $false
}
# Additive grant through the LSA API. Deliberately NOT a secedit INF round-trip: applying the
# whole USER_RIGHTS area rewrites every line, and an entry this host cannot resolve (as an orphan
# localized name here) is silently dropped by that rewrite.
if (-not ('LsaRight' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LsaRight {
  [StructLayout(LayoutKind.Sequential)] private struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] private struct LSA_OBJECT_ATTRIBUTES {
    public int Length; public IntPtr RootDirectory; public IntPtr ObjectName;
    public int Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService;
  }
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint LsaOpenPolicy(IntPtr SystemName, ref LSA_OBJECT_ATTRIBUTES ObjectAttributes, uint DesiredAccess, out IntPtr PolicyHandle);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint LsaAddAccountRights(IntPtr PolicyHandle, byte[] AccountSid, LSA_UNICODE_STRING[] UserRights, uint CountOfRights);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint LsaClose(IntPtr PolicyHandle);
  public static void Add(string account, string right) {
    var sid = new System.Security.Principal.NTAccount(account).Translate(typeof(System.Security.Principal.SecurityIdentifier)) as System.Security.Principal.SecurityIdentifier;
    if (sid == null) throw new Exception("cannot resolve account: " + account);
    byte[] bytes = new byte[sid.BinaryLength];
    sid.GetBinaryForm(bytes, 0);
    var oa = new LSA_OBJECT_ATTRIBUTES();
    oa.Length = Marshal.SizeOf(typeof(LSA_OBJECT_ATTRIBUTES));
    IntPtr policy;
    uint st = LsaOpenPolicy(IntPtr.Zero, ref oa, 0x000F0FFF, out policy);
    if (st != 0) throw new Exception("LsaOpenPolicy NTSTATUS 0x" + st.ToString("X8"));
    var rights = new LSA_UNICODE_STRING[1];
    rights[0].Buffer = Marshal.StringToHGlobalUni(right);
    rights[0].Length = (ushort)(right.Length * 2);
    rights[0].MaximumLength = (ushort)((right.Length + 1) * 2);
    try {
      uint st2 = LsaAddAccountRights(policy, bytes, rights, 1);
      if (st2 != 0) throw new Exception("LsaAddAccountRights NTSTATUS 0x" + st2.ToString("X8"));
    } finally { Marshal.FreeHGlobal(rights[0].Buffer); LsaClose(policy); }
  }
}
'@
}
if (Test-ServiceLogonRight $acctSid) {
  Ok "$Account 已具备该权限（检测按账户名/SID 双向解析）"
} else {
  Warn "$Account 缺少该权限 -> 用 LSA API 增量补授（不重写整片策略）"
  try { [LsaRight]::Add($Account, 'SeServiceLogonRight') }
  catch { Restore-Service "补授失败：$($_.Exception.Message)" }
  if (Test-ServiceLogonRight $acctSid) { Ok '权限已授予' } else { Restore-Service '补授后仍未生效' }
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
     sc.exe qc $Service | Select-String SERVICE_START_NAME     # 期望回显 .\lk（SCM 会规范化账户写法）

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
