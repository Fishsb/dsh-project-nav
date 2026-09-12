// core/gates.js — 七闸（ARCHITECTURE §6）
//
// 每个闸门都是**对架构模型的纯查询**，不是独立流程。这是 P3 的直接后果：
//   · 没有 begin/done 生命周期 ⇒ 不可能产生"孤儿动作"
//   · 闸门不持有状态 ⇒ 不需要身份 ⇒ 报错原文「a session can only drive its own actions」消失
//
// 强度只有两档：reject（拒，写不进去）与 warn（告警，写进去但信号可见）。
//
// 告警闸的纪律（否则闸门会变成"狼来了"）：只报**跨节点**的牵动。
// 同一节点内部的引用是预期行为，报出来就是噪声。

import { key, normSlashes } from './paths.js'
import { normalizeAnchor, pressureFor, impactOf, REPEAT_PATCH_THRESHOLD } from './model.js'
import { isTestPath } from './scope.js'

export const SEVERITY = { REJECT: 'reject', WARN: 'warn' }

const ok = (gate, detail = '') => ({ gate, pass: true, severity: null, detail })
const warn = (gate, detail, hint = '') => ({ gate, pass: false, severity: SEVERITY.WARN, detail, hint })
const reject = (gate, detail, hint = '') => ({ gate, pass: false, severity: SEVERITY.REJECT, detail, hint })

/** 闸门 1 · 锚点闸：这个任务的架构节点真实存在吗？ */
export function anchorGate(model, anchor) {
  const a = String(anchor ?? '').trim()
  if (!a) {
    return reject('anchor',
      'ERROR: nav_commit requires anchor=<架构节点> —— 所有开发动作必须从架构出发。',
      '先跑 nav_graph <目标> 拿到锚点。无锚点的动作 = 还没有架构思考，十有八九会变成局部补丁。')
  }
  const n = normalizeAnchor(model, a)
  if (!n) {
    return reject('anchor',
      `ERROR: anchor "${a}" 不是真实架构节点。`,
      '用 nav_graph 确认；新节点先用 nav_node 登记（功能给 files=，模块给 features=/project=）。')
  }
  if (n.kind === 'node' && n.node.status === 'retired') {
    return reject('anchor', `ERROR: anchor "${a}" 已退役（retired）。`, '改挂到现行节点，或先 nav_node 恢复登记。')
  }
  return ok('anchor', `锚点 = ${n.id}${n.kind === 'archdoc' ? '（架构档）' : ''}`)
}

/** 闸门 2 · 范围闸：撞主线反面吗？撞别人在途 scope 吗？ */
export function scopeGate(model, intent) {
  const scope = intent.scope || {}
  const items = [...(scope.features || []), ...(scope.modules || []), ...(scope.files || [])].map(String)
  const notDoing = String(model.vector?.notDoing || '').trim()
  if (notDoing) {
    const nk = key(notDoing)
    for (const it of items) {
      const ik = key(it)
      if (!ik) continue
      if (nk.includes(ik) || ik.includes(nk)) {
        return reject('scope',
          `ERROR: scope 撞主线反面（notDoing: "${notDoing}"）via "${it}"。`,
          '重新划 scope，或先改主线向量（nav_set notDoing=）。')
      }
    }
  }
  const mine = new Set((intent.materialized?.files || []).map(key))
  const overlaps = []
  for (const c of model.openCommits) {
    if (intent.closes === c.seq) continue
    const theirs = new Set((c.files || []).map(key))
    const shared = [...mine].filter((f) => theirs.has(f))
    if (shared.length) overlaps.push({ commit: c.id, task: c.task, files: shared })
  }
  if (overlaps.length) {
    return warn('scope',
      `${overlaps.length} 笔在途意图与你重叠：${overlaps.map((o) => `${o.commit}(${o.files.slice(0, 3).join(', ')}${o.files.length > 3 ? '…' : ''})`).join('、')}`,
      '重叠文件级串行更安全：等它按证据收口（改完文件即自动收），或把 scope 切成不相交的片。')
  }
  return ok('scope', `scope 与主线反面无冲突，与在途意图无重叠（${mine.size} 文件）`)
}

/** 闸门 3 · 主线闸：scope 里的模块在主线上吗？ */
export function mainlineGate(model, intent) {
  const vectorText = key(`${model.vector?.doing || ''} ${model.vector?.next || ''}`)
  const modules = new Set()
  for (const m of intent.scope?.modules || []) modules.add(String(m))
  for (const f of intent.scope?.features || []) {
    const n = model.nodes.get(`feature:${key(f)}`)
    if (n?.module) modules.add(n.module)
  }
  for (const f of intent.materialized?.files || []) {
    for (const owner of model.fileOwners.get(key(f)) || []) {
      const n = model.nodes.get(owner)
      if (n?.module) modules.add(n.module)
    }
  }
  const offMainline = [...modules].filter((m) => !vectorText.includes(key(m)))
  if (!model.vector?.doing) {
    return warn('mainline', '主线向量 doing 为空，无法判定漂移。', '跑 nav_set doing=<当前焦点>，否则"漂移"永远探测不出来。')
  }
  if (offMainline.length) {
    return warn('mainline', `模块 ${offMainline.join(', ')} 未被主线向量（doing/next）引用。`,
      '确认它在主线上，或先 nav_set 更新向量 —— 主线外的改动就是漂移。')
  }
  return ok('mainline', 'scope 涉及的模块都在主线上')
}

