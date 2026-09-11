// test/architecture.test.mjs — 架构不变量与验收判据（ARCHITECTURE §3/§9）
//
// 这一组测试不做"功能验证"，只验证**架构本身**：
//   I1 单源 · I2 渲染 · I3 可丢弃 · A1 收口不依赖会话 · A2 真相可自检
//   A4 六闸完整 · A5 模型面字段数 · A6 工具面 = 6
// 架构错了，局部补得再好也没用 —— 所以这些用例比功能用例更重要。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpRoot, put, touch, seed } from './helper.mjs'
import { appendEvents, readEvents, verifyLog, rewriteVerified } from '../core/log.js'
import { loadModel, buildModel, coverage, pressureFor } from '../core/model.js'
import { commitIntent, reconcile, archiveIntent } from '../core/commit.js'
import { paths, PLANE } from '../core/paths.js'
import { renderAll, writeProjectSection, renderModelDoc, renderMapHtml, MARK_START, MARK_END, archDocState, stampArchDoc, listArchDocs } from '../core/render.js'
import { scanTools, effectMountedTools, OLD_TOOL_NAMES, NEW_TOOL_NAMES } from './tools-list.mjs'
import { migrateLegacy } from '../core/legacy.js'

// ============ I1 单源 ============

test('I1 复算 == 缓存：模型可从事件流 + 磁盘实况无损重建', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await commitIntent(root, { task: 't1', anchor: 'PN-F01', arch: 'a', scope: { features: ['PN-F01'] } })
  await appendEvents(root, [{ kind: 'decide', anchor: 'PN-F01', reason: 'r', decision: 'd' }])
  const fresh = buildModel(root)
  const cached = loadModel(root, { useCache: true })
  assert.deepEqual(
    [...cached.nodes.values()].map((n) => [n.id, n.status, n.files]),
    [...fresh.nodes.values()].map((n) => [n.id, n.status, n.files])
  )
  assert.deepEqual(cached.vector, fresh.vector)
  assert.deepEqual(cached.decisions.map((d) => d.id), fresh.decisions.map((d) => d.id))
  assert.deepEqual(
    [...cached.patchPressure.entries()].sort(),
    [...fresh.patchPressure.entries()].sort(),
    '缓存路径与非缓存路径必须给出同一个计数闸结果'
  )
})

test('I1 事件流是唯一事实源：模型文件与事件流冲突时，以事件流为准', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  loadModel(root) // 生成缓存
  const modelFile = paths.model(root)
  const tampered = JSON.parse(readFileSync(modelFile, 'utf-8'))
  tampered.vector = { doing: 'HACKED', next: '', notDoing: '', exitCondition: '' }
  writeFileSync(modelFile, JSON.stringify(tampered), 'utf-8')
  const m = loadModel(root)
  assert.equal(m.vector.doing, 'core', '篡改模型缓存不得改变真相（缓存是投影不是源）')
  // 缓存自证：戳与事件流不一致 → 整份缓存作废重建（而不是"看起来还算新"就用）
  const stillTampered = JSON.parse(readFileSync(modelFile, 'utf-8'))
  assert.notEqual(stillTampered.vector.doing, 'HACKED', '重建必须把缓存覆盖回真相')
})

test('I1 事件流自身带完整性判据（seq 连续），断裂必须报', async (t) => {
  const root = tmpRoot(t)
  await appendEvents(root, [
    { kind: 'set', vector: { doing: 'a' } },
    { kind: 'set', vector: { doing: 'b' } },
    { kind: 'set', vector: { doing: 'c' } }
  ])
  assert.ok(verifyLog(root).ok)
  const file = paths.events(root)
  const lines = readFileSync(file, 'utf-8').trim().split('\n')
  writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n', 'utf-8') // 抽掉中间一条 → seq 1,3
  const v = verifyLog(root)
  assert.equal(v.ok, false)
  assert.match(v.problems.join(' '), /seq gap/)
})

// ============ I2 渲染 ============

test('I2 PROJECT.md 标记区重渲染；标记外的手写叙事零触碰', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const doc = join(root, 'PROJECT.md')
  writeFileSync(doc, [
    '# 手写标题（必须保留）',
    '',
    '手写叙事段落，绝不能被工具改写。',
    '',
    MARK_START,
    '',
    MARK_END,
    '',
    '结尾手写补充。'
  ].join('\n'), 'utf-8')
  const m = buildModel(root)
  const r = writeProjectSection(root, m)
  assert.equal(r.changed, true)
  const text = readFileSync(doc, 'utf-8')
  assert.ok(text.startsWith('# 手写标题（必须保留）'))
  assert.ok(text.includes('手写叙事段落，绝不能被工具改写。'))
  assert.ok(text.includes('结尾手写补充。'))
  assert.ok(text.includes('core'), '自动区应含模块名')
  assert.ok(text.includes('nav:auto:start'))
})

