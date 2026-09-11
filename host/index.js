// @dsh-external/project-nav — 从架构出发的项目治理
//
// 核心理念（唯一上位约束）：
//   所有开发动作必须从架构出发。架构不出错，局部问题只是小问题；
//   架构错了，局部补得再好也是在错误骨架上堆砌。
//
// 架构（见 ARCHITECTURE.md）：
//   ① 事件流 .internal/events.jsonl  —— 唯一事实源（append-only）
//   ② 模型   .internal/runtime/…     —— 事件流的折叠（可丢弃，I3）
//   ③ 投影   PROJECT.md / ARCH-MODEL.md / 地图 / 架构档指针 —— 全部渲染（I2）
//   闸门 = 对模型的查询（六闸，全部在 nav_commit 内）
//
// 工具面 6：nav_graph / nav_commit / nav_decide / nav_node / nav_render / nav_set

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { writeFileSync, mkdirSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import {
  PLANE, paths, nowIso, normSlashes, key
} from '../core/paths.js'
import { loadModel, normalizeAnchor, pressureFor, coverage, REPEAT_PATCH_THRESHOLD } from '../core/model.js'
import { appendEvents, verifyLog, readEvents } from '../core/log.js'
import { reconcile, commitIntent, archiveIntent, inflightView, materialize } from '../core/commit.js'
import { locate, resolveScope, evidenceOf } from '../core/scope.js'
import { listArchDocs, archDocsFor, stampArchDoc, renderAll, renderMapHtml, renderTreeText, archDocState } from '../core/render.js'
import { listLocks } from '../core/lock.js'
import { inspectLegacy, migrateLegacy } from '../core/legacy.js'
import {
  splitList, parseKv, truncate, renderHealth, renderScopeTarget, renderGaps,
  renderDocs, renderAdrs, renderArchDocs, renderMap, renderCommitResult
} from '../core/format.js'
import { governedWorkspaceOf } from '../core/boundary.js' // 本地绑定（:155 直接调用；末尾 :523 的 re-export 不建立本地绑定）
export const name = '@dsh-external/project-nav'
// `shell` 是真实硬依赖：工作区边界的可执行性探针走 shell 缝，且必须等它注册后再探。
export const inject = ['tools', 'shell']

export const Config = z.object({
  root: z.string().default(''),
  boundaryWorkspaces: z.string().default(''),
  autoBindWorkspace: z.boolean().default(true)
})

const OUTPUT = {
  schema: { type: 'string' },
  render: (_a, v) => [{ type: 'text', text: String(v) }]
}

function err(e) { return `ERROR: ${e.message}` }
function sidOf(exec) { return exec?.agent?.id ? String(exec.agent.id) : null }
function j(v) { return JSON.stringify(v, null, 2) }

export function apply(ctx, config) {
  const root = config?.root ? resolve(config.root) : process.cwd()
  if (ctx.logger?.warn && !config?.root) {
    ctx.logger.warn(`[project-nav] root config unset — governing process.cwd() (${root}). Set config.root to the workspace you want governed.`)
  } else if (ctx.logger?.info) {
    ctx.logger.info(`[project-nav] governing root: ${root} (config.root)`)
  }

  // ---- 自动收口（A1）：每一次工具调用都按证据对账，与会话无关 ----
  let lastReconcile = { closed: [], stillOpen: [], at: 0 }
  async function refresh(now = Date.now()) {
    // 先按证据收口（会写事件），再用收口后的真相建模型。
    lastReconcile = { ...(await reconcile(root, { now })), at: now }
    return loadModel(root, { now })
  }

  // ================= 工作区边界（ADR-014/016 的事故事实保留） =================
  const boundaryOn = config?.autoBindWorkspace !== false
  let boundaryUsable = null
  let boundaryReason = 'not probed yet'
  let boundaryInFlight = false
  let boundaryAttempts = 0
  let boundaryLastAttemptAt = 0
  const BOUNDARY_RETRY_MS = 10000
  const boundarySessions = []

  function boundaryDiagPath() { return resolve(root, '.internal', 'boundary-diag.json') }
  function writeBoundaryDiag() {
    try {
      const payload = {
        updatedAt: nowIso(), root, enabled: boundaryOn, allow: String(config?.boundaryWorkspaces || ''),
        probe: { verdict: boundaryUsable, reason: boundaryReason, attempts: boundaryAttempts, lastAttemptAt: boundaryLastAttemptAt ? nowIso(boundaryLastAttemptAt) : null },
        sessions: boundarySessions.slice(-25)
      }
      const file = boundaryDiagPath()
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
      renameSync(tmp, file)
    } catch { /* 诊断 best-effort：绝不因为日志失败而影响会话 */ }
  }
  function recordSession(cwd, zone, decision, detail) {
    boundarySessions.push({ at: nowIso(), cwd: String(cwd || ''), zone: String(zone || ''), decision: String(decision), detail: String(detail || '') })
    writeBoundaryDiag()
  }
  function probeBoundary(trigger) {
    const why = trigger || 'boot'
    if (boundaryInFlight || boundaryUsable === true) return
    const now = Date.now()
    if (boundaryAttempts >= 2 && now - boundaryLastAttemptAt < BOUNDARY_RETRY_MS) return
    boundaryInFlight = true
    boundaryAttempts += 1
    boundaryLastAttemptAt = now
    const shell = ctx.get?.('shell')
    if (!shell || typeof shell.resolve !== 'function' || typeof shell.run !== 'function') {
      boundaryInFlight = false
      boundaryUsable = false
      boundaryReason = `shell seam unavailable (resolve=${typeof shell?.resolve}, run=${typeof shell?.run}, trigger=${why})`
      ctx.logger?.warn?.(`[project-nav] workspace boundary: ${boundaryReason}; sessions will NOT be bound`)
      writeBoundaryDiag()
      return
    }
    try {
      const spec = shell.resolve({ command: 'exit 0', workdir: root, timeoutMs: 20000, sandboxPolicy: { mode: 'read-only', workspaceRoot: root } })
      Promise.resolve(shell.run(spec)).then((res) => {
        boundaryInFlight = false
        const sb = res && res.sandbox
        const runnerFailed = !!(sb && sb.runnerFailed)
        boundaryUsable = !runnerFailed && !!res && res.exitCode === 0
        boundaryReason = `probe ${boundaryUsable ? 'PASS' : 'FAIL'} (attempt ${boundaryAttempts}, trigger=${why}, exitCode=${res ? res.exitCode : 'n/a'}, runnerFailed=${runnerFailed})`
        if (boundaryUsable) ctx.logger?.info?.(`[project-nav] workspace boundary: ${boundaryReason}`)
        else ctx.logger?.warn?.(`[project-nav] workspace boundary: ${boundaryReason}; sessions will NOT be bound`)
        writeBoundaryDiag()
      }, (e) => {
        boundaryInFlight = false
        boundaryUsable = false
        boundaryReason = `probe rejected (attempt ${boundaryAttempts}, trigger=${why}): ${(e && e.message) || e}`
        ctx.logger?.warn?.(`[project-nav] workspace boundary: ${boundaryReason}; sessions will NOT be bound`)
        writeBoundaryDiag()
      })
    } catch (e) {
      boundaryInFlight = false
      boundaryUsable = false
      boundaryReason = `probe threw (attempt ${boundaryAttempts}, trigger=${why}): ${e.message}`
      ctx.logger?.warn?.(`[project-nav] workspace boundary: ${boundaryReason}; sessions will NOT be bound`)
      writeBoundaryDiag()
    }
  }
  if (boundaryOn && String(config?.boundaryWorkspaces || '').trim() && typeof ctx.on === 'function') probeBoundary('boot')
  if (boundaryOn && typeof ctx.on !== 'function') {
    ctx.logger?.warn?.('[project-nav] workspace boundary: this context exposes no ctx.on — sessions will NOT be bound to their workspace. Set autoBindWorkspace=false to silence.')
  }
  if (boundaryOn && typeof ctx.on === 'function') {
    ctx.on('agent/session-start', (payload) => {
      try {
        const session = payload?.agent?.session
        const cwd = session?.header?.cwd
        if (!session || !cwd || typeof session.append !== 'function') {
          recordSession(cwd, '', 'skipped-no-session-or-append', `session=${!!session} cwd=${cwd || ''}`)
          return
        }
        const zone = governedWorkspaceOf(loadModel(root), root, cwd, config?.boundaryWorkspaces)
        if (!zone) { recordSession(cwd, '', 'not-governed', ''); return }
        if (boundaryUsable !== true) {
          probeBoundary('session-start')
          recordSession(cwd, zone, 'deferred-probe', boundaryReason)
          return
        }
        const policy = ctx.get?.('sandboxPolicy')
        if (!policy || typeof policy.overrideOf !== 'function') {
          recordSession(cwd, zone, 'skipped-no-sandboxPolicy', `policy=${typeof policy}`)
          return
        }
        // 会话在 hook 之前就已被盖上模式 → 问的不是"有没有 override"，而是"模式是什么"。
        const current = policy.overrideOf(session)
        if (current === 'workspace-write' || current === 'read-only') {
          recordSession(cwd, zone, `already-${current}`, '')
          return
        }
        session.append('sandbox/mode', { mode: 'workspace-write' })
        recordSession(cwd, zone, 'bound', `previous=${current === undefined ? 'undefined' : current}`)
        ctx.logger?.info?.(`[project-nav] workspace boundary: session ${String(payload?.agent?.id || '').slice(0, 8)} bound to workspace-write (${zone})`)
      } catch (e) {
        recordSession('', '', 'error', (e && e.message) || String(e))
        ctx.logger?.warn?.(`[project-nav] workspace boundary: left session untouched (${e.message})`)
      }
    })
  }
  // ================= 边界结束 =================

  // ---- 1. nav_graph — 读：模型查询 ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_graph',
    description: 'Query the architecture model (the single source of truth folded from the event log). Modes: task (expand a target into features/modules/projects + gates), gaps (unregistered files + STALE落点), coverage, docs (reference docs / rank by task), adrs, arch (arch doc freshness), map (text tree), health (snapshot: coverage + in-flight + pressure + arch freshness + log integrity), legacy (old ledger to migrate), json. Read-only.',
    parameters: {
      mode: { type: 'string', description: 'task (default) | gaps | coverage | docs | adrs | arch | map | health | legacy | json' },
      target: { type: 'string', description: 'task/map: file path, feature code, module or project name; docs: task description to rank; adrs: anchor' },
      format: { type: 'string', description: 'text (default) | json' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const model = await refresh()
        const mode = String(args.mode || (args.target ? 'task' : 'health')).toLowerCase()
        const asJson = String(args.format || '').toLowerCase() === 'json'

        if (asJson && mode !== 'json') return j(snapshotOf(model, root, lastReconcile, mode, args.target))

        if (mode === 'task') {
          const loc = locate(root, model, args.target)
          const out = [renderScopeTarget(model, loc)]
          if (loc.kind !== 'empty' && loc.kind !== 'unknown') {
            const files = loc.kind === 'file' ? [loc.file] : (loc.node?.files || [])
            const owners = files.flatMap((f) => model.fileOwners.get(key(f)) || [])
            const docs = archDocsFor(root, model, loc.kind === 'file' ? loc.file : (loc.node?.name || args.target))
            out.push('')
            out.push('架构档指针:')
            if (!docs.length) out.push('  (无覆盖此目标的架构档 — 若这是架构级改动，先出/更新 .internal/arch/*.md)')
            for (const d of docs) out.push(`  ${d.fresh ? '✓' : '⛔'} ${d.path} — ${d.reason}`)
            const open = model.openCommits.filter((c) => (c.files || []).some((f) => files.includes(f)))
            if (open.length) { out.push(''); for (const c of open) out.push(`🔴 在途: ${c.id} ${c.task}（${c.actor ? `by ${String(c.actor).slice(0, 8)}` : 'actor=?'}）`) }
            const pressure = model.patchPressure.get(key(loc.kind === 'file' ? loc.file : loc.node?.id))
            if (pressure && pressure.sinceDecisionCount >= 2) out.push(`⚠ 计数闸: ${pressure.anchor} ${pressure.sinceDecisionCount}/${REPEAT_PATCH_THRESHOLD}`)
            out.push('')
            out.push('下一步: 改前先 nav_commit（锚点 + scope + arch= 一句话），它跑六闸。')
          }
          return out.join('\n')
        }
        if (mode === 'gaps') return renderGaps(model)
        if (mode === 'coverage') {
          const cv = coverage(model)
          return [`Coverage:`, `  项目 ${cv.projects} · 模块 ${cv.modules} · 功能 ${cv.features} · 文档工件 ${cv.artifacts} · 已退役 ${cv.retired}`, `  登记文件 ${cv.registeredFiles} · 未登记 ${cv.unregisteredFiles} · STALE ${model.stale.length}`].join('\n')
        }
        if (mode === 'docs') return renderDocs(model, { task: args.target || '' })
        if (mode === 'adrs') return renderAdrs(model, { anchor: args.target || '' })
        if (mode === 'arch') {
          const all = listArchDocs(root)
          const docs = args.target ? archDocsFor(root, model, args.target) : all
          return renderArchDocs(docs, { target: args.target, model })
        }
        if (mode === 'map') return renderMap(model, { target: args.target || '' })
        if (mode === 'legacy') {
          const info = inspectLegacy(root)
          return [`Legacy ledgers (.internal/):`, ...Object.entries(info.files).map(([f, v]) => `  ${v === null ? '· (absent)' : v.corrupt ? `⛔ ${f} (corrupt)` : `· ${f}: ${JSON.stringify(v)}`}`), info.alreadyMigrated ? `\n已迁移: ${info.marker?.at}（${info.marker?.events} 事件）` : '\n未迁移 → 用 nav_graph mode=legacy json 看全貌，迁移动作用 nav_node layer=migrate'].join('\n')
        }
        if (mode === 'json') return j(snapshotOf(model, root, lastReconcile, 'health'))
        return renderHealth(model, { rootPath: root, opens: model.openCommits, inflight: inflightView(root), locks: listLocks(root), archDocs: listArchDocs(root), logCheck: verifyLog(root), boundary: { enabled: boundaryOn, probe: { verdict: boundaryUsable, reason: boundaryReason } } })
      } catch (e) { return err(e) }
    }
  })), 'project-nav: nav_graph')

  // ---- 2. nav_commit — 写：登记改动意图（自动对账 + 六闸） ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_commit',
    description: 'Record a change intent BEFORE touching anything: anchor (architecture node) + scope + a one-line architecture reflection (arch=). Runs six gates (anchor/count/scope/mainline/decision/completion). Closure needs no second call: when the scope evidence changes, the next tool call on any session closes it automatically (evidence-based, session-independent). mode=archive voids a stale intent explicitly.',
    parameters: {
      task: { type: 'string', required: true, description: 'One-line task description' },
      anchor: { type: 'string', required: true, description: 'Architecture node this task belongs to: feature code / module / project / file path / .internal/arch/*.md' },
      arch: { type: 'string', description: 'One-line architecture reflection: does this task need an architecture change, or is the architecture sound and the change local?' },
      features: { type: 'string', description: 'Comma-separated feature codes in scope' },
      modules: { type: 'string', description: 'Comma-separated module names in scope' },
      files: { type: 'string', description: 'Comma-separated file paths / globs in scope' },
      plan: { type: 'string', description: 'Optional plan summary' },
      mode: { type: 'string', description: 'open (default) | archive (void an existing intent; needs id + reason)' },
      id: { type: 'string', description: 'archive mode: ACT-N to void' },
      reason: { type: 'string', description: 'archive mode: why it is void' }
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        const actor = sidOf(exec)
        if (String(args.mode || '').toLowerCase() === 'archive') {
          if (!args.id) return 'ERROR: archive 模式需要 id=ACT-N。'
          const r = await archiveIntent(root, args.id, args.reason, { actor })
          if (r.status !== 'ok') return r.reason
          return `✓ 已归档 ${r.archived.id}（${truncate(r.archived.task, 70)}）—— 这是唯一绕过证据的出口：空 scope / 误建 / 方向已废。`
        }
        if (!args.task) return 'ERROR: nav_commit requires task=.'
        const res = await commitIntent(root, {
          task: args.task, anchor: args.anchor, arch: args.arch,
          plan: args.plan,
          scope: { features: splitList(args.features), modules: splitList(args.modules), files: splitList(args.files) }
        }, { actor })
        const model = loadModel(root)
        const files = res.materialized?.files || []
        const docs = archDocsFor(root, model, args.anchor)
        res.archNote = docs.length
          ? docs.map((d) => `${d.fresh ? '✓' : '⛔'} ${d.path}`).join(' / ')
          : '无覆盖此锚点的架构档'
        const text = renderCommitResult(res, model)
        if (res.status === 'ok' && files.length) {
          return `${text}\n\n改动完成后无需再调用本工具收口。若这属于架构级改动，记得 nav_decide。`
        }
        return text
      } catch (e) { return err(e) }
    }
  })), 'project-nav: nav_commit')

  // ---- 3. nav_decide — 写：架构决策（挂节点，重置计数闸） ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_decide',
    description: 'Record an architecture decision (ADR) for one anchor. Required whenever a task changes the ARCHITECTURE, and mandatory once the same anchor accumulated three patches — recording it resets that anchor patch counter (the first-principles trigger). Decisions are events, so they travel with the repository.',
    parameters: {
      anchor: { type: 'string', required: true, description: 'The architecture node: feature code, module name, project, file path, or .internal/arch/*.md' },
      reason: { type: 'string', required: true, description: 'Why the architecture must change now (the root need, not the symptom)' },
      decision: { type: 'string', required: true, description: 'What the architecture becomes after this decision' },
      impact: { type: 'string', description: 'Affected features/modules/files or cross-project impact' },
      action: { type: 'string', description: 'Related commit id, e.g. ACT-004 (optional)' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const model = await refresh()
        const n = normalizeAnchor(model, args.anchor)
        if (!n) {
          return `ERROR: anchor "${args.anchor}" 不是真实架构节点 —— 决策必须挂到节点上（决策天然归属项目，D5）。\n  先 nav_node 登记节点，或锚定 .internal/arch/*.md；用 nav_graph <目标> 确认。`
        }
        const p = pressureFor(model, n.id)
        const [w] = await appendEvents(root, [{
          kind: 'decide', anchor: n.id, reason: args.reason, decision: args.decision,
          impact: args.impact || '', action: args.action || null
        }])
        const L = [`✓ ${`ADR-${w.seq}`} 已登记 @ ${w.at}`, `  锚点: ${n.id}`, `  为什么必须改: ${args.reason}`, `  架构变成什么: ${args.decision}`]
        if (args.impact) L.push(`  影响面: ${args.impact}`)
        L.push('')
        L.push(`  该锚点补丁计数已重置（此前 ${p.sinceDecisionCount}/${REPEAT_PATCH_THRESHOLD}${p.sinceDecision ? `，上次决策 ${p.sinceDecision}` : ''}）。`)
        L.push('  决策是事件 ⇒ 随仓库传播（新 clone 可读全部 ADR，A3）。')
        return L.join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: nav_decide')

  // ---- 4. nav_node — 写：节点 upsert / 退役 / 文档工件 / 迁移 ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_node',
    description: 'Create-or-update an architecture node (upsert), register a reference-doc artifact, retire a node with cascade, or run the one-time legacy migration. Existing target = field update; absent target + creation fields = create. Arbitrary fields via set=k=v pairs. layer=migrate folds the legacy .internal ledgers into the event log once.',
    parameters: {
      target: { type: 'string', description: 'Feature code / module name / project name / artifact id' },
      layer: { type: 'string', description: 'project | module | feature | artifact | migrate' },
      name: { type: 'string', description: 'Human-readable name' },
      files: { type: 'string', description: 'Feature/artifact: comma-separated file paths (REPLACES the file list)' },
      features: { type: 'string', description: 'Module: comma-separated feature codes (REPLACES the list; empty = module shell)' },
      project: { type: 'string', description: 'Module/project attachment (empty string detaches)' },
      userView: { type: 'string', description: 'Feature: user-perspective description' },
      systemView: { type: 'string', description: 'Feature: system-perspective description' },
      path: { type: 'string', description: 'Artifact: file path / directory / URL' },
      when: { type: 'string', description: 'Artifact: routing rule — which kinds of tasks must consult it' },
      tags: { type: 'string', description: 'Artifact: comma-separated tags' },
      set: { type: 'string', description: 'Any extra fields as comma-separated k=v pairs (e.g. set=maturity=live,owner=lk)' },
      retire: { type: 'boolean', description: 'RETIRE (inverse of upsert) with cascade: feature drops its file mappings + module membership; module drops its project attachment (its features survive); project detaches its modules (they survive unattached). Refused while an in-flight commit references the target.' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        if (String(args.layer || '').toLowerCase() === 'migrate') {
          const info = inspectLegacy(root)
          if (!info.files || Object.values(info.files).every((v) => v === null)) return 'Legacy ledgers absent — nothing to migrate.'
          const r = await migrateLegacy(root)
          if (r.status === 'already-migrated') return `Already migrated at ${r.marker?.at} (${r.marker?.events} events, seq ${JSON.stringify(r.marker?.seqRange)}).`
          if (r.status === 'nothing-to-migrate') return 'Legacy ledgers present but contained no entries — nothing migrated.'
          return [
            `✓ 迁移完成：${r.events} 事件（seq ${r.seqRange[0]}…${r.seqRange[1]}）`,
            `  归档: ${r.archived.map((a) => a.to).join(', ') || '(none)'}`,
            ...(r.warnings.length ? ['', '⚠ 警告:', ...r.warnings.map((w) => `  - ${w}`)] : []),
            '',
            '旧账本已成为只读快照（.internal/legacy/）。之后所有治理数据只写 .internal/events.jsonl。',
            '下一步: nav_render 重建全部投影。'
          ].join('\n')
        }
        if (args.retire) {
          const model = await refresh()
          const layer = args.layer ? String(args.layer).toLowerCase() : null
          const layers = layer ? [layer] : ['feature', 'module', 'project', 'artifact']
          let hit = null
          for (const l of layers) {
            const n = model.nodes.get(`${l}:${key(args.target)}`)
            if (n && n.status === 'active') { hit = n; break }
          }
          if (!hit) return `ERROR: nothing to retire for "${args.target}" — 未找到现行节点。\n  用 nav_graph ${args.target} 确认标识；retire 从不凭空造条目。`
          const ref = model.openCommits.find((c) => (c.scope?.features || []).includes(args.target)
            || (c.scope?.modules || []).includes(args.target)
            || (c.files || []).map(key).includes(key(args.target)))
          if (ref) return `ERROR: "${args.target}" 仍被在途改动 ${ref.id}（${ref.task}）引用。\n  改完文件后它会按证据自动收口；或 nav_commit mode=archive id=${ref.id} 归档后再 retired。`
          const [w] = await appendEvents(root, [{ kind: 'node', op: 'retire', layer: hit.layer, id: hit.name }])
          const after = loadModel(root)
          const casc = hit.layer === 'feature' ? `文件映射 ${(hit.files || []).length} 条随之消失${hit.module ? `，从模块 ${hit.module} 摘除` : ''}`
            : hit.layer === 'module' ? `项目归属 ${hit.project || '(none)'} 摘除；其 ${(hit.features || []).length} 个功能存活（失去模块）`
              : `其模块被摘除而非删除（变为 unattached，会在地图上暴露出来）`
          return [`✓ 已退役 ${hit.layer} ${hit.name}（事件 seq ${w.seq}）`, `  级联: ${casc}`, `  现在 active 节点 ${[...after.nodes.values()].filter((n) => n.status === 'active').length} 个。`, '  退役语义保留是 F3/F8 的要求：能删才不会永远留假 STALE。'].join('\n')
        }

        // upsert
        const extra = parseKv(String(args.set || '').split(',').filter(Boolean))
        const hasArtifactFields = args.path !== undefined || args.when !== undefined || args.tags !== undefined
        const hasFeatureFields = args.files !== undefined || args.userView !== undefined || args.systemView !== undefined
        const hasModuleFields = args.features !== undefined || args.project !== undefined
        let layer = args.layer ? String(args.layer).toLowerCase() : null
        if (!layer) {
          const model = loadModel(root)
          if (model.nodes.get(`module:${key(args.target)}`)) layer = 'module'
          else if (model.nodes.get(`feature:${key(args.target)}`)) layer = 'feature'
          else if (model.nodes.get(`artifact:${key(args.target)}`)) layer = 'artifact'
          else if (model.nodes.get(`project:${key(args.target)}`)) layer = 'project'
          else if (hasModuleFields) layer = 'module'
          else if (hasArtifactFields && !hasFeatureFields) layer = 'artifact'
          else layer = 'feature'
        }
        if (!args.target) return 'ERROR: nav_node requires target=.'
        const fields = { ...extra }
        if (args.name !== undefined) fields.name = args.name
        if (layer === 'feature') {
          if (args.files !== undefined) fields.files = splitList(args.files).map(normSlashes)
          if (args.userView !== undefined) fields.userView = args.userView
          if (args.systemView !== undefined) fields.systemView = args.systemView
          if (args.project !== undefined) fields.project = args.project
        }
        if (layer === 'module') {
          if (args.features !== undefined) fields.features = splitList(args.features)
          if (args.project !== undefined) fields.project = args.project
        }
        if (layer === 'artifact') {
          if (args.path !== undefined) fields.path = args.path
          if (args.when !== undefined) fields.when = args.when
          if (args.tags !== undefined) fields.tags = splitList(args.tags)
          if (args.project !== undefined) fields.project = args.project
        }
        if (layer === 'project' && args.path !== undefined) fields.path = args.path
        if (!Object.keys(fields).length) return 'ERROR: 没有任何字段可写（给 name/files/features/project/path/when/tags 或 set=k=v）。'

        const before = loadModel(root)
        const prev = before.nodes.get(`${layer}:${key(args.target)}`)
        const [w] = await appendEvents(root, [{ kind: 'node', op: 'upsert', layer, id: args.target, fields }])
        const after = loadModel(root)
        const now = after.nodes.get(`${layer}:${key(args.target)}`)
        const L = [`✓ ${prev ? 'updated' : 'created'} ${layer} "${args.target}"（事件 seq ${w.seq}）`]
        L.push(`  字段: ${Object.keys(fields).map((k) => `${k}=${truncate(Array.isArray(fields[k]) ? fields[k].join(',') : fields[k], 80)}`).join(' | ')}`)
        if (layer === 'feature') {
          L.push(`  落点: ${(now.files || []).length} 文件${(now.files || []).length ? ` (${now.files.slice(0, 5).join(', ')}${now.files.length > 5 ? '…' : ''})` : ''}`)
          const unreg = (now.files || []).filter((f) => before.stale.some((s) => s.file === f))
          if (unreg.length) L.push(`  ⚠ 这些落点在磁盘上不存在（会算作 STALE）: ${unreg.join(', ')}`)
          if (now.module) L.push(`  模块: ${now.module}`)
        }
        if (layer === 'module' && now.project) L.push(`  项目: ${now.project}`)
        L.push('')
        L.push('下一步: nav_render 重生成投影（PROJECT.md 标记区 / ARCH-MODEL.md / 地图）。')
        return L.join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: nav_node')

  // ---- 5. nav_render — 写：重生成全部投影（I2） ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_render',
    description: 'Regenerate every projection from the model: PROJECT.md marker section (outside the markers is never touched), .internal/ARCH-MODEL.md (the human-readable model snapshot), the HTML map, and optionally an arch doc fingerprint stamp. Renderings are never hand-written — hand edits are overwritten by the next render.',
    parameters: {
      target: { type: 'string', description: 'Optional: an arch doc path (.internal/arch/*.md) to stamp after you regenerated its content' },
      path: { type: 'string', description: 'Optional: PROJECT.md path override (default PROJECT.md at the governed root)' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const model = await refresh()
        const res = renderAll(root, model)
        const L = ['✓ 投影已重生成（全部来自模型，零手写）:']
        L.push(`  PROJECT.md 标记区: ${res.project.markerMissing ? '⛔ 找不到 nav:auto 标记（未写入，Once-Only：绝不猜位置）' : res.project.changed ? `已更新${res.project.created ? '（新建）' : ''}` : '无变化'}`)
        L.push(`  模型文档: ${res.modelDoc.path}`)
        L.push(`  地图: ${res.map.path}`)
        if (args.target) {
          try {
            const s = stampArchDoc(root, args.target)
            L.push(`  架构档指纹: ${s.path} ${s.changed ? `已刷新（声明 ${s.declared} 文件）` : '无变化'}`)
          } catch (e) {
            L.push(`  ⛔ 架构档指纹刷新失败: ${e.message}`)
          }
        } else {
          const stale = listArchDocs(root).filter((d) => !d.fresh)
          if (stale.length) L.push(`  ⚠ ${stale.length} 个架构档过期（重生成内容后 nav_render target=<档> 刷新指纹）: ${stale.map((d) => d.path).join(', ')}`)
        }
        if (res.project.markerMissing) L.push('  → 目标 md 里加上 <!-- nav:auto:start --> / <!-- nav:auto:end --> 两个标记后重跑。')
        return L.join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: nav_render')

  // ---- 6. nav_set — 写：根元数据 / 主线向量 ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_set',
    description: 'Set the mainline vector (doing / next / notDoing / exitCondition). Omitted fields keep their current value. The vector is an event, so it is versioned with the repository and read fresh by every tool call.',
    parameters: {
      doing: { type: 'string', description: 'Current focus' },
      next: { type: 'string', description: 'Next action' },
      notDoing: { type: 'string', description: 'Explicit anti-goals (nav_commit rejects scope that collides with this)' },
      exit: { type: 'string', description: 'Completion criteria' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const model = await refresh()
        const prev = model.vector || {}
        const vector = {
          doing: args.doing !== undefined ? args.doing : (prev.doing || ''),
          next: args.next !== undefined ? args.next : (prev.next || ''),
          notDoing: args.notDoing !== undefined ? args.notDoing : (prev.notDoing || ''),
          exitCondition: args.exit !== undefined ? args.exit : (prev.exitCondition || '')
        }
        const [w] = await appendEvents(root, [{ kind: 'set', vector }])
        const after = loadModel(root)
        const changed = Object.keys(vector).filter((k) => String(vector[k]) !== String(prev[k] ?? '') && !(k === 'exitCondition' && args.exit === undefined))
        return [
          `✓ 主线向量已更新（事件 seq ${w.seq}）`,
          `  doing: ${vector.doing || '(unset)'}`,
          `  next: ${vector.next || '(unset)'}`,
          `  notDoing: ${vector.notDoing || '(unset)'}`,
          `  exitCondition: ${vector.exitCondition || '(unset)'}`,
          changed.length ? '' : '  (无字段变化)',
          changed.length ? '下一步: nav_render 把它写进 PROJECT.md 自动区。' : ''
        ].filter(Boolean).join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: nav_set')

  // 启动自检：事件流 seq 连续性看一眼，坏了就在日志里说（不阻塞装配）。
  try {
    const check = verifyLog(root)
    if (!check.ok && ctx.logger?.warn) ctx.logger.warn(`[project-nav] event log has ${check.problems.length} problem(s): ${check.problems.slice(0, 3).join(' | ')}`)
  } catch { /* 首次运行没有事件流是正常态 */ }
}

// ---- 边界判定：实现在 core/boundary.js（纯函数，可独立测试；host 只调用） ----
export { governedWorkspaceOf } from '../core/boundary.js'


// ---- nav_graph 的 JSON 快照（只取叶子字段，绝不序列化活对象） ----
function snapshotOf(model, rootPath, rec, mode, target) {
  const cv = coverage(model)
  return {
    root: rootPath,
    builtAt: model.builtAt,
    events: model.eventCount,
    vector: {
      doing: model.vector?.doing || '', next: model.vector?.next || '',
      notDoing: model.vector?.notDoing || '', exitCondition: model.vector?.exitCondition || ''
    },
    coverage: cv,
    openCommits: model.openCommits.map((c) => ({ id: c.id, task: c.task, anchor: c.anchor, files: (c.files || []).length, at: c.at })),
    stale: model.stale.slice(0, 50),
    unregistered: model.unregistered.slice(0, 50),
    decisions: model.decisions.map((d) => ({ id: d.id, anchor: d.anchor, at: d.at, decision: truncate(d.decision, 200) })),
    pressure: [...model.patchPressure.values()].filter((p) => p.sinceDecisionCount >= 1),
    lastReconcile: { closed: rec.closed.map((c) => c.commit.id), stillOpen: rec.stillOpen.map((c) => c.id) },
    logProblems: model.log.slice(0, 20),
    mode, target: target || null
  }
}
