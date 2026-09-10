# [项目事实] reference · project-nav 已知代码问题（v0.7.0 复核）

- 卡类型：reference
- 溯源：project-nav 审查 seq37326（原始快照已过时；本卡按 **v0.7.0** 实测逐项复核）
- 源会话：session-471aca03-3da2-4078-8dc1-3493071f0953（原始） / 2026-09-10 多次复核
- 工作区：D:\FF\project-nav

## 已修复（逐项实测，含 2026-09-10 本轮）

| 问题 | 现状 | 依据 |
|---|---|---|
| `host/index.js` 硬编码 `D:/FF/project-nav` | ✅ 已修（v0.2.10） | `root` 默认空串，`config.root` 显式传入，未配置时回退 `process.cwd()` 并 boot warn |
| `host` 与 `shared` 逻辑重复 | ✅ 已修（v0.2.0） | host 仅 import `../shared/index.js`，无内联复制 |
| `client/` 已声明移除但目录仍存 | ✅ 已修 | 仓库无 `client/` 目录；README 不再声称 UI 面板 |
| `package.json` scripts 指向缺失文件 | ✅ 已修（v0.4.0） | `test = node --test test/core.test.mjs test/concurrency.test.mjs`，**43 用例实跑全绿** |
| 索引 PN-P01 死条目 / 多重挂载 | ✅ 已修（本轮） | `shared/tools/*`（5）、`client/index.js`、`scripts/build.mjs` 已移出索引；`PN-F01..F05` 三重挂载收敛为单模块；`functionToModule` 4 条层级错置键清除；PN 模块 5→2 |
| **索引写路径无互斥（G2）** | ✅ 已修（v0.7.0） | 四个 `mutate*` 入口 + `nav_sync_docs` 全部入 per-target 锁（`.internal/locks/`）；`saveIndex/saveDocs/saveVector/saveArch` 在 host 中已无直接调用 |
| 部署声明与实体不一致 | ✅ 当前一致（v0.7.0） | 声明 `file:…dsh-external-project-nav-0.7.0.tgz` = 产物内部 0.7.0 = 已装副本 0.7.0（三层 SHA256 MATCH）。**注意这是每版必做的动作**，见下「流程风险」 |

## 开放问题（v0.7.0 复核仍存在）

1. **`shared/index.js` 直接依赖 `node:fs`（G3，沙箱不兼容）**——已处置为「探测 + 显式告警」而非改造：`apply` 时会探测 `ctx.fs`，存在则 warn 提示「本插件仍走 node:fs 直读直写 `.internal/`，若本部署对插件 fs 强制围栏，治理数据可能绕过围栏」。
   暂不做异步 fs 端口双后端：当前宿主进程未受限（node:fs 全程可用），双后端会让 IO 层翻倍，违反 v0.6.0 的复杂度预算。**触发条件**：出现真实受限部署时一次性迁移；届时若注入能力无独占创建，锁必须显式降级告警（进程内队列 + `replaceIfVersion` 陈旧守卫），不得静默失效。
2. **无不变量/宪法层（G5）**——有意不引入：会给模型增加必须学习的新概念，而锚点闸 + ADR 已覆盖「先做架构思考、决策留痕」的意图。触发条件：出现「必须硬拦且 ADR 拦不住」的真实案例。
3. **性能与粒度的取舍**：锚点/指纹均为**文件级**，同一文件内的不同函数仍会被判冲突（保守串行）。当前可接受；若将来成为瓶颈，再评估函数级归属。
4. **流程风险（反复复发过两次）**：profile 声明里写的是**带版本号的 tgz 文件名**，而 bump 不会自动改声明 → 手工复制副本可让插件「看起来更新了」，从而掩盖声明未同步。发布必须走 `HANDOFF §33.4` 六步清单（bump → pack → 改声明 → 按需装 → 核拓扑与 dump-config → 用户重启）；根治方案（固定产物名 / `link:` 源码直连）见 §33.4 备选，**待 lk 决策**。

## 说明

- 本卡原始内容为 v0.2.x 时期快照（"索引 7/11/5"与当前不同源），故按实测逐项复核重写；此后随每轮架构审查更新。
- 复核方法：`nav_status` / `nav_query` 实跑 + 源码与文件系统直查 + profile 装配核对（SHA256 三层比对 + `dsh --profile web --dump-config`）。
- 关联：架构审查与开源对比见 `2026-09-10-reference-开源对比与架构审查.md`；G2/G3/G5 的完整决策见 `HANDOFF §32/§34`。
