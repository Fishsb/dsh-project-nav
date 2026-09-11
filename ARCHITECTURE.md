# project-nav 架构（v0.9.0 · 一次性重写）

> **上位约束**：所有开发动作必须从架构出发。架构不出错，局部问题只是小问题；架构错了，局部补得再好也是在错误骨架上堆砌。
>
> 本文是**本仓自己的架构契约**，不是说明文档。改代码前先读它；改了架构先改它。
> 生成物（`PROJECT.md` 标记区 / 地图 / `ARCH-MODEL.md` 指针）永不可手写——手写即被下次渲染覆盖（I2）。

---

## 1. 一句话架构

> **一条 append-only 事件流（唯一事实源）+ 一个由它折叠出的架构模型（可丢弃缓存）+ 一层渲染投影；闸门是对模型的查询，产出是模型的重渲染。**

## 2. 三层数据面（`PLANE`）

| 层 | 路径 | 生命周期 | 版本控制 | 谁能写 |
|---|---|---|---|---|
| **事件流** | `.internal/events.jsonl` | 永久 | **是** | 只追加，永不修改（模型层的唯一真相） |
| **运行时** | `.internal/runtime/` | 短命 | **否**（gitignore） | 模型缓存 · 在途意图 · 锁 · 诊断 |
| **渲染投影** | `PROJECT.md` 标记区 · `.internal/ARCH-MODEL.md` · `runtime/map-*.html` · 架构档 `arch-cache` 头 | 可再生 | 是（正文部分） | 只有 `nav_render` |

**不存在第四层。** 任何新的长期状态都必须先回答："它是事件，还是渲染？"两者都不是 → 它不该存在。

## 3. 三条不变式（可机检）

- **I1 单源**：模型的每一个属性都能由 `事件流 + 磁盘实况` 复算；不存在第二个手写真相。
  - 事件流是**唯一事实源**；`runtime/arch-model.json` 是它的折叠结果，不是真相。
  - 复算 == 缓存时，模型才算自洽。
- **I2 渲染**：地图 / `PROJECT.md` 标记区 / 模型文档 / 架构档指针 **全部**由模型纯函数生成。
  - 渲染物零手写；手写的只有「一行契约」（`AGENTS.md`）与「决策事件」。
- **I3 可丢弃**：**删除 `runtime/` 全部内容 → 治理零损失**，工具在下一次调用时重建。
  - 这是本架构最锋利的一条验收：它把"运行时状态"和"长期资产"彻底分开，
    让 D4"数据面混装"这类错误不可能再发生。

## 4. 事件模型（唯一写入面）

事件是 `events.jsonl` 里的一行 JSON，`seq` 由追加顺序分配（**ID 直接由 seq 派生**，所以并发追加不可能撞 ID）：

| kind | 字段 | 语义 |
|---|---|---|
| `commit` | `seq, at, anchor, task, plan, scope{features,modules,files}, arch, actor, phase` | 一次改动意图；`phase=open` 记录 scope 证据，`phase=closed` 记录收口结果 |
| `decide` | `seq, at, anchor, reason, decision, impact, action` | 架构决策（ADR）；`id = ADR-<seq>` |
| `node` | `seq, at, op=upsert|retire, layer, id, fields` | 节点登记 / 退役（级联） |
| `set` | `seq, at, vector{doing,next,notDoing,exitCondition}` | 根元数据 / 主线向量 |

**收口（`closed`）不依赖会话**：
- 一笔 `open` 意图的 scope 证据 = 该 scope 内文件的 `{size, mtimeMs, sha1}`。
- **证据已变** ⇒ 下一次任意工具调用**自动收口**（`evidence=changed`）。
- **证据未变** ⇒ 意图继续在途（`evidence=unchanged`），且**没有未收口状态**——
  在途 = 有人正在改，不是"孤儿"。
- 会话死亡 ⇒ 在途意图照旧可被任意会话按证据收口（A1）。**"只有会话能驱动自己的动作"这条设计被删除。**
- **收口判据必须是"按 scope 声明重解析"而不是登记时的文件快照**：新造出来的文件在登记时还不存在，
  用快照比对就永远看不见"新增"这一类变化，那类改动会永久卡在在途。
- 证据比对**先判存在性、再比内容**：先比 sha1 会把"消失"误报成"被修改"（收口证据说谎）。

## 5. 六个闸门（全部是 `nav_commit` 内的模型查询）

| 闸门 | 查询的问题 | 判据 | 强度 |
|---|---|---|---|
| **锚点闸** | 这个任务的架构节点真实存在吗？ | 节点在模型中，或锚定 `.internal/arch/*.md` | 拒（ERROR） |
| **范围闸** | scope 撞主线反面吗？撞别人在途 scope 吗？ | `notDoing` 命中 scope → 拒；与他在途重叠 → 告警 | 拒 / 告警 |
| **主线闸** | scope 里的模块在主线上吗？ | 模块未被 `doing/next` 引用 → 告警 | 告警 |
| **计数闸** | 同一锚点是否又在反复打补丁？ | 该锚点自上次决策以来 `commit` 数 ≥ 3 | 拒 |
| **决策闸** | 这次改动需要架构变更吗？ | `arch=` 缺失 → 告警要求一句话回答 | 告警 |
| **完结闸** | 有该收而未收的意图吗？ | 开新意图时按证据收旧；证据变而无人报 → 报异常 | 自动 + 报异常 |

