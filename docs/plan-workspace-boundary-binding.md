# 落地方案 · ACT-033 工作区边界绑定（project-nav v0.8.1）

> 整理日期：2026-09-11（本地）
> 架构依据：**ADR-014**（现行，收敛 ADR-012/ADR-013）
> 状态（2026-09-11 01:00，v0.8.4）：机制链已完整并全部实证 —— **覆盖判定**（白名单 opt-in，空名单即惰性）、**能力判定**（只读探针，宿主不能强制就不绑）、**绑定**（`agent/session-start`，实测生效过）、**原生强制**（fs 边界实测拦截）。当前部署刻意保持**惰性**：profile 里 `autoBindWorkspace: false` 且白名单为空——因为本机沙箱后端**仍不可用**（`dsh-web` 仍 `LocalSystem`）。修好后端并验证 PASS 后，把白名单填上（如 `boundaryWorkspaces: 'project-nav'`）即可启用，探针会自行确认宿主真的能强制。事故经过与架构调整见 §12/§13 与 ADR-016。

---

## 0. 一句话

插件只做一件事：**判定会话工作区是否被本插件治理，命中则把该会话绑定到 harness 原生 `workspace-write`。**
边界、强制、审批升级、策略向 agent 的投影，全部由 harness 承担，插件不重复实现。

## 1. 架构依据（决策链，勿重复论证）

| ADR | 结论 | 现状 |
|---|---|---|
| ADR-012 | 提出"工作区边界层"，动作单位从治理根改为会话工作区 | 历史，其**分层模型不再实施** |
| ADR-013 | 提出"目标态（沙箱）/ 过渡态（逐调用闸门）两段" | 历史，其**过渡态不再实施** |
| **ADR-014** | 收敛为**单一机制 = harness 原生会话沙箱**；插件只做覆盖判定 + 绑定 | **现行** |

补充证据（已实证，不再重复验证）：
- 沙箱 fs 层强制真实生效：写工作区外 → `[sandbox: file access denied under workspace-write mode]`
- 沙箱**天然按会话隔离**：`sandbox/mode` 是某会话日志里的事件，边界取该会话自己的 cwd
- 插件可对调用方会话 append `sandbox/mode`，fold 立即生效（读回 `workspace-write`）
- 策略会自动投影进该会话的模型上下文（`Current DSH file policy: ...`）

## 2. 目标 / 非目标

**目标**：让"被本插件治理的工作区的会话"自动获得工作区边界；让"未被治理的工作区"完全不受影响。

**非目标（明确不做，避免重复投入）**：
逐调用 JS 闸门（`tools.guard` / `tools/pre-execute`）· shell 命令文本解析与语句级判定 · `fs/write-intent` 第二道闸 · 独立越界证据账本 · `off|observe|enforce` 多态开关 · 把技能当强制层 · 新增模块文件。

## 3. 前置依赖（硬约束）

**沙箱后端必须先在宿主侧修好，并通过验证。**

理由：绑定一旦生效，若后端不可用，`workspace-write` 对 shell 是 **fail-closed** —— 该会话**丧失全部 shell**（实测报错：`no sandbox backend is usable on this host`）。所以在后端验证 PASS **之前，不部署绑定**。

修复与验证见 `docs/runbook-sandbox-backend-windows.md`。验证走纯 harness 路径（`/permission workspace-write` + `Get-Date`），**不需要任何插件**。

## 4. 落点：4 个文件，0 新增

| 文件 | 改动 | 规模 |
|---|---|---|
| `shared/index.js` | 新增纯函数 `governedWorkspaceOf(index, rootPath, cwd)` → 返回该 cwd 所属的被治理工作区目录，未命中返回 `''` | ~15 行 |
| `host/index.js` | ① `apply()` 内注册 `agent/session-start` 监听并完成绑定；② `Config` 增 `autoBindWorkspace`（bool，默认 `true`） | ~25 行 |
| `test/core.test.mjs` | 覆盖判定三例（命中项目 / root 内未登记目录 / root 外） | ~15 行 |
| `package.json` | `0.8.0 → 0.8.1`（按 §36.3 每次 +0.0.1） | 1 行 |

不新增文件（原方案的 `shared/boundary.js` / `host/boundary.js` / `test/boundary.test.mjs` 全部取消）。

## 5. 契约与时序

**钩子**：`agent/session-start` —— 契约写明 "once before the first turn"，早于 agent 任何动作，每会话一次。

