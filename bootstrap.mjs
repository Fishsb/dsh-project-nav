// bootstrap.mjs — 让 project-nav 治理它自己（一次性运行）
//
// 为什么要有这一步：治理要先能治理自己，否则这套架构就只是对别人生效的口号。
//
// 这里做一件事：
//   把本仓的架构（模块/功能/落点）折叠成事件 —— 从此它就是可引用、可校验的模型对象
//
// ⚠ 0.12.0 换代（ADR-268）：原先的 ②「用 nav_render 的同一批渲染函数产出 PROJECT.md 标记区 /
// ARCH-MODEL.md / 地图」**已删除** —— 落盘投影整体退场（唯一读者是人，而定案是「只服务 agent」）。
// 现在不需要任何"产出文件"的动作：治理经 nav_graph 按需直出 + 在场层每轮注入。
//
// **一次性**：事件流是 append-only 的，重复引导只会造出重复节点与重复决策 ——
// 所以本脚本发现事件流非空就拒绝运行。要重来请先删掉 .internal/events.jsonl 与
// .internal/runtime/（本仓自己的引导数据，可丢弃），而不是让脚本覆盖历史。
//
// 用法：node bootstrap.mjs

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvents, readEvents, verifyLog } from './core/log.js'
import { buildModel, loadModel } from './core/model.js'

const ROOT = process.cwd()

const PROJECT = { id: 'PN-P01', name: 'project-nav', path: '.' }

/** 模块：每个模块对应 ARCHITECTURE.md §9 里的一行落点（每个文件都有落点）。 */
const MODULES = [
  { id: 'core-plane', name: '平面契约', features: ['PN-F01'] },
  { id: 'core-log', name: '事件流', features: ['PN-F02'] },
  { id: 'core-model', name: '模型折叠', features: ['PN-F03'] },
  { id: 'core-gates', name: '七闸', features: ['PN-F04'] },
  { id: 'core-render', name: '渲染投影', features: ['PN-F05'] },
  { id: 'host-face', name: '装配面与工具', features: ['PN-F08'] }
]

const FEATURES = [
  {
    id: 'PN-F01', name: '平面契约', module: 'core-plane', files: ['core/paths.js'],
    userView: '只有两层数据面（事件流/运行时），任何新状态都必须先回答"它是事件还是渲染"',
    systemView: 'PLANE 常量 + 路径解析 + 规范化；不存在第三层的落点（0.12.0：落盘投影面已退场）'
  },
  {
    id: 'PN-F02', name: '事件流', module: 'core-log', files: ['core/log.js', 'core/lock.js'],
    userView: '唯一事实源：一条 append-only 的 JSONL，追加后读回校验（F9）',
    systemView: 'appendEvents 取 seq（ID 由 seq 派生）+ 三层读回校验；锁可重入（同锁嵌套不自锁）'
  },
  {
    id: 'PN-F03', name: '模型折叠', module: 'core-model', files: ['core/model.js', 'core/scope.js'],
    userView: '可丢弃的架构模型：删掉 runtime/ 后立刻可由事件流复算（I3）',
    systemView: 'foldEvents 纯函数 + attachAnchorKeys 归一锚点 + 磁盘实况叠加（STALE / 缺口 / 依赖图——import 静态扫描派生，非登记）'
  },
  {
    id: 'PN-F04', name: '七闸', module: 'core-gates', files: ['core/gates.js'],
    userView: '锚点/范围/主线/影响面/计数/决策/完结 —— 七个都是查询，所以不会产生孤儿状态',
    systemView: '七个纯函数返回 {pass,severity,detail,hint}；影响面闸用文件精度判「跨节点牵动」；runGates 汇总 blocked/warnings'
  },
  {
    id: 'PN-F05', name: '按需渲染与在场层', module: 'core-render', files: ['core/render.js', 'core/format.js'],
    userView: '治理不再落盘：nav_graph 按需直出 + 每轮把治理摘要注入 agent 上下文',
    systemView: 'renderTreeText（纯计算零写盘）+ renderPresence（在场层文本，吃 foldOnly 廉价模型）；0.12.0 删去三个落盘投影'
  },
  {
    id: 'PN-F08', name: '装配面与工具', module: 'host-face', files: ['host/index.js'],
    userView: '5 个工具：nav_graph / nav_commit / nav_decide / nav_node / nav_set',
    systemView: '唯一 host 面：工具注册（ctx.effect）+ systemPrompt 在场层注入 + tools/post-execute 写入后在场 + 启动自检'
  },
  {
    // 落点用 glob：新文件自动纳入，不必每次手工登记（否则治理本身又变成堆叠）
    id: 'PN-F09', name: '测试与契约面', module: 'host-face',
    files: [
      'test/*', 'ARCHITECTURE.md', 'AGENTS.md', 'README.md', 'README.en.md',
      'bootstrap.mjs', 'LICENSE', 'package.json', '.gitignore',
      'host/cordis.patch.yml', 'docs/*', 'docs/**/*',
      'install.ps1', 'verify-install.ps1', 'verify-runtime.mjs'
    ],
    userView: '不变量有可机检的用例；架构契约对人类可读（0.12.0：不再有渲染投影给人读）',
    systemView: '四个套件（core/architecture/concurrency/host）+ ARCHITECTURE.md 契约；投影面已退场，产出改为在场注入 + 按需直出'
  }
]

