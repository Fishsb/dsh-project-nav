# 本仓开发纪律（AGENTS.md）

> 面向在本仓工作的 agent 与维护者。**改代码前先读 [`ARCHITECTURE.md`](./ARCHITECTURE.md)** —— 它是本仓的架构契约，不是说明书。

## 0. 上位约束（唯一）

> **所有开发动作必须从架构出发。**
> 架构不出错，开发过程中出现一点问题也只是局部小问题；反之，架构错了，局部补得再好也是在错误的骨架上堆砌。

判据很具体：**动手前能说出这次改动落在哪个架构节点上**（功能码 / 模块 / 文件 / `.internal/arch/*.md`）。
说不出 = 还没做架构思考，十有八九是局部补丁。

## 1. 三条不变式是硬约束（不是"尽量"）

| | 不变式 | 违规的样子 |
|---|---|---|
| **I1** | 单源：模型每条属性都能由「事件流 + 磁盘实况」复算 | 又加了一个手写账本文件；把 `runtime/` 里的值当真相读 |
| **I2** | 渲染：地图 / `PROJECT.md` 标记区 / `ARCH-MODEL.md` / 架构档指针全部由模型生成 | 手改渲染物；给渲染物加需要人工维护的字段 |
| **I3** | 可丢弃：删掉 `.internal/runtime/` → 治理零损失 | 把任何"不能丢"的东西放进 `runtime/` |

改完任何东西，跑 `npm test`（98 项）——三条不变式都有可机检的用例。

## 2. 版本规则

> **每次更新一律 +0.0.1**，不因"加功能"跳中间位（lk 2026-09-10 定调）。
> **唯一例外：架构换代**才允许跳位，且必须在变更日志与 README §8 里写明"换代"二字。

已发生的例外：`0.8.6 → 0.9.0`（不是加功能，是换骨架：决策丢弃、事故事实 F1–F9 保留）。

## 3. 发布链（装与重启是两条时间线）

```bash
cd D:\FF\project-nav
npm pack --cache .npm-cache          # 产出 dsh-external-project-nav-<ver>.tgz
```

1. **产物名含版本号 ⇒ 声明必须同步**：profile 的 `dependencies` 里那条 `file:...tgz` 要一起改。
   历史上发生过"复制副本让插件看起来更新了、声明没改"的假绿事故。
2. **重启由用户手动执行**。装完不重启，线上仍是旧版 —— 别把"装好了"当"生效了"。
3. 核实生效：查 profile 安装副本的 SHA256、`--dump-config` 无报错、新会话工具清单出现预期工具。

> `npm pack` 在某些受限沙箱下会因 npm 缓存目录在工作区外而 `EPERM`；
> 用 `--cache .npm-cache`（工作区内）即可，不是放宽安全策略，只是改路径。

## 4. 本会话/本仓的已知边界（实测，别重复踩）

| 边界 | 事实 | 应对 |
|---|---|---|
| 文件沙箱 | `workspace-write` 的可写根是 `D:\FF\project-nav`，**不含** `D:\FF` 与 `~/.dsh` | 需要改被治理根或 profile 时，交给用户手动执行 |
| `node --test` | 用管道 spawn 子进程 → 受限沙箱下 `spawn EPERM` | 用 `npm test`（直接执行测试文件，`node:test` 照跑） |
| Node 直接 spawn | `child_process` 抓管道输出 → `EPERM` | 别在 Node 里 spawn 子进程；需要的字节转换在本 shell 内用 .NET API 做 |
| PowerShell 写文件 | **PS 5.1 的 `Set-Content -Encoding utf8` 会按 GBK 误读 UTF-8 源文件并写坏中文** | **一律用编辑工具改文本**；确需 PS 批量处理时只用 `[System.IO.File]::ReadAllBytes/WriteAllBytes` 做字节级操作 |
| PowerShell 读脚本 | **PS 5.1 读无 BOM 的 UTF-8 `.ps1` 会按 GBK 解码**，中文（尤其全角标点）会把字符串终结符吃掉 → 语法错 | 含非 ASCII 的 `.ps1` 必须存成 **UTF-8 with BOM**；而 `package.json` / `.js` / `.md` 必须**无 BOM**（node 不认 BOM） |
| PS 5.1 语法子集 | 不支持 `??`、`?.`、三元 `? :`、`-Encoding utf8NoBOM` | 用 `if/else` 与显式变量分支；写 JSON 用 .NET `UTF8Encoding($false)` |
| **profile 里不能跑 npm 装** | profile 含 `"@dsh-external/dsh-motion": "link:..."`，npm 10.9.4 不接受 `link:` 协议（`EUNSUPPORTEDPROTOCOL`）；npm 在 reify 时会解析**整份** package.json，所以 `npm install` 与 `npm install <tgz> --no-save` **都会**失败；又没有 `package-lock.json`（只有 `node_modules/.package-lock.json`）故不能 `npm ci` | 装本地 tarball 用 **`install-0.9.0.ps1`**：直接 `tar` 展开到 `node_modules/@dsh-external/project-nav/`（npm 对本地包做的本就是这件事），**完全不经过 npm**；声明另行定点改写 |
| 别在空目录里跑 `npm install <pkg>` | npm 会**向上找最近的 `package.json`** —— 在仓内临时目录里跑，它就把依赖树装进**本仓** `node_modules`（已实测发生，且它不改 package.json，很容易误判为成功） | 试验要放在仓**外**的临时目录，或用 `--prefix`；试验后清掉生成的 `node_modules` |

## 5. 事故事实不可丢弃（F1–F9）

它们写在 [`ARCHITECTURE.md`](./ARCHITECTURE.md) §8，**是需求不是历史**。架构可以重画，这些事实不能改：
并发追加不丢（F1）· 破锁用 rename + token（F2）· 能删才不留假 STALE（F3/F8）· 落点解析三来源都不许丢（F4）·
装与重启两条时间线（F5）· 边界只收工作自包含的项目（F6/F7）· 只用追加或整体重写 + 读回校验（F9）。

## 6. 迁移纪律（旧账本 → 事件流）

- `nav_graph mode=legacy` 先看清全貌 → `nav_node layer=migrate` → `nav_render`。迁移**只跑一次**。
- 迁移后旧账本进 `.internal/legacy/`（只读快照），**不再被任何读路径读取** —— 不存在第二个真相。
- ⚠ **不要混用**：0.9.0 不读旧账本，0.8.6 不读事件流。切换前先确认哪一版在跑。

## 7. 数据面的正确写法

```gitignore
!.internal/
.internal/*
!.internal/events.jsonl      # 唯一事实源：必须进版本控制
!.internal/ARCH-MODEL.md     # 人类可读的模型快照，进仓以便 diff 审查
.internal/runtime/           # 可丢弃
.internal/legacy/            # 旧账本只读快照
```

整目录忽略 `.internal/` 是**错的**：事件流不进版本控制，新 clone 读不到任何决策，"决策可传播"就成了空话。
