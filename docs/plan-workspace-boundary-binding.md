# 落地方案 · ACT-033 工作区边界绑定（project-nav v0.8.1）

> 整理日期：2026-09-11（本地）
> 架构依据：**ADR-014**（现行，收敛 ADR-012/ADR-013）
> 状态（2026-09-11 02:40，v0.8.5）：**已上线，§8 验收全套 PASS**。机制链四项 —— **覆盖判定**（白名单 opt-in，空名单即惰性）、**能力判定**（只读探针，宿主不能强制就不绑）、**绑定**（`agent/session-start`）、**原生强制**（fs 边界实测拦截）—— 全部在真实部署上实证。本机 profile 已写 `autoBindWorkspace: true` + `boundaryWorkspaces: 'project-nav'`。
> **验收证据**：① 全新会话与恢复会话的策略行均为 `workspace-write … workspace: "D:\FF\project-nav"`；② 未治理工作区零影响 —— `boundary-diag.json` 记录 `D:\FF\shoucang`×4、`D:\FF\dsh-managing-memory`×1 全为 `not-governed`（不绑）；③ 区内写成功、区外写被拒（`D:\FF\__probe4.tmp`，连 `~/.dsh/profiles/web/cordis.patch.yml` 也被拒）；④ 受限 shell 正常执行（`Get-Date`，未 fail-closed）；⑤ 判定留痕于 `D:\FF\.internal\boundary-diag.json`（probe verdict/attempts + 每会话决策）；⑥ 全量测试 85/85；⑦ 工作树 / tgz / 安装副本 SHA256 三者一致。宿主侧前置门与现行形态见 runbook §0。
> **上线前拦下的真缺陷（v0.8.5，ADR-017）**：v0.8.4 的探针"apply 时只探一次 + 首次结论永久缓存 + 早退无日志"，会把一次**启动竞态**固化成**永久惰性且零痕迹** —— 配置、挂载、白名单、宿主后端全对，却一个会话都不绑。根因是判定语义本身，不是探针参数；诊断链与修法见 §14。

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
5. **在受限会话里，工具链有三处会撞墙（2026-09-11 上线当日实测，均为设计后果、非缺陷）**：
   - **npm/pnpm 默认缓存与日志写 `%LOCALAPPDATA%\npm-cache`（工作区外）→ `EPERM`**。绕法：`npm pack --cache <工作区内目录>`（用完删）。
   - **`node --test <多文件>` 直接失败 `spawn EPERM`**：test runner 为每个测试文件 spawn 带管道的子进程，撞上本机已知的 piped-stdio 边界。绕法：**进程内直跑**——`node test/core.test.mjs`、`node test/concurrency.test.mjs`（本次 86/86 即如此跑出）。
   - **插件自身的发布/安装路径被拒**：安装要写 `~/.dsh/profiles/web`（锁文件 + 声明 + 安装副本），全在工作区外 ⇒ **从被治理会话里无法自部署**。这正是 §6 那句 opt-in 判据的张力——"工作触达 `~/.dsh` 的工作区不该 opt-in"，而 project-nav 自己每次发版都要落到 `~/.dsh`。运行期解法有二：① §9 的**单会话逃生门** `/permission danger-full-access`（后写者胜、立即生效、无需重启）；② 把部署步骤放到**未被治理的会话或用户终端**执行。
   - **反向确认（未受影响，且是设计意图的运行时体现）**：插件自身的 `nav_*` 工具仍能读写治理数据（`D:\FF\.internal` 在工作区外）—— 因为它们在**宿主进程内**执行，不经会话沙箱；插件就是治理根的唯一受权通道。

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

## 14. v0.8.5：启动竞态把 fail-safe 变成永久惰性（上线前拦下的真缺陷）

**现象（2026-09-11 二次重启后）**：宿主机已修好（runbook §0 双探针 PASS）、profile 配置在位、插件挂载正常、白名单匹配链成立 —— 但 `D:\FF\project-nav` 的新会话**一律** `danger-full-access`，区外写不被拒。边界根本没生效，且**零痕迹**（宿主 stdout 未落盘，`ctx.logger` 的输出无处可查）。

**逐层取证（动态 Cordis 插件 + A/B 对照，全部实证）**

| 层 | 证据 | 结论 |
|---|---|---|
| 事件 | 监听 `agent/session-start`：收到新会话，`source=startup`、`agent.session` 存在、`hasAppend=true`、`cwd` 正确 | OK |
| 服务 | 同一上下文能取到 `shell`（`resolve`/`run`）与 `sandboxPolicy`（`overrideOf`） | OK |
| 探针 | 就地跑**同规格**只读探针：`exitCode=0`、`runnerFailed=false` | **PASS** |
| 绑定 | 在**同一时刻**由探针插件 `session.append('sandbox/mode', …)` → 新会话立刻 `workspace-write`，区外写被拒 | OK |

⇒ 事件、服务、探针、append、宿主后端**全部正常**。唯一剩下的卡点就是 v0.8.4 探针的**判定语义**：`apply()` 只探一次 + `boundaryUsable !== null → return` 把**首次**判定永久缓存 + 三条早退路径**都不打日志**。启动竞态一旦让它为 `false`（seam 已注册但执行器/后端尚未 live），一次瞬时故障就固化为永久失效。

**修复（v0.8.5，ADR-017）**：① `inject: ['tools'] → ['tools','shell']` —— 探针经 shell seam 是**真依赖**，Cordis 会等它就绪再 apply；② 只缓存**成功**，失败可重探（首次失败后下一次 session-start 立即重试，其后 10s 节流）；③ 每次判定与每个会话决策写入 `<root>/.internal/boundary-diag.json`，所有失败分支必须 `warn`；④ 新增回归用例「boot 探针失败 → 不绑 → 重探成功 → 下一会话绑定」。
**复验**：探针 `attempt 1 / trigger=boot` 即 PASS；新会话与恢复会话均绑定；未治理工作区（shoucang / dsh-managing-memory）全部 `not-governed`；区外写（含 `~/.dsh` 配置）被拒；受限 shell 正常；全量 85/85。

**教训（与 §12 同源）**：**"能不能强制"必须是状态，不能是一次性事件**。任何"探一次就定终身"的 fail-safe，都会把瞬时故障放大成永久失效；而 fail-safe 的早退路径若不发声，失效就与"正常惰性"无法区分 —— 这正是本项目 doctrine 的头号敌人（不可信信号）。判定必须留痕，且**失败不可缓存**。
