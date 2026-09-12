// core/model.js — 折叠：事件流 + 磁盘实况 → 架构模型（I1）
//
// 模型是**可丢弃缓存**，不是真相：整份 runtime/arch-model.json 随时可删、可复算（I3）。
// 复算 = foldEvents(磁盘上的事件流) 后再叠一层"磁盘实况"（落点是否存在、缺口、覆盖率）。
//
// 一切"当前状态"都只能从这里查询 —— 没有第二处读盘拼装。

import { existsSync, readFileSync } from 'node:fs'
import { key, normSlashes, paths, nowIso } from './paths.js'
import { readEvents, rewriteVerified, logStamp } from './log.js'
import { walkFiles, globToRegExp, scanImports } from './scope.js'

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
function buildEdges(rootPath, diskFiles, fileOwners, projectDirs = []) {
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
  const scan = scanImports(rootPath, within)
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
 */
export function buildModel(rootPath, { now = Date.now() } = {}) {
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
  const edges = buildEdges(rootPath, diskFiles, fileOwners, projectDirs)

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
  const model = buildModel(rootPath, { now })
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
    edges: buildEdges(rootPath, walkFiles(rootPath), fileOwners, projectDirsOf(nodes)),
    patchPressure, log: folded.log, eventCount: plain.eventCount || 0, extras: {},
    stamp: plain.stamp
  }
}
