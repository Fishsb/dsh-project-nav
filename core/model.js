// core/model.js — 折叠：事件流 + 磁盘实况 → 架构模型（I1）
//
// 模型是**可丢弃缓存**，不是真相：整份 runtime/arch-model.json 随时可删、可复算（I3）。
// 复算 = foldEvents(磁盘上的事件流) 后再叠一层"磁盘实况"（落点是否存在、缺口、覆盖率）。
//
// 一切"当前状态"都只能从这里查询 —— 没有第二处读盘拼装。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { key, normSlashes, paths, nowIso } from './paths.js'
import { readEvents, rewriteVerified, logStamp } from './log.js'
import { walkFiles, globToRegExp, scanImports, scanImportsCached } from './scope.js'

export const LAYERS = ['project', 'module', 'feature', 'artifact']
/** 补丁计数闸阈值（同一锚点连续 3 次补丁 → 强制先出决策） */
export const REPEAT_PATCH_THRESHOLD = 3

export const nodeId = (layer, name) => `${layer}:${key(name)}`

/**
 * 纯折叠：只依赖事件序列，不读磁盘。同输入必同输出（I1）。
 * @param {object[]} events 已按 seq 升序
 */
export function foldEvents(events) {
  const nodes = new Map()
  let vector = { doing: '', next: '', notDoing: '', exitCondition: '', updatedAt: null }
  const decisions = []
  const commits = []
  const log = []

  const ensure = (layer, name, at) => {
    const id = nodeId(layer, name)
    let n = nodes.get(id)
    if (!n) {
      n = {
        id, layer, name: String(name), files: [], docs: [],
        project: null, module: null, features: [],
        meta: {}, status: 'active', createdAt: at, updatedAt: at
      }
      nodes.set(id, n)
    }
    return n
  }

  for (const ev of events) {
    if (ev.kind === 'node') {
      const layer = ev.layer
      if (!LAYERS.includes(layer)) { log.push({ seq: ev.seq, problem: `node event with unknown layer "${layer}"` }); continue }
      if (ev.op === 'upsert') {
        const n = ensure(layer, ev.id, ev.at)
        const f = ev.fields || {}
        if (f.name !== undefined) n.name = f.name
        if (Array.isArray(f.files)) n.files = [...new Set(f.files.map(normSlashes))].sort()
        if (layer === 'feature' && f.module !== undefined) n.module = f.module || null
        if (layer === 'module') {
          if (Array.isArray(f.features)) n.features = [...new Set(f.features.map(String))]
          if (f.project !== undefined) {
            const ref = resolveProjectRef(nodes, f.project)
            // 项目侧的成员表是**派生登记**（渲染一律从模块自身的 project 归属推导）。
            // 这里维护它，是为了让退役级联与诊断能看到真实成员，而不是注册时的快照。
            const pr = ref ? nodes.get(ref) : null
            if (pr) {
              const list = Array.isArray(pr.meta.moduleList) ? pr.meta.moduleList : []
              if (!list.some((x) => key(x) === key(n.name))) pr.meta.moduleList = [...list, n.name]
            }
            n.project = ref
          }
        }
        if (layer === 'artifact') {
          if (f.path !== undefined) n.path = f.path
          if (f.when !== undefined) n.when = f.when
          if (f.tags !== undefined) n.tags = Array.isArray(f.tags) ? f.tags : []
          if (f.project !== undefined) n.project = f.project || null
        }
        for (const [k, v] of Object.entries(f)) {
          if (['name', 'files', 'module', 'features', 'project', 'path', 'when', 'tags'].includes(k)) continue
          n.meta[k] = v
        }
        if (f.status !== undefined) n.status = f.status
        n.updatedAt = ev.at
      } else if (ev.op === 'retire') {
        const n = nodes.get(nodeId(layer, ev.id))
        if (!n) { log.push({ seq: ev.seq, problem: `retire of unknown ${layer} "${ev.id}"` }); continue }
        // 级联（F3/F8 的语义保留）：
        //   feature 退役 → 其模块成员关系消失，文件映射随之消失（由 nodes 派生，无需额外清理）
        //   module 退役  → 项目归属消失；其功能**存活**，只是失去模块
        //   project 退役 → 模块**存活**，只是失去项目
        if (layer === 'feature' && n.module) {
          const m = nodes.get(nodeId('module', n.module))
          if (m) m.features = m.features.filter((c) => key(c) !== key(n.name))
        }
        if (layer === 'module' && n.project) {
          const pr = nodes.get(n.project) || nodes.get(nodeId('project', n.project))
          if (pr && Array.isArray(pr.meta.moduleList)) {
            pr.meta.moduleList = pr.meta.moduleList.filter((m) => key(m) !== key(n.name))
          }
        }
        n.status = 'retired'
        n.retiredAt = ev.at
        n.updatedAt = ev.at
      } else {
        log.push({ seq: ev.seq, problem: `node event with unknown op "${ev.op}"` })
      }
      continue
    }

    if (ev.kind === 'set') {
      vector = { ...vector, ...(ev.vector || {}), updatedAt: ev.at }
      continue
    }

    if (ev.kind === 'decide') {
      decisions.push({
        id: `ADR-${ev.seq}`, seq: ev.seq, at: ev.at, anchor: ev.anchor,
        reason: ev.reason, decision: ev.decision, impact: ev.impact || '', action: ev.action || null
      })
      continue
    }

    if (ev.kind === 'commit') {
      const c = {
        id: `ACT-${ev.seq}`, seq: ev.seq, at: ev.at, phase: ev.phase || 'open',
        anchor: ev.anchor, task: ev.task, plan: ev.plan || '',
        scope: ev.scope || { features: [], modules: [], files: [] },
        arch: ev.arch ?? null, actor: ev.actor || null,
        evidence: ev.evidence || null, files: ev.files || [],
        outcome: ev.outcome || null, closedAt: ev.closedAt || null
      }
      commits.push(c)
      if (ev.phase === 'closed' && ev.closes) {
        const target = commits.find((x) => x.seq === ev.closes)
        if (target) {
          target.phase = 'closed'
          target.closes = ev.closes
          target.outcome = ev.outcome || null
          target.closedAt = ev.at
          target.closedBy = ev.actor || null
        } else log.push({ seq: ev.seq, problem: `closed event references unknown commit seq ${ev.closes}` })
      }
      continue
    }

    log.push({ seq: ev.seq, problem: `unknown event kind "${ev.kind}"` })
  }

  return { nodes, vector, decisions, commits, log }
}

