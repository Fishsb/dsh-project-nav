// test/host.test.mjs — 装配面与端到端（真 host 代码 + 桩 ctx）
//
// 这一组回答的是"A4/A6 是否真的成立"：六个工具真的注册了吗？闸门真的接在写入路径上吗？
// 收口真的不需要第二次调用吗？—— 全部走真代码，只有 ctx 与 root 是替身。
//
// 旧套件用了同样的手法（data-URL shim 编译真 host），这里沿用并把它提到台面上。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpRoot, put, touch, seed } from './helper.mjs'
import { mountHost } from './host-harness.mjs'
import { appendEvents, readEvents } from '../core/log.js'
import { paths, PLANE } from '../core/paths.js'
import { buildModel } from '../core/model.js'
import { NEW_TOOL_NAMES } from './tools-list.mjs'

async function boot(t, { config = {} } = {}) {
  const root = tmpRoot(t)
  const h = await mountHost(root, { config })
  t.after(() => h.dispose())
  return { root, h }
}

test('装配面：恰好注册 6 个工具，名字与架构文档一致', async (t) => {
  const { h } = await boot(t)
  const names = h.stub.registered.map((x) => x.name).sort()
  assert.deepEqual(names, NEW_TOOL_NAMES.slice().sort())
  assert.equal(names.length, 6)
})

test('装配面：每个工具都是 ctx.effect 挂载的（卸载即净）', async (t) => {
  const { h } = await boot(t)
  assert.equal(h.stub.effects.length, 6, '每个工具一个 effect')
  assert.equal(h.stub.registered.length, 6)
  h.stub.disposeAll()
  assert.equal(h.stub.registered.length, 0, '释放 effect 后工具注册必须全部撤销')
})

test('nav_node：登记节点 → 模型与事件流都落地', async (t) => {
  const { root, h } = await boot(t)
  put(root, 'src/a.js')
  const out = await h.call('nav_node', { target: 'E-F01', layer: 'feature', name: '编辑器', files: 'src/a.js' })
  assert.match(out, /created feature "E-F01"/)
  const m = buildModel(root)
  assert.deepEqual(m.nodes.get('feature:e-f01').files, ['src/a.js'])
  assert.equal(readEvents(root).events.length, 1)
})

test('nav_node：retire 级联，且被在途改动引用时拒绝', async (t) => {
  const { root, h } = await boot(t)
  await seed(root, { files: ['src/a.js'] })
  const ok = await h.call('nav_commit', { task: '改 A', anchor: 'PN-F01', arch: '架构不变', features: 'PN-F01' })
  assert.match(ok, /已登记 ACT-/)
  const blocked = await h.call('nav_node', { target: 'PN-F01', retire: true })
  assert.match(blocked, /仍被在途改动/)
  touch(root, 'src/a.js', 'v2')
  await h.call('nav_graph', { mode: 'health' }) // 任意一次调用即触发按证据收口
  const retired = await h.call('nav_node', { target: 'PN-F01', retire: true })
  assert.match(retired, /已退役 feature PN-F01/)
  assert.equal(buildModel(root).nodes.get('feature:pn-f01').status, 'retired')
})

test('nav_node：模块重挂项目（re-home）与摘除', async (t) => {
  const { root, h } = await boot(t)
  await seed(root)
  await appendEvents(root, [{ kind: 'node', op: 'upsert', layer: 'project', id: 'PN-P02', fields: { name: 'PN-P02', path: '.' } }])
  const moved = await h.call('nav_node', { target: 'core', layer: 'module', project: 'PN-P02' })
  assert.match(moved, /项目: project:pn-p02/, '回显的归属必须是归一后的节点 id（不是登记时的写法）')
  // 归属在折叠时归一成**项目节点 id**（登记给 name、渲染按 id 比会让模块静默消失）
  assert.equal(buildModel(root).nodes.get('module:core').project, 'project:pn-p02')
  assert.equal(buildModel(root).nodes.get('project:pn-p02').meta.moduleList.includes('core'), true)
  const detached = await h.call('nav_node', { target: 'core', layer: 'module', project: '' })
  assert.match(detached, /updated module "core"/)
  assert.equal(buildModel(root).nodes.get('module:core').project, null)
  assert.equal(buildModel(root).nodes.get('project:pn-p02').meta.moduleList.includes('core'), false, '摘除后项目成员表必须同步')
})

