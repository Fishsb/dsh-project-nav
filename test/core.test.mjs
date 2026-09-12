// test/core.test.mjs — 领域行为基准（新架构口径）
//
// 旧套件的 74 项是**行为基准**，不是兼容目标：每一条背后的事故事实都必须在新架构下继续成立，
// 所以这里按"事实"而非"旧 API"重写。跑法：node --test test/*.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpRoot, put, touch, seed } from './helper.mjs'
import { appendEvents, readEvents, verifyLog, logStamp } from '../core/log.js'
import { buildModel, loadModel, normalizeAnchor, coverage, pressureFor, nodeId, impactOf } from '../core/model.js'
import { resolveScope, evidenceOf, diffEvidence, globToRegExp, scanImports, extractSpecifiers, walkFiles, isTestPath } from '../core/scope.js'
import { anchorGate, scopeGate, mainlineGate, countGate, decisionGate, runGates, impactGate } from '../core/gates.js'
import { commitIntent, reconcile, archiveIntent } from '../core/commit.js'
import { paths } from '../core/paths.js'

// ============ 事件流（唯一事实源） ============

test('事件流 seq 从 1 开始、严格连续、append-only', async (t) => {
  const root = tmpRoot(t)
  await appendEvents(root, [{ kind: 'set', vector: { doing: 'a' } }])
  await appendEvents(root, [{ kind: 'set', vector: { doing: 'b' } }, { kind: 'set', vector: { doing: 'c' } }])
  const { events } = readEvents(root)
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3])
  assert.deepEqual(events.map((e) => e.vector.doing), ['a', 'b', 'c'])
  assert.ok(verifyLog(root).ok)
})

test('事件流只追加：旧行永不改写，历史每次调用都在', async (t) => {
  const root = tmpRoot(t)
  await appendEvents(root, [{ kind: 'set', vector: { doing: 'first' } }])
  const after1 = readFileSync(paths.events(root), 'utf-8')
  await appendEvents(root, [{ kind: 'set', vector: { doing: 'second' } }])
  const after2 = readFileSync(paths.events(root), 'utf-8')
  assert.ok(after2.startsWith(after1), '第二次追加必须保留第一次的全部字节')
})

test('坏行不被静默丢弃：计入 corrupt 而不是消失', async (t) => {
  const root = tmpRoot(t)
  await appendEvents(root, [{ kind: 'set', vector: { doing: 'ok' } }])
  const file = paths.events(root)
  writeFileSync(file, `${readFileSync(file, 'utf-8')}{ this is not json\n`, 'utf-8')
  const { events, corrupt } = readEvents(root)
  assert.equal(events.length, 1)
  assert.equal(corrupt.length, 1)
  const check = verifyLog(root)
  assert.equal(check.ok, false)
  assert.match(check.problems[0], /corrupt line/)
})

test('并发追加：seq 不重复、不丢事件（F1 的根治：追加不需要读改写）', async (t) => {
  const root = tmpRoot(t)
  const writers = 8
  await Promise.all(Array.from({ length: writers }, (_, i) => appendEvents(root, [{ kind: 'set', vector: { doing: `w${i}` } }])))
  const { events } = readEvents(root)
  assert.equal(events.length, writers)
  assert.deepEqual(events.map((e) => e.seq), Array.from({ length: writers }, (_, i) => i + 1))
  assert.equal(new Set(events.map((e) => e.vector.doing)).size, writers)
})

test('F9 写回校验：追加成功但内容对不上 → 抛错，绝不静默', async (t) => {
  const root = tmpRoot(t)
  const file = paths.events(root)
  await appendEvents(root, [{ kind: 'set', vector: { doing: 'a' } }])
  // 模拟"另一个写手把文件截断/换掉"：先让前缀校验失败
  writeFileSync(file, `${JSON.stringify({ seq: 99, kind: 'set', at: 'x', vector: { doing: 'intruder' } })}\n`, 'utf-8')
  await assert.rejects(
    () => appendEvents(root, [{ kind: 'set', vector: { doing: 'b' } }]),
    /(write-back check|integrity) FAILED/
  )
})

// ============ 折叠与模型（I1） ============

test('折叠是纯函数：同事件序列必得同模型', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const a = buildModel(root)
  const b = buildModel(root)
  assert.deepEqual(
    [...a.nodes.values()].map((n) => [n.id, n.name, n.status, n.files]),
    [...b.nodes.values()].map((n) => [n.id, n.name, n.status, n.files])
  )
  assert.deepEqual(a.vector, b.vector)
})