/**
 * 锚点归一 —— **必须在折叠层做一次，且只做一次**：
 * 缓存路径与非缓存路径若各自算锚点键，会给出不同的计数闸结果，
 * 那就是"同一份真相两个答案"（I1 的致命形态）。
 * 折叠完成时节点已全部就位，所以这里能确定性归一。
 */
export function attachAnchorKeys(folded) {
  const view = { nodes: folded.nodes, fileOwners: fileOwnersOf(folded.nodes) }
  for (const c of folded.commits) {
    const n = normalizeAnchor(view, c.anchor)
    c.anchorKey = key(n ? n.id : c.anchor)
  }
  for (const d of folded.decisions) {
    const n = normalizeAnchor(view, d.anchor)
    d.anchorKey = key(n ? n.id : d.anchor)
  }
  return folded
}

function fileOwnersOf(nodes) {
  const fileOwners = new Map()
  for (const n of nodes.values()) {
    if (n.status !== 'active' || n.layer !== 'feature') continue
    for (const f of n.files || []) {
      const k = key(f)
      if (!fileOwners.has(k)) fileOwners.set(k, [])
      if (!fileOwners.get(k).includes(n.id)) fileOwners.get(k).push(n.id)
    }
  }
  return fileOwners
}

/**
 * 一条 commit 事件算不算「一次补丁」？
 *
 *   open                → 算：一次改动意图。
 *   closed 且带 closes   → **不算**：它只是那笔意图的收口回执（同一笔改动的第二个事件）。
 *                          两者都算 ⇒ 每笔改动被计两次 ⇒ 阈值 3 实际在 ~1.5 笔时就触发，
 *                          计数闸（第一性原理触发器）会退化成狼来了。
 *   closed 且不带 closes → 算：历史迁移来的"已完成的改动"记录，没有配对的 open 事件。
 */
function isPatchRecord(c) {
  if (c.phase === 'open') return true
  return c.phase === 'closed' && !c.closes
}

/** 锚点补丁计数（计数闸数据源）。缓存与非缓存路径共用同一实现。 */
function pressureFrom(folded) {
  const lastDecisionByAnchor = new Map()
  for (const d of folded.decisions) lastDecisionByAnchor.set(d.anchorKey || key(d.anchor), d)
  const patchCount = new Map()
  const openCommits = []
  for (const c of folded.commits) {
    if (c.phase === 'open') openCommits.push(c)
    if (!isPatchRecord(c)) continue
    const a = c.anchorKey || key(c.anchor)
    if (!a) continue                    // 无锚点的记录归属不到架构节点，不进计数
    patchCount.set(a, (patchCount.get(a) || 0) + 1)
  }
  const patchPressure = new Map()
  for (const [anchor, count] of patchCount) {
    const last = lastDecisionByAnchor.get(anchor)
    const since = last
      ? folded.commits.filter((c) => isPatchRecord(c) && c.seq > last.seq && (c.anchorKey || key(c.anchor)) === anchor).length
      : count
    patchPressure.set(anchor, { anchor, count, sinceDecision: last ? last.id : null, sinceDecisionCount: since })
  }
  return { patchPressure, openCommits }
}

/**
 * 依赖图（ARCHITECTURE §1 的「谁引用谁」）。
 *
 * **磁盘派生，不是事件** —— 与 STALE / 缺口同一位置计算，所以：
 *   · 不进事件流（守住 §3「不存在第四层」）
 *   · 不缓存（事件流的戳证明不了磁盘 import 新鲜；缓存它就会给出第二答案，违反 I1）
 *   · 删 runtime/ 可无损重建（I3）
 *
 * 文件级边用 fileOwners 提升为**节点级边**：一个功能/模块引用另一个，当且仅当
 * 它名下的某个文件 import 了对方名下的某个文件。跨节点才成边（同节点内部引用不是架构信息）。
 *
 * ⚠ 节点级边是**粗粒度投影**，不是判据：同模块内功能共享文件多，rollup 会退化成近似完全图。
 * 判据一律用 `impactOf()` 的文件精度。
 *
 * ⚠ 扫描边界：只扫**已登记项目目录**内的文件（仓里常躺着未登记工程 / 产物 / 归档，
 * 实测它们能占全部代码文件的 92%，扫了又慢又无用）。
 * **但一个项目目录都取不到时退回全量扫描** —— 宁可慢，也不能"取不到边界就静默扫出空图"：
 * 空图会让影响面闸永远放行，那是假绿。用了哪种模式记在 `scope.mode` 并在 mode=impact 里显示。
 *
 * @returns {{fileEdges, external, unresolved, skipped, scanned, deps, dependents, scope}}
 *   deps       nodeId → Set(nodeId)：我引用谁
 *   dependents nodeId → Set(nodeId)：谁引用我（= 改动的影响面）
 */
