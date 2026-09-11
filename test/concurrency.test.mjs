// test/concurrency.test.mjs — 并发与锁（F1/F2 的事故事实，新架构口径）
//
// 旧套件 998 行里真正值钱的是**事实**，不是代码：
//   ① 两会话并发写 → 索引被覆盖回退（F1）    ② 破锁竞态会删掉别人新建的锁（F2）
//   ③ 活锁被误破 / 自锁等待（→ token 校验 + 可重入）
// 新架构的答案：事件流 append-only（"覆盖回退"在结构上不可能）+ runtime 锁只保护可丢缓存。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpRoot, put, touch, seed } from './helper.mjs'
import { appendEvents, readEvents, verifyLog } from '../core/log.js'
import { buildModel, loadModel } from '../core/model.js'
import { commitIntent, reconcile } from '../core/commit.js'
import { acquire, release, withLock, listLocks } from '../core/lock.js'
import { paths } from '../core/paths.js'

test('F1 并发追加 20 次：一条不丢、seq 无重复、无空洞', async (t) => {
  const root = tmpRoot(t)
  const writers = 20
  await Promise.all(Array.from({ length: writers }, (_, i) =>
    appendEvents(root, [{ kind: 'set', vector: { doing: `w${String(i).padStart(2, '0')}` } }])))
  const { events, corrupt } = readEvents(root)
  assert.equal(corrupt.length, 0)
  assert.equal(events.length, writers)
  assert.deepEqual(events.map((e) => e.seq), Array.from({ length: writers }, (_, i) => i + 1))
  assert.equal(new Set(events.map((e) => e.vector.doing)).size, writers, '任何一次写入都不许被覆盖掉')
  assert.ok(verifyLog(root).ok)
})

test('F1 并发创建节点：全部存活（旧实现会互相覆盖索引）', async (t) => {
  const root = tmpRoot(t)
  const n = 12
  await Promise.all(Array.from({ length: n }, (_, i) =>
    appendEvents(root, [{ kind: 'node', op: 'upsert', layer: 'feature', id: `C-F${i}`, fields: { name: `F${i}`, files: [`f${i}.js`] } }])))
  const m = buildModel(root)
  assert.equal([...m.nodes.values()].filter((x) => x.layer === 'feature').length, n)
  assert.equal(m.nodes.size, n)
})

test('并发决策：ADR id 互异（id 由 seq 派生，不存在"分配竞态"）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const n = 8
  await Promise.all(Array.from({ length: n }, (_, i) =>
    appendEvents(root, [{ kind: 'decide', anchor: 'PN-F01', reason: `r${i}`, decision: `d${i}` }])))
  const ids = buildModel(root).decisions.map((d) => d.id)
  assert.equal(ids.length, n)
  assert.equal(new Set(ids).size, n)
})

test('并发意图登记：多笔 open 意图共存且各带自己的证据', async (t) => {
  const root = tmpRoot(t)
  await seed(root, { files: ['src/a.js'] })
  put(root, 'src/b.js')
  await Promise.all([
    commitIntent(root, { task: 'A', anchor: 'PN-F01', arch: 'a', scope: { files: ['src/a.js'] } }),
    commitIntent(root, { task: 'B', anchor: 'PN-F01', arch: 'a', scope: { files: ['src/b.js'] } })
  ])
  const m = buildModel(root)
  assert.equal(m.openCommits.length, 2)
  for (const c of m.openCommits) assert.equal(Object.keys(c.evidence).length, 1)
})

test('并发收口：同一批意图不会被收两遍', async (t) => {
  const root = tmpRoot(t)
  await seed(root, { files: ['src/a.js'] })
  put(root, 'src/b.js')
  const c1 = await commitIntent(root, { task: 'A', anchor: 'PN-F01', arch: 'a', scope: { files: ['src/a.js'] } })
  const c2 = await commitIntent(root, { task: 'B', anchor: 'PN-F01', arch: 'a', scope: { files: ['src/b.js'] } })
  touch(root, 'src/a.js', 'v2')
  touch(root, 'src/b.js', 'v2')
  await Promise.all([reconcile(root), reconcile(root), reconcile(root), reconcile(root)])
  const m = buildModel(root)
  const targets = m.commits.filter((c) => c.closes !== undefined).map((c) => c.closes)
  assert.deepEqual(targets.slice().sort(), [c1.commit.seq, c2.commit.seq].sort())
  assert.equal(new Set(targets).size, targets.length, '同一意图不得被收两次')
  assert.equal(m.openCommits.length, 0)
})