```
启动时（仅在允名单非空时才探）：
  probeBoundary(): shell.resolve({command:'exit 0', workdir: root, timeoutMs: 20000,
                    sandboxPolicy:{mode:'read-only', workspaceRoot: root}}) → shell.run(spec)
     ├─ sandbox.runnerFailed 或 exitCode ≠ 0 或抛错 → boundaryUsable = false
     └─ 否则 → true        （每插件实例只探一次；用 read-only 是因为 workspace-write
                            的 eager ACE 传播要遍历整棵工作区树，代价过高）

agent/session-start(payload)
  ├─ agent = payload.agent ; cwd = agent.session.header.cwd
  ├─ 无 cwd → 返回
  ├─ index = loadIndex(root)            ← 抛错则吞掉并返回（见下）
  ├─ zone = governedWorkspaceOf(index, root, cwd, Config.boundaryWorkspaces)
  ├─ zone 为空 → 返回（白名单外：零操作）
  ├─ boundaryUsable ≠ true → 触发探针并返回   ← 宿主不能强制就绝不绑定
  ├─ pol = ctx.get('sandboxPolicy')
  ├─ pol 不存在 → 返回
  ├─ current = pol.overrideOf(session)
  ├─ current ∈ {workspace-write, read-only} → 返回   ← 已在边界 / 更严不动
  └─ session.append('sandbox/mode', { mode: 'workspace-write' })
       + ctx.logger.info(...)  一行
```

纪律（v0.8.4 现行版）：
- **宿主可强制性是前置输入**（ADR-016，v0.8.4）：宿主后端起不来时 `workspace-write` 下**任何 shell 都 fail-closed**，绑上去等于**夺走会话的 shell**。探针用公开 seam（`shell.resolve`/`run`）+ `read-only` 策略——与上游自己的 readiness 探针（`defaultProbeWindowsAcl`：read-only、零授权、无 ACL 变更）同形，只探一次、结论按插件实例缓存；**探针未绿就不绑**（含 pending，宁可第一个候选会话不绑，也不在未验证的宿主上绑）。
- **覆盖是 opt-in 白名单**（ADR-016，v0.8.3）：空名单不治理任何工作区。
- **边界断言，而不是"填空"**（v0.8.2 修正）：会话在**本钩子运行之前就被盖了一个模式戳**——`dsh-permission-presets` 在 `session/created` 时执行 `pinInitialPermission` → `setSandboxMode(session, spec.sandbox)`。所以判据**不能是"有没有覆盖"**（v0.8.1 就是这么写的，导致每个会话都被跳过、边界永远惰性），必须看**值是什么**：`workspace-write` → 已在边界（幂等，含恢复）；`read-only` → 比我们要设的更严，采用我们的值等于**放松**它，所以不动；其余（`undefined` 或初始化器的默认戳）→ 断言边界。
- **会话内的显式切换仍然有效**：`/permission danger-full-access` 在该会话里 append 更晚的事件，**后写者胜**。插件只在会话建立时表态，不中途干预。
- **失败安全**：整段 `try/catch`；**任何异常一律不绑定**（宁可不设边界，也绝不阻断会话建立或污染日志）。
- **部署级出口**：`Config.autoBindWorkspace = false`。

## 6. 覆盖判定规则（`governedWorkspaceOf`）

```
allow = Config.boundaryWorkspaces（逗号分隔，可用项目码 / 相对路径 / 目录名）
allow 为空                          → ''（不治理任何工作区 —— 安全默认）
cwd 在 root 之外，或 cwd === root    → ''（root 本身永不治理）
cwd 在 root 之内                     → 在 projectPaths 中找"被 allow 命中且包含 cwd"的项目 → 边界 = 该目录
                                       没有命中的 → ''（不治理）
```

**为什么 root 永不治理**：root 级边界的可写范围是整个 root，等于允许一个会话写进**每一个**项目——正是这个能力要防的那种漂移。

