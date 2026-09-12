<div align="center">

# 🧭 dsh-project-nav

**面向 DeepSeek Harness（DSH）的项目反漂移治理插件**

[![version](https://img.shields.io/badge/version-0.10.1-blue)](../../releases)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-green)](./LICENSE)
[![dsh-tools](https://img.shields.io/badge/dsh--tools-%3E%3D0.1.2--rc.1-orange)](https://www.npmjs.com/package/@deepseek-ai/dsh-tools)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](./package.json)

*每个任务从架构出发 · 每个文件都有落点 · 一切皆可回溯*

</div>

---

> **核心理念（唯一上位约束）**
>
> **所有开发动作必须从架构出发。**
> 架构不出错，开发过程中出现一点问题也只是局部小问题；反之，架构错了，局部补得再好也是在错误的骨架上堆砌。

**它解决的问题**：AI 写单个文件没问题，但**在引用之间没有全局思想**——
改一个文件不知道牵动谁，于是只能在一个文件里越堆越长。本插件把「谁属于谁」和**「谁引用谁」**一起摊给模型看。

**v0.10.0 是架构换代**：模型从「包含树」升级为**「包含树 + 依赖图」**。
依赖边由 import 静态扫描**派生**（不是登记、不是手写、不会过期），同时闸门六 → 七，新增**影响面闸**。
设计契约见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

---

## 1. 一句话架构

> **一条 append-only 事件流（唯一事实源）+ 一个由它折叠出的架构模型（可丢弃缓存）+ 一层渲染投影。**
> **模型 = 包含树 + 依赖图；依赖图由磁盘 import 派生。闸门是对模型的查询，产出是模型的重渲染。**

```
   ┌────────────────────────────────────────────────────────────────┐
   │ ① 事件流  .internal/events.jsonl     ← 唯一事实源（append-only）│
   │   commit{锚点,scope,arch=,phase} · decide{ADR} · node{} · set{} │
   └───────────────────────────┬────────────────────────────────────┘
                               │ 纯函数折叠（I1）
   ┌───────────────────────────▼────────────────────────────────────┐
   │ ② 模型  .internal/runtime/arch-model.json    ← 可丢弃（I3）     │
   │   包含树(项目/模块/功能/工件) + 依赖图 + 证据 + 向量 + 计数      │
   │   依赖图 = import 静态扫描派生（磁盘实况，与 STALE/缺口同层）    │
   └───────────────────────────┬────────────────────────────────────┘
                               │ 全部派生（I2）
   ┌───────────┬───────────────┼───────────────┬───────────────────┐
   ▼           ▼               ▼               ▼                   ▼
 nav_graph  PROJECT.md      ARCH-MODEL.md   地图 HTML         一页总览
 （闸门=查询）（渲染）        （渲染）        （渲染）        （影响面直出）
```

**三条不变式（可机检）**

| | 不变式 | 验法 |
|---|---|---|
| **I1** | 单源：模型每条属性都能由「事件流 + 磁盘实况」复算，无第二手写真相 | 复算 == 缓存（**依赖图两路径必须一致**，否则缓存就是第二个答案） |
| **I2** | 渲染：地图 / `PROJECT.md` 标记区 / `ARCH-MODEL.md` 全部由模型生成 | 手改渲染物 → 下次渲染覆盖它 |
| **I3** | 可丢弃：删掉整个 `.internal/runtime/` → 治理零损失（**依赖图同办**） | 删后跑全量查询，结果一致 |

## 2. 治理面最小化（第一性判据）

> **会因代码变更而"过期"的文档，不该是文档 —— 该是投影。**

投影 = 零手写、随时重生、**没有"过期"这回事**（因为没人维护它）。于是手写面只剩两样：

| 面 | 载体 | 何时改 |
|---|---|---|
| **契约** | `ARCHITECTURE.md` · `AGENTS.md` | 只在架构换代 / 纪律变更时 |
| **投影** | `PROJECT.md` 标记区 · `ARCH-MODEL.md` · 地图 · `nav_graph` 直出的一页 | 永不手写，随时重算 |

`.internal/arch/*.md` 曾是要维护的资产（sha1 指纹 + 新鲜度机检 + 行号重锚），
0.10.0 起降级为**按需临时投影**：不盖指纹、不做机检。要让它被按任务检索到，
登记成普通 `artifact` 节点（`nav_node layer=artifact when=…`），走 `nav_graph mode=docs`。

## 3. 六个工具（11 → 6）

工具数下降**不是目标**，是"闸门变查询、产出变渲染"的结果。

| 工具 | 模型操作 | 典型用法 |
|---|---|---|
| `nav_graph` | **读**：落点 / **影响面** / 缺口 / 覆盖度 / 文档路由 / 健康快照 / 地图 | `nav_graph mode=impact target=core/model.js` |
| `nav_commit` | **写**：登记改动意图（锚点 + scope + `arch=` 一句话），跑七闸；**自动按证据收上一笔** | `nav_commit task="加一层校验" anchor=PN-F01 arch="架构不变" features=PN-F01` |
| `nav_decide` | **写**：架构决策（挂节点，登记即重置该节点补丁计数） | `nav_decide anchor=PN-F01 reason=… decision=…` |
| `nav_node` | **写**：节点 upsert / 退役并级联 / 参考文档工件 | `nav_node target=E-F01 name=编辑器 files=src/a.js` |
| `nav_render` | **写**：重生成全部投影 | `nav_render` |
| `nav_set` | **写**：主线向量（doing / next / notDoing / exit） | `nav_set doing="收口 shoucang" notDoing="pmg 融合"` |

### 看一眼影响面：`nav_graph mode=impact`

这是本插件存在的理由。动手前问一句「我改的东西，谁在引用」：

```
File: core/model.js  —  1 个落点文件

↓ 我引用谁:
  core/model.js → core/log.js, core/paths.js, core/scope.js

↑ 谁引用我 = 影响面（9 个文件 · 7 个节点）:
  bootstrap.mjs ← 被 core/model.js 引用
  core/commit.js ← 被 core/model.js 引用
  ...
```

### 最重要的行为变化：**收口不需要第二个动作**

- 登记一笔改动 = 一次 `nav_commit`，它记下 scope 内每个文件的 `{size, mtimeMs, sha1}` 作为**证据**。
- 改完文件后，**下一次任意工具调用**（任意会话）发现证据变了 → 自动收口。
- **收口不依赖会话**：会话死了，意图照旧被任意会话按证据收口。
- 证据没变 ⇒ 意图继续**在途**（有人正在改 = 正常状态，不是孤儿）。
- 唯一绕过证据的出口：`nav_commit mode=archive id=ACT-N reason=…`。

## 4. 七个闸门（全部是 `nav_commit` 内的模型查询）

| 闸门 | 问题 | 判据 | 强度 |
|---|---|---|---|
| **锚点闸** | 架构节点真实存在吗？ | 节点在模型中，或锚定 `.internal/arch/*.md` | 拒 |
| **范围闸** | 撞主线反面吗？撞别人在途 scope 吗？ | `notDoing` 命中 → 拒；与他在途重叠 → 告警 | 拒/告警 |
| **主线闸** | scope 里的模块在主线上吗？ | 未被 `doing/next` 引用 → 告警 | 告警 |
| **影响面闸** | scope 的落点被**别的节点**引用了吗？ | 跨节点下游未纳入 scope → 告警（测试文件不算意外下游） | 告警 |
| **计数闸** | 同一锚点又在反复打补丁？ | 自上次决策以来 ≥ 3 次 → **强制先出决策** | 拒 |
| **决策闸** | 这次改动需要架构变更吗？ | `arch=` 缺失 → 告警要求一句话回答 | 告警 |
| **完结闸** | 有该收而未收的意图吗？ | 开新笔时按证据自动收旧；异常才报 | 自动 + 报异常 |

闸门是**查询**而不是流程，因此不可能产生"孤儿状态"，也无法被"另开一条路"绕过——写入只有一个入口。

## 5. 数据面：3 层

| 层 | 路径 | 生命周期 | 版本控制 |
|---|---|---|---|
| **事件流** | `.internal/events.jsonl` | 永久 | **是**（唯一事实源） |
| **运行时** | `.internal/runtime/`（模型缓存 · **依赖图** · 在途 · 锁 · 诊断） | 短命 | **否**（gitignore，可丢弃可重建） |
| **渲染投影** | `PROJECT.md` 标记区 · `.internal/ARCH-MODEL.md` · `runtime/map-*.html` | 可再生 | 投影本身可进仓 |

**不存在第四层**：任何新的长期状态先回答"它是事件，还是渲染？"，两者都不是就不该存在。
依赖图**不是第四层**——它是磁盘实况，与 STALE 探测、缺口扫描在同一位置计算。

> `.gitignore` 必须**只排除 runtime**，不能整目录排除 `.internal/`——
> 否则事件流不进版本控制，新 clone 读不到任何决策，"决策可传播"就是一句空话。

## 6. 安装

```bash
# 1) 打包（在插件仓根）—— 产物名含版本号，从 package.json 派生
npm pack --cache .npm-cache      # 产出 dsh-external-project-nav-<ver>.tgz

# 2) 装进 profile：直接跑装脚本（它自己从 package.json 读版本、摊开 tgz、定点改声明、自证）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\FF\project-nav\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File D:\FF\project-nav\verify-install.ps1

# 3) 重启 dsh —— 装与重启是两条时间线，重启前线上仍是旧版
```

> ⚠ profile 里**不能跑 npm install**（`link:` 协议不被接受）。用 **`install.ps1`** 直接 `tar` 展开。
> 脚本**版本无关**（版本从 `package.json` 读）—— 换代不再新增脚本。详见 [`AGENTS.md`](./AGENTS.md) §4。
> `verify-install.ps1` 验五级：声明面 / 实体面 / 树 = 包 = 装 / 架构面 / **运行时面**。
> 最后一级是必需的——**静态对得上 ≠ 能加载**。

**配置**（profile 里的插件项）：

| 键 | 默认 | 说明 |
|---|---|---|
| `root` | `''` → 进程 cwd | 被治理工作区根（其 `.internal/` 存事件流）。**建议显式设置** |

## 7. 测试

```bash
npm test                  # 四个套件：94 项
npm run test:node-runner  # 同一批用例走 node --test
```

| 套件 | 覆盖 |
|---|---|
| `test/core.test.mjs` | 事件流 / 折叠 / scope 解析 / 七闸 / **依赖图扫描与影响面** / 收口（43） |
| `test/architecture.test.mjs` | **不变量** I1·I2·I3（含依赖图双路径一致与可重建）· A1·A4·A5·A6（20） |
| `test/concurrency.test.mjs` | F1 并发追加不丢 / F2 破锁竞态 / token 校验 / 重入 / 无锁残留（12） |
| `test/host.test.mjs` | 真 host 代码 + 桩 ctx：装配面 6 工具、闸门接线、**nav_graph mode=impact 端到端**、归属归一回归（19） |

> 沙箱提示：`node --test` 会用管道 spawn 子进程，在某些受限沙箱下报 `spawn EPERM`。
> `npm test` 直接执行测试文件（文件被直接运行时 `node:test` 同样执行），因此不受影响。

## 8. 版本规则

> **每次更新一律 +0.0.1**，不因"加功能"跳中间位（lk 2026-09-10 定调）。
> **例外：架构换代**才允许跳位，且必须在变更日志里写明"换代"二字。

- `0.8.6 → 0.9.0`：换骨架（决策丢弃、事实 F1–F9 保留）。
- `0.9.2 → 0.10.0`：**换代** —— 模型从「包含树」升级为「包含树 + 依赖图」，闸门六 → 七。
- `0.10.0 → 0.10.1`：**修 bug**（非换代）—— 计数闸曾把 `closed` 收口回执也当补丁数，每笔改动被计两次、
  阈值 3 实际在 ~1.5 笔就触发；另修 `.d.ts` 被当代码扫、退役锚点计数仍显示。

## 9. 开发纪律

1. 改代码前先读 [`ARCHITECTURE.md`](./ARCHITECTURE.md)——它是本仓的架构契约，不是说明书。
2. 改了架构先改契约；契约之外不新增文件（新增即架构变更）。
3. 渲染物永不手写：手改 `PROJECT.md` 标记区 / `ARCH-MODEL.md` / 地图，下一次 `nav_render` 就覆盖它。
4. **会因代码变更而过期的文档，不该是文档 —— 该是投影。**（§2）
5. 事故事实（F1–F9）不可丢弃：它们是需求，只有实现方式可以换。

## License

BSD-3-Clause © Fishsb (lk)