test('node upsert：创建 / 字段替换 / 落点整体替换', async (t) => {
  const root = tmpRoot(t)
  await appendEvents(root, [{ kind: 'node', op: 'upsert', layer: 'feature', id: 'F1', fields: { name: 'F1', files: ['a.js', 'b.js'] } }])
  let m = buildModel(root)
  assert.deepEqual(m.nodes.get('feature:f1').files, ['a.js', 'b.js'])
  await appendEvents(root, [{ kind: 'node', op: 'upsert', layer: 'feature', id: 'F1', fields: { files: ['c.js'] } }])
  m = buildModel(root)
  assert.deepEqual(m.nodes.get('feature:f1').files, ['c.js'], 'files 是整体替换语义（旧行为契约）')
  assert.equal(m.nodes.get('feature:f1').name, 'F1', '未提供的字段不丢')
})

test('node retired 级联：feature 退役摘除模块成员关系', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await appendEvents(root, [{ kind: 'node', op: 'retire', layer: 'feature', id: 'PN-F01' }])
  const m = buildModel(root)
  assert.equal(m.nodes.get('feature:pn-f01').status, 'retired')
  assert.deepEqual(m.nodes.get('module:core').features, [], '退役功能必须离开模块成员表')
  assert.equal(m.fileOwners.size, 0, '退役后落点映射消失')
})

test('node retired 级联：module 退役后其功能存活但失去模块', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await appendEvents(root, [{ kind: 'node', op: 'retire', layer: 'module', id: 'core' }])
  const m = buildModel(root)
  assert.equal(m.nodes.get('module:core').status, 'retired')
  assert.equal(m.nodes.get('feature:pn-f01').status, 'active', '功能不能随模块一起死')
})

test('退役让假 STALE 归零（F3/F8：索引能删才不会永远报漂移）', async (t) => {
  const root = tmpRoot(t)
  await seed(root, { files: ['src/gone.js'] })
  rmSync(join(root, 'src/gone.js'))
  let m = buildModel(root)
  assert.equal(m.stale.length, 1, '文件消失 → 先报 STALE')
  await appendEvents(root, [{ kind: 'node', op: 'retire', layer: 'feature', id: 'PN-F01' }])
  m = buildModel(root)
  assert.equal(m.stale.length, 0, '退役后不再有假警报')
})

test('set 事件：向量按最后一次为准，并带时间戳', async (t) => {
  const root = tmpRoot(t)
  await appendEvents(root, [{ kind: 'set', vector: { doing: 'x' } }])
  await appendEvents(root, [{ kind: 'set', vector: { doing: 'y', notDoing: 'z' } }])
  const m = buildModel(root)
  assert.equal(m.vector.doing, 'y')
  assert.equal(m.vector.notDoing, 'z')
  assert.ok(m.vector.updatedAt)
})

test('decide 的 id 由 seq 派生（并发下不可能撞 id）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await appendEvents(root, [{ kind: 'decide', anchor: 'PN-F01', reason: 'r1', decision: 'd1' }])
  await appendEvents(root, [{ kind: 'decide', anchor: 'PN-F01', reason: 'r2', decision: 'd2' }])
  const m = buildModel(root)
  const ids = m.decisions.map((d) => d.id)
  assert.equal(new Set(ids).size, 2)
  assert.deepEqual(ids, ['ADR-5', 'ADR-6'])
})

test('未知锚点的决策被明确记录为模型问题，而不是静默忽略', async (t) => {
  const root = tmpRoot(t)
  await appendEvents(root, [{ kind: 'decide', anchor: 'NOPE', reason: 'r', decision: 'd' }])
  const m = buildModel(root)
  assert.equal(m.decisions.length, 1)
  assert.equal(m.decisions[0].anchorKey, 'nope')
})

// ============ scope 解析（F4） ============

test('scope 解析三来源等权合并：索引键 ∪ 字面量 ∪ glob', async (t) => {
  const root = tmpRoot(t)
  await seed(root, { files: ['src/a.js'] })
  put(root, 'docs/readme.md')
  put(root, 'lib/b.js')
  const m = buildModel(root)
  const r = resolveScope(root, m, { features: ['PN-F01'], files: ['docs/readme.md', 'lib/*.js'] })
  assert.deepEqual(r.files, ['docs/readme.md', 'lib/b.js', 'src/a.js'])
  assert.deepEqual(r.fromIndex, ['src/a.js'])
  assert.deepEqual(r.fromLiteral, ['docs/readme.md'])
  assert.deepEqual(r.fromGlob, ['lib/b.js'])
})

