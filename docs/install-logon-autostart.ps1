<#
  install-logon-autostart.ps1 — 在没有 nssm 的前提下，用「登录自启」交互式计划任务
  恢复 dsh-web(3080) 与 bge-embed(9915) 的自启。

  背景（2026-09-11）：nssm 及其全部服务被卸载后，DSH 网页与本地 bge-m3 嵌入后端
  都失去了自启。而 dsh-web 必须以 lk 的**登录会话**身份运行 —— 沙箱后端
  （dsh-sandbox-windows-acl）构造受限令牌时需要令牌里带 logon SID，服务账户 /
  LocalSystem 的令牌天然没有（实测：`no logon SID found among 4 token groups`）。
  登录时触发的 `/it` 任务给的正是这种带 logon SID 的交互式令牌，且**不需要账户密码**
  （密码路线已实测走不通：Windows Hello PIN ≠ 账户密码，系统日志 id 7038）。

  为什么不用最高权限（/rl highest）：不需要。当前手工启动的实例是标准（已过滤）令牌，
  受限令牌 runner 实测照样 PASS；少给权限反而更稳。

  用法（**需要管理员**：`schtasks /create /sc onlogon` 非管理员实测 Access is denied）：
      powershell -ExecutionPolicy Bypass -File D:\FF\project-nav\docs\install-logon-autostart.ps1

  只装一个：  ... -Only web      或   ... -Only embed
  卸载：      ... -Remove          （卸载同样需要管理员）
  立即触发（不等下次登录）：
      schtasks /run /tn dsh-web-user
      schtasks /run /tn dsh-bge-embed-user

  注意：任务只在**登录时**触发。若届时端口已被手工启动的实例占用，新实例会绑定失败
  （EADDRINUSE）并退出，不会破坏已运行的那个。
#>

