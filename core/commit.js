// core/commit.js — 写入编排：意图登记 + 按证据自动收口（ARCHITECTURE §4/§5 完结闸）
//
// 这里没有"生命周期"：登记一笔意图（open）后，收口（closed）由**证据**触发，
// 与哪个会话、谁先谁后无关。会话死了、进程重启了，收口照样发生（A1）。

import { existsSync, mkdirSync, readFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { paths, nowIso } from './paths.js'
import { appendEvents, rewriteVerified } from './log.js'
import { loadModel } from './model.js'
import { resolveScope, evidenceOf, diffEvidence } from './scope.js'
import { withLock } from './lock.js'
import { runGates } from './gates.js'

/** 意图 → 落点物化（F4：三来源等权合并，解析不出来的必须显式报出） */
export function materialize(rootPath, model, scope, anchor) {
  const r = resolveScope(rootPath, model, scope)
  return {
    scope: {
      features: (scope.features || []).map(String),
      modules: (scope.modules || []).map(String),
      files: (scope.files || []).map(String)
    },
    anchor,
    files: r.files,
    missing: r.missing,
    unresolved: r.unresolved,
    sources: { fromIndex: r.fromIndex, fromLiteral: r.fromLiteral, fromGlob: r.fromGlob }
  }
}

function inflightFile(rootPath, seq) {
  return join(paths.inflightDir(rootPath), `${seq}.json`)
}

function writeInflight(rootPath, commit) {
  try {
    mkdirSync(paths.inflightDir(rootPath), { recursive: true })
    rewriteVerified(inflightFile(rootPath, commit.seq), JSON.stringify({
      id: commit.id, seq: commit.seq, at: commit.at, anchor: commit.anchor,
      task: commit.task, scope: commit.scope, files: commit.files, evidence: commit.evidence
    }, null, 2))
  } catch { /* 在途状态是缓存：丢了也能从事件流复算（I3） */ }
}

function clearInflight(rootPath, seq) {
  try { const f = inflightFile(rootPath, seq); if (existsSync(f)) unlinkSync(f) } catch { /* 同上 */ }
}

/** 在途意图的 scope 声明（写入事件，收口时按它重解析）。 */
function matchSpecOf(intent) {
  return {
    features: (intent.scope?.features || []).map(String),
    modules: (intent.scope?.modules || []).map(String),
    files: (intent.scope?.files || []).map(String)
  }
}

/**
 * 一笔意图当前应覆盖的文件集合 = **按 scope 声明重新解析**，而不是用登记时的快照。
 *
 * 为什么必须是重解析：新造出来的文件在登记时还不存在，用快照比对就永远看不见"新增"，
 * 这类改动会永久卡在在途（旧账本里"孤儿动作"的同类形态）。
 */
export function filesForCommit(rootPath, model, c) {
  const spec = c.scope || {}
  const r = resolveScope(rootPath, model, spec)
  const files = new Set(r.files)
  for (const f of c.files || []) files.add(f)
  return [...files].sort()
}

/**
 * 按证据收口所有该收的在途意图。
 *
 * 判据只有一条：**scope 内文件的证据是否已变化**。
 * 证据没变 ⇒ 继续在途（有人正在改，这不是孤儿，也不该被"收掉"）。
 *
 * @returns {{closed:object[], stillOpen:object[]}}
 */
export async function reconcile(rootPath, { now = Date.now(), actor = null } = {}) {
  const model = loadModel(rootPath, { now })
  if (!model.openCommits.length) return { closed: [], stillOpen: [] }

  const closed = []
  const stillOpen = []
  for (const c of model.openCommits) {
    const before = c.evidence || {}
    if (!Object.keys(before).length) { stillOpen.push({ ...c, reason: 'empty-evidence' }); continue }
    const files = filesForCommit(rootPath, model, c)
    const after = evidenceOf(rootPath, files)
    const diff = diffEvidence(before, after)
    if (!diff.changed) { stillOpen.push({ ...c, reason: 'unchanged', diff }); continue }
    closed.push({ commit: c, diff })
  }
  if (!closed.length) return { closed: [], stillOpen }

  // 收口一律在锁内追加（避免两个会话同时收同一笔）。
  // 锁被占用不是错误：说明另一个会话正在收口，下一次调用（或它自己）会处理。
  // 把"等待别人"当成失败会让并发场景整体报错 —— 那是 v0.9.0 要根治的那类形态。
  const deferred = []
  try {
    await withLock(rootPath, 'events', async () => {
      for (const { commit: c, diff } of closed) {
        // 二次确认：锁内重读，防止别人已经收过
        const fresh = loadModel(rootPath, { now })
        const still = fresh.openCommits.find((x) => x.seq === c.seq)
        if (!still) continue
        await appendEvents(rootPath, [{
          kind: 'commit', phase: 'closed', closes: c.seq, anchor: c.anchor,
          task: c.task, plan: '', scope: c.scope, arch: c.arch, actor,
          outcome: {
            evidence: 'changed',
            modified: diff.modified, vanished: diff.vanished, appeared: diff.appeared
          }
        }], { now })
        clearInflight(rootPath, c.seq)
      }
    }, { timeoutMs: 15000 })
  } catch (e) {
    if (!/is held by another writer/.test(String(e.message))) throw e
    for (const { commit: c, diff } of closed) deferred.push({ ...c, diff, reason: 'lock-deferred' })
    return { closed: [], stillOpen: [...stillOpen, ...deferred] }
  }

  return { closed, stillOpen }
}

/**
 * 登记一笔改动意图。
 * @returns {{status:'blocked'|'rejected'|'ok', ...}}
 */
export async function commitIntent(rootPath, intent, { now = Date.now(), actor = null } = {}) {
  // 1) 完结闸：先按证据收掉该收的（自动收口）
  const rec = await reconcile(rootPath, { now, actor })

  // 2) 用收口后的模型做闸门查询
  const model = loadModel(rootPath, { now })
  const scope = {
    features: intent.scope?.features || [],
    modules: intent.scope?.modules || [],
    files: intent.scope?.files || []
  }

  // 3) 空 scope 且想开新意图 → 拒（空 scope 没有证据可收，会永久卡在在途）
  const mat = materialize(rootPath, model, scope, intent.anchor)
  if (!mat.files.length) {
    return {
      status: 'rejected', reconcile: rec, gates: null, materialized: mat,
      reason: 'ERROR: scope 解析出 0 个文件 —— 没有证据就没有收口判据。',
      hint: '给 features=/modules=/files=（支持 glob）；若确实只改文档，用 files=<路径> 显式登记。'
    }
  }

  // 4) 六闸
  const gateReport = runGates(model, { ...intent, scope, materialized: mat }, { pending: rec.stillOpen })
  if (gateReport.blocked.length) {
    return { status: 'blocked', reconcile: rec, gates: gateReport, materialized: mat }
  }

  // 5) 登记（含证据快照 —— 收口判据就写在这里，不在 runtime）
  const evidence = evidenceOf(rootPath, mat.files)
  const [written] = await appendEvents(rootPath, [{
    kind: 'commit', phase: 'open', anchor: intent.anchor, task: intent.task,
    plan: intent.plan || '', scope, arch: intent.arch ?? null, actor,
    files: mat.files, evidence
  }], { now })
  writeInflight(rootPath, written)

  return {
    status: 'ok', reconcile: rec, gates: gateReport, materialized: mat,
    commit: { id: `ACT-${written.seq}`, seq: written.seq, at: written.at }
  }
}

/** 显式归档一笔在途意图（唯一绕过证据的出口：空 scope / 误建 / 方向已废）。 */
export async function archiveIntent(rootPath, id, reason, { now = Date.now(), actor = null } = {}) {
  const model = loadModel(rootPath, { now })
  const seq = Number(String(id).replace(/^ACT-/, ''))
  const target = model.openCommits.find((c) => c.seq === seq)
  if (!target) {
    return { status: 'no-action', reason: `未找到在途意图 ${id}（只有 open 的意图可归档）。` }
  }
  await appendEvents(rootPath, [{
    kind: 'commit', phase: 'closed', closes: target.seq, anchor: target.anchor,
    task: target.task, plan: '', scope: target.scope, arch: target.arch, actor,
    outcome: { evidence: 'archived', reason: reason || '(no reason given)' }
  }], { now })
  clearInflight(rootPath, target.seq)
  return { status: 'ok', archived: { id: `ACT-${target.seq}`, task: target.task } }
}

/** 读在途意图的诊断视图（nav_graph）。 */
export function inflightView(rootPath) {
  const dir = paths.inflightDir(rootPath)
  if (!existsSync(dir)) return []
  const out = []
  try {
    for (const f of readdirSync(dir)) {
      try { out.push(JSON.parse(readFileSync(join(dir, f), 'utf-8'))) } catch { /* 单文件坏 → 跳过 */ }
    }
  } catch { /* 诊断 best-effort */ }
  return out
}