test('scope 不丢 root 相对键（F4：曾导致 12/18 功能指纹恒空）', async (t) => {
  const root = tmpRoot(t)
  await seed(root, { files: ['deepseek/app/src/host/index.js'] })
  const m = buildModel(root)
  const r = resolveScope(root, m, { modules: ['core'] })
  assert.deepEqual(r.files, ['deepseek/app/src/host/index.js'], '模块解析必须穿透到功能的落点，不许为空')
})

test('scope 解析失败是显式的：missing / unresolved 不会被吞', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const m = buildModel(root)
  const r = resolveScope(root, m, { features: ['NOPE'], files: ['nowhere.js', 'nope/*.js', '../outside.js'] })
  assert.deepEqual(r.files, ['nowhere.js'], '不存在的字面量仍登记（它会以 appeared 被收口），但必须报 missing')
  assert.ok(r.unresolved.some((u) => u.includes('NOPE')))
  assert.ok(r.missing.some((u) => u.includes('nowhere.js')), '不存在的字面量必须显式报出')
  assert.ok(r.missing.some((u) => u.includes('nope/*.js')), 'glob 匹配为空必须显式报出')
  assert.ok(r.missing.some((u) => u.includes('outside')), '越界路径必须显式报出，绝不静默纳入 scope')
})

test('证据比对分四类：modified / vanished / appeared / unchanged', () => {
  const before = { 'a.js': { exists: true, size: 1, sha1: 'x' }, 'gone.js': { exists: true, size: 1, sha1: 'g' }, 'same.js': { exists: true, size: 2, sha1: 's' } }
  const after = { 'a.js': { exists: true, size: 9, sha1: 'y' }, 'same.js': { exists: true, size: 2, sha1: 's' }, 'new.js': { exists: true, size: 1, sha1: 'n' } }
  const d = diffEvidence(before, after)
  assert.deepEqual(d.modified, ['a.js'])
  assert.deepEqual(d.vanished, ['gone.js'])
  assert.deepEqual(d.appeared, ['new.js'])
  assert.deepEqual(d.unchanged, ['same.js'])
  assert.equal(d.changed, true)
})

test('同样的证据 → changed=false（收口不能靠"我改了"的自述）', () => {
  const e = { 'a.js': { exists: true, size: 1, sha1: 'x' } }
  assert.equal(diffEvidence(e, e).changed, false)
})

test('glob → 正则支持 ** 与 *', () => {
  assert.ok(globToRegExp('src/**/*.js').test('src/a/b/c.js'))
  assert.ok(globToRegExp('src/*.js').test('src/a.js'))
  assert.equal(globToRegExp('src/*.js').test('src/a/b.js'), false)
  assert.ok(globToRegExp('**/*.md').test('a.md'))
})

test('不在磁盘上的落点记 exists:false，不算 vanished（也不清空 scope）', async (t) => {
  const root = tmpRoot(t)
  put(root, 'a.js')
  const e1 = evidenceOf(root, ['a.js', 'ghost.js'])
  assert.equal(e1['a.js'].exists, true)
  assert.equal(e1['ghost.js'].exists, false)
  const e2 = evidenceOf(root, ['a.js', 'ghost.js'])
  assert.equal(diffEvidence(e1, e2).changed, false, '本来就不存在的文件不该每次都被报成漂移')
})

// ============ 六闸 ============

test('闸门1 锚点闸：缺锚点 / 假锚点 → 拒；真节点 → 过', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const m = buildModel(root)
  assert.equal(anchorGate(m, '').severity, 'reject')
  assert.equal(anchorGate(m, 'NOPE').severity, 'reject')
  assert.equal(anchorGate(m, 'PN-F01').pass, true)
  assert.equal(anchorGate(m, 'core').pass, true)
  assert.equal(anchorGate(m, '.internal/arch/x.md').pass, true, '架构档是合法锚点')
})

test('闸门1 锚点闸：已退役节点不能当锚点', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await appendEvents(root, [{ kind: 'node', op: 'retire', layer: 'feature', id: 'PN-F01' }])
  const m = buildModel(root)
  assert.equal(anchorGate(m, 'PN-F01').severity, 'reject')
})