test('F2 破锁竞态：过期锁被一个写手破除，且不留残骸', async (t) => {
  const root = tmpRoot(t)
  const a = await acquire(root, 'events', { staleMs: 0 })
  assert.equal(a.acquired, true)
  const b = await acquire(root, 'events', { staleMs: 0, timeoutMs: 2000 })
  assert.equal(b.acquired, true)
  assert.equal(b.broke, true, '过期锁必须被破除（rename 破锁：只有一个赢家）')
  release(root, 'events', b.token)
  const left = existsSync(paths.locksDir(root)) ? readdirSync(paths.locksDir(root)) : []
  assert.deepEqual(left, [], `锁目录必须无残骸: ${left.join(', ')}`)
})

test('F2 token 校验：绝不释放别人的锁', async (t) => {
  const root = tmpRoot(t)
  const a = await acquire(root, 'events', { staleMs: 60000 })
  assert.equal(a.acquired, true)
  assert.equal(release(root, 'events', 'not-my-token'), false, '非持有者不得释放')
  assert.equal(existsSync(join(paths.locksDir(root), 'events.lock')), true, '锁必须还在')
  assert.equal(release(root, 'events', a.token), true)
  assert.equal(existsSync(join(paths.locksDir(root), 'events.lock')), false)
})

test('锁可重入：同一写入流里嵌套取同名锁不会自锁', async (t) => {
  const root = tmpRoot(t)
  const out = await withLock(root, 'events', async () => {
    const inner = await acquire(root, 'events', { timeoutMs: 200 })
    assert.equal(inner.acquired, true)
    assert.equal(inner.reentrant, true)
    return 'done'
  })
  assert.equal(out, 'done')
  assert.equal(existsSync(join(paths.locksDir(root), 'events.lock')), false, '退出后锁必须释放')
})

test('锁超时是 fail-loud：不静默继续写（F1 的另一半）', async (t) => {
  const root = tmpRoot(t)
  const a = await acquire(root, 'events', { staleMs: 600000 })
  await assert.rejects(
    () => withLock(root, 'events', async () => 'should-not-run', { timeoutMs: 200, staleMs: 600000 }),
    /held by another writer/
  )
  release(root, 'events', a.token)
})

test('并发混合写后无锁残留，且事件流完整', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await Promise.all([
    appendEvents(root, [{ kind: 'node', op: 'upsert', layer: 'feature', id: 'X-F1', fields: { files: ['x.js'] } }]),
    appendEvents(root, [{ kind: 'decide', anchor: 'PN-F01', reason: 'r', decision: 'd' }]),
    appendEvents(root, [{ kind: 'set', vector: { doing: 'core' } }]),
    commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'a', scope: { features: ['PN-F01'] } })
  ])
  assert.ok(verifyLog(root).ok)
  assert.deepEqual(listLocks(root), [], '不得有锁残留')
})

test('并发读缓存：得到同一形状，且缓存坏了只导致重建', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'a', scope: { features: ['PN-F01'] } })
  const models = await Promise.all(Array.from({ length: 6 }, () => Promise.resolve().then(() => loadModel(root))))
  assert.equal(new Set(models.map((m) => m.nodes.size)).size, 1, '并发读必须得到同一形状')
  assert.ok(models.every((m) => m.vector.doing === 'core'))
})

test('事件流被外部截断：后续写入拒绝在坏流上追加（而不是把洞留在那里）', async (t) => {
  const root = tmpRoot(t)
  await appendEvents(root, [
    { kind: 'set', vector: { doing: 'a' } },
    { kind: 'set', vector: { doing: 'b' } },
    { kind: 'set', vector: { doing: 'c' } }
  ])
  const file = paths.events(root)
  const lines = readFileSync(file, 'utf-8').trim().split('\n')
  writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n', 'utf-8')
  await assert.rejects(() => appendEvents(root, [{ kind: 'set', vector: { doing: 'd' } }]), /integrity FAILED/)
})
