# Runbook · Windows 沙箱后端起不来 → 会话级工作区边界无法启用

> 记录日期：2026-09-11（本地）
> 触发场景：project-nav 要落地工作区边界（ADR-014 定稿：**单一机制** = DSH 原生会话沙箱），依赖把会话限制在 `workspace-write`。
> 结论（2026-09-11 二次更新）：**已修复** —— 根因确在宿主服务账户（不在插件）；最终出路不是"改服务账户"，而是**卸掉 nssm**、改以 `lk` 身份启动 `dsh-web`，后端随即 PASS。**先读 §0 的现行状态与实证**；§二/§三/§五/§七 保留为历史留档，其中一切"改服务账户 / `nssm remove` / `sc config` 恢复"的操作在新宿主形态下均已失效。
> 执行者：**用户**（agent 不碰宿主进程：不自重启、不改服务配置）

---

## 零、现行状态（2026-09-11 二次更新 · 已修复并实证）

**宿主形态（现行）**：nssm 服务已卸载（`sc query dsh-web` → `1060 不存在`），`dsh-web` 以 **lk 身份前台运行**：

```
D:\lk\tools\dsh-web.cmd        # 现唯一启动方式；无自启 —— 重启电脑/注销后需手动拉起
```

实测：3080 监听者 = `DESKTOP-97Q0S5H\lk`；agent 自己的 `whoami` 也已是 `desktop-97q0s5h\lk`（此前是 `nt authority\system`）。

**后端实证（决定门已开）**——直接用官方 runner 做探针（与插件就绪探针同形：`read-only`、零授权、零 ACL 变更）：

| 模式 | 命令（runner = `…\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js`，node = 宿主同款 `D:\lk\hermes\…\node.exe`） | 结果 |
|---|---|---|
| read-only | `--workspace D:\FF\project-nav --temp %TEMP% --mode read-only -- cmd /c "echo SANDBOX_PROBE_OK & whoami"` | **PASS**：`SANDBOX_PROBE_OK` / `desktop-97q0s5h\lk`，exit 0 |
| workspace-write | 同上改 `--mode workspace-write`（工作区 = 临时探针目录） | **PASS**：区内写成功；**区外写被拒**（`Access is denied.`），exit 0 |

> ⚠️ **判据只能跑 runner，不能看 `whoami`**：`.NET WindowsIdentity.Groups` 与 `whoami /groups` **都看不到** logon SID（`S-1-5-5-*`），但那**不等于令牌里没有** —— runner 的 `findLogonSid` 是按 token group 的 `SE_GROUP_LOGON_ID` **属性**取的（`types-DuU3lSVe.js:584-610`）；真没有才会打印 `windows-acl-run: CreateRestrictedToken prerequisite failed: no logon SID found among N token groups` 并退 127。**曾据 `whoami` 输出误判"令牌仍无 logon SID"，实为工具口径问题。**

**回归到边界**：前置门已开 → profile `cordis.patch.yml` 已写 `autoBindWorkspace: true` + `boundaryWorkspaces: 'project-nav'`（YAML 解析 + 插件 Config schema 双校验通过）。**重启 dsh-web** 后按本文 §四与 `plan-workspace-boundary-binding.md` §8 验收。

**已知缺口（nssm 卸载的后果，不属边界本身）**：

1. **自启已恢复（登录自启计划任务，2026-09-11 用户拍板）** —— nssm 卸载后 `dsh-web`(3080) 与 `bge-embed`(9915) 一度都失去自启；现由 `docs/install-logon-autostart.ps1` 建两个**交互式登录任务**：`dsh-web-user` / `dsh-bge-embed-user`（`LogonType=Interactive`、`RunLevel=Limited`、user=lk、trigger=登录时）。
   **验收走实证**：杀掉手工实例后 `schtasks /run /tn dsh-bge-embed-user` → 9915 在 ~4s 内复活（`provider=DmlExecutionProvider`、owner=lk）——**建了任务 ≠ 任务能拉起服务**，故以"任务真的把服务拉起来"为判据。手动启动件仍保留（`D:\lk\tools\dsh-web.cmd` / `bge-embed.cmd`），与任务**二选一**，别同时用（后起的会 EADDRINUSE 退出）。