test('闸门3 主线闸：低于主线告警，未设 doing 也告警', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  let m = buildModel(root)
  assert.equal(mainlineGate(m, { scope: { modules: [] }, materialized: { files: ['src/a.js'] } }).pass, true)
  await appendEvents(root, [{ kind: 'set', vector: { doing: 'other', next: '' } }])
  m = buildModel(root)
  const r = mainlineGate(m, { scope: { modules: [] }, materialized: { files: ['src/a.js'] } })
  assert.equal(r.severity, 'warn')
  assert.match(r.detail, /core/)
})

test('闸门4 计数闸：第 3 次补丁拒，第 2 次告警；决策重置', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  for (let i = 0; i < 2; i++) await appendEvents(root, [{ kind: 'commit', phase: 'closed', anchor: 'PN-F01', task: `p${i}`, scope: { files: [] } }])
  let m = buildModel(root)
  assert.equal(countGate(m, 'PN-F01').severity, 'warn')
  await appendEvents(root, [{ kind: 'commit', phase: 'closed', anchor: 'PN-F01', task: 'p2', scope: { files: [] } }])
  m = buildModel(root)
  const blocked = countGate(m, 'PN-F01')
  assert.equal(blocked.severity, 'reject')
  assert.match(blocked.detail, /3 次补丁/)
  // 决策重置计数闸
  await appendEvents(root, [{ kind: 'decide', anchor: 'PN-F01', reason: 'r', decision: 'd' }])
  m = buildModel(root)
  assert.equal(countGate(m, 'PN-F01').pass, true, '决策登记必须重置该锚点补丁计数')
  assert.equal(pressureFor(m, 'PN-F01').sinceDecisionCount, 0)
})

test('计数闸按**归一键**统计：功能码与节点 id 是同一个锚点（否则恒 0 且静默）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await appendEvents(root, [{ kind: 'commit', phase: 'closed', anchor: 'PN-F01', task: 'a', scope: { files: [] } }])
  await appendEvents(root, [{ kind: 'commit', phase: 'closed', anchor: 'feature:pn-f01', task: 'b', scope: { files: [] } }])
  const m = buildModel(root)
  assert.equal(pressureFor(m, 'PN-F01').sinceDecisionCount, 2)
  assert.equal(pressureFor(m, 'feature:pn-f01').sinceDecisionCount, 2)
})

test('闸门2 范围闸：撞 notDoing → 拒；与在途 scope 重叠 → 告警', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const m = buildModel(root)
  const collide = scopeGate(m, { scope: { files: ['forbidden-thing.js'] }, materialized: { files: ['forbidden-thing.js'] } })
  assert.equal(collide.severity, 'reject')
  const overlap = scopeGate({ ...m, openCommits: [{ seq: 1, id: 'ACT-1', task: 'other', files: ['src/a.js'] }] },
    { scope: { features: ['PN-F01'] }, materialized: { files: ['src/a.js'] } })
  assert.equal(overlap.severity, 'warn')
  assert.match(overlap.detail, /ACT-1/)
})

test('闸门5 决策闸：arch= 缺失只告警（不阻断工程），填写即过', () => {
  assert.equal(decisionGate({}).severity, 'warn')
  assert.equal(decisionGate({ arch: '架构不变，纯局部修复' }).pass, true)
})

test('runGates 汇总：blocked 与 warnings 分离', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const m = buildModel(root)
  const r = runGates(m, { anchor: 'NOPE', scope: {}, materialized: { files: ['src/a.js'] } })
  assert.ok(r.blocked.length >= 1)
  // 钉住的是**闸门集合**（架构契约，ARCHITECTURE §6），不是数字 —— 数字会漂，集合不会。
  assert.deepEqual(
    r.results.map((x) => x.gate).sort(),
    ['anchor', 'completion', 'count', 'decision', 'impact', 'mainline', 'scope'],
    '七闸一个不少'
  )
})

// ============ 写入：意图登记与自动收口（A1） ============

test('nav_commit 登记意图并落证据快照', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const res = await commitIntent(root, {
    task: '改 a.js', anchor: 'PN-F01', arch: '架构不变',
    scope: { features: ['PN-F01'] }
  })
  assert.equal(res.status, 'ok')
  assert.equal(res.commit.id, 'ACT-5')
  const m = buildModel(root)
  assert.equal(m.openCommits.length, 1)
  assert.ok(m.openCommits[0].evidence['src/a.js'].sha1, '证据必须先落，收口才有判据')
})