const ARTIFACTS = [
  {
    id: 'arch-contract', name: '架构契约（本仓）', path: 'ARCHITECTURE.md',
    when: '改代码前必读；改架构时必须先改它；判断"某个状态该落在哪一层"时',
    tags: ['architecture', 'contract']
  },
  {
    id: 'handoff', name: '历史交接记录', path: 'HANDOFF.md',
    when: '追溯 v0.8.x 及更早的实现选择、事故记录、发布过程时',
    tags: ['history']
  }
]

const MAINLINE = {
  doing: 'core-model 验证：把新架构的每条不变量用可机检的用例钉住',
  next: '在被治理根（D:\\FF）补齐 .gitignore 的三层规则 → 迁移旧账本 → 安装 0.9.0 并重启后实机验收',
  notDoing: '回到 begin/done 生命周期；让任何状态绕过事件流；把渲染物手写或回写进模型',
  exitCondition: 'I1/I2/I3 + A1…A6 全绿，且 lk 侧实机跑通"登记 → 改文件 → 自动收口 → 投影"闭环'
}

async function main() {
  if (existsSync(join(ROOT, '.internal', 'events.jsonl'))) {
    const { events } = readEvents(ROOT)
    if (events.length) {
      console.log(`events.jsonl 已存在（${events.length} 事件）—— 引导是一次性的，拒绝重复运行。`)
      console.log('要重来：删掉 .internal/events.jsonl 与 .internal/runtime/ 后再跑（本仓引导数据，可丢弃）。')
      process.exit(1)
    }
  }

  const drafts = [
    { kind: 'node', op: 'upsert', layer: 'project', id: PROJECT.id, fields: { name: PROJECT.name, path: PROJECT.path } },
    ...MODULES.map((m) => ({
      kind: 'node', op: 'upsert', layer: 'module', id: m.id,
      fields: { name: m.name, project: PROJECT.id, features: m.features }
    })),
    ...FEATURES.map((f) => ({
      kind: 'node', op: 'upsert', layer: 'feature', id: f.id,
      fields: { name: f.name, files: f.files, module: f.module, userView: f.userView, systemView: f.systemView }
    })),
    ...ARTIFACTS.map((a) => ({
      kind: 'node', op: 'upsert', layer: 'artifact', id: a.id,
      fields: { name: a.name, path: a.path, when: a.when, tags: a.tags }
    })),
    { kind: 'set', vector: MAINLINE },
    // 第一条决策：本次重写本身（架构换代 → 允许跳位发布）
    {
      kind: 'decide', anchor: 'PN-P01',
      reason: '旧骨架把"治理"实现成了流程：闸门是步骤而非查询，导致收口依赖会话身份（5/6 动作永久孤儿）；真相散在 5 个手写账本里且无证据字段，描述腐烂无警报；ADR 账本在所有仓之外，决策不可传播；长期资产与运行时状态混称"单一数据真身"。局部补丁已三次以上，架构必须换。',
      decision: '一条 append-only 事件流作为唯一事实源；架构模型是它的折叠（runtime 内，可丢弃）；地图/PROJECT.md/模型文档/架构档指针全部是模型的重渲染；六个闸门实现为唯一写入口 nav_commit 内的纯查询；工具面 11→6，数据面 7→3。收口判据从"会话身份"换成"scope 证据是否变化"。',
      impact: 'host/index.js 全量重写（11→6 工具）；shared/index.js 整体替换为 core/ 十个模块；test/ 四个套件 61 项重写；PROJECT.md 与 ARCHITECTURE.md 成为投影与契约',
      action: null
    }
  ]

  const written = await appendEvents(ROOT, drafts)
  console.log(`✓ 已写入 ${written.length} 条事件（seq ${written[0].seq}…${written[written.length - 1].seq}）`)

  const check = verifyLog(ROOT)
  console.log(check.ok ? '✓ 事件流 seq 连续' : `⛔ 事件流异常：${check.problems.join(' | ')}`)

  const model = loadModel(ROOT, { useCache: false })
  console.log(`✓ 模型：${model.nodes.size} 节点 / ${model.decisions.length} 决策 / ${model.openCommits.length} 在途`)

  // ⚠ 0.12.0：PROJECT.md 骨架创建与 renderAll 投影重生成**已删除**（落盘投影退场，ADR-268）。
  // 本脚本现在只做"把架构折叠成事件"这一件事 —— 产出面已无文件可写。

  const after = buildModel(ROOT)
  console.log(`✓ 复算校验：节点 ${after.nodes.size} · 缺口文件 ${after.unregistered.length} · STALE ${after.stale.length}`)
}

main().catch((e) => { console.error('bootstrap 失败:', e); process.exit(1) })