2. **连带损伤：`dsh-bge-embed`（`127.0.0.1:9915`，守藏记忆的本地 bge-m3 向量后端）随 nssm 一起消失** —— 该服务原为 `nssm AUTO_START`，卸载后 9915 无监听，记忆 **dense 召回静默退化为纯词法**（`scheduler.ts` 里 `embedBaseUrl` 仍指 9915）。**已恢复并实证**：新建启动件 `D:\lk\tools\bge-embed.cmd`（与 `dsh-web.cmd` 同一约定，ASCII-only；无 nssm、无自启），
   ```
   D:\AI\venv-bge\Scripts\python.exe D:\lk\deepseek\tools\bge-m3-openai-server-gpu.py D:\AI\models\bge-m3 1024 9915
   ```
   实测：`/health` → `provider=DmlExecutionProvider`（GPU）、`dims=1024`；批量 3 条 361ms；语义自检 `cos(排障要先取真因, debug 时先定位根因)=0.62` > `cos(…, 今天天气不错)=0.39`（**近义高于无关，鉴别力在**）。
   > 踩坑留痕：第一版自检用 PowerShell 管道取向量，`$r.data | % { $_.embedding }` 会把 1024 维数组**展平成标量流**，算出的余弦恒为 ±1.0（假数据）。**这类"看起来是模型的错"的结果，先怀疑测量代码**；换 node 直取 `data[i].embedding` 才可信。
3. **`switch-dsh-web-to-user.ps1` 作废** —— 它的前提（停用 nssm 服务）已不存在；其 onlogon 思路由 `install-logon-autostart.ps1` 按新形态落地。**并且不再需要最高权限**（`/rl highest`）：当前实例是标准（已过滤）令牌，受限令牌 runner 实测 PASS，故任务用 `Limited` —— 少给权限更稳。

**本次踩到的三个 Windows 坑（均实测，别再踩）**：

- **PS 5.1：`$ErrorActionPreference='Stop'` 会把原生命令写 stderr 当成终止错误** —— 连 `*> $null` 都压不住，脚本会在自己的 FAIL 分支之前就中断（非提权跑 `schtasks /create` 即复现：Access is denied 直接把脚本打死，连"需要提权"的提示都打不出来）。修法：原生命令统一走一个局部把 EAP 降为 `Continue` 的包装函数，退出码与输出自判。
- **`schtasks /query /fo list` 的字段名是本地化的**（中文为 状态:/下次运行时间:/作为用户运行:）→ 按英文正则解析恒得 `?`。要机器可读就走 `Get-ScheduledTask` 的结构化字段（与显示语言无关）。
- **从 harness 的 shell 里 `Start-Process -Verb RunAs` 会把该 shell 的作业对象带崩** —— 本次报 `subprocess-local: Windows Job runner exited with exit code 3221225786`（`0xC000013A` = Ctrl+C 退出码），而**提权侧其实跑成功了**。做法：让提权进程把输出重定向到文件，父侧轮询该文件取结果，别指望同一个工具调用还能活着拿返回。

---

## 一、现象（实证）

给单个会话绑定 `sandbox/mode = workspace-write` 后（插件 append 事件，见 §四），任何 `pwsh` 调用直接拒跑：

```
Error: sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host;
refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux),
ensure sandbox-exec is usable (macOS), or ensure the ACL restricted-token runner can start (Windows) —
otherwise switch the consumer to danger-full-access.
Runner failure: windows-acl-run: CreateRestrictedToken prerequisite failed:
no logon SID found among 4 token groups
```

注意这是 **fail-closed**：命令被拒绝执行，而不是静默无沙箱放行（设计如此，是对的）。

同一会话下 fs 层**是生效的**：
- 写 `D:\FF\__boundary-probe.txt` → `[sandbox: file access denied under workspace-write mode]`
- 写 `C:\Users\lk\.dsh\tmp\...` → 放行（策略声明"平台临时区可写"）

即：**fs 层 OK，shell 层不可用** → 绑定 workspace-write 会让该会话失去全部 shell。

## 二、根因（源码 + 令牌双证据）

| 证据 | 内容 |
|---|---|
| 报错源 | `@deepseek-ai/dsh-sandbox-windows-acl/lib/types-DuU3lSVe.js:610` — `throw new Error('CreateRestrictedToken prerequisite failed: no logon SID found among ${groupCount} token groups')` |
| 该包的设计 | 同文件 676–679 行：受限令牌按 `[logon SID, EVERYONE]`（read-only）/ `+workspace SID (+temp SID)`（workspace-write）构造；**logon SID 是必需项**，缺失即抛 |
| 服务账户 | `sc qc dsh-web` → `SERVICE_START_NAME : LocalSystem` |
| 当前令牌 | `whoami` = `nt authority\system`；`whoami /groups` 恰好 **4 个组**（Administrators / Everyone / Authenticated Users / Mandatory Label），**无任何 `S-1-5-5-*`（Logon Session）SID** |