test('A1 收口不依赖会话：证据一变，下一次任意调用自动收口', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'ok', scope: { features: ['PN-F01'] } })
  let m = buildModel(root)
  assert.equal(m.openCommits.length, 1)
  assert.equal((await reconcile(root)).closed.length, 0, '证据没变 → 继续在途（不是孤儿，也不该被收掉）')
  touch(root, 'src/a.js', 'changed-content')
  const rec = await reconcile(root)
  assert.equal(rec.closed.length, 1)
  m = buildModel(root)
  assert.equal(m.openCommits.length, 0, '证据已变 → 自动收口')
  assert.equal(m.commits.find((c) => c.seq === 5).phase, 'closed')
  assert.deepEqual(m.commits.find((c) => c.seq === 5).outcome.modified, ['src/a.js'])
})

test('收口事件记录三类变化（改 / 消失 / 新增）', async (t) => {
  const root = tmpRoot(t)
  await seed(root, { files: ['src/a.js', 'src/b.js'] })
  // scope 用 glob 声明：这样"新落在 scope 内"的文件才算 appeared（语义边界要测准）
  await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'ok', scope: { files: ['src/*.js'] } })
  touch(root, 'src/a.js', 'x2')
  rmSync(join(root, 'src/b.js'))
  put(root, 'src/c.js')
  const rec = await reconcile(root)
  assert.equal(rec.closed.length, 1)
  const out = rec.closed[0].diff
  assert.deepEqual(out.modified, ['src/a.js'])
  assert.deepEqual(out.vanished, ['src/b.js'])
  assert.deepEqual(out.appeared, ['src/c.js'])
})

test('在途意图按当前索引重解析：登记后新加进功能的文件会被收口', async (t) => {
  const root = tmpRoot(t)
  await seed(root, { files: ['src/a.js'] })
  await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'ok', scope: { features: ['PN-F01'] } })
  // 把一个新文件登记进同一功能（索引变了）→ 该文件进入在途 scope
  put(root, 'src/added.js')
  await appendEvents(root, [{ kind: 'node', op: 'upsert', layer: 'feature', id: 'PN-F01', fields: { files: ['src/a.js', 'src/added.js'] } }])
  const rec = await reconcile(root)
  assert.equal(rec.closed.length, 1)
  assert.deepEqual(rec.closed[0].diff.appeared, ['src/added.js'])
})

test('空 scope 被拒：解析出 0 个文件 = 没有收口判据', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const res = await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'ok', scope: { files: ['assets/*.png'] } })
  assert.equal(res.status, 'rejected')
  assert.match(res.reason, /0 个文件/)
})

test('字面量文件尚不存在也允许登记（新文件会以 appeared 被收口）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const res = await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'ok', scope: { files: ['src/brand-new.js'] } })
  assert.equal(res.status, 'ok')
  assert.deepEqual(res.materialized.files, ['src/brand-new.js'])
  put(root, 'src/brand-new.js')
  const rec = await reconcile(root)
  assert.deepEqual(rec.closed[0].diff.appeared, ['src/brand-new.js'])
})

test('闸门拒绝时**不写任何事件**（拒就是拒）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const before = readEvents(root).events.length
  const res = await commitIntent(root, { task: 't', anchor: 'NOPE', arch: 'ok', scope: { features: ['PN-F01'] } })
  assert.equal(res.status, 'blocked')
  assert.equal(readEvents(root).events.length, before, '被拒的意图不得留下半条记录')
})

test('archive 是唯一绕过证据的收口出口，且只对在途意图生效', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const r1 = await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'ok', scope: { files: ['src/a.js'] } })
  assert.equal(r1.status, 'ok')
  const a = await archiveIntent(root, r1.commit.id, '方向已废')
  assert.equal(a.status, 'ok')
  assert.equal(buildModel(root).openCommits.length, 0)
  const again = await archiveIntent(root, r1.commit.id, '再来一次')
  assert.equal(again.status, 'no-action', '已收口的不能再归档')
})

test('开新意图会先按证据收上一笔（完结闸 = 自动对账）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await commitIntent(root, { task: '第一笔', anchor: 'PN-F01', arch: 'ok', scope: { files: ['src/a.js'] } })
  touch(root, 'src/a.js', 'v2')
  const res = await commitIntent(root, { task: '第二笔', anchor: 'PN-F01', arch: 'ok', scope: { files: ['src/a.js'] } })
  assert.equal(res.reconcile.closed.length, 1, '开新笔时自动收上一笔')
  assert.equal(buildModel(root).openCommits.length, 1)
  assert.equal(buildModel(root).openCommits[0].task, '第二笔')
})