test('I2 手改渲染物 ⇒ 下一次渲染覆盖它（这是 I2 的验法）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const m = buildModel(root)
  renderAll(root, m, { now: Date.parse(m.builtAt) })
  const modelDoc = join(root, PLANE.MODEL_DOC)
  const original = readFileSync(modelDoc, 'utf-8')
  writeFileSync(modelDoc, '# 我手改的模型文档\n', 'utf-8')
  renderAll(root, m)
  const after = readFileSync(modelDoc, 'utf-8')
  assert.ok(after.startsWith(original.split('\n').slice(0, 3).join('\n')), '渲染物必须回到由模型生成的形态')
  assert.ok(!after.includes('我手改的'), '手写内容不得残留')
  assert.ok(after.includes('## 主线向量'), '渲染必须完整重建，而不是打补丁')
})

test('I2 找不到标记时拒绝写入（Once-Only：绝不猜位置）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  writeFileSync(join(root, 'PROJECT.md'), '# 没有标记的文件\n', 'utf-8')
  const r = writeProjectSection(root, buildModel(root))
  assert.equal(r.markerMissing, true)
  assert.equal(r.changed, false)
  assert.equal(readFileSync(join(root, 'PROJECT.md'), 'utf-8'), '# 没有标记的文件\n', '拒绝写入必须真的没写')
})

test('I2 投影全部可生成：地图 / 模型文档 / PROJECT.md 自动区', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const m = buildModel(root)
  const res = renderAll(root, m)
  assert.ok(existsSync(join(root, PLANE.MODEL_DOC)))
  assert.ok(existsSync(join(root, res.map.path)))
  const html = readFileSync(join(root, res.map.path), 'utf-8')
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('永不手改'), '渲染物必须自带"别手改"的声明')
  assert.ok(renderModelDoc(m).includes('真相是'))
})

test('A2 架构档真相可自检：声明文件变了就必须报过期（D2 的机检面）', async (t) => {
  const root = tmpRoot(t)
  put(root, 'src/a.js', 'v1')
  mkdirSync(join(root, '.internal', 'arch'), { recursive: true })
  writeFileSync(join(root, '.internal', 'arch', 'doc.md'), [
    '---',
    'arch-cache: |-',
    `  src/a.js: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef`,
    '  at: 2026-09-11T00:00:00.000Z',
    '---',
    '',
    '# 架构档',
    ''
  ].join('\n'), 'utf-8')
  let st = archDocState(root, '.internal/arch/doc.md')
  assert.equal(st.fresh, false)
  assert.match(st.reason, /已变/)

  // 刷新指纹后视为新鲜
  const stamped = stampArchDoc(root, '.internal/arch/doc.md')
  assert.equal(stamped.changed, true)
  st = archDocState(root, '.internal/arch/doc.md')
  assert.equal(st.fresh, true, `刷新后必须新鲜：${st.reason}`)

  // 源文件再变 → 立刻过期
  touch(root, 'src/a.js', 'v2')
  st = archDocState(root, '.internal/arch/doc.md')
  assert.equal(st.fresh, false, '声明文件一变，档就必须过期')
})

test('A2 没有指纹头的档被明确标为「未纳管」，而不是假装新鲜', async (t) => {
  const root = tmpRoot(t)
  mkdirSync(join(root, '.internal', 'arch'), { recursive: true })
  writeFileSync(join(root, '.internal', 'arch', 'bare.md'), '# 无头文件\n', 'utf-8')
  const st = archDocState(root, '.internal/arch/bare.md')
  assert.equal(st.fresh, false)
  assert.equal(st.noHeader, true)
})

test('A2 给不存在的文件刷指纹必须报错（不许把档钉在一个幻觉上）', async (t) => {
  const root = tmpRoot(t)
  mkdirSync(join(root, '.internal', 'arch'), { recursive: true })
  writeFileSync(join(root, '.internal', 'arch', 'doc.md'), '---\narch-cache: |-\n  ghost.js: abc\n---\n\n# d\n', 'utf-8')
  assert.throws(() => stampArchDoc(root, '.internal/arch/doc.md'), /does not exist/)
})

