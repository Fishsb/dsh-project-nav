<div align="center">

# 🧭 dsh-project-nav

**面向 DeepSeek Harness（DSH）的项目反漂移治理插件**

[![version](https://img.shields.io/badge/version-0.2.9-blue)](../../releases)
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

## ✨ 核心能力

- 🗺️ **双向治理地图**：项目→模块→功能→文件 四维交叉索引，单一数据真身，一张图看清全部结构
- 🏛️ **架构文档层（核心）**：L1 项目总览 + L2 特征主链（贯通式流程、行号级证据），agent 开发前必读，指纹过期自动重生成
- 🏛️ **架构先行协议**：任务必须锚定架构节点才入账；无锚点 = 架构不足 → 先修架构再开发；同节点 ≥3 次修补强制回架构层整体审视
- 🎯 **治理事务环**：`nav_plan` → `begin` → 改动 → `done`（abort 兜底），单 in_progress 强制，未完成动作 = 漂移信号，地图标红
- 🧭 **主线向量带牙齿**：doing / next / notDoing / exitCondition——方案撞上"不做什么"**直接拒绝立项**
- 📚 **参考文档地基**：按 when 路由规则注册，方案确认时自动推荐该读什么
- 🔄 **Once-Only / SSOT**：手写 `PROJECT.md` 叙事不动，`nav:auto` 标记区自动派生
- 🌳 **渐进式导图**：自包含离线 HTML 思维导图，无 CDN、双击即开
- 🩺 **磁盘漂移探测**：索引里有、磁盘上没有（STALE）一览无余，双路径形态兼容

## 🔧 工具一览（12 个）

| 工具 | 作用 |
|------|------|
| `nav_query` | 查结构/模块/功能，改动前理解范围（含范围门禁 + 主线告警） |
| `nav_plan` | 治理优先门禁：改动前登记动作（范围预校验 + 反目标硬拦截） |
| `nav_mark` | 事务生命周期 begin / done / abort |
| `nav_update` | 登记功能↔文件映射增量 |
| `nav_add_feature` / `nav_add_module` | 注册功能 / 模块（含孤儿提示、双挂载警告） |
| `nav_add_doc` / `nav_docs` | 注册 / 检索参考文档（本地死链拒绝） |
| `nav_map` | 治理地图：`text`（agent 导航）/ `html`（人看导图） |
| `nav_sync_docs` | 自动对齐 PROJECT.md（标记区派生） |
| `nav_status` | 健康快照：覆盖度 + 未完成动作 + STALE 文件 |
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
| 索引层 | `.internal/nav-index.json`（四维映射 + 原子写） | 机器（工具查询） |
| **架构文档层（核心）** | `.internal/arch/*.md`：L1 总览 + L2 特征主链 | **agent 开发前必读** + 人 |
| 渲染层 | nav_map HTML / 架构投影图 | 人（只看不写回） |

## 📦 安装

```bash
pnpm pack
dsh plugin --profile web add "@dsh-external/project-nav@file:<tgz 路径>"
```

依赖：`@deepseek-ai/dsh-tools`（peer，精确锁 `0.1.2-rc.1`）。

## 🗃️ 数据

单一数据真身 `<工作区根>/.internal/`（nav-index / vector / nav-actions / nav-docs / arch），其余全部自动派生——**零每项目配置**。索引与数据文件不进 git（`.gitignore`），数据手术一律先备份。

## 🛠️ 开发

```bash
pnpm install
pnpm test      # node --test
pnpm pack      # 构建发布包
```

发布循环：bump version → `pnpm pack` → `dsh plugin --profile web add "@dsh-external/project-nav@file:<tgz>"` → 重启 dsh-web。

工程日志见 [HANDOFF.md](./HANDOFF.md)（§1–§27：决策 / 数据手术 / 闭环审查全记录）。

## 📄 License

[BSD-3-Clause](./LICENSE) © 2026 Fishsb