// ============ 依赖图：import 静态扫描（ARCHITECTURE §1 的「谁引用谁」） ============

test('extractSpecifiers：跨行 import 抽得到；注释里的 import 必须被剥掉（幻影边比缺边更糟）', () => {
  const src = [
    'import {',
    '  a,',
    '  b',
    "} from './x.js'",
    "import './side.js'",
    "const c = require('./y.js')",
    "const d = await import('./z.js')",
    "import pkg from 'external-pkg'",
    "// import Ghost from './line-comment.js'",
    "/* import Blocked from './block-comment.js' */",
    "const url = 'https://example.com/a.js'"
  ].join('\n')
  const specs = extractSpecifiers(src)
  assert.deepEqual(specs, ['./x.js', './side.js', './y.js', './z.js', 'external-pkg'])
  assert.ok(!specs.some((s) => s.includes('comment')), '注释中的 import 是幻影边，必须剥掉')
})

test('scanImports：相对引用成边、外部包单列、解析不到不静默丢（F4 精神）', async (t) => {
  const root = tmpRoot(t)
  put(root, 'src/a.js', "import b from './b.js'\nimport ext from 'lodash'\nimport m from './missing.js'\n")
  put(root, 'src/b.js', 'export default 1\n')
  const r = scanImports(root, walkFiles(root))
  assert.deepEqual(r.edges.get('src/a.js'), ['src/b.js'])
  assert.deepEqual(r.external.get('src/a.js'), ['lodash'])
  assert.deepEqual(r.unresolved, ['src/a.js -> ./missing.js'])
})

test('scanImports：确定性 —— 同输入必同输出（它是磁盘派生的事实，不是推断）', async (t) => {
  const root = tmpRoot(t)
  put(root, 'src/a.js', "import './b.js'\n")
  put(root, 'src/b.js', "import './c.js'\n")
  put(root, 'src/c.js', 'export const c = 1\n')
  const one = scanImports(root, walkFiles(root))
  const two = scanImports(root, walkFiles(root))
  assert.deepEqual([...one.edges], [...two.edges])
})

test('isTestPath：测试是「预期下游」，不当影响面告警', () => {
  assert.equal(isTestPath('test/core.test.mjs'), true)
  assert.equal(isTestPath('src/__tests__/x.js'), true)
  assert.equal(isTestPath('src/a.spec.ts'), true)
  assert.equal(isTestPath('core/model.js'), false)
})

test('模型把文件边提升为跨节点边，影响面按文件精度给出', async (t) => {
  const root = tmpRoot(t)
  await seed(root)                                   // PN-F01 -> src/a.js
  put(root, 'src/b.js', "import a from './a.js'\n")
  await appendEvents(root, [
    { kind: 'node', op: 'upsert', layer: 'feature', id: 'PN-F02', fields: { name: 'PN-F02', files: ['src/b.js'], module: 'core' } }
  ])
  const m = buildModel(root)
  assert.deepEqual([...m.edges.dependents.get('feature:pn-f01')], ['feature:pn-f02'], 'F02 依赖 F01')
  assert.deepEqual(impactOf(m, ['src/a.js']).get('src/a.js'), ['src/b.js'], '影响面用文件精度，不用节点粗粒度')
})

test('影响面闸：跨节点牵动 → 告警；引用方也在 scope 内 → 过（否则是狼来了）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, 'src/b.js', "import a from './a.js'\n")
  await appendEvents(root, [
    { kind: 'node', op: 'upsert', layer: 'feature', id: 'PN-F02', fields: { name: 'PN-F02', files: ['src/b.js'], module: 'core' } }
  ])
  const m = buildModel(root)
  const intent = (scope) => ({ scope, materialized: { files: ['src/a.js'] } })

  const cross = impactGate(m, intent({ features: ['PN-F01'] }))
  assert.equal(cross.severity, 'warn', 'scope 外节点引用它 ⇒ 必须告警')
  assert.match(cross.detail, /pn-f02/)

  const same = impactGate(m, intent({ features: ['PN-F01', 'PN-F02'] }))
  assert.equal(same.pass, true, '引用方也在 scope 内 ⇒ 已覆盖，不告警')

  assert.equal(impactGate(m, { scope: {}, materialized: { files: [] } }).pass, true, 'scope 为空不误报')
})