function buildEdges(rootPath, diskFiles, fileOwners, projectDirs = [], { useScanCache = false } = {}) {
  const dirs = projectDirs.filter(Boolean)
  const inScope = (f) => {
    if (!dirs.length) return true
    for (const d of dirs) {
      if (d === '.' || d === '') return true              // 项目就在根 ⇒ 全仓都在范围内
      if (f === d || f.startsWith(`${d}/`)) return true
    }
    return false
  }
  const within = diskFiles.filter(inScope)
  // P0-1：扫缓存。`scanImports` 是纯磁盘派生（实测 2730 个代码文件 ≈ 360ms），
  // 每次工具调用都重建模型 ⇒ 每次都白付。缓存指纹 = 传入清单 + size/mtime，
  // 任何一项变了即失效 ⇒ 它仍只是"磁盘实况"的加速器，不是第二个真相（I1）。
  const scan = useScanCache
    ? scanImportsCached(rootPath, within).result
    : scanImports(rootPath, within)
  const deps = new Map()
  const dependents = new Map()
  for (const [from, tos] of scan.edges) {
    const fromNodes = fileOwners.get(key(from)) || []
    if (!fromNodes.length) continue
    for (const to of tos) {
      const toNodes = fileOwners.get(key(to)) || []
      if (!toNodes.length) continue
      for (const a of fromNodes) {
        for (const b of toNodes) {
          if (a === b) continue
          if (!deps.has(a)) deps.set(a, new Set())
          deps.get(a).add(b)
          if (!dependents.has(b)) dependents.set(b, new Set())
          dependents.get(b).add(a)
        }
      }
    }
  }
  return {
    fileEdges: scan.edges, external: scan.external, unresolved: scan.unresolved,
    skipped: scan.skipped, scanned: scan.scanned, deps, dependents,
    scope: { mode: dirs.length ? 'projects' : 'all', dirs, candidates: within.length }
  }
}

/**
 * 一组文件的**共同目录前缀**（'' / null = 散在多处，不贡献边界）。
 * 单层文件（无 `/`）不参与共同前缀计算 —— 一个根级文件不该把边界拉平成全仓。
 */
function commonDirPrefix(files) {
  const partsList = files
    .map((f) => {
      const s = normSlashes(f)
      const i = s.lastIndexOf('/')
      return i < 0 ? null : s.slice(0, i)
    })
    .filter((d) => d && d !== '.')
    .map((d) => d.split('/'))
  if (!partsList.length) return null
  const first = partsList[0]
  let n = first.length
  for (const p of partsList) {
    n = Math.min(n, p.length)
    for (let i = 0; i < n; i++) {
      if (p[i] !== first[i]) { n = i; break }
    }
  }
  return n === 0 ? null : first.slice(0, n).join('/')
}

/**
 * 已登记项目的目录前缀 = 依赖图扫描边界。
 *
 * ① 优先用显式登记的 `project.meta.path` / `meta.projectPaths`；
 * ② 没有时**从登记落点推导** —— 一个项目下所有功能文件所在目录的共同前缀。
 *    这样不必为了性能去补一份新的登记数据（登记即维护，能派生就派生）。
 * 取不到任何目录 ⇒ 返回空数组 ⇒ buildEdges 退回全量扫描并把 mode 标成 all（fail-loud）。
 */
function projectDirsOf(nodes) {
  const dirs = new Set()
  const projects = [...nodes.values()].filter((n) => n.layer === 'project' && n.status === 'active')
  for (const n of projects) {
    for (const d of Object.values(n.meta?.projectPaths || {})) {
      const s = normSlashes(String(d)).replace(/\/+$/, '')
      if (s) dirs.add(s)
    }
    const p = n.meta?.path ? normSlashes(String(n.meta.path)).replace(/\/+$/, '') : ''
    if (p && p !== '.') dirs.add(p)
  }
  if (dirs.size) return [...dirs].sort()

  for (const p of projects) {
    const ids = new Set()
    for (const m of nodes.values()) {
      if (m.layer !== 'module' || m.status !== 'active' || !moduleBelongsTo(m, p)) continue
      for (const c of m.features || []) ids.add(nodeId('feature', c))
    }
    for (const f of nodes.values()) {
      if (f.layer !== 'feature' || f.status !== 'active') continue
      const mod = f.module ? nodes.get(nodeId('module', f.module)) : null
      if (mod && moduleBelongsTo(mod, p)) ids.add(f.id)
    }
    const files = [...ids].flatMap((id) => nodes.get(id)?.files || [])
    const pre = commonDirPrefix(files)
    if (pre) dirs.add(pre)
  }
  return [...dirs].sort()
}

/**
 * 完整模型 = 折叠 + 磁盘实况（I1：模型的每个属性都能由这两者复算）。
 *
 * `useScanCache` 默认 **false**：`buildModel` 是**纯重算**（内存里，不落盘），
 * 而扫描缓存是一份 **runtime 资产**。把写盘副作用塞进纯重算会破坏 I3 的可机检性
 * ——「删掉 runtime/ 后重建不留下资产」那条用例正是这么抓住它的（0.11.0 现场）。
 * 故：只有 `loadModel`（明确允许落 runtime 的路径）才开缓存。
 */
