<div align="center">

# 🧭 dsh-project-nav

**面向 DeepSeek Harness（DSH）的项目反漂移治理插件**

[![version](https://img.shields.io/badge/version-0.7.0-blue)](../../releases)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-green)](./LICENSE)
[![dsh-tools](https://img.shields.io/badge/dsh--tools-0.1.2--rc.1-orange)](https://www.npmjs.com/package/@deepseek-ai/dsh-tools)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](./package.json)

**简体中文** | [English](./README.en.md)

*每个任务从架构出发 · 每个文件都有落点 · 一切皆可回溯*

</div>

---

## 为什么需要

AI coding 的长期项目会漂移：文件越堆越多却没有功能映射、方案失去范围约束、文档烂尾、模型在架构空白处反复打补丁。

**project-nav** 在 DSH 内闭合这个循环：agent 自己维护一套工作区级治理层——改任何东西之前先过架构门与范围门，改完之后收口、对齐、不留悬空状态。

## 🧭 设计原则：以架构为核心，其余为辅助（v0.6.0 收敛）

- **核心（不可省）**：索引（架构真相）+ **锚点闸**（动手前先做架构思考）+ **ADR**（架构决策留痕）+ **计数闸**（同一锚点反复补丁 → 强制回架构层）。
- **辅助（够用即止）**：并发租约与排队、scope 文件指纹、文档自动派生、参考文档路由、地图渲染——它们服务核心，不另立门槛。
- **复杂度预算（唯一裁剪标准：模型是否必须多读/多记/多遵循）**：
  - 能推导的**不另建账本** —— 补丁 = 带锚点的 `done` 动作，`nav-patches.json` 已废除；
  - 能合并的**不另开工具** —— 功能/模块注册与字段更新合并为 `nav_update`（upsert），参考文档注册与检索合并为 `nav_docs`；
  - 能推断的**不强制参数** —— 单目标 scope 自动取锚，只有多目标/歧义时才要求 `anchor=`。
- **为什么**：治理插件本身也是被模型读的代码。太复杂 → 不聪明的模型读不了也遵循不了；聪明的模型不需要过多强限制。

## ✨ 核心能力

- 🗺️ **双向治理地图**：项目→模块→功能→文件 四维交叉索引，单一数据真身，一张图看清全部结构
- 🏛️ **架构文档层（生态配合，不在本包内）**：L1 项目总览 + L2 特征主链（贯通式流程、行号级证据）、指纹过期自动重生成，由配套的 arch-view 技能提供——本仓库只交付索引与治理闭环
- 🏛️ **架构先行协议（v0.5.0 起）**：任务必须锚定架构节点才入账——单目标 scope 自动取锚，多目标必须显式 `anchor=`；同锚点自最近架构决策以来 ≥3 次补丁 → **计数闸**强制回架构层；`nav_adr` 记录架构决策并重置计数
- 🎯 **治理事务环**：`nav_plan` → `begin` → 改动 → `done`（abort 兜底），未完成动作 = 漂移信号，地图标红；**每会话同时只允许一个 in_progress**
- 🧵 **多会话并发（v0.3.0）**：锁的粒度是 **scope 而不是工作区**——不相交的会话真并行干活，只有 scope 相交（同功能 / 同模块 / 同文件 / 索引派生出的同一文件）才排队；`nav_mark begin wait=true` 可阻塞等待，崩溃会话的租约自动过期自愈，账本带跨进程文件锁（并发立项不再丢动作）
- 🔍 **scope 文件指纹（v0.4.0）**：`begin` 记录 scope 内每个文件的 size/mtime/sha1，`done` 比对并报 `⚠ Scope drift`（被改/被删/新出现三类），运行中动作由 `nav_status` 实时显示漂移——租约防「同时开工」，指纹防「开工期间被别人动过」
- 🔒 **共享状态写入串行化（v0.7.0）**：索引 / 参考文档 / 向量 / 架构决策账本 / `PROJECT.md` 的每个读改写都在**按目标文件的互斥锁**下进行（锁目录 `.internal/locks/`）——两个会话同时写不再互相覆盖（这正是此前索引被反复回退的根因）；锁等待异步化（不再阻塞事件循环），持有者崩溃时按锁文件 mtime 破锁
- 🧭 **主线向量带牙齿**：doing / next / notDoing / exitCondition——方案撞上"不做什么"**直接拒绝立项**
- 📚 **参考文档地基**：按 when 路由规则注册，方案确认时自动推荐该读什么
- 🔄 **Once-Only / SSOT**：手写 `PROJECT.md` 叙事不动，`nav:auto` 标记区自动派生
- 🌳 **渐进式导图**：自包含离线 HTML 思维导图，无 CDN、双击即开
- 🩺 **磁盘漂移探测**：索引里有、磁盘上没有（STALE）一览无余，双路径形态兼容

## 🔧 工具一览（10 个，单一职责）

| 工具 | 作用 |
|------|------|
| `nav_query` | 查结构/模块/功能，改动前理解范围（范围门禁 + 主线告警 + **跨会话占用提示**） |
| `nav_plan` | 治理优先门禁：登记动作（**锚点闸** + 范围预校验 + 反目标硬拦截 + **计数闸**） |
| `nav_mark` | 事务生命周期 begin / done / abort（begin 含 scope 冲突闸 + 租约 + 排队；done 报 scope 漂移与计数压力） |
| `nav_adr` | **架构决策记录**（锚点 + 触发原因 + 决策 + 影响面）；登记即重置该锚点补丁计数 |
| `nav_update` | **唯一登记口（upsert）**：更新已存在条目，或直接创建功能/模块（新功能给 `files=`，新模块给 `features=`/`project=`） |
| `nav_docs` | 参考文档：给 `title`+`path`+`when` 即登记（`when` 是路由规则），否则列库 / 按 `task` 排序推荐 |
| `nav_map` | 治理地图：`text`（agent 导航）/ `html`（人看导图） |
| `nav_sync_docs` | 自动对齐 PROJECT.md（标记区派生：功能地图 + 主线向量 + **架构决策**） |
| `nav_status` | 健康快照：覆盖度 + 未完成动作 + STALE 文件 + **跨会话并发视图** |
| `nav_set_vector` | 设置主线向量 |

## 🔄 治理循环

```mermaid
flowchart LR
  Q[nav_query<br>影响面 + 门禁] --> P[nav_plan<br>登记 ACT-xxx]
  P --> C((改代码))
  C --> M[nav_mark done<br>收口]
  M --> S[nav_sync_docs<br>文档对齐]
  S --> Q
  ST[nav_status<br>漂移探测] -.-> P
```

## 🏛️ 三层模型

| 层 | 载体 | 读者 |
|----|------|------|
| 索引层 | `<root>/.internal/nav-index.json`（四维映射 + 原子写） | 机器（工具查询） |
| 架构文档层（生态配合） | `<root>/.internal/arch/*.md`（由配套 arch-view 技能维护，不在本包） | agent + 人 |
| 渲染层 | nav_map HTML（本包生成） | 人（只看不写回） |

## 📦 安装

```bash
pnpm pack
dsh plugin --profile web add "@dsh-external/project-nav@file:<tgz 路径>"
```

依赖：`@deepseek-ai/dsh-tools`（peer，精确锁 `0.1.2-rc.1`）；Node ≥ 18。

## ⚙️ 配置 root（重要）

插件治理哪个工作区由 `root` 决定——被治理目录下的 `.internal/` 存放全部数据。
`root` **没有机器相关默认值**：未配置时回退到 DSH 进程的工作目录（cwd），启动日志会以 warn 打印实际生效的 root。

在 profile 的 patch 层（如 `~/.dsh/profiles/<profile>/cordis.patch.yml`）给插件条目补 `config`：

```yaml
- id: project-nav
  config:
    root: 'C:/path/to/your/workspace'   # 指向含 PROJECT.md 的被治理工作区
```

配置后重启 profile 生效。启动日志中显示的 root 就是要被治理的目录——请确认它符合预期再开始用 `nav_*` 工具。

可选 `leaseTtlMs`（默认 30 分钟）：会话崩溃后其 scope 锁在此之前保持有效，超时自动过期释放。

## 🗃️ 数据

单一数据真身 `<root>/.internal/`（nav-index / vector / nav-actions / nav-docs），其余全部自动派生——**除 `root` 外零每项目配置**。索引与数据文件不进 git（`.gitignore`），数据手术一律先备份。`.internal/arch/*.md` 由配套 arch-view 技能维护，不在本包数据流内。

## 🛠️ 开发

```bash
pnpm install
pnpm test      # node --test test/core.test.mjs test/concurrency.test.mjs（27 项真实回归，全部在临时目录跑，不碰真实工作区）
pnpm pack      # 构建发布包
```

发布循环：bump version → `pnpm pack` → `dsh plugin --profile web add "@dsh-external/project-nav@file:<tgz>"` → 重启 dsh-web（记得补 `config.root`，见上）。

工程日志见 [HANDOFF.md](./HANDOFF.md)（§1–§27：决策 / 数据手术 / 闭环审查全记录）。

## 📄 License

[BSD-3-Clause](./LICENSE) © 2026 Fishsb
