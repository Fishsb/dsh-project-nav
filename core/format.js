// core/format.js — 渲染与解析的薄工具（不含业务判断）
//
// 一切"说给模型看"的文本都在这里成形，避免 host 里散落字符串模板。

import { key, normSlashes } from './paths.js'
import { coverage, moduleBelongsTo, REPEAT_PATCH_THRESHOLD } from './model.js'
import { renderTreeText } from './render.js'

export function splitList(s) {
  return s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []
}

/** 解析 `k=v,k2=v2` 形式的附加字段。 */
export function parseKv(pairs) {
  const out = {}
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const s = String(p)
    const i = s.indexOf('=')
    if (i < 0) continue
    const k = s.slice(0, i).trim()
    const v = s.slice(i + 1).trim()
    if (k) out[k] = v
  }
  return out
}

export function truncate(s, n = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

export function renderHealth(model, { rootPath, opens, locks = [], inflight = [], logCheck = null } = {}) {
  const cv = coverage(model)
  const L = []
  L.push('Health')
  L.push(`  Root: ${rootPath}`)
  L.push(`  事件流: ${model.eventCount} 事件${logCheck ? (logCheck.ok ? '（seq 连续 ✓）' : `（⛔ ${logCheck.problems.length} 处异常）`) : ''}`)
  L.push(`  模型: 项目 ${cv.projects} · 模块 ${cv.modules} · 功能 ${cv.features} · 文档工件 ${cv.artifacts} · 已退役 ${cv.retired}`)
  L.push(`  落点: 登记文件 ${cv.registeredFiles} · 未登记 ${cv.unregisteredFiles} · STALE ${model.stale.length}`)
  L.push(`  主线: doing=${model.vector?.doing || '(unset)'} | next=${model.vector?.next || '(unset)'}`)
  if (model.vector?.notDoing) L.push(`  反目标: ${model.vector.notDoing}`)
  if (model.vector?.exitCondition) L.push(`  完成判据: ${model.vector.exitCondition}`)
  L.push('')
  L.push(`  在途改动 (${opens.length}): ${opens.length ? '' : '(无)'}`)
  for (const c of opens) {
    const age = Math.round((Date.now() - Date.parse(c.at)) / 60000)
    L.push(`    · ${c.id} ${truncate(c.task, 70)} | anchor=${c.anchor} | ${(c.files || []).length} 文件 | ${age} 分钟前 | ${c.actor ? `actor=${String(c.actor).slice(0, 8)}` : 'actor=?'}`)
  }
  if (inflight.length) L.push(`    在途状态文件: ${inflight.length}（runtime 缓存，可丢）`)
  L.push('')
  L.push(`  架构决策: ${model.decisions.length} 条${model.decisions.length ? `（最近 ${model.decisions[model.decisions.length - 1].id} @ ${model.decisions[model.decisions.length - 1].anchor}）` : ''}`)
  const pressure = [...model.patchPressure.values()].filter((p) => {
    if (p.sinceDecisionCount < 2) return false
    const n = model.nodes.get(p.anchor)
    return !(n && n.status === 'retired')     // 退役锚点的历史计数没有意义：它已不可能再被锚定
  })
  if (pressure.length) {
    L.push('  ⚠ 计数闸压力:')
    for (const p of pressure) L.push(`    · ${p.anchor} ${p.sinceDecisionCount}/${REPEAT_PATCH_THRESHOLD}（自 ${p.sinceDecision || '项目开始'}）`)
  }
  if (model.stale.length) {
    L.push('')
    L.push(`  STALE 落点 (${model.stale.length}) — 登记了但磁盘上没有:`)
    for (const s of model.stale.slice(0, 15)) L.push(`    · ${s.file} <- ${s.node}`)
    if (model.stale.length > 15) L.push(`    …(+${model.stale.length - 15})`)
  }
  if (model.log.length) {
    L.push('')
    L.push(`  ⛔ 模型自身问题 (${model.log.length}) —— 不吞:`)
    for (const p of model.log.slice(0, 10)) L.push(`    · seq=${p.seq ?? '?'} ${truncate(p.problem, 110)}`)
  }
  if (locks.length) {
    L.push('')
    L.push(`  runtime 锁 (${locks.length}):`)
    for (const l of locks) L.push(`    · ${l.name} age=${Math.round(l.ageMs / 1000)}s pid=${l.pid ?? '?'}`)
  }
  return L.join('\n')
}

export function renderScopeTarget(model, loc) {
  const L = []
  if (loc.kind === 'unknown') {
    L.push(`No mapping found for "${loc.target}".`)
    L.push('  · 若是新功能：nav_node target=<功能码> name=… userView=… files=…（登记落点）')
    L.push('  · 若是新模块：nav_node target=<模块名> features=<功能码,功能码> project=<项目>')
    L.push('  · 若是文件但未登记：nav_node target=<功能码> set=files=<逗号分隔路径>')
    return L.join('\n')
  }
  if (loc.kind === 'file') {
    L.push(`File: ${loc.file}`)
    if (!loc.owners.length) L.push('  ⚠ 该文件未被任何功能登记 -> 会算进"未登记"缺口')
    for (const o of loc.owners) {
      L.push(`  <- 功能 ${o.name}${o.meta?.name ? ` (${o.meta.name})` : ''}`)
      const mod = o.module ? model.nodes.get(`module:${key(o.module)}`) : null
      if (mod) {
        const proj = mod.project ? model.nodes.get(mod.project) || model.nodes.get(`project:${key(mod.project)}`) : null
        L.push(`     -> 模块 ${mod.name}${proj ? ` -> 项目 ${proj.name}` : ''}`)
      } else L.push('     -> (未挂模块)')
    }
    return L.join('\n')
  }
  const n = loc.node
  if (loc.kind === 'project') {
    L.push(`Project: ${n.name}${n.meta?.path ? ` — ${n.meta.path}` : ''}`)
    const mods = [...model.nodes.values()].filter((m) => m.layer === 'module' && m.status === 'active' && moduleBelongsTo(m, n))
    for (const m of mods) {
      const feats = (m.features || []).map((c) => model.nodes.get(`feature:${key(c)}`)).filter(Boolean)
      L.push(`  ▸ ${m.name} (${feats.length} 功能)`)
      for (const f of feats) L.push(`     ○ ${f.name}${f.meta?.name ? ` — ${f.meta.name}` : ''}  [${(f.files || []).length} 文件]`)
    }
    if (!mods.length) L.push('  (无模块)')
    return L.join('\n')
  }
  if (loc.kind === 'module') {
    L.push(`Module: ${n.name}${n.meta?.name ? ` — ${n.meta.name}` : ''}${n.project ? ` · project=${n.project}` : ' · (未归属项目)'}`)
    const feats = (n.features || []).map((c) => model.nodes.get(`feature:${key(c)}`)).filter(Boolean)
    for (const f of feats) {
      L.push(`  ○ ${f.name}${f.meta?.name ? ` — ${f.meta.name}` : ''}`)
      if (f.meta?.userView) L.push(`      用户视角: ${truncate(f.meta.userView, 110)}`)
      if (f.meta?.systemView) L.push(`      系统视角: ${truncate(f.meta.systemView, 110)}`)
      for (const file of (f.files || []).slice(0, 15)) L.push(`      · ${file}`)
    }
    return L.join('\n')
  }
  if (loc.kind === 'artifact') {
    L.push(`Artifact: ${n.name}`)
    L.push(`  path: ${n.path}`)
    L.push(`  when (路由规则): ${n.when || '(未填)'}`)
    if (n.tags?.length) L.push(`  tags: ${n.tags.join(', ')}`)
    return L.join('\n')
  }
  // feature
  L.push(`Feature: ${n.name}${n.meta?.name ? ` — ${n.meta.name}` : ''}${n.status === 'retired' ? ' (已退役)' : ''}`)
  if (n.meta?.userView) L.push(`  用户视角: ${n.meta.userView}`)
  if (n.meta?.systemView) L.push(`  系统视角: ${n.meta.systemView}`)
  if (n.module) L.push(`  模块: ${n.module}`)
  else L.push('  模块: (未挂)')
  for (const file of n.files || []) {
    const stale = model.stale.some((s) => s.node === n.id && s.file === file)
    L.push(`  落点: ${file}${stale ? '  ⛔STALE(磁盘无此文件)' : ''}`)
  }
  if (!(n.files || []).length) L.push('  落点: (空 — 用 nav_node set=files=… 登记)')
  const inflight = model.openCommits.filter((c) => (c.files || []).some((f) => (n.files || []).includes(f)))
  for (const c of inflight) L.push(`  🔴 在途: ${c.id} ${truncate(c.task, 70)}`)
  const pressure = model.patchPressure.get(key(n.id))
  if (pressure) L.push(`  补丁计数: ${pressure.sinceDecisionCount}/${REPEAT_PATCH_THRESHOLD}（自 ${pressure.sinceDecision || '项目开始'}）`)
  return L.join('\n')
}

/**
 * 影响面（依赖图 · 文件精度）。这是"全局思想"的读侧入口：
 * 动手前看一眼——我改的东西，谁在引用；我又引用了谁。
 */
export function renderImpact(model, loc) {
  const files = loc.kind === 'file' ? [loc.file] : (loc.node?.files || [])
  const title = loc.kind === 'file'
    ? `File: ${loc.file}`
    : `${loc.kind}: ${loc.node?.name}${loc.node?.meta?.name ? ` — ${loc.node.meta.name}` : ''}`
  if (!files.length) return `${title}\n  落点: (空) —— 依赖图无话可说（先 nav_node files= 登记落点）`

  const inside = new Set(files.map(key))
  const mine = new Set(files.map(normSlashes))

  const outbound = new Map()          // 我的文件 → 它引用的 scope 外文件
  for (const f of mine) {
    const tos = (model.edges.fileEdges.get(f) || []).filter((t) => !inside.has(key(t)))
    if (tos.length) outbound.set(f, tos)
  }
  const inbound = new Map()           // scope 外文件 → 它引用的我的文件
  for (const [from, tos] of model.edges.fileEdges) {
    if (inside.has(key(from))) continue
    const hits = tos.filter((t) => inside.has(key(t)))
    if (hits.length) inbound.set(normSlashes(from), hits)
  }

  const L = [`${title}  —  ${files.length} 个落点文件`, '']
  L.push(`↓ 我引用谁（${outbound.size} 个落点有外部依赖）:`)
  if (!outbound.size) L.push('  (无 —— 不依赖任何 scope 外文件)')
  for (const [f, ts] of [...outbound].slice(0, 12)) L.push(`  ${f} → ${ts.join(', ')}`)

  const nodes = new Set()
  for (const f of inbound.keys()) for (const o of model.fileOwners.get(key(f)) || []) nodes.add(o)
  L.push('')
  L.push(`↑ 谁引用我 = 影响面（${inbound.size} 个文件 · ${nodes.size} 个节点）:`)
  if (!inbound.size) L.push('  (无 —— 没有 scope 外文件依赖它，这次改动是局部封闭的)')
  for (const [f, ts] of [...inbound].slice(0, 12)) L.push(`  ${f} ← 被 ${ts.join(', ')} 引用`)
  if (nodes.size) L.push(`  波及节点: ${[...nodes].slice(0, 12).join('、')}${nodes.size > 12 ? ` …+${nodes.size - 12}` : ''}`)

  const e = model.edges
  const sc = e.scope || { mode: 'all', dirs: [], candidates: 0 }
  const where = sc.mode === 'projects'
    ? `已登记项目目录（${sc.dirs.length} 个）`
    : '全仓 fallback（取不到项目目录 ⇒ 降级为全量，绝不静默扫空）'
  L.push('')
  L.push(`依赖图: 范围=${where} · 候选 ${sc.candidates} 文件 → 扫 ${e.scanned} 个代码文件 · ${e.fileEdges.size} 条文件边 · 外部包 ${e.external.size} 个文件有 bare import`)
  if (e.unresolved.length) L.push(`  ⚠ ${e.unresolved.length} 条相对引用解析不到（未静默丢弃，用 mode=json 可取全量）`)
  if (e.skipped.length) L.push(`  跳过 ${e.skipped.length} 个超体量文件（打包产物，噪声大于信号）`)
  return L.join('\n')
}

export function renderGaps(model, { limit = 30 } = {}) {
  const L = []
  L.push(`Gaps — 未登记文件 ${model.unregistered.length} · STALE 落点 ${model.stale.length}`)
  if (model.unregistered.length) {
    L.push('')
    L.push('  未登记文件（磁盘上有、架构模型里没有落点 => 地图对它们失明）:')
    for (const f of model.unregistered.slice(0, limit)) L.push(`    · ${f}`)
    if (model.unregistered.length > limit) L.push(`    …(+${model.unregistered.length - limit})`)
    L.push('  -> nav_node target=<功能码> set=files=<路径> 把它挂到某个功能下')
  }
  if (model.stale.length) {
    L.push('')
    L.push('  STALE（登记了但磁盘上没有 => 每次都会被报成漂移，假警报会腐蚀信号）:')
    for (const s of model.stale.slice(0, limit)) L.push(`    · ${s.file} <- ${s.node}`)
    L.push('  -> 真删了：nav_node target=<节点> retire=true；只是搬走：nav_node set=files=…')
  }
  if (!model.unregistered.length && !model.stale.length) L.push('  ✓ 无缺口：登记与磁盘一致。')
  return L.join('\n')
}

export function renderDocs(model, { task = '', project = '', tag = '' } = {}) {
  const arts = [...model.nodes.values()].filter((n) => n.layer === 'artifact' && n.status === 'active')
  let list = arts
  if (project) list = list.filter((a) => key(a.project) === key(project) || key(a.meta?.project) === key(project))
  if (tag) list = list.filter((a) => (a.tags || []).map(key).includes(key(tag)))
  if (!list.length) {
    return 'No reference docs registered.\n  用 nav_node target=<文档id> layer=artifact path=… when=… title=… 登记（when = 路由规则：哪类任务必须查它）。'
  }
  if (task) {
    const tk = key(task)
    const scored = list.map((a) => {
      let score = 0
      const when = key(a.when || '')
      if (when && tk) {
        for (const w of when.split(/[,，;；\s]+/).filter(Boolean)) if (w.length > 1 && tk.includes(w)) score += 3
      }
      if (key(a.name || '').split(/\s+/).some((w) => w.length > 1 && tk.includes(w))) score += 2
      for (const t of a.tags || []) if (tk.includes(key(t))) score += 2
      return { a, score }
    }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score)
    if (!scored.length) return `No doc matched task "${task}".\n  已登记 ${list.length} 份；可用 nav_graph mode=docs 全列。`
    const L = [`Docs for task "${truncate(task, 80)}" (${scored.length} 命中):`]
    for (const { a, score } of scored) L.push(`  · [${score}] ${a.name}\n      path: ${a.path}\n      when: ${a.when}`)
    return L.join('\n')
  }
  const L = [`Reference docs (${list.length}):`]
  for (const a of list) L.push(`  · ${a.name}${a.meta?.project ? ` [${a.meta.project}]` : ''}\n      path: ${a.path}\n      when: ${a.when || '(未填)'}`)
  return L.join('\n')
}

export function renderAdrs(model, { anchor = '', limit = 20 } = {}) {
  let list = model.decisions
  if (anchor) list = list.filter((d) => key(d.anchor) === key(anchor) || key(d.anchor).includes(key(anchor)))
  if (!list.length) return `No architecture decision recorded${anchor ? ` for anchor "${anchor}"` : ''}.\n  用 nav_decide anchor=… reason=… decision=… 登记（挂到节点上，决策天然有项目归属）。`
  const L = [`Architecture decisions (${list.length}${anchor ? `, anchor=${anchor}` : ''}):`]
  for (const d of list.slice(-limit).reverse()) {
    L.push(`  · ${d.id} [${d.anchor}] ${d.at.slice(0, 10)}`)
    L.push(`      为什么必须改: ${truncate(d.reason, 150)}`)
    L.push(`      架构变成什么: ${truncate(d.decision, 150)}`)
    if (d.impact) L.push(`      影响面: ${truncate(d.impact, 130)}`)
  }
  return L.join('\n')
}

export function renderMap(model, { target = '' } = {}) {
  return renderTreeText(model, { target })
}

/** 一笔 nav_commit 的结果文本（登记 / 被拒 / 自动收口）。 */
export function renderCommitResult(res, model) {
  const L = []
  if (res.reconcile?.closed?.length) {
    L.push(`自动收口 ${res.reconcile.closed.length} 笔（证据已变，与会话无关）:`)
    for (const { commit: c, diff } of res.reconcile.closed) {
      const bits = []
      if (diff.modified.length) bits.push(`改 ${diff.modified.length}`)
      if (diff.appeared.length) bits.push(`新增 ${diff.appeared.length}`)
      if (diff.vanished.length) bits.push(`消失 ${diff.vanished.length}`)
      L.push(`  ✓ ${c.id} ${truncate(c.task, 60)} — ${bits.join(' / ') || 'evidence changed'}`)
    }
    L.push('')
  }
  if (res.status === 'blocked') {
    L.push('⛔ 闸门拒绝 — 本次改动未登记（先解决再动手）:')
    for (const b of res.gates.blocked) L.push(`  ${b.gate}: ${b.detail}`)
    for (const b of res.gates.blocked) if (b.hint) L.push(`     -> ${b.hint}`)
    const warns = res.gates.warnings
    if (warns.length) { L.push('  （同时的告警）'); for (const w of warns) L.push(`  ⚠ ${w.gate}: ${w.detail}`) }
    return L.join('\n')
  }
  if (res.status === 'rejected') {
    L.push(res.reason)
    if (res.hint) L.push(`  -> ${res.hint}`)
    if (res.materialized?.unresolved?.length) L.push(`  未解析: ${res.materialized.unresolved.join('; ')}`)
    return L.join('\n')
  }
  const c = res.commit
  L.push(`✓ 已登记 ${c.id} @ ${c.at}`)
  L.push(`  锚点: ${res.gates.results.find((r) => r.gate === 'anchor')?.detail || ''}`)
  L.push(`  落点: ${res.materialized.files.length} 文件（索引 ${res.materialized.sources.fromIndex.length} / 字面量 ${res.materialized.sources.fromLiteral.length} / glob ${res.materialized.sources.fromGlob.length}）`)
  if (res.materialized.missing.length) L.push(`  ⚠ 解析未命中: ${res.materialized.missing.slice(0, 8).join('; ')}`)
  if (res.materialized.unresolved.length) L.push(`  ⚠ 未登记标识: ${res.materialized.unresolved.slice(0, 8).join('; ')}`)
  L.push('')
  L.push('闸门:')
  for (const r of res.gates.results) {
    const mark = r.pass ? '✓' : r.severity === 'reject' ? '⛔' : '⚠'
    L.push(`  ${mark} ${r.gate}: ${r.detail}`)
    if (!r.pass && r.hint) L.push(`     -> ${r.hint}`)
  }
  L.push('')
  L.push('收口无需动作：改完文件后，下一次任意工具调用会按证据自动收口（A1）。')
  return L.join('\n')
}