export function buildModel(rootPath, { now = Date.now(), useScanCache = false } = {}) {
  const { events, corrupt } = readEvents(rootPath)
  const base = attachAnchorKeys(foldEvents(events))

  // 反向索引：文件 → 归属节点
  const fileOwners = fileOwnersOf(base.nodes)

  // 项目成员表：**派生**（从模块自身的 project 归属算），不是存储。
  // 曾把它当存储维护（挂载时追加、摘除时不删），于是"摘除后项目下仍列着模块" ——
  // 派生数据被当成第二真相，必然与真相分叉。
  for (const n of base.nodes.values()) {
    if (n.layer !== 'project') continue
    n.meta.moduleList = [...base.nodes.values()]
      .filter((m) => m.layer === 'module' && m.status === 'active' && moduleBelongsTo(m, n))
      .map((m) => m.name)
  }

  // 磁盘实况：落点是否存在（STALE 探测）
  // glob 落点不做存在性判定：它本身不是文件路径，拿它去 existsSync 必然恒报 STALE（假警报腐蚀信号）。
  const stale = []
  for (const n of base.nodes.values()) {
    if (n.status !== 'active') continue
    for (const f of n.files || []) {
      if (/[*?]/.test(f)) continue
      if (!existsSync(`${rootPath}/${f}`)) stale.push({ node: n.id, file: f })
    }
  }

  // 缺口：磁盘上有、登记里没有
  // （projectDirs 同时充当依赖图扫描边界 —— 原来算了却没人用，是死代码）
  const projectDirs = projectDirsOf(base.nodes)
  const diskFiles = walkFiles(rootPath)
  const anchoredGlobs = new Set()
  for (const n of base.nodes.values()) {
    if (n.status !== 'active') continue
    for (const f of n.files || []) if (/[*?]/.test(f)) anchoredGlobs.add(normSlashes(f))
  }
  const unregistered = []
  for (const f of diskFiles) {
    if (fileOwners.has(key(f))) continue
    if (anchoredGlobs.size) {
      let covered = false
      for (const g of anchoredGlobs) { if (globToRegExp(g).test(f)) { covered = true; break } }
      if (covered) continue
    }
    unregistered.push(f)
  }

  // 磁盘实况：依赖图（谁引用谁）—— ARCHITECTURE §1 / §3。复用上面走出的 diskFiles，不重复走盘。
  const edges = buildEdges(rootPath, diskFiles, fileOwners, projectDirs, { useScanCache })

  // 最近决策 + 锚点补丁计数（计数闸的数据源）—— 与缓存路径共用同一实现
  const { patchPressure, openCommits } = pressureFrom(base)

  const model = {
    rootPath,
    builtAt: nowIso(now),
    nodes: base.nodes,
    vector: base.vector,
    decisions: base.decisions,
    commits: base.commits,
    openCommits,
    fileOwners,
    stale,
    unregistered,
    edges,
    patchPressure,
    log: [...base.log, ...corrupt.map((c) => ({ seq: null, problem: `corrupt event line ${c.line}: ${c.reason}` }))],
    eventCount: events.length,
    /** 挂载点：nav_graph 的扩展（如文档路由）直接写这里，刷新重算即得。 */
    extras: {}
  }
  return model
}

/** 项目归属归一：模块可以按项目 id 或项目名登记，折叠时统一折成项目**节点 id**。
 *  不归一就会出现"模块挂上去了、地图上看不到"这类静默失效（登记给 name、渲染按 id 比）。 */
function resolveProjectRef(nodes, ref) {
  const r = String(ref ?? '').trim()
  if (!r) return null
  const byId = nodes.get(nodeId('project', r))
  if (byId) return byId.id
  for (const n of nodes.values()) {
    if (n.layer === 'project' && key(n.name) === key(r)) return n.id
  }
  return r // 项目尚未登记：保留原名，等它出现后仍能被比对命中
}

/** 某模块是否属于某项目（两侧都归一，避免归属键不一致导致静默漏渲染）。 */
export function moduleBelongsTo(moduleNode, projectNode) {
  if (!moduleNode?.project || !projectNode) return false
  const p = String(moduleNode.project)
  return key(p) === key(projectNode.id) || key(p) === key(projectNode.name)
}

/** 锚点归一：锚点可以是节点 id / 功能码 / 模块名 / 文件路径 / 架构档。 */
export function normalizeAnchor(model, anchor) {
  const a = String(anchor ?? '').trim()
  if (!a) return null
  // 完整节点 id（"feature:pn-f09"）必须与裸名等价。
  // 它们本来不等价：先前的实现只走 nodeId(layer, a)，而 nodeId 会再 key() 一次，
  // 于是 "module:pn-m03" 被折成 "module:module:pn-m03" → 恒 NULL。
  // 症状是「工具描述说锚点可为节点 id，实际凡是照描述写的都被锚点闸拒」——
  // 描述与实现不符，比拒绝本身更坏：它会把人训练成猜别名的写法。
  const direct = model.nodes.get(key(a))
  if (direct) return { kind: 'node', id: direct.id, layer: direct.layer, name: direct.name, node: direct }
  for (const layer of ['feature', 'module', 'project', 'artifact']) {
    const n = model.nodes.get(nodeId(layer, a))
    if (n) return { kind: 'node', id: n.id, layer, name: n.name, node: n }
  }
  const owners = model.fileOwners.get(key(a))
  if (owners && owners.length) return { kind: 'file', id: normSlashes(a), file: normSlashes(a), owners: owners.map((o) => model.nodes.get(o)).filter(Boolean) }
  if (normSlashes(a).startsWith('.internal/arch/')) return { kind: 'archdoc', id: normSlashes(a), file: normSlashes(a) }
  return null
}

function resolveAnchorKey(model, anchor) {
  const n = normalizeAnchor(model, anchor)
  return n ? n.id : String(anchor ?? '')
}

/** 决策 id 由事件 seq 派生（ADR-N），补丁计数按锚点重置（计数闸语义）。 */
export function pressureFor(model, anchor) {
  const n = normalizeAnchor(model, anchor)
  const k = key(n ? n.id : anchor)
  return model.patchPressure.get(k) || { anchor: k, count: 0, sinceDecision: null, sinceDecisionCount: 0 }
}

/**
 * 影响面（**文件精度**）：scope 内文件被 scope 外哪些文件引用。
 *
 * 为什么判据用文件精度、不用节点粗粒度：同一模块内的功能常常互相成边（共享文件太多），
 * 节点级 rollup 会退化成近似完全图 —— 那是"看起来很有信息"的噪声，会让闸门变成狼来了。
 * 节点级 deps/dependents 仍保留，只作**粗粒度投影**（画图 / 一页总览），不作判据。
 */