// ============ I3 可丢弃 ============

test('I3 删掉整个 runtime/ → 治理零损失（查询结果逐字节一致）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'a', scope: { features: ['PN-F01'] } })
  await appendEvents(root, [{ kind: 'decide', anchor: 'PN-F01', reason: 'r', decision: 'd' }])

  const snapshot = (m) => JSON.stringify({
    vector: m.vector,
    nodes: [...m.nodes.values()].map((n) => [n.id, n.status, n.files, n.project, n.module]),
    decisions: m.decisions.map((d) => [d.id, d.anchor, d.decision]),
    open: m.openCommits.map((c) => [c.id, c.anchor, c.task, Object.keys(c.evidence || {}).sort()]),
    pressure: [...m.patchPressure.entries()].sort(),
    coverage: coverage(m)
  })
  const before = snapshot(loadModel(root, { useCache: true }))
  assert.ok(existsSync(paths.runtime(root)))

  rmSync(paths.runtime(root), { recursive: true, force: true })
  assert.equal(existsSync(paths.runtime(root)), false)

  const after = snapshot(loadModel(root))
  assert.equal(after, before, '删掉运行时面后模型必须逐字节等价重建')
  assert.ok(existsSync(paths.runtime(root)), '重建时 runtime/ 自动恢复')
})

test('I3 在途状态文件是可丢缓存：丢了照样能按证据收口', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'a', scope: { features: ['PN-F01'] } })
  rmSync(paths.inflightDir(root), { recursive: true, force: true })
  touch(root, 'src/a.js', 'v2')
  const rec = await reconcile(root)
  assert.equal(rec.closed.length, 1, '在途缓存丢了不该影响收口（收口判据在事件流里）')
})

// ============ A1 收口不依赖会话 ============