/** 闸门 7 · 影响面闸：scope 的落点被 **scope 之外的节点** 引用了吗？（全局思想的最小强制） */
export function impactGate(model, intent) {
  const files = intent.materialized?.files || []
  if (!files.length) return ok('impact', '无落点文件，影响面不可判（scope 为空时不误报）')

  // scope 自己的节点集 = 显式声明的 ∪ 从落点归属推导的
  const scopeNodes = new Set()
  for (const f of files) for (const o of model.fileOwners.get(key(f)) || []) scopeNodes.add(o)
  for (const c of intent.scope?.features || []) scopeNodes.add(`feature:${key(c)}`)
  for (const m of intent.scope?.modules || []) scopeNodes.add(`module:${key(m)}`)

  const impact = impactOf(model, files)
  const outside = []                     // [被引文件, [scope 外的引用方]]
  for (const [target, froms] of impact) {
    const outs = froms.filter((f) => {
      if (isTestPath(f)) return false                    // 测试是预期下游，不算"意外牵动"
      const owners = model.fileOwners.get(key(f)) || []
      return owners.length > 0 && owners.every((o) => !scopeNodes.has(o))
    })
    if (outs.length) outside.push([target, outs])
  }
  if (!outside.length) return ok('impact', `本 scope 的 ${files.length} 个落点没有被 scope 外的节点引用`)

  const downFiles = new Set()
  const downNodes = new Set()
  for (const [, froms] of outside) {
    for (const f of froms) {
      downFiles.add(f)
      for (const o of model.fileOwners.get(key(f)) || []) downNodes.add(o)
    }
  }
  const bare = (id) => String(id).slice(String(id).indexOf(':') + 1)
  const names = [...downNodes].map(bare)
  return warn('impact',
    `影响面：scope 外的 ${downFiles.size} 个文件引用本 scope 落点，涉及 ${downNodes.size} 个节点（${names.slice(0, 6).join('、')}${names.length > 6 ? ` …+${names.length - 6}` : ''}）。`,
    `改这里会牵动它们 —— 确认是否一并纳入 scope，或明确下游不受影响：${outside.slice(0, 4).map(([t, fs]) => `${t} ← ${fs.slice(0, 3).join(', ')}${fs.length > 3 ? '…' : ''}`).join('；')}${outside.length > 4 ? ` …(+${outside.length - 4} 处)` : ''}`)
}

/** 闸门 4 · 计数闸：同一锚点是否又在反复打补丁？ */
export function countGate(model, anchor, { threshold = REPEAT_PATCH_THRESHOLD } = {}) {
  const p = pressureFor(model, anchor)
  if (p.sinceDecisionCount >= threshold) {
    return reject('count',
      `⛔ 计数闸触发：锚点 ${p.anchor} 自 ${p.sinceDecision || '项目开始'} 以来已有 ${p.sinceDecisionCount} 次补丁（阈值 ${threshold}）。`,
      `按第一性原理，先出架构决策（nav_decide anchor="${p.anchor}"），再判断这次是不是又一个局部补丁。`)
  }
  if (p.sinceDecisionCount === threshold - 1) {
    return warn('count', `锚点 ${p.anchor} 已有 ${p.sinceDecisionCount} 次补丁（阈值 ${threshold}）——距强制架构决策还差 1 次。`,
      '如果这是"同一死胡同反复打补丁"，现在就该出决策而不是再补一刀。')
  }
  return ok('count', `锚点 ${p.anchor} 补丁计数 ${p.sinceDecisionCount}/${threshold}`)
}

/** 闸门 5 · 决策闸：这次改动需要架构变更吗？（要一句话回答） */
export function decisionGate(intent) {
  const arch = intent.arch
  if (arch === undefined || arch === null || String(arch).trim() === '') {
    return warn('decision', '⚠ 架构反思缺失（arch= 未填）。',
      '用一句话回答「本任务是否需要调整架构」——需要则先 nav_decide，不需要则说明架构为何仍然成立。')
  }
  return ok('decision', `架构反思：${String(arch).slice(0, 120)}`)
}

/** 闸门 6 · 完结闸：有该收而未收的意图吗？（收口按证据，不按会话） */
export function completionGate(model, { pending = [] } = {}) {
  if (pending.length) {
    return warn('completion',
      `${pending.length} 笔在途意图的证据尚未变化：${pending.map((p) => `${p.id}(${p.task})`).join('、')}`,
      '在途 = 有人正在改，不是孤儿。改完文件后它会在下一次任意调用时按证据自动收口。')
  }
  const emptyScoped = model.openCommits.filter((c) => !(c.files || []).length && !(c.scope?.files || []).length && !(c.scope?.features || []).length && !(c.scope?.modules || []).length)
  if (emptyScoped.length) {
    return warn('completion',
      `${emptyScoped.length} 笔意图没有 scope 声明（${emptyScoped.map((c) => c.id).join('、')}）——没有声明就没有证据，永远不会自动收口。`,
      '用 nav_commit mode=archive 显式归档。')
  }
  return ok('completion', '无该收而未收的意图')
}

/**
 * 跑全部闸门。返回 { results, blocked, warnings }。
 * blocked 非空 ⇒ 写入必须被拒（调用方负责拒绝）。
 */
export function runGates(model, intent, opts = {}) {
  const results = [
    anchorGate(model, intent.anchor),
    scopeGate(model, intent),
    mainlineGate(model, intent),
    impactGate(model, intent),
    countGate(model, intent.anchor, opts),
    decisionGate(intent),
    completionGate(model, opts)
  ]
  const blocked = results.filter((r) => r.severity === SEVERITY.REJECT)
  const warnings = results.filter((r) => r.severity === SEVERITY.WARN)
  return { results, blocked, warnings }
}