export function impactOf(model, files) {
  const inside = new Set((files || []).map(key))
  const out = new Map()                     // 被引文件 → [scope 外的引用方]
  for (const [from, tos] of model.edges.fileEdges) {
    if (inside.has(key(from))) continue     // 引用方已在 scope 内 ⇒ 已覆盖
    for (const to of tos) {
      if (!inside.has(key(to))) continue    // 被引方不在 scope ⇒ 无关
      if (!out.has(to)) out.set(to, [])
      out.get(to).push(from)
    }
  }
  return out
}

/**
 * 文件职责压力 —— "一个文件里塞了多个功能"的可机检信号。
 *
 * 为什么不用行数判据：行数是**代理指标**。长文件未必坏（本仓 core/model.js 就长），
 * 短文件照样能混三个职责；而一旦把行数做成闸门，它必然退化成狼来了
 * —— 与 0.10.0 修掉的「计数闸把收口回执当补丁、阈值 3 实际 ~1.5 就触发」是同一类错。
 *
 * 真信号是**结构**，且全部由磁盘实况 + 事件流派生（零手写、删 runtime/ 可无损重建）：
 *   - owners：这个文件被几个**不同**架构节点登记为落点。1 个 = 职责单一；
 *             3 个以上 = 它成了多个功能的公共堆放点。
 *   - din   ：被多少个文件 import（基础模块被广泛引用是**正常**的，只作参考，不作判据）。
 *   - dout  ：它 import 了多少个文件（耦合面）。
 *
 * 函数只**报告**，不做拒绝：拆不拆是架构判断，交给模型与 ADR，不交给阈值。
 */
export function filePressure(model, { threshold = REPEAT_PATCH_THRESHOLD } = {}) {
  const din = new Map()
  for (const [, tos] of model.edges.fileEdges) {
    for (const t of new Set(tos || [])) din.set(t, (din.get(t) || 0) + 1)
  }
  const files = []
  for (const [f, ownerIds] of model.fileOwners) {
    const owners = [...new Set(ownerIds)].map((id) => model.nodes.get(id)).filter(Boolean)
    files.push({
      file: normSlashes(f),
      owners: owners.map((n) => ({ id: n.id, name: n.name })),
      ownerCount: owners.length,
      din: din.get(f) || 0,
      dout: new Set(model.edges.fileEdges.get(f) || []).size,
      over: owners.length >= threshold
    })
  }
  // 先按"被几个节点瓜分"，再按被引用广度，最后按路径 —— 确定性排序，便于 diff 与断言。
  files.sort((a, b) => (b.ownerCount - a.ownerCount) || (b.din - a.din) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return { files, threshold, over: files.filter((f) => f.over) }
}

/** 覆盖率：登记功能 / 全部磁盘文件。 */
export function coverage(model) {
  const features = [...model.nodes.values()].filter((n) => n.layer === 'feature' && n.status === 'active')
  const registeredFiles = features.reduce((a, n) => a + (n.files?.length || 0), 0)
  return {
    projects: [...model.nodes.values()].filter((n) => n.layer === 'project' && n.status === 'active').length,
    modules: [...model.nodes.values()].filter((n) => n.layer === 'module' && n.status === 'active').length,
    features: features.length,
    artifacts: [...model.nodes.values()].filter((n) => n.layer === 'artifact' && n.status === 'active').length,
    registeredFiles,
    unregisteredFiles: model.unregistered.length,
    retired: [...model.nodes.values()].filter((n) => n.status === 'retired').length
  }
}

// ---- 治理主权探针（0.11.0 · GTP P2；原 P1 观测层被实测取消，见落地文档 §2.4） ----
//
// 要回答的问题：**项目是不是在插件之外自建了一套治理？**
//
// 为什么不需要事件订阅（这是本探针的架构依据）：
//   自建治理件就在**磁盘上**；"最近改动是否晚于最近一次治理登记"由 **mtime + 事件流** 即可判定。
//   订阅产出只能落 `runtime/`（可丢，I3）—— 能被丢掉的那份不可能是真相（I1）。
//   故本探针**零订阅、零新状态**：纯函数，输入是模型 + 磁盘，输出是事实。

/** 治理类文件名特征：命中即"疑似自建门禁"。词表刻意保守 —— 误报会腐蚀信号（F3）。 */
const GOVERNANCE_NAME_RE = /(check|gate|audit|guard|lint|verify|ratchet|threshold|budget)/i

/** 已知的"并行账本"文件名：它们是插件之外的第二本账。 */
const PARALLEL_LEDGERS = ['CHANGELOG.md', 'OPEN-ITEMS.md', 'AGENTS.md', 'CONTRIBUTING.md']

/**
 * 只看**脚本**文件：`.mjs/.cjs/.js` 一律算；`.ts/.tsx` 只在 `scripts/` 目录下才算。
 *
 * 为什么对 .ts 加目录条件（0.11.0 夹具暴露的真问题）：`src/audit-source.ts` 是**产品源码**
 * （它实现的功能叫"蒸馏审计"），只因文件名含 audit 就被词表命中 ⇒ 报成"自建门禁"是误报。
 * 治理件的形态是**可执行脚本**，而 `.ts` 在 `src/` 下通常是模块源码；在 `scripts/` 下才是脚本。
 */
const CODE_RE = /\.(mjs|cjs|js)$/i
const TS_SCRIPT_RE = /(^|\/)scripts\/[^/]+\.(ts|tsx|mts|cts)$/i

/**
 * 声明文件不算治理件：`.d.ts` 是**类型声明产物**，与 0.10.1 修掉的「`.d.ts` 被当代码扫」同一类错
 * （那条 bug 的判据可复用：类型声明没有可执行的门禁语义）。
 */
const DECL_RE = /\.d\.(ts|mts|cts)$/i

/**
 * 生成物不算自建治理：`lib/*.js` 常是 `src/*.ts` 的编译产物，而 `lib/audit-source.js` 是**产品代码**
 * （shoucang 实测：它是"蒸馏审计的双源读"，只因名字带 audit 被词表命中）。
 *
 * 判据用**结构**（同名 TS 源码存在 ⇒ 是产物），而不是继续调词表 —— 调词表是无底洞，
 * 且每次放宽都会重新引入漏报。这条与 `TEST_LIKE_RE` 同源：**宁可漏报，不可误报**（F3）。
 */
const BUILT_RE = /(^|\/)(lib|dist|out|build|release)\//i

/**
 * 测试文件不算"自建门禁"：`deploy-guard.test.cjs` 是在**测**某个守卫，不是守卫本身。
 * 不排除它们会把测试名里的 guard/verify 全算成外来治理件 —— 那是"假警报腐蚀信号"（F3），
 * 与 0.10.1 修掉的计数闸退化同源。判据必须**窄**：宁可漏报，不可误报。
 */
const TEST_LIKE_RE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/i

/** 顶层目录黑名单：与 walkFiles 同源（噪声目录不进统计，否则计数没有意义）。 */
const GOV_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.internal', 'dist', 'build', '.next', 'coverage',
  '.dsh-vision-toolkit', '.npm-cache', '.roundtable',
  // 基准/夹具目录：它们是**测试用的模拟仓**，不是被治理项目的自建治理。
  // 不排除会把 40 个 smoke 夹具的 AGENTS.md 全算成"并行账本"——计数立刻失去意义（0.11.0 实测）。
  '.gov-bench', 'fixtures', '__fixtures__', 'tmp', 'temp'
])