路径比较：统一 `\` → `/`、盘符小写、去尾斜杠；包含判定为 `p === zone || p.startsWith(zone + '/')`。

## 7. 实施顺序（关键：验证在部署之前；重启两次，无法合并）

| # | 谁 | 动作 | 是否重启 |
|---|---|---|---|
| 1 | 用户 | 改 `dsh-web` 服务账户（`nssm set … ObjectName DESKTOP-97Q0S5H\lk`） | 否 |
| 2 | 用户 | **一次重启** dsh-web | ✅ |
| 3 | 用户 | 验证后端：`/permission workspace-write` → `Get-Date` 能跑 | 否 |
| 4 | agent | 接线验证 spike：`agent/session-start` 能否安全 append 且 fold 立即生效（用动态插件试，不改仓） | 否 |
| 5 | agent | 实现 §4 改动 + 测试 + bump 0.8.1 + pack + 装进 profile | 否 |
| 6 | 用户 | **二次重启**（插件生效） | ✅ |
| 7 | agent | 实机验收（§8） | 否 |

> 两次重启**不能合并**：绑定一旦随插件上线就对**新会话**立即生效；此时若后端尚未验证通过，新会话将丧失全部 shell。想合并只能先把 `autoBindWorkspace` 设成 `false` 装上去，但改回 `true` 本身还需要一次重启——合并没有收益，只增加状态。
> 步骤 4 存在的唯一原因：`session.append` 在**会话建立时刻**的合法性尚未实证（目前的证据是在工具调用时刻 append）。若 spike 不过，退路是在 `agent/created` 上绑定，或改为惰性绑定（首次工具调用时）。
> 步骤 3 必须在步骤 5 之前：后端没修好就装绑定 ⇒ 新会话全部失去 shell。
> 顺带：**v0.8.0 已提交但从未部署**（运行中插件仍是 10 个工具、无 `nav_arch`），本次发布将首次携带 0.8.0 的全部内容。

## 8. 验收判据（实证，不看"应该好了"）

| # | 检查 | 期望证据 |
|---|---|---|
| 1 | 被治理工作区的新会话自动绑定 | 新会话上下文出现 `Current DSH file policy: workspace-write ... workspace: "D:\FF\project-nav"` |
| 2 | 未治理工作区零影响 | 在 root 内**未登记**目录（或 root 外）开会话 → 上下文仍是 `danger-full-access` |
| 3 | 边界真的在拦 | 工作区内写 → 成功；写 `D:\FF\__probe.tmp` → `[sandbox: file access denied under workspace-write mode]` |
| 4 | shell 在后端修好后可用 | 受限会话内 `Get-Date` **正常执行**（修复前是拒跑） |
| 5 | 用户显式选择优先 | 手动 `/permission danger-full-access` 后，重开会话前该会话保持 danger-full-access |
| 6 | 幂等 | 恢复同一会话 → 日志不新增重复 `sandbox/mode` 事件 |
| 7 | 失败安全 | 临时把 `nav-index.json` 弄坏 → 会话仍能正常建立（只是不绑定） |
| 8 | 回归 | `node --test test/core.test.mjs test/concurrency.test.mjs` 全绿 |
| 9 | 发布一致性 | 工作树 / tgz / 安装副本 三者 `host`+`shared` SHA256 MATCH；`--dump-config` 无重复 id |

## 9. 回滚

| 粒度 | 手段 |
|---|---|
| 单会话 | `/permission danger-full-access`（立即，无需重启） |
| 全局绑定 | `Config.autoBindWorkspace = false`（需重启）或禁用插件 |
| 服务账户 | `reg import` 第 3 步的备份 → 改回 `LocalSystem` → 重启 |
| 插件版本 | profile 依赖指回 `0.8.0` tgz（若已归档则用 `.superseded-<日期>` 那份） |

## 10. 已知边界（如实标注）

1. **只影响新会话**：钩子在会话建立时触发，已运行会话保持原模式（可手动 `/permission`）。
2. **审批已禁用** ⇒ 墙后的"更宽重试"会直接变成拒绝。要保留交互升级通道需同时开启审批；否则就是硬边界（符合当前意图）。
3. **`session-start` 时刻 append 的合法性**待 §7 步骤 4 spike 证实，退路见该行。
4. **不覆盖 shell 之外的黑箱**：这条不是缺口而是特性——沙箱在文件层强制，`node -e`、子进程、`$env:VAR` 间接路径都受同一策略约束（这正是逐调用闸门做不到、因而不采用的原因）。

## 11. 附带发现（不在本次范围，单独留痕）

**`arch-cache` 时效判定用例不可信**：`test/core.test.mjs :: arch-cache mtime accepts both UTC and local-wall-clock renderings of one instant` 在**同一小时内 pass/fail 交替**，并在 `git worktree` 拉出的 **HEAD 干净副本上同样失败**（26/27）——即**与本次改动无关，是既有缺陷**。

已排除的解释：不是时区固定差异（`TZ=UTC` 与 `TZ=Asia/Shanghai` 下失败的断言位置不同：UTC 下 `local === utc`，根本进不到 `localForm` 分支）。触发条件尚未钉住。

**为什么必须单独记账**：该用例守的是架构档指纹的"瞬时比较"语义（HANDOFF §38.6 记录过它曾经真的坏过——UTC / 本地墙上时间 / 秒截断三种渲染必须算同一瞬时）。一个时好时坏的用例既是**不可信的信号**（本插件 doctrine 的头号敌人），也会让人对它守的那条不变式失去警觉。建议单独开一个动作定位并消除其时间相关性，不要夹带进本次边界层改动。

## 12. v0.8.2：v0.8.1 的边界从未生效（实机发现）

**现象**：重启装入 v0.8.1 后，新会话（子代理）报告 `Current DSH file policy: danger-full-access`，且其 cwd 正是被治理的 `D:\FF\project-nav`——**该绑却没绑**。用探针在 `agent/session-start` 上实测（观察 project-nav 监听器之后的状态）：事件确实触发（`source=startup`、cwd 正确、`session.append` 可用），但 `overrideOf(session)` **已经是 `danger-full-access`**；而且早在 `agent/created` 时就已经是了。

**根因（源码级）**：`dsh-permission-presets` 注册了 `ctx.on("session/created", session => this.pinInitialPermission(session))`；对全新会话它执行 `setSandboxMode(session, spec.sandbox)`，把初始预设的沙箱模式**写进会话日志**。`session/created` 早于 `agent/session-start`，所以 v0.8.1 的判据 `overrideOf(session) !== undefined → 返回`（本意是"不夺权/幂等"）**永远为真 → 每个被治理会话都被跳过，边界永远是惰性的**。

**为什么判据不能用 `defaultMode` 比较**：实测 `sandboxPolicy.defaultMode = workspace-write`，而初始化器盖的戳是 `danger-full-access`（来自预设推导，部署配置里没有 `defaultPreset`）。两者不等，所以"等于部署默认就绑定"这条规则同样不成立。**唯一可用的判据是值本身**（见 §5）。

**教训**：这条 bug 与 HANDOFF §37.6 记录的三次"假信号"是**同一枚硬币的反面**——那三次是**误报**，这次是**静默漏报**：报错时人还能看见，什么都不做时连日志都没有（`ctx.logger` 的输出根本没进 nssm 日志）。**"不夺权"这种听起来正确的礼貌规则，如果判据选错了输入，就会变成"永远不做"。** 检测手段只能是对**真实部署**做端到端探针——单元测试当时全绿，因为它测的是我写下的那条错判据。

## 13. 实机事故：正确的策略落在没有执行力的宿主上（2026-09-11 00:40）

**重启后的实测（好消息）**：v0.8.2 的绑定**按设计工作了**——本会话在重启后被绑到 `workspace-write`（运行时上下文实证），fs 边界也真的在拦：
```
写 D:\FF\__boundary-live-probe.txt  →  [sandbox: file access denied under workspace-write mode]
```

**但（坏消息）**：`dsh-web` 仍是 `LocalSystem`，沙箱后端起不来，而该模式下 shell 是 **fail-closed**：
```
sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host;
refusing to run the command unconfined.  Runner failure: windows-acl-run:
CreateRestrictedToken prerequisite failed: no logon SID found among 4 token groups
```
于是**每个被治理会话都失去了 shell**——包括本会话（cwd `D:\FF\project-nav`）与另一个活会话 `session-ab5e360d`（cwd `D:\FF\shoucang`）。

**当场修复（三步，全部实证）**：
1. 用动态插件给**调用方会话** append `sandbox/mode=danger-full-access` → 本会话 shell 立即恢复（运行时上下文回到 `danger-full-access`）。
2. 遍历活会话，把卡在 `workspace-write` 的**全部释放** → 命中并释放 `session-ab5e360d`（cwd `D:\FF\shoucang`）；并保留一个 `session-start` 中和器，保证此后新建/恢复的会话不再被绑死。
3. profile 里把 `autoBindWorkspace` 显式置为 **false**，使**任何重启顺序**下都不再出现该状态（安全默认优先于功能可用）。

**暴露的架构缺口**：插件**无法感知宿主能不能真的强制**。
- `sandbox.confine()` 在后端不可用时**不抛错**——实测返回 `enforcement=partial` 的包装 argv（`argv0` 是 runner 的 node），失败发生在 **runner 执行时**。所以"绑定前自检"这条近路不存在。
- 后果具有普遍性：**一个正确的策略落在没有执行力的宿主上，不是保护环境，而是弄坏环境**——fail-closed 把"不能强制"变成了"不能用"。

**候选对策（待决策，不擅自加机制）**：

| # | 对策 | 代价 |
|---|---|---|
| ① | 保持人工前置（现状）：宿主先修好，再打开开关 | 顺序靠人守——已被现实否证两次 |
| ② | 插件加**一次性能力探针**：真正起一次受限进程，失败则不绑（按进程缓存） | ✅ **已落 v0.8.4**——不需要新数据文件：`shell.resolve`/`run` 是公开 seam，且 `ShellRunResult.sandbox.runnerFailed` 是一等字段；探针用 `read-only`（零授权、无 ACL 变更），避开 `workspace-write` 的 eager ACE 传播 |
| ③ | 把"宿主可强制"做成**显式能力声明**（`.internal/` 下一份标记），由验证流程写入、插件只读 | 引入一个新数据文件（无进程开销，天然可审计） |
