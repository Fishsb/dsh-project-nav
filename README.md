# 🧭 dsh-project-nav

`@dsh-external/project-nav` —— 面向 DeepSeek Harness（DSH）的**项目反漂移治理插件**。

在 AI coding 过程中，agent 自己维护一套工作区级治理层：改任何东西之前，先理解项目结构和改动范围；改完之后，收口、对齐、不留悬空状态。

## ✨ 核心能力

- 🗺️ **治理地图**：工作区级 项目→模块→功能→文件 双向索引，一张图看清所有项目结构
- 🎯 **治理事务环**：`nav_plan` → `begin` → 改动 → `done`（delta 收口），单 in_progress 强制，未完成动作 = 漂移信号
- 🧭 **主线向量**：doing / next / notDoing / exitCondition，范围撞上"不做什么"直接拒绝立项
- 📚 **参考文档地基**：按 `when` 路由规则注册参考文档，方案确认时自动推荐该读什么
- 🔄 **一份核心文档，其余自动对齐**（Once-Only/SSOT）：手写 `PROJECT.md` 叙事不动，`nav:auto` 标记区自动派生
- 🌳 **渐进式导图**：自包含离线 HTML 思维导图，无 CDN、双击即开
- 🩺 **磁盘漂移探测**：索引里有、磁盘上没有的文件（STALE Files）一览无余

## 🔧 工具一览（12 个）

| 工具 | 作用 |
|------|------|
| `nav_query` | 查结构/模块/功能，改动前理解范围 |
| `nav_plan` | 治理优先门禁：改动前登记动作（含范围预校验 + 主线门禁） |
| `nav_mark` | 事务生命周期 begin / done / abort |
| `nav_update` | 登记功能↔文件映射增量 |
| `nav_add_feature` / `nav_add_module` | 注册功能 / 模块（含孤儿提示、双挂载警告） |
| `nav_add_doc` / `nav_docs` | 注册 / 检索参考文档（本地死链拒绝） |
| `nav_map` | 生成渐进式思维导图 HTML |
| `nav_sync_docs` | 自动对齐 PROJECT.md（标记区派生） |
| `nav_status` | 健康快照：覆盖度 + 未完成动作 + STALE 文件 |
| `nav_set_vector` | 设置主线向量 |

## 📦 安装

```bash
pnpm pack
dsh plugin --profile web add "@dsh-external/project-nav@file:<tgz 路径>"
```

依赖：`@deepseek-ai/dsh-tools`（peer，精确锁 `0.1.2-rc.1`）。

## 🗃️ 数据

单一数据真身 `D:\FF\.internal\`（nav-index.json / vector.json / nav-actions.json / nav-docs.json），其余全部自动派生——**零每项目配置**。

## 📄 License

BSD-3-Clause