/**
 * 治理入口识别：一批 check-*.mjs 通常**由一个 runner 统一驱动**（实测 shoucang：91 个脚本挂在
 * `scripts/check-runner.mjs` 一个入口下）。
 *
 * 为什么按入口聚合而不是逐个脚本：**治理的单元是入口，不是实现细节**。
 * 逐个登记 91 个脚本＝91 条事件，而登记 1 个 runner 就覆盖了它驱动的全部脚本 ——
 * 后者才是"接管"的正确粒度（ARCHITECTURE §2②：计数守恒，但聚合与取回路径必须给出）。
 */
const RUNNER_NAME_RE = /(^|\/)(check-runner|run-checks|verify|ci|gate-runner)\.(mjs|cjs|js|ts)$/i

/** 本插件自己的包名（用于把"插件自身文件"从"外来治理件"里排除）。读不到就返回空串（判据失效而非误报）。 */
function ownPackageName() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return String(JSON.parse(readFileSync(`${here}/../package.json`, 'utf-8')).name || '')
  } catch { return '' }
}

/**
 * 治理主权探针。
 *
 * @returns {{
 *   foreignScripts: string[],   项目自建的治理类脚本（root 相对路径）
 *   runners: string[],          治理**入口**（真正该被接管的单元；驱动多个 check-*.mjs）
 *   parallelLedgers: string[],  并行账本文件（插件之外的第二本账）
 *   exempted: string[],         已登记豁免的项（opt-out 声明）
 *   sovereign: boolean          是否"插件独占治理"（无未豁免的外来件）
 * }}
 */
