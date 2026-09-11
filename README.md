<div align="center">

# 🧭 dsh-project-nav

**面向 DeepSeek Harness（DSH）的项目反漂移治理插件**

[![version](https://img.shields.io/badge/version-0.9.0-blue)](../../releases)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-green)](./LICENSE)
[![dsh-tools](https://img.shields.io/badge/dsh--tools-%3E%3D0.1.2--rc.1-orange)](https://www.npmjs.com/package/@deepseek-ai/dsh-tools)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](./package.json)

**简体中文** | [English](./README.en.md)

*每个任务从架构出发 · 每个文件都有落点 · 一切皆可回溯*

</div>

---

> **核心理念（唯一上位约束）**
>
> **所有开发动作必须从架构出发。**
> 架构不出错，开发过程中出现一点问题也只是局部小问题；反之，架构错了，局部补得再好也是在错误的骨架上堆砌。

**v0.9.0 是从架构出发的一次性重写**：设计契约见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。
旧的补丁式演进（11 个工具 / 5 个并列账本 / begin·done 生命周期）整体放弃——不是收敛，是换骨架。
**决策可丢弃，事实（F1–F9）不可丢弃**：它们全部变成新架构的需求。

---

## 1. 一句话架构

> **一条 append-only 事件流（唯一事实源）+ 一个由它折叠出的架构模型（可丢弃缓存）+ 一层渲染投影；闸门是对模型的查询，产出是模型的重渲染。**

```
   ┌───────────────────────────────────────────────────────────────┐
   │ ① 事件流  .internal/events.jsonl    ← 唯一事实源（append-only） │
   │   commit{锚点,scope,arch=,phase} · decide{ADR} · node{} · set{}│
   └───────────────────────────┬───────────────────────────────────┘
                               │ 纯函数折叠（I1）
   ┌───────────────────────────▼───────────────────────────────────┐
   │ ② 模型  .internal/runtime/arch-model.json   ← 可丢弃（I3）      │
   │   节点(项目/模块/功能/工件) + 边 + 证据 + 主线向量 + 决策 + 补丁计数│
   └───────────────────────────┬───────────────────────────────────┘
                               │ 全部派生（I2）
   ┌───────────┬───────────────┼───────────────┬──────────────────┐
   ▼           ▼               ▼               ▼                  ▼
 nav_graph  PROJECT.md      ARCH-MODEL.md   地图 HTML        架构档指纹
 （闸门=查询）（渲染）        （渲染）        （渲染）          （机检）
```

**三条不变式（可机检）**

| | 不变式 | 验法 |
|---|---|---|
| **I1** | 单源：模型每条属性都能由「事件流 + 磁盘实况」复算，无第二手写真相 | 复算 == 缓存 |
| **I2** | 渲染：地图 / `PROJECT.md` 标记区 / `ARCH-MODEL.md` / 架构档指针全部由模型生成 | 手改渲染物 → 下次渲染覆盖它 |
| **I3** | 可丢弃：删掉整个 `.internal/runtime/` → 治理零损失 | 删后跑全量查询，结果一致 |

## 2. 六个工具（11 → 6）

工具数下降**不是目标**，是"闸门变查询、产出变渲染"的结果。

| 工具 | 模型操作 | 典型用法 |
|---|---|---|
| `nav_graph` | **读**：影响面 / 缺口 / 覆盖度 / 文档路由 / 架构档新鲜度 / 健康快照 / 地图 | `nav_graph mode=task target=src/host/app.js` |
| `nav_commit` | **写**：登记改动意图（锚点 + scope + `arch=` 一句话），跑六闸；**自动按证据收上一笔** | `nav_commit task="加一层校验" anchor=PN-F01 arch="架构不变" features=PN-F01` |
| `nav_decide` | **写**：架构决策（挂节点，登记即重置该节点补丁计数） | `nav_decide anchor=PN-F01 reason=… decision=…` |
| `nav_node` | **写**：节点 upsert / 退役并级联 / 参考文档工件 / 旧账本迁移 | `nav_node target=E-F01 name=编辑器 files=src/a.js` |
| `nav_render` | **写**：重生成全部投影（+ 可选刷新架构档指纹） | `nav_render target=.internal/arch/overview.md` |
| `nav_set` | **写**：主线向量（doing / next / notDoing / exit） | `nav_set doing="收口 shoucang" notDoing="pmg 融合"` |

### 最重要的行为变化：**收口不需要第二个动作**

- 登记一笔改动 = 一次 `nav_commit`，它记下 scope 内每个文件的 `{size, mtimeMs, sha1}` 作为**证据**。
- 改完文件后，**下一次任意工具调用**（任意会话）发现证据变了 → 自动收口。
- **收口不依赖会话**："只有自己的会话能驱动自己的动作"这条设计被删除：
  会话死了，意图照旧被任意会话按证据收口。
- 证据没变 ⇒ 意图继续**在途**（有人正在改 = 正常状态，不是孤儿）。
- 唯一绕过证据的出口：`nav_commit mode=archive id=ACT-N reason=…`（空 scope / 误建 / 方向已废）。

## 3. 六个闸门（全部是 `nav_commit` 内的模型查询）

| 闸门 | 问题 | 判据 | 强度 |
|---|---|---|---|
| **锚点闸** | 架构节点真实存在吗？ | 节点在模型中，或锚定 `.internal/arch/*.md` | 拒 |
| **范围闸** | 撞主线反面吗？撞别人在途 scope 吗？ | `notDoing` 命中 → 拒；与他在途重叠 → 告警 | 拒/告警 |
| **主线闸** | scope 里的模块在主线上吗？ | 未被 `doing/next` 引用 → 告警 | 告警 |
| **计数闸** | 同一锚点又在反复打补丁？ | 自上次决策以来 ≥ 3 次 → **强制先出决策** | 拒 |
| **决策闸** | 这次改动需要架构变更吗？ | `arch=` 缺失 → 告警要求一句话回答 | 告警 |
| **完结闸** | 有该收而未收的意图吗？ | 开新笔时按证据自动收旧；异常才报 | 自动 + 报异常 |

闸门是**查询**而不是流程，因此它们不可能产生"孤儿状态"，也无法被"另开一条路"绕过——
写入只有一个入口。

## 4. 数据面：7 → 3

| 层 | 路径 | 生命周期 | 版本控制 |
|---|---|---|---|
| **事件流** | `.internal/events.jsonl` | 永久 | **是**（唯一事实源） |
| **运行时** | `.internal/runtime/`（模型缓存 · 在途 · 锁 · 诊断） | 短命 | **否**（gitignore，可丢弃可重建） |
| **渲染投影** | `PROJECT.md` 标记区 · `.internal/ARCH-MODEL.md` · `runtime/map-*.html` · 架构档 `arch-cache` 头 | 可再生 | 投影本身可进仓 |

> `.gitignore` 必须**只排除 runtime**，不能整目录排除 `.internal/`——
> 否则事件流不进版本控制，新 clone 读不到任何决策，"决策可传播"就是一句空话。

## 5. 安装

```bash
# 1) 打包（在插件仓根）
npm pack

# 2) 装进 profile：编辑 ~/.dsh/profiles/<profile>/package.json
#      dependencies:  "@dsh-external/project-nav": "file:<本仓路径>/dsh-external-project-nav-0.9.0.tgz"
#      dsh.profile.bundles 里已有 "@dsh-external/project-nav"（保持不变）

# 3) 重启 dsh —— 装与重启是两条时间线，重启前线上仍是旧版
```

**配置**（profile 里的插件项）：

| 键 | 默认 | 说明 |
|---|---|---|
| `root` | `''` → 进程 cwd | 被治理工作区根（其 `.internal/` 存事件流）。**建议显式设置** |

## 6. 迁移（旧账本 → 事件流）

旧版有 5 个并列账本：`nav-index.json` / `vector.json` / `nav-actions.json` / `nav-docs.json` / `nav-arch.json`。

```
nav_graph mode=legacy        # 先看清旧账本全貌（只读）
nav_node layer=migrate       # 一次性折叠成事件 + 归档为 .internal/legacy/ 只读快照
nav_render                   # 重建全部投影
```

迁移**只跑一次**（落下 `.internal/legacy/migrated.json` 标记）。迁移后旧文件离开原位、不再被任何读路径读取——
不存在第二个真相。本轮不保留二段式侧车与回切；旧快照仅作取证材料。

## 7. 测试

```bash
npm test                  # 四个套件：98 项
npm run test:node-runner  # 同一批用例走 node --test
```

| 套件 | 覆盖 |
|---|---|
| `test/core.test.mjs` | 事件流 / 折叠 / scope 解析 / 六闸 / 收口 / 迁移（含真实索引形状与落点口径）（43） |
| `test/architecture.test.mjs` | **不变量** I1·I2·I3·A1·A2·A4·A5·A6（22） |
| `test/concurrency.test.mjs` | F1 并发追加不丢 / F2 破锁竞态 / token 校验 / 重入 / 无锁残留（12） |
| `test/host.test.mjs` | 真 host 代码 + 桩 ctx：装配面 6 工具、闸门接线、端到端、归属归一回归（22） |

> 沙箱提示：`node --test` 会用管道 spawn 子进程，在某些受限沙箱下报 `spawn EPERM`。
> `npm test` 直接执行测试文件（文件被直接运行时 `node:test` 同样执行），因此不受影响。

## 8. 版本规则

> **每次更新一律 +0.0.1**，不因"加功能"跳中间位（lk 2026-09-10 定调）。
> **例外：架构换代**才允许跳位，且必须在变更日志里写明"换代"二字。

本版 `0.8.6 → 0.9.0` 即该例外：不是加功能，是换骨架（决策丢弃、事实保留）。

## 9. 开发纪律

1. 改代码前先读 [`ARCHITECTURE.md`](./ARCHITECTURE.md)——它是本仓的架构契约，不是说明书。
2. 改了架构先改契约；契约之外不新增文件（新增即架构变更）。
3. 渲染物永不手写：手改 `PROJECT.md` 标记区 / `ARCH-MODEL.md` / 地图，下一次 `nav_render` 就覆盖它。
4. 事故事实（F1–F9）不可丢弃：它们是需求，只有实现方式可以换。

## License

BSD-3-Clause © Fishsb (lk)