`4 token groups` 与实测组数完全对上。**logon SID 是登录会话产生的**（交互登录/服务登录时由 LSA 创建），LocalSystem 的内核令牌天然没有；Windows 没有"给 SYSTEM 补一个 logon SID"的开关。所以唯一出路是**让 dsh-web 以真实用户账户运行**。

## 三、修复步骤（用户执行 · 历史留档：改服务账户路线已废弃，见 §0）

> **最快路径**：以**管理员身份**运行随附脚本，它把下面 1–4 步全做了（含备份、权限补授、失败自动回滚、新 token 打印）：
> ```powershell
> powershell -ExecutionPolicy Bypass -File D:\FF\project-nav\docs\enable-sandbox-backend.ps1
> ```
> 下方的分步说明是它的等价手工版，供审计与排障。

### 0. 前置确认（已核实，无需重做）
- `DESKTOP-97Q0S5H\lk` 在 `Administrators` 组内（`Get-LocalGroupMember Administrators` 已确认）
- `lk` 是当前交互登录用户
- 关键路径属主为 `BUILTIN\Administrators`（`.dsh`、`.dsh\profiles\web`、`.dsh\sessions`、`D:\FF\.internal`、`D:\lk\tools\nssm`）→ lk 在组内，迁移后仍可读写
- ⚠️ **`lk` 目前并不具备"作为服务登录"权限**（`SeServiceLogonRight` 实测只授予了 `NT SERVICE\ALL SERVICES` / `NT VIRTUAL MACHINE\Virtual Machines` 等）。nssm 的 `set ObjectName` 通常会代为授予；若它没有，服务会因缺此权限而**起不来**——脚本会在切换后复查该权限并缺则补授。

### 1. 备份服务配置（可回滚的前提）
```powershell
reg export "HKLM\SYSTEM\CurrentControlSet\Services\dsh-web" "$env:USERPROFILE\.dsh\backups\dsh-web-svc-20260911.reg" /y
# 或： nssm dump dsh-web > "$env:USERPROFILE\.dsh\backups\dsh-web-dump-20260911.txt"
```
> 注意：nssm 控制台输出是 **UTF-16**，直接读会看到字符间空格；取路径/参数请**从注册表读**（`Get-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Services\dsh-web`），别解析 `nssm get` 的回显。

### 2. 切换服务账户
```powershell
# 需要该账户密码（agent 不代持密码，必须由你输入）
D:\lk\tools\nssm\nssm.exe set dsh-web ObjectName DESKTOP-97Q0S5H\lk <密码>
D:\lk\tools\nssm\nssm.exe set dsh-web ObjectName        # 回显确认
```
若报权限错误，先授予"作为服务登录"（secpol.msc → 本地策略 → 用户权限分配 → 作为服务登录 → 添加 `lk`）。

### 3. 重启服务（**用户手动**；agent 禁自重启）
```powershell
sc.exe stop dsh-web ; sc.exe query dsh-web      # 确认 STOPPED
sc.exe start dsh-web ; sc.exe query dsh-web     # 确认 RUNNING
```
重启后 token 会更新在 nssm out 日志尾（3080 URL + token 每次启动都新打）。

## 四、验证（必须实证，不看"应该好了"）

1. **账户已生效**
   ```powershell
   sc.exe qc dsh-web | Select-String SERVICE_START_NAME    # 期望：DESKTOP-97Q0S5H\lk
   (Get-CimInstance Win32_Process -Filter "Name='node.exe'").CommandLine
   ```
2. **runner 前置条件已满足**（核心验证，**不需要任何插件**）
   DSH 自带权限预设切换命令，直接在会话里执行：

   ```
   /permission workspace-write
   ```

   然后跑一条最简 shell：
   ```powershell
   Get-Date
   ```
   - 修复前：`sandbox mode "workspace-write" is requested but no sandbox backend is usable`
   - 修复后：**命令正常执行**（在受限模式下运行，而非拒跑）← 这就是 PASS 判据
   - 验完切回：`/permission danger-full-access`

   > 依据：`dsh-permission-presets` 注册了 `/permission <preset>` 命令，预设表中 `workspace-write` = `{ sandbox: 'workspace-write', approval: 'ask' }`；写入路径是往该会话日志 append `permission/preset` + `sandbox/mode`，因此**天然只影响当前会话**。
   > 这是**纯 harness 路径，不需要任何插件**——验证沙箱后端是否修好，用它就够了。
3. **边界真的在拦**
   ```powershell
   # 工作区内：应成功
   Set-Content D:\FF\project-nav\.probe.tmp ok
   # 工作区外：应被拒
   Set-Content D:\FF\__probe.tmp bad      # 期望 [sandbox: file access denied under workspace-write mode]
   ```