export function governanceSovereignty(model, { maxDepth = 4 } = {}) {
  const rootPath = model.rootPath
  // 排除插件自身：本插件就住在被治理根下时，`project-nav/core/gates.js`、`verify-runtime.mjs`
  // 会被自己的名字匹配规则命中 —— 把自己的文件报成"外来治理件"是纯粹的假警报（0.11.0 实测踩到）。
  //
  // 判据**不硬编码路径**（源码仓 / profile 安装副本 / 改名都要成立），而是问：
  // "离这个文件最近的 package.json，是不是本插件自己？" —— 按包名识别，路径无关、版本无关。
  const selfName = ownPackageName()
  const pkgCache = new Map()
  const nearestPackageName = (rel) => {
    let dir = normSlashes(rel).split('/').slice(0, -1).join('/')
    const seen = []
    for (;;) {
      if (pkgCache.has(dir)) { const hit = pkgCache.get(dir); for (const s of seen) pkgCache.set(s, hit); return hit }
      seen.push(dir)
      try {
        const pj = JSON.parse(readFileSync(`${rootPath}/${dir ? `${dir}/` : ''}package.json`, 'utf-8'))
        const name = String(pj.name || '')
        for (const s of seen) pkgCache.set(s, name)
        return name
      } catch {
        if (!dir) { for (const s of seen) pkgCache.set(s, ''); return '' }
        dir = dir.split('/').slice(0, -1).join('/')
      }
    }
  }
  const isSelf = (f) => selfName !== '' && nearestPackageName(f) === selfName

  const found = []
  const walk = (dir, rel, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (GOV_SKIP_DIRS.has(e.name)) continue
        walk(`${dir}/${e.name}`, rel ? `${rel}/${e.name}` : e.name, depth + 1)
      } else if (e.isFile()) {
        found.push(rel ? `${rel}/${e.name}` : e.name)
      }
    }
  }
  walk(rootPath, '', 0)

  // 产物判定：处在构建目录（lib/dist/out/build/release）下，且**同一根内存在同名 TS 源码**
  // ⇒ 它是编译产物，不是独立的治理件。
  //
  // 为什么按 basename 而非同路径匹配：`lib/x.js` 的源码是 `src/x.ts`（**不同目录**），
  // 要求同路径会永远判不出（0.11.0 实测：`lib/audit-source.js` 因此漏过排除，被当成自建门禁）。
  // 判据仍保守：只在构建目录内生效 + 必须有同名 TS 源码 —— 两个条件都满足才排除（宁可漏报，F3）。
  const tsBasenames = new Set(
    found.filter((f) => /\.(ts|mts|tsx)$/i.test(f))
      .map((f) => normSlashes(f).split('/').pop().replace(/\.(ts|mts|tsx)$/i, '').toLowerCase())
  )
  const isBuildOutput = (f) => {
    if (!BUILT_RE.test(f)) return false
    const bare = normSlashes(f).split('/').pop().replace(/\.(js|cjs|mjs)$/i, '').toLowerCase()
    return tsBasenames.has(bare)
  }

  const candidates = found
    .filter((f) => (CODE_RE.test(f) || TS_SCRIPT_RE.test(f))
      && !DECL_RE.test(f)
      && !TEST_LIKE_RE.test(f)
      && !isSelf(f)
      && !isBuildOutput(f)
      && GOVERNANCE_NAME_RE.test(f.split('/').pop()))
    .map(normSlashes)
    .sort()
  // 入口与实现分开报：入口是**接管单元**，实现是它驱动的细节。
  const runners = candidates.filter((f) => RUNNER_NAME_RE.test(f))
  const foreignScripts = candidates.filter((f) => !RUNNER_NAME_RE.test(f))

  // 并行账本：只算**实际存在**的那些（根级或子项目级），并区分层级。
  //
  // ⚠ 0.11.0 施工实测的假警报：先前实现用 `found.some(f => f.endsWith('/'+name))` 判定，
  //   于是根下并不存在的 `CHANGELOG.md` 只因**某个子项目**有它就被报成根级账本 ——
  //   报出的是"根有 4 本账"，实际根只有 1 本（AGENTS.md）。账本层级错位会让"接管面"整个失准。
  // 判据改为：**该路径确实存在于 found 里**，并保留完整相对路径（层级即真相）。
  const parallelLedgers = found
    .filter((f) => PARALLEL_LEDGERS.includes(normSlashes(f).split('/').pop()) && !isSelf(f))
    .map(normSlashes)
    .sort()

  // 已登记治理件：**登记即接管**（三档语义，对标 Allstar 的动作分级 log/issue/fix）。
  //
  //   ① exempt   —— 确认保留，退出告警（理由在 when 里，可审计）；
  //   ② refs     —— 领域适应度函数（管的是别的领域，不是元治理重复），登记后**退出"未知外来件"**，
  //                 但仍可经 nav_graph mode=docs 被路由检索到；
  //   ③ competing—— 确认与插件职能重叠的"第二本账"，登记后**仍保留告警**（它确实该被收敛），
  //                 但告警文案从"未知外来件"升级为"已接管·待收敛"，并给出移交路径。
  //
  // 为什么必须分档：只做"登记即静音"会让 competing 项伪装成已解决（假绿）；
  // 只做"一律告警"则登记毫无收益，没人有动机登记。判据是**登记改变了什么**，而不是"登记了就没事"。
  //
  // ⚠ 字段位置是**顶层** `path` / `when`，不是 `meta.*` —— 折叠时 artifact 的这两个字段落在节点根部
  //   （0.11.0 施工实测：读 `meta.when` 会恒空 ⇒ 豁免永不生效，且看起来"功能已实现"）。
  //   这类"读错字段名"的静默失效比报错更坏，故此处**同时**兜 meta 以便未来归一。
  // ⚠ **只认 when 的起始前缀**，不做全文匹配（0.11.0 施工实测的判定冲突）：
  //   先前用全文正则，于是某条 when 里为了**说明移交路径**而提到 "exempt" 二字，
  //   该件就被同时算成 competing 与 exempt —— 两档语义打架，且结果取决于措辞。
  //   改判前缀后，语义只由**第一个词**决定，与正文措辞无关（判据稳定，可断言）。
  //   这是"描述现状的契约"的另一面：**声明字段必须是机器可判的，不能靠人读整句**。
  const DECL_KIND_RE = /^\s*(exempt|refs|competing)\b/i
  const declared = { exempt: [], refs: [], competing: [] }
  const declare = { exempt: new Set(), refs: new Set(), competing: new Set() }
  const addDecl = (kind, p) => {
    const k = key(p)
    if (!k || declare[kind].has(k)) return
    declare[kind].add(k)
    declared[kind].push(k)
  }
  for (const n of model.nodes.values()) {
    if (n.layer !== 'artifact' || n.status !== 'active') continue
    const when = String(n.when ?? n.meta?.when ?? '')
    const m = when.match(DECL_KIND_RE)
    if (!m) continue
    const p = normSlashes(String(n.path ?? n.meta?.path ?? n.name ?? ''))
    if (!p) continue
    addDecl(m[1].toLowerCase(), p)
  }
  const hit = (set, f) => set.has(key(f)) || set.has(key(String(f).split('/').pop()))
  const isExempt = (f) => hit(declare.exempt, f) || hit(declare.refs, f)
  const isCompeting = (f) => hit(declare.competing, f)
  const unexemptedScripts = foreignScripts.filter((f) => !isExempt(f))
  const unexemptedRunners = runners.filter((f) => !isExempt(f))
  const unexemptedLedgers = parallelLedgers.filter((f) => !isExempt(f))
  // 待收敛 = 已登记 competing、但仍占着外来件名额的那些（告警保留，但语义已升级）。
  const pendingConvergence = [...new Set([...foreignScripts, ...runners, ...parallelLedgers])].filter((f) => isCompeting(f))

  return {
    // 入口在前：**接管单元是入口**（一个 runner 驱动 N 个 check），实现细节在后。
    runners: unexemptedRunners,
    foreignScripts: unexemptedScripts,
    parallelLedgers: unexemptedLedgers,
    exempted: [...declared.exempt],
    /** 已登记为领域适应度函数（不再算未知外来件） */
    referenced: [...declared.refs],
    /** 已接管但仍需收敛的竞争项（告警保留，带移交路径） */
    pendingConvergence,
    sovereign: unexemptedRunners.length === 0 && unexemptedScripts.length === 0 && unexemptedLedgers.length === 0
  }
}

