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
  assert.match(proj, /### ADR-\d+ · feature:pn-f01/, '决策必须进投影，且挂在节点上')
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