[CmdletBinding()]
param(
  [ValidateSet('both', 'web', 'embed')]
  [string]$Only = 'both',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
# 本文件含中文 → 必须 UTF-8 **带 BOM**（PS 读无 BOM 脚本会按 ANSI/GBK 猜编码，实测会把
# 中文字符尾字节吃成引号 → "字符串未终止"）。改完务必复核首三字节 = EF BB BF。
if ($PSVersionTable.PSVersion.Major -ge 7) { $PSNativeCommandUseErrorActionPreference = $false }

$tasks = [ordered]@{
  web   = @{ Name = 'dsh-web-user';       Cmd = 'D:\lk\tools\dsh-web.cmd';   Port = 3080; Label = 'DSH 网页（dsh-web）' }
  embed = @{ Name = 'dsh-bge-embed-user'; Cmd = 'D:\lk\tools\bge-embed.cmd'; Port = 9915; Label = '记忆嵌入后端（bge-m3 / DirectML GPU）' }
}

$want = switch ($Only) { 'web' { @('web') } 'embed' { @('embed') } default { @('web', 'embed') } }
$Account = "$env:COMPUTERNAME\$env:USERNAME"

function Ok($m)   { Write-Host "    PASS  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    WARN  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "`n    FAIL  $m" -ForegroundColor Red; exit 1 }

function Listening([int]$p) { [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) }

# 原生命令统一走本包装。PS 5.1 的坑：$ErrorActionPreference='Stop' 时，原生命令写 stderr
# 会被当成**终止错误**（连 `*> $null` 都压不住，实测脚本在 FAIL 分支前就中断）→ 这里局部
# 降为 Continue，退出码与输出由调用方自己判。
function Invoke-Schtasks {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Argv)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & schtasks @Argv 2>&1
    [pscustomobject]@{ Exit = $LASTEXITCODE; Out = ($out | Out-String) }
  } finally { $ErrorActionPreference = $prev }
}
function TaskExists([string]$n) { (Invoke-Schtasks /query /tn $n).Exit -eq 0 }

$isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "`n=== 登录自启安装 ===  account=$Account  admin=$isAdmin  only=$Only  remove=$Remove" -ForegroundColor Cyan

if ($Remove) {
  $failed = $false
  foreach ($k in $want) {
    $t = $tasks[$k]
    if (-not (TaskExists $t.Name)) { Warn "任务 $($t.Name) 不存在，跳过"; continue }
    $r = Invoke-Schtasks /delete /tn $t.Name /f
    if ($r.Exit -ne 0 -or (TaskExists $t.Name)) { Write-Host "    FAIL  删除 $($t.Name) 失败：$($r.Out.Trim())" -ForegroundColor Red; $failed = $true; continue }
    Ok "已删除任务 $($t.Name)"
  }
  if ($failed) { Die '有任务未能删除（多半是权限）——请以管理员重跑 -Remove' }
  Write-Host "`n回滚完成 —— 之后需手动启动：D:\lk\tools\dsh-web.cmd / bge-embed.cmd" -ForegroundColor Yellow
  exit 0
}

# ---- 前置：启动件必须在位 ----
foreach ($k in $want) {
  $t = $tasks[$k]
  if (-not (Test-Path $t.Cmd)) { Die "启动件不存在：$($t.Cmd)" }
  Ok "启动件在位：$($t.Cmd)"
}

# ---- 建任务 ----
$created = @()
foreach ($k in $want) {
  $t = $tasks[$k]
  $tr = "cmd /c $($t.Cmd)"
  $r = Invoke-Schtasks /create /tn $t.Name /tr $tr /sc onlogon /ru $Account /it /f
  if ($r.Exit -ne 0 -or -not (TaskExists $t.Name)) {
    Write-Host "`n    FAIL  创建 $($t.Name) 失败（exit $($r.Exit)）：$($r.Out.Trim())" -ForegroundColor Red
    if (-not $isAdmin) {
      Write-Host "    原因：非管理员。schtasks /create /sc onlogon 需要提权。请以管理员重跑：" -ForegroundColor Yellow
      Write-Host "      Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$PSCommandPath'" -ForegroundColor Yellow
    }
    if ($created.Count) { Write-Host "    （已创建的任务保留：$($created -join ', ')；可 -Remove 回滚）" -ForegroundColor Yellow }
    exit 1
  }
  $created += $t.Name
  Ok "任务已创建：$($t.Name)  ->  $tr"
}

# ---- 复核（实证，不看"应该建好了"）----
# 注意：`schtasks /query /fo list` 的字段名是**本地化**的（中文为 状态:/下次运行时间:/
# 作为用户运行:），按英文正则解析只会拿到 ?（实测）。故优先用 Get-ScheduledTask 的
# 结构化字段（与显示语言无关）。
Write-Host "`n=== 复核 ===" -ForegroundColor Cyan
foreach ($k in $want) {
  $t = $tasks[$k]
  $st = Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue
  if ($st) {
    $trg = ($st.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join '+'
    $act = ($st.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)".Trim() }) -join ' | '
    "    $($t.Name)  state=$($st.State)  logonType=$($st.Principal.LogonType)  runLevel=$($st.Principal.RunLevel)  user=$($st.Principal.UserId)  trigger=$trg  port=$($t.Port)"
    "    $(' ' * $t.Name.Length)  action=$act  [$($t.Label)]"
  } else {
    Warn "Get-ScheduledTask 查不到 $($t.Name) —— 原始输出："
    (Invoke-Schtasks /query /tn $t.Name /fo list /v).Out.Trim()
  }
  if (Listening $t.Port) { Warn "端口 $($t.Port) 当前已有实例在监听（本任务只在下次登录时触发，不会抢端口）" }
}

Write-Host @"

==================== 说明 ====================
- 只在**登录时**触发；重启电脑/注销再登录即自动拉起两个后端。
- 不等登录、想现在触发： schtasks /run /tn dsh-web-user   （embed 同理）
- 回滚： powershell -ExecutionPolicy Bypass -File "$PSCommandPath" -Remove
- 校验沙箱身份是否仍是 lk（这是当初必须脱离 LocalSystem 的原因）：
    (Get-CimInstance Win32_Process -Filter "ProcessId=(Get-NetTCPConnection -State Listen -LocalPort 3080).OwningProcess").GetOwner()
- 注意：任务与「手工双击 .cmd」是两条路，别同时用（后起的那个会 EADDRINUSE 退出）。
==============================================
"@ -ForegroundColor Cyan
