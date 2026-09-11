# ARCH-MODEL — 架构模型快照

> **本文件由 `nav_render` 生成，永不手写**（I2）。真相是 `.internal/events.jsonl`（append-only）；
> 本文件是它的折叠投影，供人阅读与 `git diff` 审查。删除 `.internal/runtime/` 后本文件仍可由事件流重建。

生成时间：2026-09-11T00:34:08.267Z · 事件数：22

## 主线向量

| doing | next | notDoing | exitCondition |
|---|---|---|---|
| core-model 验证：把新架构的每条不变量用可机检的用例钉住 | 在被治理根（D:\FF）补齐 .gitignore 的三层规则 → 迁移旧账本 → 安装 0.9.0 并重启后实机验收 | 回到 begin/done 生命周期；让任何状态绕过事件流；把渲染物手写或回写进模型 | I1/I2/I3 + A1…A6 全绿，且 lk 侧实机跑通"登记 → 改文件 → 自动收口 → 投影"闭环 |

## 覆盖度

- 项目 1 · 模块 8 · 功能 9 · 文档工件 2
- 登记文件 28 · 未登记文件 15 · 已退役 0
- 在途改动 0 · 架构决策 1

## 节点

| 层 | id | 名称 | 归属 | 落点 | 证据 |
|---|---|---|---|---|---|
| artifact | `artifact:arch-contract` | 架构契约（本仓） | — | `ARCHITECTURE.md` | when=改代码前必读；改架构时必须先改它；判断"某个状态该落在哪一层"时 |
| artifact | `artifact:handoff` | 历史交接记录 | — | `HANDOFF.md` | when=追溯 v0.8.x 及更早的实现选择、事故记录、发布过程时 |
| feature | `feature:pn-f09` | 测试与契约面 | host-face | 16 文件 | 2026-09-11T00:34:08.252Z |
| feature | `feature:pn-f06` | 工作区边界 | core-boundary | 1 文件 | 2026-09-11T00:34:08.252Z |
| feature | `feature:pn-f07` | 旧账本迁移 | core-migrate | 2 文件 | 2026-09-11T00:34:08.252Z |
| feature | `feature:pn-f04` | 六闸 | core-gates | 1 文件 | 2026-09-11T00:34:08.252Z |
| feature | `feature:pn-f03` | 模型折叠 | core-model | 2 文件 | 2026-09-11T00:34:08.252Z |
| feature | `feature:pn-f01` | 平面契约 | core-plane | 1 文件 | 2026-09-11T00:34:08.252Z |
| feature | `feature:pn-f02` | 事件流 | core-log | 2 文件 | 2026-09-11T00:34:08.252Z |
| feature | `feature:pn-f05` | 渲染投影 | core-render | 2 文件 | 2026-09-11T00:34:08.252Z |
| feature | `feature:pn-f08` | 装配面与工具 | host-face | 1 文件 | 2026-09-11T00:34:08.252Z |
| module | `module:core-boundary` | 工作区边界 | project:pn-p01 | — | 2026-09-11T00:34:08.252Z |
| module | `module:core-migrate` | 旧账本迁移 | project:pn-p01 | — | 2026-09-11T00:34:08.252Z |
| module | `module:core-gates` | 六闸 | project:pn-p01 | — | 2026-09-11T00:34:08.252Z |
| module | `module:core-model` | 模型折叠 | project:pn-p01 | — | 2026-09-11T00:34:08.252Z |
| module | `module:core-plane` | 平面契约 | project:pn-p01 | — | 2026-09-11T00:34:08.252Z |
| module | `module:core-log` | 事件流 | project:pn-p01 | — | 2026-09-11T00:34:08.252Z |
| module | `module:core-render` | 渲染投影 | project:pn-p01 | — | 2026-09-11T00:34:08.252Z |
| module | `module:host-face` | 装配面与工具 | project:pn-p01 | — | 2026-09-11T00:34:08.252Z |
| project | `project:pn-p01` | project-nav | — | — | 2026-09-11T00:34:08.252Z |

## 架构决策（ADR）

### ADR-22 · PN-P01

- 时间：2026-09-11T00:34:08.252Z
- 为什么必须改：旧骨架把"治理"实现成了流程：闸门是步骤而非查询，导致收口依赖会话身份（5/6 动作永久孤儿）；真相散在 5 个手写账本里且无证据字段，描述腐烂无警报；ADR 账本在所有仓之外，决策不可传播；长期资产与运行时状态混称"单一数据真身"。局部补丁已三次以上，架构必须换。
- 架构变成什么：一条 append-only 事件流作为唯一事实源；架构模型是它的折叠（runtime 内，可丢弃）；地图/PROJECT.md/模型文档/架构档指针全部是模型的重渲染；六个闸门实现为唯一写入口 nav_commit 内的纯查询；工具面 11→6，数据面 7→3。收口判据从"会话身份"换成"scope 证据是否变化"。
- 影响面：host/index.js 全量重写（11→6 工具）；shared/index.js 整体替换为 core/ 十个模块；test/ 四个套件 61 项重写；PROJECT.md 与 ARCHITECTURE.md 成为投影与契约

---

*渲染物。手改即被下一次 `nav_render` 覆盖。*