test('nav_graph：项目名与模块归属键不同名时，地图仍能列出模块（静默漏渲染的回归）', async (t) => {
  const { root, h } = await boot(t)
  await appendEvents(root, [
    { kind: 'node', op: 'upsert', layer: 'project', id: 'PN-P01', fields: { name: 'project-nav', path: '.' } },
    { kind: 'node', op: 'upsert', layer: 'module', id: 'core', fields: { name: '核心', project: 'PN-P01', features: [] } }
  ])
  const tree = await h.call('nav_graph', { mode: 'map' })
  assert.match(tree, /project-nav/)
  assert.match(tree, /核心/, '模块必须出现在其项目下（归属键不一致曾让它彻底看不见）')
})

test('nav_commit：七闸接线 —— 假锚点被拒，且不留下任何记录', async (t) => {
  const { root, h } = await boot(t)
  await seed(root)
  const before = readEvents(root).events.length
  const out = await h.call('nav_commit', { task: 'x', anchor: 'GHOST', arch: 'a', features: 'PN-F01' })
  assert.match(out, /闸门拒绝/)
  assert.match(out, /anchor:/)
  assert.equal(readEvents(root).events.length, before, '被拒的意图不得留下记录')
})

test('nav_commit：缺 arch= 只告警不阻断（工程类改动不该被卡住）', async (t) => {
  const { root, h } = await boot(t)
  await seed(root)
  const out = await h.call('nav_commit', { task: '小修', anchor: 'PN-F01', features: 'PN-F01' })
  assert.match(out, /已登记 ACT-/)
  assert.match(out, /⚠ decision:/)
})

test('nav_commit：登记即声明收口方式 —— 下一次调用自动收口，无需第二个动作', async (t) => {
  const { root, h } = await boot(t)
  await seed(root, { files: ['src/a.js'] })
  const out = await h.call('nav_commit', { task: '改 A', anchor: 'PN-F01', arch: '局部', features: 'PN-F01' })
  assert.match(out, /收口无需动作/)
  assert.equal(buildModel(root).openCommits.length, 1)
  touch(root, 'src/a.js', 'v2')
  const health = await h.call('nav_graph', { mode: 'health' })
  assert.match(health, /在途改动 \(0\)/)
  assert.equal(buildModel(root).openCommits.length, 0, '任意一次工具调用即可收口（A1）')
})

test('nav_commit：archive 归档在途意图', async (t) => {
  const { root, h } = await boot(t)
  await seed(root)
  const out = await h.call('nav_commit', { task: 'x', anchor: 'PN-F01', arch: 'a', features: 'PN-F01' })
  const id = /ACT-\d+/.exec(out)[0]
  const arch = await h.call('nav_commit', { mode: 'archive', task: 'x', anchor: 'PN-F01', id, reason: '方向已废' })
  assert.match(arch, /已归档/)
  assert.equal(buildModel(root).openCommits.length, 0)
})

test('nav_decide：决策挂节点、重置计数闸；假锚点被拒', async (t) => {
  const { root, h } = await boot(t)
  await seed(root)
  const bad = await h.call('nav_decide', { anchor: 'GHOST', reason: 'r', decision: 'd' })
  assert.match(bad, /不是真实架构节点/)
  const ok = await h.call('nav_decide', { anchor: 'PN-F01', reason: '因为 X', decision: '改成 Y', impact: 'PN-F01' })
  assert.match(ok, /ADR-\d+ 已登记/)
  assert.match(ok, /补丁计数已重置/)
  const m = buildModel(root)
  assert.equal(m.decisions.length, 1)
  assert.equal(m.decisions[0].anchor, 'feature:pn-f01', '决策必须挂到节点 id 上（决策天然有归属）')
})

test('nav_set：向量逐字段更新，未给字段保持', async (t) => {
  const { root, h } = await boot(t)
  await seed(root)
  const out = await h.call('nav_set', { doing: '新焦点' })
  assert.match(out, /doing: 新焦点/)
  assert.match(out, /notDoing: forbidden-thing/, '未提供的字段必须保持原值')
  assert.equal(buildModel(root).vector.doing, '新焦点')
})

test('nav_graph：task 模式给落点、影响面入口与下一步', async (t) => {
  const { root, h } = await boot(t)
  await seed(root)
  const out = await h.call('nav_graph', { mode: 'task', target: 'src/a.js' })
  assert.match(out, /File: src\/a\.js/)
  assert.match(out, /<- 功能 PN-F01/)
  assert.match(out, /模块 core/)
  assert.match(out, /影响面: nav_graph mode=impact/)
  assert.match(out, /下一步: 改前先 nav_commit/)
})

