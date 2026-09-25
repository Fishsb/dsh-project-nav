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

// ⚠ 这两处**不是**"第二个真相"：失败原因由**返回值**就地交给调用方（回执），
//   既不落盘、也不进模型 —— 只把原本"被吞掉"的那条消息挪到一个可读出口。
//   为什么不能只打日志：日志不进 agent 的上下文，等于没报（本仓「静默失效」同族）。

/** 写一笔在途缓存。@returns {string|null} 失败原因（null = 成功）—— 失败必须能传出去，不许无声。 */
function writeInflight(rootPath, commit) {
  try {
    mkdirSync(paths.inflightDir(rootPath), { recursive: true })
    rewriteVerified(inflightFile(rootPath, commit.seq), JSON.stringify({
      id: commit.id, seq: commit.seq, at: commit.at, anchor: commit.anchor,
      task: commit.task, scope: commit.scope, files: commit.files, evidence: commit.evidence
    }, null, 2))
    return null
  } catch (e) {
    // 在途状态是缓存：丢了也能从事件流复算（I3）⇒ **不抛**，收口判据不受影响。
    // 但"写失败了"这件事本身必须可读 —— 交给回执。
    return String(e?.message || e)
  }
}

/** 清一笔在途缓存。@returns {string|null} 失败原因（null = 成功或本就无该文件）。 */
function clearInflight(rootPath, seq) {
  try {
    const f = inflightFile(rootPath, seq)
    if (existsSync(f)) unlinkSync(f)
    return null
  } catch (e) {
    // 同上：清不掉不改变"已收口"这个事实（那写在事件流里），但残骸必须可见。
    return String(e?.message || e)
  }
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
  if (!model.openCommits.length) return { closed: [], stillOpen: [], faulted: [] }

  const closed = []
  const stillOpen = []
  for (const c of model.openCommits) {
    const before = c.evidence || {}
    if (!Object.keys(before).length) { stillOpen.push({ ...c, reason: 'empty-evidence' }); continue }
    const files = filesForCommit(rootPath, model, c)
    const after = evidenceOf(rootPath, files)
    const diff = diffEvidence(before, after)
    // 收口的两种"不收"必须可区分：「读不到」不是「没变」——
    // 它意味着**这条证据不可判**，把它并按证据收口就是拿读失败当"改过了"（静默收口）。
    // 记仍 open 且把原因带出去，让调用方看得见"为什么没收"。
    // 解析漂移 ⇒ 判据**不可判**：这不是"文件变了"，是"文本→实体的对应关系变了"。
    // 拿它收口会在事件流写下因果错误的事实（如把无关同名文件记成 appeared）。
    // 与「读不到」同族：宁可不收，也不许拿不稳的证据收口。取整笔不收（不选中端口径），
    // 这样既不收口也不入库——避免恒在途却被当成"已解决"。
    if (diff.rerouted && diff.rerouted.length) {
      stillOpen.push({ ...c, reason: 'rerouted', rerouted: diff.rerouted, diff })
      continue
    }
    if (!diff.changed) {
      stillOpen.push(diff.unreadable.length
        ? { ...c, reason: 'unreadable', unreadable: diff.unreadable, diff }
        : { ...c, reason: 'unchanged', diff })
      continue
    }
    closed.push({ commit: c, diff })
  }
  if (!closed.length) return { closed: [], stillOpen, faulted: [] }

  // 收口一律在锁内追加（避免两个会话同时收同一笔）。
  // 锁被占用不是错误：说明另一个会话正在收口，下一次调用（或它自己）会处理。
  // 把"等待别人"当成失败会让并发场景整体报错 —— 那是 v0.9.0 要根治的那类形态。
  const deferred = []
  // 收口本身是**事件流里的事实**，与缓存清没清掉无关；但"残骸清不掉"必须能传出去
  // （静默的后果：在途缓存永远比模型多，且没人知道为什么 —— 与 writeInflight 吞错同型）。
  const faulted = []
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
        const err = clearInflight(rootPath, c.seq)
        if (err) faulted.push({ op: 'clear', id: c.id, seq: c.seq, anchor: c.anchor, error: err })
      }
    }, { timeoutMs: 15000 })
  } catch (e) {
    if (!/is held by another writer/.test(String(e.message))) throw e
    for (const { commit: c, diff } of closed) deferred.push({ ...c, diff, reason: 'lock-deferred' })
    return { closed: [], stillOpen: [...stillOpen, ...deferred], faulted }
  }

  return { closed, stillOpen, faulted }
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
  // 写缓存失败**不改变登记结果**（这仍是 'ok'：事实已在事件流里，I1/I3 要求如此），
  // 但失败原因随回执带出去 —— 否则"登记好了、缓存却没有"就永远只有用户自己看得出来。
  const fault = writeInflight(rootPath, written)

  return {
    status: 'ok', reconcile: rec, gates: gateReport, materialized: mat,
    inflightFault: fault,
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
  // 归档出口与收口同办：清不掉残骸必须能传出去（否则回执说"已归档"，缓存里那笔还在）。
  const fault = clearInflight(rootPath, target.seq)
  return { status: 'ok', inflightFault: fault, archived: { id: `ACT-${target.seq}`, task: target.task } }
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

/**
 * **在途缓存 ⟷ 模型在途**的差集 —— 从缓存文件名（`<seq>.json`，与模型笔的 `seq` 同键空间）确定性比对。
 *
 * 判据只用**数集**（seq 集合），不用耗时、不读文件内容 ⇒ 可确定断言：
 *   · `missing` = 模型说 open、缓存里没有 ⇒ 该笔的缓存丢了（写失败 / 被删）
 *   · `extra`   = 缓存里有、模型说不在途 ⇒ 残骸（清理失败 / 幽灵条目）
 *   · `over`/`under` = 两种方向各自的计数，供 health 一行直出
 *
 * ⚠ **方向**：模型 → 缓存。缓存**永远不是**第二真相（I1）——它在事件流之后，
 * 且这里只拿它当"被检查物"，任何一侧都不能反过来定义另一侧（I3：删掉 runtime/ 零损失）。
 * 没有 inflight 目录 = 缓存一条都没有（不是"没读到"）——模型有 open 就报 missing。
 *
 * ⚠ **不报** readdir 失败与解析失败：那是"读不到"，与"不一致"不同类，
 * 混进同一行就是拿读失败当差异（本仓 A2 裁决的静默收口同型）。它们走 digest 的 `unreadable`。
 */
export function inflightDrift(rootPath, model) {
  const opens = model?.openCommits || []
  const seqs = new Set(opens.map((c) => c.seq))
  const dir = paths.inflightDir(rootPath)
  const digest = { dir, ok: true, unreadable: [], skipped: [] }
  const files = new Set()
  if (existsSync(dir)) {
    let entries = []
    try { entries = readdirSync(dir) } catch (e) {
      digest.ok = false
      digest.unreadable.push(`目录读不到: ${String(e?.message || e)}`)
    }
    for (const f of entries) {
      const m = /^(\d+)\.json$/.exec(f)
      if (!m) { if (f !== '.keep') digest.skipped.push(f); continue }   // 非缓存命名 = 未归类残骸，不是"缓存条目"
      files.add(Number(m[1]))
    }
  }
  const missing = [], extra = []
  for (const c of opens) if (!files.has(c.seq)) missing.push({ id: c.id, seq: c.seq, anchor: c.anchor, task: c.task })
  for (const s of [...files].sort((a, b) => a - b)) {
    if (!seqs.has(s)) extra.push({ id: `ACT-${s}`, seq: s, file: `${s}.json` })
  }
  return {
    ...digest,
    dirExists: existsSync(dir),
    /** 缓存里**合法命名**的条目数（模型侧对应量 = model.openCommits.length）。 */
    cached: files.size,
    open: opens.length,
    missing, extra,
    over: missing.length,
    under: extra.length,
    read: missing.length + extra.length,
    /** 一致 ⇔ 一个方向都不缺、一个方向都不多。 */
    consistent: missing.length === 0 && extra.length === 0
  }
}
