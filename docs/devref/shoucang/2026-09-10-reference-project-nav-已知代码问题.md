# [项目事实] reference · project-nav 已知代码问题（2026-09-10 复核更新）

- 卡类型：reference
- 溯源：project-nav 审查 seq37326（原始快照已过时，本节按 v0.4.0 实测复核）
- 源会话：session-471aca03-3da2-4078-8dc1-3493071f0953（原始） / 2026-09-10 复核
- 工作区：D:\\FF\\project-nav

## 已修复（原始卡所列问题，逐项复核）

| 原始问题 | 现状 | 依据 |
|---|---|---|
| `host/index.js` 硬编码 `D:/FF/project-nav` | ✅ 已修（v0.2.10） | `root` 默认空串，`config.root` 显式传入，未配置时回退 `process.cwd()` 并 boot warn |
| `host` 与 `shared` 逻辑重复 | ✅ 已修（v0.2.0） | host 仅 import `../shared/index.js`，无内联复制 |
| `client/` 已声明移除但目录仍存 | ✅ 已修 | 仓库无 `client/` 目录；README 不再声称 UI 面板 |
| `package.json` scripts 指向缺失文件 | ✅ 已修（v0.4.0） | `test` = `node --test test/core.test.mjs test/concurrency.test.mjs`（27 用例实跑全绿） |
| 索引 7 features/11 files/5 modules（与真实不符） | ⚠ 见下（开放项） | 当前索引 PN-P01 仍有死条目 |

## 开放问题（2026-09-10 复核仍存在）

1. **`shared/index.js` 依赖 `node:fs`，受限沙箱不兼容**（仍未修，最高优先级）。
   待改：fs 能力由 `ctx.get('fs')` 注入。注意 v0.4.0 新增的**账本文件锁**（`openSync` O_EXCL / `rmSync`）与**scope 指纹**（`statSync` / `readFileSync` / `readdirSync` / `node:crypto`）是重度使用处——若注入能力无独占创建，锁必须**显式降级告警**（进程内锁 + 陈旧检测），不得静默失效。
2. **索引 PN-P01 死条目 / 多重挂载复现**：`shared/tools/*.js`（5 个，v0.2.0 已删）、`client/index.js`、`scripts/build.mjs` 仍在索引里；`PN-F01..F05` 同时挂在 `PN-M01/02/03` 三个模块上；`PN-M04`(PN-F06)/`PN-M05`(PN-F07) 为空壳。v0.2.9 清理过同一问题，本次复核发现已回退。`nav_status` 因此报 14 条 STALE。
3. **部署声明与实体一度不一致（已消除）**：profile 依赖原声明 `file:…0.2.10.tgz` 而实体是 0.4.0，重装会静默回退；2026-09-10 已改为 `file:D:/FF/project-nav/dsh-external-project-nav-0.4.0.tgz` 并经官方通道安装、核对单实例拓扑。

## 说明

- 本卡原始内容为 v0.2.x 时期快照（"索引 7/11/5"对应当时某次临时树，与当前 23 features/45 files/9 modules 不同源），故按实测逐项复核后重写。
- 复核方法：`nav_status` / `nav_query` 实跑 + 源码与仓库文件系统直查 + profile 装配核对。