test('nav_graph：未知目标给出登记指引，而不是一句"没有"', async (t) => {
  const { root, h } = await boot(t)
  await seed(root)
  const out = await h.call('nav_graph', { mode: 'task', target: 'nothing-here' })
  assert.match(out, /No mapping found/)
  assert.match(out, /nav_node/)
})

test('nav_graph：gaps 报未登记文件与 STALE 落点', async (t) => {
  const { root, h } = await boot(t)
  await seed(root, { files: ['src/a.js'] })
  put(root, 'src/orphan.js')
  const out = await h.call('nav_graph', { mode: 'gaps' })
  assert.match(out, /未登记文件/)
  assert.match(out, /src\/orphan\.js/)
})

test('nav_graph：json 模式返回可序列化快照（不含活对象）', async (t) => {
  const { root, h } = await boot(t)
  await seed(root)
  const out = await h.call('nav_graph', { mode: 'json' })
  const j = JSON.parse(out)
  assert.equal(j.vector.doing, 'core')
  assert.equal(j.coverage.features, 1)
  assert.ok(typeof j.events === 'number')
})

test('nav_render：三个投影全生成；标记缺失时明确拒绝而不是猜', async (t) => {
  const { root, h } = await boot(t)
  await seed(root)
  // 无标记的 PROJECT.md → 拒绝写入自动区
  writeFileSync(join(root, 'PROJECT.md'), '# 没有标记\n', 'utf-8')
  const out1 = await h.call('nav_render', {})
  assert.match(out1, /找不到 nav:auto 标记/)
  assert.equal(readFileSync(join(root, 'PROJECT.md'), 'utf-8'), '# 没有标记\n')
  assert.ok(existsSync(join(root, PLANE.MODEL_DOC)))
  // 有标记 → 正常写入
  writeFileSync(join(root, 'PROJECT.md'), `# 标题\n\n<!-- nav:auto:start -->\nold\n<!-- nav:auto:end -->\n\n手写结尾\n`, 'utf-8')
  const out2 = await h.call('nav_render', {})
  assert.match(out2, /PROJECT.md 标记区: 已更新/)
  const text = readFileSync(join(root, 'PROJECT.md'), 'utf-8')
  assert.ok(text.includes('手写结尾'), '标记外内容零触碰')
  assert.ok(!text.includes('\nold\n'), '标记内必须被重渲染')
})