test('A1 会话死亡不产生孤儿：收口只认证据（复现 D1 的反面）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const res = await commitIntent(root, { task: '另一个会话的活', anchor: 'PN-F01', arch: 'a', scope: { files: ['src/*.js'] }, }, { actor: 'session-AAA' })
  assert.equal(res.status, 'ok')
  // 会话 AAA 消失（不再有任何调用来自它），另一个身份继续工作
  put(root, 'src/new-from-B.js')
  const rec = await reconcile(root, { actor: 'session-BBB' })
  assert.equal(rec.closed.length, 1, '任何会话都能按证据收口，不需要"主"')
  const m = buildModel(root)
  assert.equal(m.openCommits.length, 0)
  assert.deepEqual(m.commits.find((c) => c.id === res.commit.id).outcome.appeared, ['src/new-from-B.js'])
})

test('A1 同一意图不会被两个会话重复收口（收口在锁内二次确认）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'a', scope: { features: ['PN-F01'] } })
  touch(root, 'src/a.js', 'v2')
  const [a, b] = await Promise.all([reconcile(root), reconcile(root)])
  const m = buildModel(root)
  // 收口事件 = 指向某笔意图的 closed 事件。同一目标被收两次才是真问题（原始意图的
  // phase 也会变成 closed —— 拿 phase 判重会把"意图本身"误当成第二笔收口）。
  const closures = m.commits.filter((c) => c.closes !== undefined && c.closes !== null)
  assert.equal(closures.length, 1, `每笔意图只能被收口一次（实际 ${closures.length} 次：${closures.map((c) => `${c.id}→${c.closes}`).join(', ')}）`)
  assert.equal(m.openCommits.length, 0)
  assert.equal(m.commits.filter((c) => c.closes === undefined).length, 1, '只有一笔原始意图')
  assert.ok(a.closed.length + b.closed.length >= 1)
})

test('A1 并发收口多笔意图：每笔恰好收口一次（跨会话 + 跨意图）', async (t) => {
  const root = tmpRoot(t)
  await seed(root, { files: ['src/a.js'] })
  put(root, 'src/b.js')
  const c1 = await commitIntent(root, { task: 'one', anchor: 'PN-F01', arch: 'a', scope: { files: ['src/a.js'] } })
  const c2 = await commitIntent(root, { task: 'two', anchor: 'PN-F01', arch: 'a', scope: { files: ['src/b.js'] } })
  assert.equal(c1.status, 'ok')
  assert.equal(c2.status, 'ok')
  touch(root, 'src/a.js', 'v2')
  touch(root, 'src/b.js', 'v2')
  await Promise.all([reconcile(root), reconcile(root), reconcile(root)])
  const m = buildModel(root)
  const closures = m.commits.filter((c) => c.closes !== undefined && c.closes !== null)
  assert.equal(closures.length, 2, `两笔意图各收一次（实际 ${closures.length}）`)
  assert.deepEqual(closures.map((c) => c.closes).sort(), [c1.commit.seq, c2.commit.seq].sort())
  assert.equal(new Set(closures.map((c) => c.closes)).size, closures.length, '同一意图不得被收两次')
  assert.equal(m.openCommits.length, 0)
})

// ============ A4 / A5 / A6 ============

test('A6 工具面 = 6 个工具，且一个不少', () => {
  const tools = scanTools()
  assert.deepEqual(tools.names.slice().sort(), NEW_TOOL_NAMES.slice().sort(), `实际注册: ${tools.names.join(', ')}`)
  assert.equal(tools.names.length, 6)
})

test('A6 旧工具名不再出现在工具注册里（描述里提及历史是允许的，注册不行）', () => {
  const tools = scanTools()
  for (const old of OLD_TOOL_NAMES) {
    assert.ok(!tools.names.includes(old), `旧工具 ${old} 仍在注册`)
  }
  assert.equal(tools.duplicates.length, 0, `重复注册: ${tools.duplicates.join(', ')}`)
})

test('A6 每个工具都注册在 ctx.effect 内（否则卸载卸不干净）', () => {
  const { total, mounted } = effectMountedTools()
  assert.equal(total, 6, `工具注册点应为 6，实际 ${total}`)
  assert.equal(mounted, total, `挂在 ctx.effect 内的工具 ${mounted}/${total} —— 有工具未挂 effect，卸载会留下残留监听/工具`)
})

test('A5 模型面字段数 ≤ 4（锚点 / scope / arch= / 理由）', () => {
  const tools = scanTools()
  const commit = tools.schemas.find((s) => s.name === 'nav_commit')
  assert.ok(commit, 'nav_commit 必须存在')
  const nonMode = commit.params.filter((p) => !['task', 'plan', 'features', 'modules', 'files', 'mode', 'id', 'reason'].includes(p))
  assert.ok(nonMode.length <= 4, `nav_commit 的模型面字段过多: ${nonMode.join(', ')}`)
})

test('A4 六闸在 host 的写入路径上是强制的（闸门不在流程里，在查询里）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  // 锚点闸：假锚点直接拒
  const bad = await commitIntent(root, { task: 't', anchor: 'GHOST', arch: 'a', scope: { features: ['PN-F01'] } })
  assert.equal(bad.status, 'blocked')
  assert.equal(bad.gates.blocked[0].gate, 'anchor')
  // 计数闸：3 次补丁后拒
  for (let i = 0; i < 3; i++) {
    await appendEvents(root, [{ kind: 'commit', phase: 'closed', anchor: 'PN-F01', task: `p${i}`, scope: { features: ['PN-F01'] } }])
  }
  const m = buildModel(root)
  assert.equal(pressureFor(m, 'PN-F01').sinceDecisionCount, 3)
  const blocked = await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'a', scope: { features: ['PN-F01'] } })
  assert.equal(blocked.status, 'blocked')
  assert.ok(blocked.gates.blocked.some((b) => b.gate === 'count'))
})

// ============ 迁移与平面 ============

test('平面契约：长期资产只有一个事件流文件（数据面 7 → 3）', async (t) => {
  const root = tmpRoot(t)
  assert.equal(PLANE.EVENTS, '.internal/events.jsonl')
  await seed(root)
  const internal = readdirSync(join(root, '.internal'))
  const longLived = internal.filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'))
  assert.deepEqual(longLived, ['events.jsonl'], `长期数据面必须只有事件流，实际: ${longLived.join(', ')}`)
})

test('迁移后不存在第二真相：旧账本文件名的读路径已消失', async (t) => {
  const root = tmpRoot(t)
  mkdirSync(join(root, '.internal'), { recursive: true })
  for (const f of ['nav-index.json', 'vector.json', 'nav-actions.json', 'nav-docs.json', 'nav-arch.json']) {
    writeFileSync(join(root, '.internal', f), JSON.stringify({}), 'utf-8')
  }
  const r = await migrateLegacy(root)
  assert.equal(r.status, 'migrated')
  for (const f of ['nav-index.json', 'vector.json', 'nav-actions.json', 'nav-docs.json', 'nav-arch.json']) {
    assert.equal(existsSync(join(root, '.internal', f)), false)
    assert.equal(existsSync(join(root, '.internal', 'legacy', f)), true)
  }
})
