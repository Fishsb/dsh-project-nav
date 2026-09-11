# project-nav — 项目主档

> 标记区内由 `nav_render` 从事件流生成，**永不手写**；标记外任意书写。

## 这个仓是什么

DSH 的项目治理插件。核心理念与架构契约见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

<!-- nav:auto:start -->
## 项目地图（自动区 · 由 nav_render 从事件流生成，勿手改）

**主线**：doing = core-model 验证：把新架构的每条不变量用可机检的用例钉住 ｜ next = 在被治理根（D:\FF）补齐 .gitignore 的三层规则 → 迁移旧账本 → 安装 0.9.0 并重启后实机验收
**反目标（notDoing）**：回到 begin/done 生命周期；让任何状态绕过事件流；把渲染物手写或回写进模型
**完成判据**：I1/I2/I3 + A1…A6 全绿，且 lk 侧实机跑通"登记 → 改文件 → 自动收口 → 投影"闭环

**覆盖度**：1 项目 · 7 模块 · 8 功能 · 27 登记文件 · 4 未登记 · 2 已退役

### project-nav

- **平面契约**（1 功能）
  - `平面契约` — `core/paths.js`
- **事件流**（1 功能）
  - `事件流` — `core/lock.js`、`core/log.js`
- **模型折叠**（1 功能）
  - `模型折叠` — `core/model.js`、`core/scope.js`
- **六闸**（1 功能）
  - `六闸` — `core/gates.js`
- **渲染投影**（1 功能）
  - `渲染投影` — `core/format.js`、`core/render.js`
- **旧账本迁移**（1 功能）
  - `旧账本迁移` — `core/commit.js`、`core/legacy.js`
- **装配面与工具**（1 功能）
  - `装配面与工具` — `host/index.js`

### 架构决策（ADR）

| id | 锚点 | 决策 | 时间 |
|---|---|---|---|
| ADR-22 | `PN-P01` | 一条 append-only 事件流作为唯一事实源；架构模型是它的折叠（runtime 内，可丢弃）；地图/PROJECT.md/模型文档/架构档指针全部是模型的重渲染；六个闸门实… | 2026-09-11 |

### 在途改动

*(无 — 所有改动都已按证据收口)*

<sub>生成于 2026-09-11T10:51:14.338Z · events=24</sub>
<!-- nav:auto:end -->