test('端到端：七闸全绿的一笔改动 —— 登记 → 改 → 自动收口 → 投影', async (t) => {
  const { root, h } = await boot(t)
  await seed(root, { files: ['src/a.js'] })
  const commit = await h.call('nav_commit', { task: '给 A 加一层', anchor: 'PN-F01', arch: '架构不变，纯局部', features: 'PN-F01' })
  assert.match(commit, /已登记 ACT-/)
  assert.match(commit, /✓ anchor/)
  assert.match(commit, /✓ scope/)
  assert.match(commit, /✓ mainline/)
  assert.match(commit, /✓ impact/)
  assert.match(commit, /✓ count/)
  assert.match(commit, /✓ decision/)
  touch(root, 'src/a.js', 'v2')
  const dec = await h.call('nav_decide', { anchor: 'PN-F01', reason: '根因是接口错位', decision: '接口按节点粒度' })
  assert.match(dec, /ADR-/)
  const render = await h.call('nav_render', {})
  assert.match(render, /投影已重生成/)
  const health = await h.call('nav_graph', { mode: 'health' })
  assert.match(health, /在途改动 \(0\)/)
  assert.match(health, /架构决策: 1 条/)
  const proj = readFileSync(join(root, PLANE.MODEL_DOC), 'utf-8')
  assert.match(proj, /\| ADR · `ADR-\d+` · `feature:pn-f01` \|/, '决策必须进投影索引，且挂在节点上')
  assert.match(proj, /接口按节点粒度/)
  assert.match(proj, /给 A 加一层/, '已收口的改动必须在人类可读投影里可回溯')
  assert.match(proj, /## 最近的收口/)
})

test('nav_graph mode=impact：端到端给出依赖图两侧（我引用谁 / 谁引用我）', async (t) => {
  const { root, h } = await boot(t)
  await seed(root)                                   // PN-F01 -> src/a.js
  put(root, 'src/b.js', "import a from './a.js'\n")
  await appendEvents(root, [
    { kind: 'node', op: 'upsert', layer: 'feature', id: 'PN-F02', fields: { name: 'PN-F02', files: ['src/b.js'], module: 'core' } }
  ])
  const out = await h.call('nav_graph', { mode: 'impact', target: 'PN-F01' })
  assert.match(out, /我引用谁/)
  assert.match(out, /谁引用我/, '影响面就是本插件存在的理由，必须直出')
  assert.match(out, /src\/b\.js/, '引用方要列出来')
  assert.match(out, /依赖图: 范围=/)
  assert.match(out, /扫 \d+ 个代码文件/)
  assert.match(out, /候选 \d+ 文件/)
})

// ============ PN-S1：查证申报（plan）的承载与可见 ============
//
// 背景：plan 此前**只有写入面、零渲染出口**（治理根 45 条非空 plan 对模型完全不可见）
// ⇒ 填了等于没填。本块钉死"写了必须看得见"，并配负例：
//   · 不阻断写入（A 路线不新增闸位 ⇒ 新判据只能是文本，不是闸）
//   · 闭笔后仍可追回（收口事件结构性带 plan:''，必须取自原始 open 笔）
//   · 三态可分辨（裸串无法断言"填了"，故同打段数）

test('PN-S1/E1+E2：查证申报进写入回执与在途列表，且不阻断写入', async (t) => {
  const { root, h } = await boot(t)
  await seed(root, { files: ['src/a.js'] })
  const marker = 'MARKER-查证-项目内已有模块X；上游库Y已存在；不复用因为Z'
  const out = await h.call('nav_commit', {
    task: '加一个导出', anchor: 'PN-F01', arch: '架构不变，纯局部', features: 'PN-F01', plan: marker
  })
  assert.match(out, /已登记 ACT-/, '附申报不得阻断写入')
  assert.ok(out.includes('MARKER-查证-项目内已有模块X'), 'E1：回执必须能看到申报原文')
  assert.match(out, /（3 段）/, '段数必须同打 —— 否则"填了没有"不可断言（假绿）')
  assert.ok(out.indexOf('查证申报') < out.indexOf('收口无需动作'),
    '位置断言：申报小节必须早于收口说明，否则等于插在末尾没人看得见')
  const health = await h.call('nav_graph', { mode: 'health' })
  assert.match(health, /查证申报 MARKER-查证-项目内已有模块X/, 'E2：在途列表同见')
})

test('PN-S1 负例：未附申报时只提示、绝不阻断（T1 已存在文件静默）', async (t) => {
  const { root, h } = await boot(t)
  await seed(root, { files: ['src/a.js'] })
  // 夹具硬约束：seed 把 notDoing 设为 'forbidden-thing'，而 scopeGate 做 includes 互含判定，
  // 故本用例 scope 绝不能含该串，否则撞范围闸、走不到本判据。
  const out = await h.call('nav_commit', {
    task: '新增一个模块', anchor: 'PN-F01', arch: '局部', files: 'src/brand-new.js'
  })
  assert.match(out, /已登记 ACT-/, '未附申报不得阻断写入')
  assert.match(out, /查证申报: \(未填\)/)
  assert.match(out, /本笔未附查证申报/, 'T2（未登记到任何架构节点的落点）必须给中性提示')
  assert.ok(!out.includes('未检索'), '文案必须是中性事实，不得写成因果断言')
})

test('PN-S1/E3：收口之后仍能追回申报（唯一持久出口）', async (t) => {
  const { root, h } = await boot(t)
  await seed(root, { files: ['src/a.js'] })
  await h.call('nav_commit', {
    task: '改 A', anchor: 'PN-F01', arch: '局部', features: 'PN-F01', plan: 'PERSIST-MARKER-查过项目内已有等价实现'
  })
  touch(root, 'src/a.js', 'v2')
  await h.call('nav_graph', { mode: 'health' })          // 任意调用按证据自动收口
  const render = await h.call('nav_render', {})
  assert.match(render, /投影已重生成/)
  const doc = readFileSync(join(root, PLANE.MODEL_DOC), 'utf-8')
  assert.match(doc, /\| 查证申报 \|/, '收口表必须新增该列')
  assert.ok(doc.includes('PERSIST-MARKER'),
    'E3：闭笔后仍可追回 —— 取自原始 open 笔（照抄闭笔事件的 plan 会恒空白）')
})

test('PN-S1/E4：机器取回出口（nav_graph mode=json）同见申报', async (t) => {
  const { root, h } = await boot(t)
  await seed(root, { files: ['src/a.js'] })
  await h.call('nav_commit', {
    task: '改 A', anchor: 'PN-F01', arch: '局部', features: 'PN-F01', plan: 'JSON-MARKER-已查'
  })
  const j = JSON.parse(await h.call('nav_graph', { mode: 'json' }))
  assert.ok(Array.isArray(j.openCommits) && j.openCommits.length === 1, 'JSON 投影必须带 openCommits')
  assert.match(j.openCommits[0].plan, /JSON-MARKER-已查/, 'E4：json 投影必须带 plan（此前字段集里没有它）')
})

test('PN-AC-03：事件流 kind 是白名单闭集（未知 kind 必抛，负例）', async (t) => {
  const root = tmpRoot(t)
  await assert.rejects(
    () => appendEvents(root, [{ kind: 'sought', anchor: 'x' }]),
    /unknown event kind/,
    '新增事件 kind 必须是硬失败，否则"不新增 kind"这条约束没有机检'
  )
})

// ============ PN-S2：零命中必须给候选（不是丢回一句"没有"） ============
//
// 实测原缺陷：自然语言任务 `locate` 5/5 零命中；命中时才知道分支只给"没有"+三条登记指引。
// ARCHITECTURE §2②：任何"少展示"必须**可见且可取回**。改法零扫盘（不调 walkFiles）。

test('PN-S2：自然语言目标零命中时给确定性候选 + 取回路径', async (t) => {
  const { root, h } = await boot(t)
  await seed(root)
  await h.call('nav_node', { target: 'PN-F09', layer: 'feature', name: '导出功能', files: 'src/exp.js' })
  const out = await h.call('nav_graph', { mode: 'task', target: '加一个导出功能' })
  assert.match(out, /No mapping found/, '零命中仍必须明说没匹配上（不伪装）')
  assert.match(out, /共 [1-9]\d* 条候选/, '必须给候选，而不是"没有"')
  assert.match(out, /feature:pn-f09/, '候选里要认得出相关节点')
  assert.match(out, /2-gram 重叠打分/, '口径要写清楚，别让调用方以为是精确检索')
})

test('PN-S2 负例：全不相关时明说候选 0 条（不凑候选）', async (t) => {
  const { root, h } = await boot(t)
  await seed(root)
  const out = await h.call('nav_graph', { mode: 'task', target: 'zzz-nothing-qqq' })
  assert.match(out, /候选 0 条/, '凑候选会训练出"候选不可信"，比不给更坏')
  assert.match(out, /nav_node/, '零候选时登记指引仍须在位')
})

test('PN-S2：落点文件按后缀命中（fileOwners 的键是 root 相对路径）', async (t) => {
  const { root, h } = await boot(t)
  await seed(root, { files: ['project-nav/core/log.js'] })
  const out = await h.call('nav_graph', { mode: 'task', target: 'core/log.js' })
  assert.match(out, /共 [1-9]\d* 条候选/, '短路径必须能回溯到 root 相对路径的登记键')
  assert.match(out, /project-nav\/core\/log\.js/, '候选要给出真实的登记键')
})

// ============ PN-S3：既有决策点名（不重开已关的议题） ============
//
// 施工期落点偏离会议草案（原定 gates.js 加纯查询）：通过的闸其 detail 不渲染，
// 挂在闸上等于死文本 —— 故落在可见路径（renderCommitResult）。闸门集合零变更。

test('PN-S3：本锚点已有决策时点名，且带理由摘要', async (t) => {
  const { root, h } = await boot(t)
  await seed(root, { files: ['src/a.js'] })
  await h.call('nav_decide', { anchor: 'PN-F01', reason: '根因是接口错位', decision: '接口按节点粒度' })
  const out = await h.call('nav_commit', { task: '再改 A', anchor: 'PN-F01', arch: '局部', features: 'PN-F01' })
  assert.match(out, /相关既有决策: ADR-\d+/, '本锚点有决策时必须点名')
  assert.match(out, /根因是接口错位/, '点名必须带理由摘要，否则等于没点名')
})

test('PN-S3 负例：无决策的锚点不得出现点名（否则每天都响＝狼来了）', async (t) => {
  const { root, h } = await boot(t)
  await seed(root, { files: ['src/a.js'] })
  const out = await h.call('nav_commit', { task: '改 A', anchor: 'PN-F01', arch: '局部', features: 'PN-F01' })
  assert.ok(!out.includes('相关既有决策'), '无决策时零输出 —— 告警必须稀缺才有信号')
})