4. **回滚验证**：把会话模式 append 回 `danger-full-access`，确认 shell 与区外写恢复。

## 五、已知副作用与注意

1. **审批策略**：`workspace-write` 预设捆绑 `approval: 'ask'`。本部署 approval prompts 已禁用 → "更宽重试"（`sandbox_permissions` 升级）会**直接变成拒绝**。若要保留交互升级通道，需同时开启审批。
2. **属主迁移**：现有文件属主是 `BUILTIN\Administrators`。lk 在组内通常无碍；若真出现拒绝访问，对 `.dsh` 做一次 ACL/属主修正即可（**先判因再改，勿整组覆盖 ACL**）。
3. **不要用 `Set-Content -Encoding UTF8` 改任何 DSH 的 JSON/YAML 配置**（本环境会写 BOM），一律走 node `fs.writeFileSync` 或 .NET `UTF8Encoding($false)`。
4. **删服务用 `nssm remove dsh-web confirm`，不要 `sc delete`**；`AppEnvironmentExtra` 整体替换会清空既有环境变量。
5. **`enable-sandbox-backend.ps1` 必须保持 UTF-8 *带 BOM*。** 脚本含中文，而 PowerShell 读无 BOM 脚本时按 ANSI/GBK 猜编码，会把某个中文字符的尾字节吃成引号、导致"字符串未终止"——**实测：同一份内容按 UTF-8 解码 0 错误、按 GBK936 解码 7 错误**。改了它之后务必确认首三字节仍是 `EF BB BF`：
   ```powershell
   ([System.IO.File]::ReadAllBytes($p))[0..2] | ForEach-Object { $_.ToString('X2') }
   ```
   > 与本机既有的"JSON/YAML 一律不许有 BOM"恰好相反——**配置类无 BOM，含非 ASCII 的 .ps1 必须有 BOM**。

## 六、修好之后 project-nav 侧要做什么

**不在本文展开**——见 `docs/plan-workspace-boundary-binding.md`（ACT-033 落地方案，ADR-014 单机制）。

一句话交接：插件只做"覆盖判定 + 会话绑定"（命中被治理工作区的会话 → append `sandbox/mode=workspace-write`），边界/强制/升级/策略投影全部由 harness 原生沙箱承担。

**顺序上有一处强依赖**：本文 §四.2 的验证 PASS **必须早于**插件绑定上线——后端不可用时绑定会让新会话丧失全部 shell（fail-closed）。

## 七、密码走不通时的替代路径（2026-09-11 实机结论 · 历史留档：最终以"卸载 nssm + 前台以 lk 运行"落地，见 §0）

三次尝试切服务账户均失败于同一处：`nssm set ObjectName` 能写入，但服务启动被拒——

```
系统日志 id=7038  dsh-web 服务无法使用当前配置的密码以 .\lk 身份登录，
                 错误原因: The user name or password is incorrect.
系统日志 id=7000  The service did not start due to a logon failure.
```

即**账户密码不对**（常见原因：日常用 Windows Hello 的 PIN 登录，而 PIN ≠ 账户密码）。而"让服务以 lk 运行"**必然**需要那个密码 —— 没有密码时这条路是死的。

**可行替代：交互式计划任务（不需要密码）。** 原理：真实用户的**登录会话**自带 logon SID，而 `/it`（仅用户已登录时运行）任务不需要存储密码 —— 正好满足沙箱后端对令牌的要求。

```powershell
# 以管理员身份（lk 需已在交互登录）
powershell -ExecutionPolicy Bypass -File D:\FF\project-nav\docs\switch-dsh-web-to-user.ps1
# 回滚
powershell -ExecutionPolicy Bypass -File D:\FF\project-nav\docs\switch-dsh-web-to-user.ps1 -Rollback
```

脚本行为：备份服务注册表 → 生成 ASCII 包装 `.cmd`（复刻 nssm 的 `AppEnvironmentExtra` 与命令行）→ 建 `onlogon` + 最高权限 + `/it` 任务 → **停用**（不删除）nssm 服务 → 启动任务 → 等端口就绪 → **校验监听进程所有者确实是 lk** → 打印新 token；任一步失败自动恢复服务。

两条必须知道的约束：
1. **agent 无法自己启动该进程** —— agent 的子进程继承宿主（SYSTEM）令牌，仍然没有 logon SID。必须由"以 lk 身份"的机制启动。
2. **服务是停用而非删除**（`sc.exe config dsh-web start= auto` 即可恢复）；确认新方式稳定后，再按 nssm 删除规程 `nssm remove dsh-web confirm` 彻底移除。