/**
 * 治理活力：**最近一次改动是否晚于最近一次治理登记** —— "治理被绕过"的只读信号。
 *
 * 判据全部来自已有真相：`mtime`（磁盘实况）+ 最近 commit 时间（事件流）。零新状态。
 * ⚠ 只读信号，**不做闸门、不拒绝写入**（ARCHITECTURE §10 同一判例：代理指标做成闸门必然退化）。
 */
export function governanceVitality(model) {
  const rootPath = model.rootPath
  const lastCommitAt = model.commits.length ? model.commits[model.commits.length - 1].at : null
  let newest = null
  for (const f of model.fileOwners.keys()) {
    try {
      const s = statSync(`${rootPath}/${f}`)
      if (!newest || s.mtimeMs > newest.mtimeMs) newest = { file: normSlashes(f), mtimeMs: s.mtimeMs }
    } catch { /* 落点已消失 ⇒ 由 STALE 报告，这里不重复报 */ }
  }
  if (!newest) return { lastCommitAt, newestFile: null, newestAt: null, bypassedMs: null, bypassed: false }
  const commitMs = lastCommitAt ? Date.parse(lastCommitAt) : 0
  const bypassedMs = commitMs ? newest.mtimeMs - commitMs : null
  return {
    lastCommitAt,
    newestFile: newest.file,
    newestAt: new Date(newest.mtimeMs).toISOString(),
    bypassedMs,
    // 容差 60s：同一次操作里"先改文件后登记"是正常顺序，不算绕过（否则必然狼来了）。
    bypassed: bypassedMs !== null && bypassedMs > 60_000
  }
}

// ---- 运行时缓存（I3：可删可重建） ----

/**
 * 取模型：优先读 runtime 缓存，缓存缺失/失效则重算并落盘。
 * **删掉 runtime/ 后这里必须能无损重建** —— 这是 I3 的现场。
 *
 * 缓存只有在"带日志戳且戳与当前事件流一致"时才被采信：
 * 一份无法自证与源一致性的缓存**不是缓存，是第二个真相**（I1）。
 */
export function loadModel(rootPath, { useCache = false, now = Date.now() } = {}) {
  const stamp = logStamp(rootPath)
  if (useCache) {
    try {
      const cached = JSON.parse(readFileSync(paths.model(rootPath), 'utf-8'))
      const sameSource = cached?.stamp
        && cached.stamp.digest === stamp.digest
        && cached.stamp.size === stamp.size
        && cached.stamp.lines === stamp.lines
      if (sameSource && stamp.lines > 0) return buildModelFromPlain(cached, rootPath)
    } catch { /* 缓存不可用 → 重算（这就是 cache 的语义：随时可丢） */ }
  }
  // 只有这条路径允许落 runtime ⇒ 只有它开扫描缓存（buildModel 保持纯重算，见其注释）
  const model = buildModel(rootPath, { now, useScanCache: true })
  model.stamp = stamp
  try { persistModel(rootPath, model) } catch { /* 缓存写失败不影响正确性 */ }
  return model
}

function persistModel(rootPath, model) {
  const plain = {
    builtAt: model.builtAt, eventCount: model.eventCount, stamp: model.stamp,
    nodes: [...model.nodes.values()],
    vector: model.vector, decisions: model.decisions, commits: model.commits,
    stale: model.stale, unregistered: model.unregistered, log: model.log
  }
  rewriteVerified(paths.model(rootPath), JSON.stringify(plain, null, 2))
}

function buildModelFromPlain(plain, rootPath) {
  const nodes = new Map()
  for (const n of plain.nodes || []) nodes.set(n.id, n)
  // 与 buildModel 同规则重算派生成员表（缓存里的可能已过期）
  for (const n of nodes.values()) {
    if (n.layer !== 'project') continue
    n.meta.moduleList = [...nodes.values()]
      .filter((m) => m.layer === 'module' && m.status === 'active' && moduleBelongsTo(m, n))
      .map((m) => m.name)
  }
  const fileOwners = fileOwnersOf(nodes)
  // 缓存里的 commit/decision 已带 anchorKey（烘焙在事件流折叠层），
  // 所以这条路径与 buildModel 得到**完全相同**的计数闸结果（I1）。
  const folded = { nodes, commits: plain.commits || [], decisions: plain.decisions || [], log: plain.log || [], vector: plain.vector || {} }
  const { patchPressure, openCommits } = pressureFrom(folded)
  return {
    rootPath,
    builtAt: plain.builtAt,
    nodes, vector: plain.vector || {}, decisions: folded.decisions, commits: folded.commits,
    openCommits, fileOwners,
    stale: plain.stale || [], unregistered: plain.unregistered || [],
    // 依赖图**不缓存、每次重算**：它是磁盘派生，事件流的戳证明不了磁盘 import 还新鲜。
    // 两条路径走同一实现 ⇒ 结果必然一致（I1：同一份真相不允许两个答案）。
    // （P0-1）重算走 `scanImportsCached`：它的指纹是**磁盘**（清单+size+mtime），不是事件流戳，
    // 所以"不缓存依赖图"与"缓存扫描结果"不矛盾 —— 前者说的是不拿事件流戳当新鲜度证明。
    edges: buildEdges(rootPath, walkFiles(rootPath), fileOwners, projectDirsOf(nodes), { useScanCache: true }),
    patchPressure, log: folded.log, eventCount: plain.eventCount || 0, extras: {},
    stamp: plain.stamp
  }
}