> 计数闸与决策闸的区别：决策闸要求"回答架构问题"（`arch=`），计数闸在**同一锚点被反复补丁**时强制先出决策。

## 6. 工具面：11 → 6（每个工具 = 模型上的一种操作）

| 工具 | 模型操作 | 吸收的旧工具 |
|---|---|---|
| `nav_graph` | **读**：影响面 / 落点 / 缺口 / 覆盖度 / 文档路由 / 健康 / 架构档新鲜度 | `nav_query` `nav_status` `nav_docs`(读) `nav_map`(读侧) `nav_arch list\|check` |
| `nav_commit` | **写**：登记改动意图（锚点 + scope + `arch=` 一句）；开新笔时按证据自动收上一笔 | `nav_plan` `nav_mark` |
| `nav_decide` | **写**：架构决策（挂节点；登记即重置该节点补丁计数） | `nav_adr` |
| `nav_node` | **写**：节点 upsert / 退役并级联；文档工件注册同此入口 | `nav_update` `nav_docs`(写) |
| `nav_render` | **写**：重生成全部投影（PROJECT.md / 模型文档 / 地图 / 架构档指纹） | `nav_sync_docs` `nav_arch stamp` |
| `nav_set` | **写**：根元数据与主线向量 | `nav_set_vector` |

工具数下降**不是目标**，是"闸门变查询、产出变渲染"的结果。若实现中发现两个工具可合并，按 I2 继续收。

## 7. 迁移（一次性重写 · 已拍板）

1. 旧账本 5 个文件（`nav-index.json` / `vector.json` / `nav-actions.json` / `nav-docs.json` / `nav-arch.json`）
   → 一次性折叠为事件流（`node` / `set` / `commit` / `decide`）。
2. 迁移后旧账本**归档为只读快照**（`.internal/legacy/`），不再被任何代码读写。
3. 失败回切：**没有回切**（本轮不保留二段式侧车）。旧快照仅作取证材料。

## 8. 不可丢弃的事故事实（F1–F9，新架构的需求）

| # | 事实 | 新架构如何满足 |
|---|---|---|
| F1 | 两会话并发写 → 索引被覆盖回退 | 事件流 append-only（追加不覆盖）；模型缓存由 `runtime/` 锁保护重写 |
| F2 | 破锁竞态 `stat→unlink` 删掉别人新锁 | 破锁保留 `rename + token 校验`；锁**必须可重入**（写入编排会在锁内追加事件），否则并发路径退化成长等待 |
| F3 | 假警报腐蚀信号（曾 7 条假 STALE） | 退役语义保留 + I1 单源 |
| F4 | scope 解析曾丢路径 ⇒ 12/18 功能指纹恒空 | 落点 = 索引键 ∪ 字面量 ∪ glob 展开，并带断言 |
| F5 | 装与重启是两条时间线 | 发布链契约照旧（tgz → profile → 重启） |
| F6 | Windows `workspace-write` 只有一个可写根、不含 `~/.dsh` | 边界白名单只收工作自包含的项目 |
| F7 | 服务账户无 logon SID ⇒ 沙箱后端起不来 | 探针不过即不绑定 |
| F8 | 索引"能增不能删"⇒ 永久假 STALE | 退役能力保留 |
| F9 | `mutateJsonFile` 保存旧对象 ⇒ 内容静默不落盘 | 只用**追加**与**整体重写 + 读回校验**，禁止"保存旧对象"式静默 |

## 9. 文件落点

```
ARCHITECTURE.md      本文：架构契约（改架构先改它）
AGENTS.md            本仓开发纪律：版本规则 / 发布链 / 已知边界 / 迁移纪律
PROJECT.md           项目主档（标记区内是渲染物；标记外手写）
bootstrap.mjs        自举：把本仓的架构折叠成事件并生成投影（一次性）
install-0.9.1.ps1    运维件：把 0.9.1 装进 profile（摊开 tgz + 改声明；需用户执行）
verify-0.9.1-install.ps1  运维件：独立校验安装面四件事（只读，可重启前跑）
host/index.js        Cordis 装配：6 工具注册（唯一 host 面）
core/paths.js        路径契约与平面（PLANE）
core/log.js          事件流：追加 / 读取 / seq 复算 / 写回校验（F9）
core/lock.js         runtime 锁：rename 破锁（F2）+ token 校验 + 可重入
core/model.js        折叠：事件流 + 磁盘实况 → 架构模型（I1）
core/scope.js        落点解析三来源合并（F4）与证据指纹/比对
core/gates.js        六闸（纯函数查询）
core/commit.js       写入编排：意图登记 + 按证据自动收口
core/render.js       渲染投影（I2）+ 架构档指纹解析与 stamp
core/format.js       输出文本成形（说给模型看的话都在这里）
core/legacy.js       旧账本 → 事件流迁移器（一次性）
test/core.test.mjs           领域行为基准（43）
test/architecture.test.mjs   不变量 I1/I2/I3 · A1–A6（22）
test/concurrency.test.mjs    并发与锁（F1/F2）（12）
test/host.test.mjs           真 host 代码 + 桩 ctx 的装配面与端到端（21）
test/host-harness.mjs        host 编译夹具（data:/file: shim）
test/helper.mjs              临时 root 夹具
test/tools-list.mjs          工具面静态契约扫描（A6/A5 的判定依据）
```

**每个文件都有落点**：上表之外不新增文件；新增即意味着架构变更，须先改本文。
自证的工程面由功能 `PN-F09`「测试与契约面」承载（落点用 glob，新文件自动纳入）。
