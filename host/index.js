// @dsh-external/project-nav — anti-drift governance for agent-maintained projects
// Design core: governance-first transaction loop (HANDOFF §14):
//   nav_query (scope) → nav_plan (register action) → nav_mark begin → change → nav_mark done
// 11 tools. Core logic lives in ../shared/index.js (single source, no duplication).
// v0.8.0 (ADR-011): the architecture layer (.internal/arch/*.md + arch-cache fingerprint header)
// is wired into the read face — nav_query prints the arch pointer, nav_plan records archBasis,
// nav_mark done reports docs the change made stale, nav_status summarizes freshness, and the new
// nav_arch tool owns list/check/stamp. Rendering stays a projection outside the plugin.

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { writeFileSync, mkdirSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import {
  loadIndex, getIndexAge,
  loadVector,
  loadActions, loadActionsReconciled, mutateActions, reconcileActions,
  mutateIndex, mutateVector, mutateDocs, mutateArch, withFileLock, retireEntry, indexEntryKind,
  nextActionId, selfOwner, DEFAULT_LEASE_TTL_MS,
  isLeaseExpired, canonPath, scopeOwnModules, sessionLabel, sessionBusyWith, checkScopeConflicts, queuePosition, actorLabel, describeConflicts,
  loadDocs, nextDocId, suggestDocs,
  queryIndex, partialSearch, normalizePath,
  renderTreeText, renderMapHtml, renderProjectDocSection,
  findStaleFiles, scopeTargetsOfOpenActions,
  snapshotScopeFiles, verifyScopeFingerprint, resolveScopeFile, indexedOwnersOf, governedWorkspaceOf,
  loadArch, nextDecisionId, checkAnchor, repeatPressure, REPEAT_PATCH_THRESHOLD, lastDecisionFor,
  listArchDocs, archDocsFor, archDocsForScope, archDocStatus, renderArchPointer, stampArchDoc, parseArchCache
} from '../shared/index.js'

// ---- Plugin metadata (Cordis contract) ----

export const name = '@dsh-external/project-nav'
export const inject = ['tools']

export const Config = z.object({
  // Workspace root governed by this plugin — the folder whose .internal/
  // holds the nav index/vector/actions/docs data (usually the PROJECT.md root).
  // No machine-specific default: leave empty to fall back to the process
  // working directory at load time (a boot log reports the resolved root).
  // Set config.root to govern a specific workspace explicitly.
  root: z.string().default(''),
  // Multi-session leases: how long an in_progress action keeps its scope lock
  // without a heartbeat before another session may claim the same scope.
  leaseTtlMs: z.number().default(0),
  // Workspace boundary (ADR-014): bind every session whose cwd belongs to a GOVERNED
  // workspace to the native `workspace-write` sandbox, so its write actions cannot leave
  // that workspace while reads stay unrestricted everywhere. The boundary itself is the
  // harness's — this plugin only decides which workspaces are governed. Set false to
  // leave every session untouched.
  autoBindWorkspace: z.boolean().default(true)
})

// ---- helpers ----

function err(e) {
  return `ERROR: ${e.message}`
}

function splitList(s) {
  return s ? String(s).split(',').map(x => x.trim()).filter(Boolean) : []
}

/**
 * Session identity of the caller. The governed workspace is shared by every DSH
 * session, so this is what tells two concurrent sessions apart; `exec.agent.id`
 * is the agent's SessionId. Returns null outside a session (tests, CLI), which
 * makes the gates fall back to the legacy global-single-lock behaviour.
 */
function sidOf(exec) {
  return exec?.agent?.id ? String(exec.agent.id) : null
}

/** Lease TTL: config override wins, otherwise the shared default. */
function ttlOf(config) {
  return Number(config?.leaseTtlMs) > 0 ? Number(config.leaseTtlMs) : DEFAULT_LEASE_TTL_MS
}
/** Names of known project directories (used to fold workspace-relative paths). */
function dirNamesOf(index) {
  const out = new Set();
  for (const p of Object.values(index?.projectPaths || {})) {
    const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length) out.add(parts[parts.length - 1].toLowerCase());
  }
  return out;
}

/**
 * Does a query target fall inside an action's scope?
 * Canonical paths only (so "project-nav/host/index.js" and "host/index.js" are
 * the SAME file). A target that IS a feature code or module name matches
 * literally; a target that is a FILE matches scope files exactly (or inside a
 * scope directory) — bare filenames match only exactly, so a scope "index.js"
 * cannot claim every index.js in the repo.
 */
function targetInScope(target, scope, index = null) {
  const dirs = dirNamesOf(index);
  const t = canonPath(target, dirs);
  if (!t) return false;
  for (const f of (scope.features || [])) if (f.toLowerCase() === t) return true;
  for (const m of (scope.modules || [])) if (m.toLowerCase() === t) return true;
  for (const f of (scope.files || [])) {
    const nf = canonPath(f, dirs);
    if (!nf) continue;
    // exact match, or target inside a scope DIRECTORY, or scope path expressed
    // relative to the query's directory.
    if (t === nf) return true;
    if (nf.includes('/') && t.startsWith(nf + '/')) return true;
    if (t.includes('/') && nf.startsWith(t + '/')) return true;
  }
  return false
}

/**
 * The live action holding this target, if any: matches by literal path scope OR
 * by feature — a file that the index maps to a feature the other action holds is
 * an overlap even though the two scopes name different things.
 */
function occupyingAction(ledger, target, index = null) {
  const dirs = dirNamesOf(index)
  const targetFeatures = featuresOfTarget(index, target, dirs)
  return (ledger.actions || []).find(a => {
    if (a.status !== 'in_progress' || isLeaseExpired(a)) return false
    const scope = a.scope || {}
    return targetInScope(target, scope, index) || featureTouch(scope, targetFeatures)
  }) || null
}

/**
 * Scope gate for nav_query: answers the question a parallel session actually has
 * — "is somebody else on this file right now?". A live action held by ANOTHER
 * session is reported as OCCUPIED (and nav_mark begin will queue behind it); the
 * caller's own open actions keep the original plan-first gate, and other
 * sessions' unrelated actions are reported as free-to-work context instead of noise.
 */
/** Does this scope name (or own, through the index) any of these feature codes? */
function featureTouch(scope, featureCodes) {
  if (!featureCodes || featureCodes.size === 0) return false
  return (scope?.features || []).some(c => featureCodes.has(c))
}

function featuresOfTarget(index, target, dirs) {
  const f2f = index?.indexes?.fileToFeature || {};
  const t = canonPath(target, dirs);
  const out = new Set();
  for (const [file, codes] of Object.entries(f2f)) {
    if (canonPath(file, dirs) === t) for (const c of codes) out.add(c);
  }
  return out;
}

function scopeGate(ledger, target, sessionId = null, index = null) {
  const sid = sessionId ? String(sessionId) : ''
  const dirs = dirNamesOf(index)
  const targetFeatures = featuresOfTarget(index, target, dirs)
  const actions = ledger.actions || []
  const covers = a => {
    const scope = a.scope || {}
    return targetInScope(target, scope, index) || featureTouch(scope, targetFeatures)
  }
  // 1. Somebody else's live lock on this target → the parallel-session warning.
  const occupier = actions.find(a => a.status === 'in_progress' && !isLeaseExpired(a) && covers(a)) || null
  if (occupier && (!sid || occupier.owner?.sessionId !== sid)) {
    return `\n⚠ OCCUPIED: ${actorLabel(occupier)} is changing this target right now.\n  A live action from another session holds it. Options: wait for it (your own nav_mark begin with wait=true blocks until it is released), pick a different target, or re-scope so the two do not overlap (nav_plan).`
  }
  // 2. The caller's own open action covers it → plan-first reminder.
  const mine = actions.find(a => (a.status === 'planned' || a.status === 'in_progress') && (!sid || a.owner?.sessionId === sid) && covers(a))
  if (mine) {
    return `Gate: this target belongs to your OPEN action ${mine.id} (${mine.status}) "${mine.task}". Changes here must run under that action.`
  }
  const open = actions.filter(a => a.status === 'planned' || a.status === 'in_progress')
  if (open.length === 0) return ''
  const others = open.filter(a => !sid || a.owner?.sessionId !== sid)
  // 3. The caller's own open actions cover nothing here → plan-first reminder.
  if (others.length === 0) {
    const list = open.map(a => `${a.id} [${a.status}] ${a.task}`).join('; ')
    return `⚠ Gate: ${open.length} open action(s) exist (${list}) and this target is NOT in their scope. Plan first (nav_plan) or finish them (nav_mark).`
  }
  // 4. Others are working somewhere inside the module this query names → partial occupancy.
  const modulesOfTarget = new Set()
  for (const [mod, feats] of Object.entries(index?.indexes?.moduleToFeatures || {})) {
    if ((feats || []).some(c => targetFeatures.has(c))) modulesOfTarget.add(mod)
  }
  if (modulesOfTarget.size) {
    const busyModules = []
    for (const a of others) {
      for (const m of scopeOwnModules(index, a.scope || {})) {
        if (modulesOfTarget.has(m)) busyModules.push(`${a.id} holds ${m}`)
      }
    }
    if (busyModules.length) {
      return `\n⚠ PARTIALLY OCCUPIED: this target sits in module(s) ${[...modulesOfTarget].join(', ')} and other sessions are live inside them (${busyModules.join('; ')}).\n  Their scopes are narrower than the whole module, so check the overlap before touching anything: ${others.map(actorLabel).join('; ')}`
    }
  }
  // 5. Others' unrelated open actions → context, not a blocker.
  const list = others.map(actorLabel).join('; ')
  return `⚠ Gate: ${others.length} open action(s) belong to OTHER sessions (${list}) and this target is not in their scope — free to work, but register your own scope (nav_plan) so the two cannot drift into each other.`
}

/** Mainline gate heuristic: are the query hits referenced in doing/next text? */
function mainlineGate(vector, result) {
  const mainline = `${vector.doing || ''} ${vector.next || ''}`.toLowerCase().trim()
  // Only gate on module names — feature codes never appear in prose mainline
  // text, so matching them would warn on every query (noise → gate gets ignored).
  if (!mainline || result.modules.length === 0) return ''
  const referenced = result.modules.some(m => m.length >= 3 && mainline.includes(m.toLowerCase()))
  if (referenced) return ''
  return `⚠ Mainline: module(s) ${result.modules.join(', ')} not referenced in the mainline vector (doing/next). Confirm this is on-mainline, or update the vector (nav_set_vector).`
}

const OUTPUT = {
  schema: { type: 'string' },
  render: (_a, v) => [{ type: 'text', text: String(v) }]
}

// ---- plugin entry ----

export function apply(ctx, config) {
  // Resolve the governed root at load time: explicit config.root wins;
  // otherwise fall back to the process cwd and say so loudly at boot, so the
  // plugin never silently targets a hardcoded machine-specific path.
  const root = config?.root ? resolve(config.root) : process.cwd()
  if (ctx.logger?.warn && !config?.root) {
    ctx.logger.warn(`[project-nav] root config unset — governing process.cwd() (${root}). Set config.root to the workspace you want governed (see README "配置").`)
  } else if (ctx.logger?.info) {
    ctx.logger.info(`[project-nav] governing root: ${root} (config.root)`)
  }

  // G3 (HANDOFF §33): every read/write in this plugin goes through node:fs.
  // Some deployments expose a sandboxed fs capability (ctx.fs) that fences
  // mutations by workspace policy. When it is present, say so loudly instead of
  // silently bypassing the fence. The async fs-port swap is deliberately deferred
  // until a confined deployment actually exists (complexity budget, v0.6.0).
  let fsCapability = null
  try { fsCapability = ctx.get?.('fs') ?? ctx.fs ?? null } catch { fsCapability = null }
  if (fsCapability && ctx.logger?.warn) {
    ctx.logger.warn('[project-nav] a sandboxed fs capability (ctx.fs) is present, but this plugin reads/writes .internal/ through node:fs directly. If this deployment confines plugin fs access, governance data may bypass the fence — see HANDOFF §33 (G3).')
  }

  // ---- workspace boundary (ADR-014) ----
  // The harness owns the boundary: a session's cwd IS its workspace, and `workspace-write`
  // confines every write (files, shell, subprocesses, third-party plugins) to it while
  // leaving reads unrestricted everywhere. The plugin contributes the one fact the harness
  // cannot know — whether THIS deployment governs that workspace — by binding matching
  // sessions to that mode once, at session start. Enforcement, the approval path, and
  // projecting the policy into the model's own context are all native; nothing is
  // re-implemented here.
  if (config?.autoBindWorkspace !== false && typeof ctx.on !== 'function') {
    // Fail VISIBLE: a context without ctx.on would silently leave every session unbound,
    // and a boundary that reports nothing is worse than one that reports it is missing.
    ctx.logger?.warn?.('[project-nav] workspace boundary: this context exposes no ctx.on — sessions will NOT be bound to their workspace. Set autoBindWorkspace=false to silence.')
  }
  if (config?.autoBindWorkspace !== false && typeof ctx.on === 'function') {
    ctx.on('agent/session-start', (payload) => {
      try {
        const session = payload?.agent?.session
        const cwd = session?.header?.cwd
        if (!session || !cwd || typeof session.append !== 'function') return
        // Not governed → leave the session completely alone (its workspace may merely share the root).
        const zone = governedWorkspaceOf(loadIndex(root), root, cwd)
        if (!zone) return
        const policy = ctx.get?.('sandboxPolicy')
        if (!policy || typeof policy.overrideOf !== 'function') return
        // Someone already chose a mode for this session (the user's /permission, or an earlier
        // bind): never override an explicit choice, and never append the same event twice.
        if (policy.overrideOf(session) !== undefined) return
        session.append('sandbox/mode', { mode: 'workspace-write' })
        ctx.logger?.info?.(`[project-nav] workspace boundary: session ${sessionLabel(payload?.agent?.id)} bound to workspace-write (${zone})`)
      } catch (e) {
        // Fail-safe: a boundary that cannot be set must never break session establishment.
        ctx.logger?.warn?.(`[project-nav] workspace boundary: left session untouched (${e.message})`)
      }
    })
  }

  // ---- 1. nav_query — bidirectional mapping + gates ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_query',
    description: 'Understand the scope of a change target BEFORE touching anything: query by file path or feature code to expand features/modules/projects, with open-action and mainline drift gates.',
    parameters: {
      target: { type: 'string', required: true, description: 'File path or feature code (e.g., PE-F01)' },
      format: { type: 'string', description: 'Output format: text (default) or json' }
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sid = sidOf(exec)
      const ttl = ttlOf(config)
      try {
        const index = loadIndex(root)
        const result = queryIndex(index, args.target)
        if (!result || (result.features.length === 0 && result.files.length === 0 && result.modules.length === 0)) {
          const partials = partialSearch(index, args.target)
          if (partials.length > 0) {
            return `No exact match for "${args.target}". Did you mean:\n${partials.map(m => `  - ${m}`).join('\n')}`
          }
          return `No mapping found for "${args.target}". Register it via nav_update (upsert: a feature with files=, a module with features=/project=).`
        }
        const { ledger } = await loadActionsReconciled(root, { sessionId: sid, ttlMs: ttl })
        const notices = [scopeGate(ledger, args.target, sid, index), mainlineGate(loadVector(root), result)].filter(Boolean)
        // 架构档指针：这是「开发前必读架构档」落到读取面的那一行——agent 不必记得去查，
        // 查询目标的影响面时顺手就知道本目标的架构档在哪、还新不新鲜（ADR-011 接线①）。
        let archStates = []
        try { archStates = archDocsFor(index, root, args.target) } catch { archStates = [] }
        if (args.format === 'json') return JSON.stringify({ ...result, notices, archDocs: archStates }, null, 2)
        const lines = [
          `Query: ${result.query} (${result.type})`,
          `Features: ${result.features.join(', ') || 'none'}`,
          `Modules: ${result.modules.join(', ') || 'none'}`,
          `Projects: ${result.projects.join(', ') || 'none'}`,
          `Files:\n${result.files.map(f => `  → ${f}`).join('\n') || '  (none registered)'}`
        ]
        const vector = loadVector(root)
        if (vector.doing || vector.next) {
          lines.push('', 'Mainline Vector:')
          if (vector.doing) lines.push(`  Doing: ${vector.doing}`)
          if (vector.next) lines.push(`  Next: ${vector.next}`)
        }
        lines.push('', renderArchPointer(archStates))
        if (notices.length) lines.push('', ...notices)
        return lines.join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: query')

  // ---- 2. nav_plan — governance-first: register an action BEFORE changing anything ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_plan',
    description: 'Governance-first gate: register a change action (task + plan + scope) BEFORE executing any project change. Returns an ACT-id to begin/done with nav_mark. Refuses scope that collides with the mainline anti-goals (notDoing).',
    parameters: {
      task: { type: 'string', required: true, description: 'One-line task description' },
      plan: { type: 'string', description: 'Change plan summary derived from governance info' },
      features: { type: 'string', description: 'Comma-separated feature codes in scope' },
      modules: { type: 'string', description: 'Comma-separated module names in scope' },
      files: { type: 'string', description: 'Comma-separated file paths in scope' },
      anchor: { type: 'string', description: 'Architecture-first protocol: the architecture node this task belongs to (feature code / module / file / .internal/arch/*.md). Required — an action with no architecture anchor is a local patch in the making.' },
      arch: { type: 'string', description: 'One-line architecture reflection: does this task need an architecture change, or is the architecture sound and the change local?' }
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sid = sidOf(exec)
      const ttl = ttlOf(config)
      try {
        const scope = {
          features: splitList(args.features),
          modules: splitList(args.modules),
          files: splitList(args.files)
        }
        if (!scope.features.length && !scope.modules.length && !scope.files.length) {
          return 'ERROR: scope is empty — provide at least one of features/modules/files so the action has a checkable scope.'
        }
        const vector = loadVector(root)
        // Mainline gate: refuse if scope collides with explicit anti-goals.
        const notDoing = (vector.notDoing || '').toLowerCase()
        if (notDoing) {
          const tokens = [...scope.features, ...scope.modules].map(x => x.toLowerCase()).filter(x => x.length >= 4)
          const collide = tokens.find(x => notDoing.includes(x))
          if (collide) {
            return `ERROR: scope collides with mainline anti-goal (notDoing: "${vector.notDoing}") via "${collide}". Re-scope the plan or update the vector first (nav_set_vector).`
          }
        }
        const { ledger } = await loadActionsReconciled(root, { sessionId: sid, ttlMs: ttl })
        const index = loadIndex(root)
        // ---- 架构先行协议：锚点闸 + 计数闸（scope 无歧义时自动取锚——强限制只留给真正需要架构思考的地方） ----
        let anchor = normalizePath(String(args.anchor || '').trim())
        let autoAnchor = ''
        if (!anchor) {
          if (scope.features.length === 1) { anchor = scope.features[0]; autoAnchor = '自动取自 scope 的唯一功能 ' + anchor }
          else if (!scope.features.length && scope.modules.length === 1) { anchor = scope.modules[0]; autoAnchor = '自动取自 scope 的唯一模块 ' + anchor }
          else if (!scope.features.length && !scope.modules.length && scope.files.length === 1) { anchor = scope.files[0]; autoAnchor = '自动取自 scope 的唯一文件 ' + anchor }
        }
        if (!anchor) {
          return [
            'ERROR: nav_plan requires anchor=<架构节点> —— 所有开发动作必须从架构出发。',
            '  改哪个功能就锚功能码（PN-F01），动哪个模块就锚模块名（PN-M02），修哪个文件就锚文件路径；架构层改动锚 .internal/arch/*.md。',
            '  先跑 nav_query <目标> 拿到锚点，再登记动作。无锚点的动作 = 还没有架构思考，十有八九会变成局部补丁。',
            '  arch=<一句话架构判断> 可选但强烈建议：本任务是否需要调整架构？',
            '  若某目标在架构上**找不到锚点**（nav_query 展不开、对应架构档不存在，或档已过期且与实际差异大），它就不是普通工程任务而是**架构修订任务**：先出整体架构方案（改 .internal/arch/*.md），lk 确认后再派生工程动作。'
          ].join('\n')
        }
        const anchorChk = checkAnchor(index, root, anchor)
        if (!anchorChk.ok) {
          return `ERROR: anchor "${anchor}" 不是真实架构节点（${anchorChk.hint}）。先 nav_query 确认，或用 nav_update 直接补登记（upsert：新功能给 files=，新模块给 features=/project=）。`
        }
        const archLedger = loadArch(root)
        const pressure = repeatPressure(archLedger, ledger.actions, anchor)
        const archNote = []
        if (!String(args.arch || '').trim()) {
          archNote.push('⚠ 架构反思缺失（arch= 未填）：动手前请用一句话回答「本任务是否需要调整架构」——需要则先出架构决策（nav_adr），不需要则说明架构为何仍然成立。')
        }
        if (pressure.exceeded) {
          archNote.push(`⛔ 计数闸触发：锚点 ${anchor} 自 ${pressure.sinceDecision || '项目开始'} 以来已有 ${pressure.count} 次补丁（阈值 ${pressure.threshold}）——按第一性原理，先出架构决策（nav_adr anchor="${anchor}"），再判断这次改动是不是又一个局部补丁。`)
        } else if (pressure.count > 0) {
          archNote.push(`ℹ 该锚点已有 ${pressure.count} 次补丁（阈值 ${pressure.threshold}）${pressure.sinceDecision ? `，最近架构决策 ${pressure.sinceDecision}` : '，尚无架构决策'}。`)
        }
        // B4: scope-vs-index pre-validation at plan time — every scope item must either exist in the
        // index or be explicitly new. Silent unknowns are how a plan quietly points at the wrong target.
        // File resolution goes through the index-aware resolvers: a scope written from inside a project
        // directory (`host/index.js`) resolves to the indexed `project-nav/host/index.js` and must NOT
        // be reported as unknown — a false alarm here trains the agent to ignore real ones.
        const unknown = {
          features: scope.features.filter(f => !index.indexes?.featureToFiles?.[f] && !index.descriptions?.[f]),
          modules: scope.modules.filter(mod => !index.indexes?.moduleToFeatures?.[mod]),
          files: scope.files.filter(f => !indexedOwnersOf(root, f, index) && !resolveScopeFile(root, f, index))
        }
        const unknownNote = (unknown.features.length || unknown.modules.length || unknown.files.length)
          ? `\n  ⚠ Scope items not found in index: features=[${unknown.features.join(', ')}] modules=[${unknown.modules.join(', ')}] files=[${unknown.files.join(', ')}]\n    If this task CREATES them, ignore. If it should MODIFY existing ones, the identifier is likely wrong — re-check with nav_query.`
          : ''
        // Multi-session gate: the old global "one in_progress action at a time" rule is gone —
        // a workspace runs as many actions at once as it has DISJOINT scopes. The plan-time job
        // is to warn the session up front whether its scope will collide at begin time, so it can
        // split the scope instead of queueing behind another session.
        const plannedAction = { scope, owner: { sessionId: sid || '' }, createdAt: new Date().toISOString() }
        const conflicts = checkScopeConflicts(ledger, plannedAction, { index })
        const conflictNote = conflicts.length
          ? ['', `⚠ ${conflicts.length} live action(s) overlap YOUR planned scope — nav_mark begin will QUEUE behind them:`, ...describeConflicts(conflicts),
             '  Better fix: narrow/split the scope (disjoint files ⇒ real parallelism), or wait for the holder to finish with nav_mark done.']
          : []
        const busy = sid ? sessionBusyWith(ledger, sid) : null
        const busyNote = busy
          ? [`⚠ Your session already holds ${actorLabel(busy)} — finish it (nav_mark done) or abort it (nav_mark abort) before beginning a new one. (Other sessions are unaffected: it is one in_progress per session, not one per workspace.)`]
          : []
        // 架构对照（ADR-011 接线②）：本动作的落点/波及对应哪些架构档、还新不新鲜。随 plan 一起
        // 留痕（archBasis），方案确认时就能看见「这次改动会不会让某一档架构描述失效」。
        let archStates = []
        try { archStates = archDocsForScope(index, root, scope) } catch { archStates = [] }
        const archBasis = {
          node: anchor,
          kind: anchorChk.kind,
          docs: archStates.map(d => ({ path: d.path, scope: d.scope || '', fresh: !!d.ok, drifted: (d.drifted || []).length }))
        }
        const action = {
          id: null,   // assigned INSIDE the ledger lock: concurrent planners must not collide
          task: args.task,
          plan: args.plan || '',
          scope,
          status: 'planned',
          anchor,
          anchorKind: anchorChk.kind,
          archNote: String(args.arch || '').trim(),
          archBasis,
          owner: selfOwner(sid, { cwd: process.cwd() }),
          lease: null,
          createdAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null
        }
        await mutateActions(root, { sessionId: sid, ttlMs: ttl }, (lg) => {
          lg.actions = lg.actions || []
          action.id = nextActionId(lg)   // id from the RECONCILED ledger, under the lock
          lg.actions.push(action)
        })
        const warns = []
        if (!vector.doing) warns.push('⚠ Mainline vector "doing" is empty — set it (nav_set_vector) so drift can be detected.')
        warns.push(...busyNote, ...conflictNote)
        // Reference-doc suggestions: consult BEFORE finalizing the plan (方案确认参考).
        const suggestions = suggestDocs(loadDocs(root), {
          taskText: `${args.task} ${args.plan || ''}`,
          projects: Object.keys(index.indexes?.projectToModules || {}),
          modules: scope.modules
        }).slice(0, 5)
        return [
          `✓ Action ${action.id} registered (planned): ${action.task}`,
          `  Anchor: ${anchor} (${anchorChk.kind})${autoAnchor ? ` · ${autoAnchor}` : ''}${action.archNote ? ` · arch: ${action.archNote}` : ''}`,
          ...(archNote.length ? ['', ...archNote] : []),
          `  Scope: features=[${scope.features.join(', ')}] modules=[${scope.modules.join(', ')}] files=[${scope.files.join(', ')}]`,
          `  架构对照: 落点 ${anchor} (${anchorChk.kind}) · 波及 ${scope.features.length + scope.modules.length + scope.files.length} 项`,
          ...renderArchPointer(archStates).split('\n').map(l => '  ' + l),
          ...(unknownNote ? [unknownNote] : []),
          ...(suggestions.length ? [
            '',
            'Reference docs to consult at 方案确认 (read/fetch these before finalizing the plan):',
            ...suggestions.map(d => `  ${d.id} ${d.title}\n    → ${d.path}\n    when: ${d.when}`)
          ] : []),
          ...(warns.length ? ['', ...warns] : []),
          'Next: consult suggested docs, finalize plan, then nav_mark id="' + action.id + '" action=begin before touching files.'
        ].join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: plan')

  // ---- 3. nav_mark — action lifecycle: begin / done / abort ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_mark',
    description: 'Mark an action lifecycle transition: begin (planned→in_progress, BEFORE changes), done (in_progress→done, AFTER changes), abort (give up). The open-action list is the drift signal — never leave actions unfinished. An action whose lease lapsed is "expired": its owner can still begin (re-acquire the lease + retake the fingerprint), done (late close-out) or abort it, so finished work is never stranded.',
    parameters: {
      id: { type: 'string', required: true, description: 'Action id from nav_plan (e.g., ACT-001)' },
      action: { type: 'string', required: true, description: 'One of: begin, done, abort' }
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sid = sidOf(exec)
      const ttl = ttlOf(config)
      try {
        const index = loadIndex(root)
        if (args.action === 'begin') {
          // Multi-session gate: BEGIN is the moment a scope turns into a live lock.
          // Disjoint scopes start immediately and in parallel; overlapping ones wait
          // for the holder (or queue behind it). Leases self-heal, so a crashed
          // session can never wedge the workspace.
          let waited = 0
          let result = null
          for (;;) {
            result = await mutateActions(root, { sessionId: sid, ttlMs: ttl }, (ledger) => {
              const a = (ledger.actions || []).find(x => x.id === args.id)
              if (!a) return { kind: 'no-action' }
              if (a.owner?.sessionId && sid && a.owner.sessionId !== sid) {
                return { kind: 'foreign', action: a }
              }
              if (a.status === 'in_progress') return { kind: 'reenter', action: a }
              // A lapsed lease turns the action into "expired" (reconcileActions). Before this,
              // "expired" was a terminal state with NO entry: such an action could be neither
              // begun, done nor aborted, so an agent that finished a long task could never record
              // it. Its owner may re-acquire — the lease is retaken and the fingerprint re-snapshotted.
              const reacquire = a.status === 'expired'
              if (a.status !== 'planned' && !reacquire) return { kind: 'bad-state', action: a }
              const busy = sid ? sessionBusyWith(ledger, sid) : null
              if (busy) return { kind: 'session-busy', action: a, busy }
              const conflicts = checkScopeConflicts(ledger, a, { index })
              if (conflicts.length) {
                const q = queuePosition(ledger, a, { index })
                return { kind: 'blocked', action: a, conflicts, q }
              }
              a.status = 'in_progress'
              a.startedAt = new Date().toISOString()
              a.owner = a.owner && a.owner.sessionId ? a.owner : selfOwner(sid, { cwd: process.cwd() })
              // Fingerprint the scope now, so `done` can tell whether these files were
              // touched by somebody else while this action was running.
              const scopeNow = snapshotScopeFiles(root, index, a.scope || {})
              a.scopeState = Object.keys(scopeNow).length ? { takenAt: a.startedAt, scope: a.scope || {}, files: scopeNow } : null
              a.lease = { acquiredAt: a.startedAt, renewedAt: a.startedAt, ttlMs: ttl }
              return { kind: 'begun', action: a, reacquired: reacquire }
            })
            if (result.kind !== 'blocked' || !args.wait) break
            const budget = args.waitMs === undefined ? 120000 : Number(args.waitMs)
            if (!(budget > 0) || waited >= budget) break
            await new Promise(r => setTimeout(r, 2000))
            waited += 2000
          }
          if (result.kind === 'no-action') return `ERROR: no action "${args.id}". Use nav_plan to create one.`
          if (result.kind === 'foreign') return `ERROR: ${result.action.id} is held by ${actorLabel(result.action)} — a session can only drive its own actions. Create your own action (nav_plan) and begin that one.`
          if (result.kind === 'reenter') return `✓ ${result.action.id} already in_progress (held by you) — go ahead and change the files.`
          if (result.kind === 'bad-state') return `ERROR: ${result.action.id} is "${result.action.status}", only "planned" actions can begin.`
          if (result.kind === 'session-busy') {
            return [
              `ERROR: your session already holds ${actorLabel(result.busy)}.`,
              '  One in_progress action per session: finish it (nav_mark done) or abort it (nav_mark abort) before beginning another.',
              '  (Other SESSIONS may work in parallel — the lock is per scope, not global.)'
            ].join('\n')
          }
          if (result.kind === 'blocked') {
            const q = result.q
            return [
              `⛔ BLOCKED: ${result.action.id} overlaps ${result.conflicts.length} live action(s)${q.ahead ? ` — queue position ${q.ahead}` : ''}:`,
              ...describeConflicts(result.conflicts),
              '',
              `Your scope: features=[${(result.action.scope?.features || []).join(', ')}] modules=[${(result.action.scope?.modules || []).join(', ')}] files=[${(result.action.scope?.files || []).join(', ')}]`,
              args.wait
                ? `  Waited ${Math.round(waited / 1000)}s, still held. Ask again with a longer waitMs, or split/disjoint your scope (nav_plan) so the two can run in parallel.`
                : '  Retry with wait=true (optionally waitMs=<ms>) to queue until the holder finishes with nav_mark done / abort.',
              '  Do NOT edit overlapping files while the holder is live — that is exactly how two sessions drift into each other.'
            ].join('\n')
          }
          return [
            `✓ ${result.action.id} → in_progress (scope locked for session ${sid ? sessionLabel(sid) : 'unknown'})`,
            ...(result.reacquired ? ['  Re-acquired after a lapsed lease — the scope fingerprint was retaken just now.'] : []),
            `  Scope: features=[${(result.action.scope?.features || []).join(', ')}] modules=[${(result.action.scope?.modules || []).join(', ')}] files=[${(result.action.scope?.files || []).join(', ')}]`,
            `  Disjoint from every other live action${waited ? ` (queued ${Math.round(waited / 1000)}s)` : ''} — other sessions keep working in parallel.`,
            '  Ready: change the files, then nav_mark action=done to close out (and release the scope).'
          ].join('\n')
        }

        if (args.action === 'done') {
          let deltaLines = []
          var scopeDrift = null
          const res = await mutateActions(root, { sessionId: sid, ttlMs: ttl }, (ledger) => {
            const a = (ledger.actions || []).find(x => x.id === args.id)
            if (!a) return { kind: 'no-action' }
            if (a.owner?.sessionId && sid && a.owner.sessionId !== sid) return { kind: 'foreign', action: a }
            // "expired" is closable by its owner — a lapsed lease must not strand finished work
            // (the state machine otherwise had no exit from "expired"). It is recorded as a late
            // close-out so the ledger stays honest about the gap.
            const late = a.status === 'expired'
            if (a.status !== 'in_progress' && !late) return { kind: 'bad-state', action: a }
            // Did anything move under us? Compare the begin-time snapshot against disk now.
            if (a.scopeState) {
              try { scopeDrift = verifyScopeFingerprint(root, index, a.scopeState, a.scope) } catch { scopeDrift = null }
            }
            a.status = 'done'
            a.completedAt = new Date().toISOString()
            if (late) a.lateCompletion = true
            a.lease = null
            if (scopeDrift && !scopeDrift.ok) a.drift = { at: a.completedAt, changed: scopeDrift.changed, removed: scopeDrift.removed, added: scopeDrift.added }
            // Positive evidence that this action patched NOTHING: the fingerprint proved the scope
            // is byte-identical. The repeat-patch gate counts *patches*, so a bookkeeping action
            // (a verification pass) must not push its anchor toward the threshold — false pressure
            // ends in hollow ADRs, and a diluted decision ledger is the same "alarm fatigue" failure
            // as a permanent false STALE. No scopeState = no proof, so it keeps counting.
            if (scopeDrift && a.scopeState
              && scopeDrift.changed.length === 0 && scopeDrift.removed.length === 0 && scopeDrift.added.length === 0
              && Object.values(a.scopeState.files || {}).some(v => v && typeof v === 'object')) {
              // …and at least ONE scoped file must have actually EXISTED at begin. A snapshot whose
              // every entry is "missing" proves nothing about the work (stale or mistyped scope),
              // so it stays "no evidence" and keeps counting — the gate prefers over-counting.
              a.noChange = true
            }
            // Delta close-out (OpenSpec archive semantics): surface index deltas the
            // agent must merge before this change counts as synced.
            const f2files = index.indexes?.featureToFiles || {}
            const missingFeatures = (a.scope?.features || []).filter(c => !f2files[c])
            // Same index-aware resolution as the fingerprint path and the plan-time pre-check:
            // a literal map lookup here reported already-registered files as "outside the index".
            const unregisteredFiles = (a.scope?.files || []).filter(f => !indexedOwnersOf(root, f, index))
            if (missingFeatures.length) deltaLines.push(`  - 未登记功能（需 nav_update 创建）: ${missingFeatures.join(', ')}`)
            if (unregisteredFiles.length) deltaLines.push(`  - 索引外文件（需登记到所属功能，nav_update field="files" value="..."）: ${unregisteredFiles.join(', ')}`)
            // Releasing a scope is what unblocks the sessions queued behind it.
            // 架构先行协议：完结动作按锚点记入补丁账本 + 计数闸复查（结果随返回值带出，不依赖跨作用域副作用）
            const waiters = (ledger.actions || []).filter(o => o.status === 'planned' && o.id !== a.id && checkScopeConflicts(ledger, o, { index }).length === 0)
            let pressureNote = ''
            if (a.anchor) {
              try {
                const pr = repeatPressure(loadArch(root), ledger.actions, a.anchor)
                if (pr.exceeded) {
                  pressureNote = '  [计数闸] ' + a.anchor + ' 已有 ' + pr.count + ' 次补丁（阈值 ' + pr.threshold + '），最近架构决策 ' + (pr.sinceDecision || '无') + '：这是「同一死胡同反复打补丁」的信号——下次改动前先 nav_adr 出架构决策。'
                } else if (pr.count >= pr.threshold - 1) {
                  pressureNote = '  [计数闸] ' + a.anchor + ' 补丁计数 ' + pr.count + '/' + pr.threshold + '，接近升格阈值：先想根因，别拆东墙补西墙。'
                }
              } catch (e) { pressureNote = '  ⚠ 架构补丁账本写入失败：' + e.message }
            } else {
              pressureNote = '  ⚠ 本动作无锚点（未走锚点闸）——无法计入架构补丁账本。'
            }
            return { kind: 'done', action: a, waiters: waiters.map(w => w.id), pressureNote, late }
          })
          if (res.kind === 'no-action') return `ERROR: no action "${args.id}". Use nav_plan to create one.`
          if (res.kind === 'foreign') return `ERROR: ${res.action.id} is held by ${actorLabel(res.action)} — only the holding session can close it. Ask that session to nav_mark done / abort, or let its lease expire (self-heals).`
          if (res.kind === 'bad-state') return `ERROR: ${res.action.id} is "${res.action.status}", only "in_progress" actions can be done.`
          const lines = [`✓ ${res.action.id} → done: ${res.action.task}`, 'Delta close-out（合并进索引后本次变更才算同步完成）:']
          if (res.late) lines.push('  ⚠ Late close-out: this action\'s lease had already expired (another session may have taken the scope meanwhile) — the fingerprint below is informational only.')
          if (deltaLines.length) {
            lines.push(...deltaLines, '  修完后跑 nav_sync_docs 对齐 PROJECT.md 功能地图。')
          } else {
            lines.push('  ✓ scope 与索引一致，无缺口。跑 nav_sync_docs 对齐 PROJECT.md 功能地图。')
          }
          if (scopeDrift && !scopeDrift.ok) {
            lines.push('  ⚠ Scope drift since begin (files moved under this action — possibly another session):')
            if (scopeDrift.changed.length) lines.push('    modified: ' + scopeDrift.changed.join(', '))
            if (scopeDrift.removed.length) lines.push('    vanished: ' + scopeDrift.removed.join(', '))
            if (scopeDrift.added.length) lines.push('    appeared: ' + scopeDrift.added.join(', '))
            lines.push('    Review those files before trusting this close-out (recorded on the action as `drift`).')
          } else if (scopeDrift) {
            lines.push('  ✓ Scope fingerprint verified: none of the scoped files changed during this action.')
          }
          if (res.pressureNote) lines.push(res.pressureNote)
          // 架构档过期提示（ADR-011 接线③）：本动作改的就是这些档声明覆盖的文件，所以收口这一刻
          // 正是「架构描述已被代码甩下」的判定点——提示重生成 + 用 nav_arch stamp 刷新指纹。
          try {
            const archAfter = archDocsForScope(index, root, res.action.scope || {})
            if (archAfter.length) {
              const stale = archAfter.filter(d => !d.ok)
              lines.push(stale.length
                ? `  架构档: 本次改动使 ${stale.length}/${archAfter.length} 档过期 → 重生成内容后跑 nav_arch mode="stamp" path="<档>" 刷新指纹：${stale.map(d => d.path).join(', ')}`
                : `  架构档: ${archAfter.length} 档覆盖本 scope，指纹仍新鲜（本次改动未触及档内声明文件）。`)
            }
          } catch { /* 架构档提示永不阻断收口 */ }
          if (res.waiters.length) lines.push(`  Scope released — ${res.waiters.length} queued action(s) can now begin: ${res.waiters.join(', ')}`)
          return lines.join('\n')
        }

        if (args.action === 'abort') {
          const res = await mutateActions(root, { sessionId: sid, ttlMs: ttl }, (ledger) => {
            const a = (ledger.actions || []).find(x => x.id === args.id)
            if (!a) return { kind: 'no-action' }
            if (a.owner?.sessionId && sid && a.owner.sessionId !== sid) return { kind: 'foreign', action: a }
            if (a.status !== 'planned' && a.status !== 'in_progress' && a.status !== 'expired') return { kind: 'bad-state', action: a }
            a.status = 'aborted'
            a.completedAt = new Date().toISOString()
            a.lease = null
            return { kind: 'aborted', action: a }
          })
          if (res.kind === 'no-action') return `ERROR: no action "${args.id}". Use nav_plan to create one.`
          if (res.kind === 'foreign') return `ERROR: ${res.action.id} is held by ${actorLabel(res.action)} — only the holding session can abort it.`
          if (res.kind === 'bad-state') return `ERROR: ${res.action.id} is already "${res.action.status}".`
          return `✓ ${res.action.id} → aborted: ${res.action.task}`
        }

        return 'ERROR: action must be one of: begin, done, abort.'
      } catch (e) { return err(e) }
    }
  })), 'project-nav: mark')

  // ---- 4. nav_update — sync descriptions / file lists ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_update',
    description: 'Create-or-update any index entry (upsert): features, modules, and their fields — the single registration tool. Existing target = update the field; absent target + creation fields = create. Keeps the model-facing registration surface at one tool.',
    parameters: {
      target: { type: 'string', required: true, description: 'Feature code or module name' },
      field: { type: 'string', description: 'UPDATE only: field to set on an existing entry — name, userView, systemView, files (feature only), status, or any custom field' },
      value: { type: 'string', description: 'UPDATE only: new value (for "files": comma-separated paths)' },
      name: { type: 'string', description: 'CREATE only: human-readable name' },
      userView: { type: 'string', description: 'CREATE feature: user perspective description' },
      systemView: { type: 'string', description: 'CREATE feature: system perspective description' },
      files: { type: 'string', description: 'CREATE feature: comma-separated file paths' },
      features: { type: 'string', description: 'CREATE module: comma-separated feature codes belonging to it (empty = module shell); also replaces an existing module list' },
      project: { type: 'string', description: 'Module: the project to attach it to — for an EXISTING module this re-homes it (the old attachment is removed), and project="" detaches it (unattached modules still appear on the map). CREATE feature/module: the project to attach it to.' },
      retire: { type: 'boolean', description: 'RETIRE (inverse of upsert): remove this entry from the index and cascade — feature drops its file mappings + module membership, module drops its project attachments (its features survive), project detaches its modules (they survive as unattached). Use when something is genuinely gone from the workspace, so it stops being reported as false STALE. Refused while an open action still references the target. If a module and a project share a name, one call retires one layer — repeat for the next (the reply names what was retired).' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        // RETIRE — the inverse of upsert. The index is the source of truth for what
        // EXISTS, so a deletion must be expressible; otherwise the entry stays mapped
        // forever and nav_status reports permanent false STALE (alarm fatigue erodes
        // the drift signal this plugin exists for).
        if (args.retire) {
          const idx0 = loadIndex(root)
          // Single source of truth for "what is this node" — a fileless feature lives
          // only in a module's membership list, so a forward-only check would call it unknown.
          if (indexEntryKind(idx0, args.target) === null) {
            return `ERROR: nothing to retire for "${args.target}" — not a known feature, module or project.\n  Run nav_query ${args.target} to check the identifier (retire never invents an entry).`
          }
          // Integrity gate: an entry with work in flight must not vanish under it.
          const targetPath = normalizePath(String(args.target))
          // Reconcile first: a lapsed lease is not "work in flight". Reading the raw file let a
          // dead session block retirement until some other tool happened to reconcile the ledger.
          const ledgerNow = loadActions(root)
          reconcileActions(ledgerNow, {})
          const openNow = (ledgerNow.actions || []).filter(a => a.status === 'planned' || a.status === 'in_progress')
          const blocker = openNow.find(a => {
            const sc = a.scope || {}
            return (sc.features || []).includes(args.target)
              || (sc.modules || []).includes(args.target)
              || (sc.files || []).map(normalizePath).includes(targetPath)
          })
          if (blocker) {
            return [
              `ERROR: "${args.target}" is still referenced by open action ${blocker.id} ("${blocker.task}", ${blocker.status}).`,
              `  Close it first — nav_mark id=${blocker.id} action=done (or abort). Retiring an entry under a live action would orphan that action's scope.`
            ].join('\n')
          }
          const r = await mutateIndex(root, (index) => retireEntry(index, args.target))
          if (!r) {
            return `ERROR: "${args.target}" vanished between the check and the retirement — re-run nav_query ${args.target} and retry.`
          }
          if (r.kind === 'feature') {
            return [
              `✓ Retired feature ${args.target}`,
              `  file mappings removed: ${r.files.length}${r.files.length ? ' (' + r.files.join(', ') + ')' : ''}`,
              ...(r.modules.length ? [`  detached from module(s): ${r.modules.join(', ')}`] : [])
            ].join('\n')
          }
          if (r.kind === 'module') {
            return [
              `✓ Retired module ${args.target}`,
              `  project attachments removed: ${r.projects.length ? r.projects.join(', ') : '(none)'}`,
              `  its ${r.features.length} feature(s) survive — they may belong to another module: ${r.features.length ? r.features.join(', ') : '(none)'}`,
              '  (to move a surviving module under another project: nav_update target=<module> project=<project>; project="" detaches it)'
            ].join('\n')
          }
          return [
            `✓ Retired project ${args.target}`,
            `  its ${r.modules.length} module(s) were detached, NOT deleted: ${r.modules.length ? r.modules.join(', ') : '(none)'}`,
            '  ⚠ they now surface as "(unattached modules)" on the map — retire or re-home each one so the map stays truthful.'
          ].join('\n')
        }
        return await mutateIndex(root, (index) => {
        if (index.indexes?.featureToFiles?.[args.target]) {
          if (args.field === 'files') {
            const newList = splitList(args.value).map(normalizePath)
            for (const old of index.indexes.featureToFiles[args.target]) {
              const arr = index.indexes.fileToFeature[old]
              if (arr) index.indexes.fileToFeature[old] = arr.filter(c => c !== args.target)
            }
            index.indexes.featureToFiles[args.target] = newList
            for (const f of newList) {
              if (!index.indexes.fileToFeature[f]) index.indexes.fileToFeature[f] = []
              if (!index.indexes.fileToFeature[f].includes(args.target)) index.indexes.fileToFeature[f].push(args.target)
            }
            return `✓ Feature ${args.target} files replaced: ${newList.length} file(s), mappings rebuilt.`
          }
          if (!args.field || args.value === undefined) return 'ERROR: updating an existing entry requires field + value.'
          if (!index.descriptions) index.descriptions = {}
          index.descriptions[args.target] = index.descriptions[args.target] || {}
          index.descriptions[args.target][args.field] = args.value
          index.descriptions[args.target].lastModified = now_()
          return `✓ Updated feature ${args.target}: ${args.field} = "${args.value}"`
        }
        if (index.indexes?.moduleToFeatures?.[args.target]) {
          const notes = []
          if (args.features !== undefined) {
            index.indexes.moduleToFeatures[args.target] = splitList(args.features)
            notes.push(`feature list replaced (${index.indexes.moduleToFeatures[args.target].length} feature(s))`)
          }
          // Re-home / detach. Module→project attachment used to be write-once (only the create
          // branch accepted project=), so retiring a project left its modules unattached with no
          // way back onto the map — the retire close-out's advice "re-home each one" was
          // unactionable. project= now MOVES the module, and project="" detaches it.
          if (args.project !== undefined) {
            const dest = String(args.project || '').trim()
            if (!index.indexes.projectToModules) index.indexes.projectToModules = {}
            const from = Object.keys(index.indexes.projectToModules)
              .filter(p => (index.indexes.projectToModules[p] || []).includes(args.target))
            for (const p of from) {
              index.indexes.projectToModules[p] = index.indexes.projectToModules[p].filter(m => m !== args.target)
            }
            if (dest) {
              if (!index.indexes.projectToModules[dest]) index.indexes.projectToModules[dest] = []
              if (!index.indexes.projectToModules[dest].includes(args.target)) index.indexes.projectToModules[dest].push(args.target)
              notes.push(from.length ? `re-homed from ${from.join(', ')} to ${dest}` : `attached to project ${dest}`)
            } else {
              notes.push(from.length ? `detached from project ${from.join(', ')} (now unattached)` : 'already unattached')
            }
          }
          if (notes.length) return `✓ Module ${args.target}: ${notes.join('; ')}.`
          if (!args.field || args.value === undefined) return 'ERROR: updating an existing entry requires field + value (or features= for modules).'
          if (!index.moduleMeta) index.moduleMeta = {}
          index.moduleMeta[args.target] = index.moduleMeta[args.target] || {}
          index.moduleMeta[args.target][args.field] = args.value
          index.moduleMeta[args.target].lastModified = now_()
          return `✓ Updated module ${args.target}: ${args.field} = "${args.value}"`
        }
        const wantsModule = args.features !== undefined || args.project !== undefined
        if (wantsModule) {
          const feats = splitList(args.features)
          let attachNote = ''
          if (args.project) {
            const prevOwner = Object.entries(index.indexes.projectToModules || {})
              .find(([proj, mods]) => Array.isArray(mods) && mods.includes(args.target) && proj !== args.project)
            if (prevOwner) attachNote = `\n  ⚠ Module "${args.target}" was already attached to project "${prevOwner[0]}" — it now appears on BOTH projects' maps.`
            if (!index.indexes.projectToModules[args.project]) index.indexes.projectToModules[args.project] = []
            if (!index.indexes.projectToModules[args.project].includes(args.target)) index.indexes.projectToModules[args.project].push(args.target)
          }
          index.indexes.moduleToFeatures[args.target] = feats
          if (!index.moduleMeta) index.moduleMeta = {}
          index.moduleMeta[args.target] = { ...(index.moduleMeta[args.target] || {}), name: args.name || '' }
          return `✓ Module ${args.target} created: ${feats.length} feature(s)` + (args.project ? `, attached to project ${args.project}` : '') + attachNote
        }
        const fileList = splitList(args.files).map(normalizePath)
        index.indexes.featureToFiles[args.target] = fileList
        for (const f of fileList) {
          if (!index.indexes.fileToFeature[f]) index.indexes.fileToFeature[f] = []
          if (!index.indexes.fileToFeature[f].includes(args.target)) index.indexes.fileToFeature[f].push(args.target)
        }
        if (!index.descriptions) index.descriptions = {}
        index.descriptions[args.target] = {
          name: args.name || '',
          userView: args.userView || '',
          systemView: args.systemView || '',
          createdAt: now_()
        }
        return `✓ Feature ${args.target} created with ${fileList.length} file(s)\n  ⚠ Not attached to any module yet — nav_update again with target=<module>, features=<codes>, project=<name> to place it on the map.`
        })
      } catch (e) { return err(e) }
    }
  })), 'project-nav: update')

  // ---- nav_add_feature / nav_add_module / nav_add_doc were merged into nav_update (upsert)
  //      and nav_docs in v0.6.0 — the tool face is 10 tools, not 13. ----

  // ---- 5. nav_docs — reference docs: query AND register in one tool ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_docs',
    description: 'Reference docs in one tool: give title+path+when to REGISTER a document (when = routing rule: which kinds of tasks must consult it); otherwise list the registry, or pass task to rank docs for that task. Read/fetch returned paths yourself.',
    parameters: {
      title: { type: 'string', description: 'REGISTER: document title' },
      path: { type: 'string', description: 'REGISTER: file path, directory, or URL of the doc' },
      when: { type: 'string', description: 'REGISTER: task routing rule keywords/phrases' },
      project: { type: 'string', description: 'REGISTER: project the doc belongs to / QUERY: filter by project code' },
      tags: { type: 'string', description: 'REGISTER: comma-separated tags' },
      task: { type: 'string', description: 'QUERY: task description to rank relevant docs for' },
      tag: { type: 'string', description: 'QUERY: filter by tag' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        if (args.path || args.title || args.when) {
          if (!args.path || !args.title || !args.when) return 'ERROR: registering requires title + path + when (when is the task routing rule).'
          const isUrl = /^https?:\/\//i.test(args.path)
          // Resolve against the GOVERNED ROOT, not process.cwd(): config.root may point at a
          // workspace other than the directory the daemon happens to run in, and a root-relative
          // doc path then failed with a bogus "does not exist".
          const docFile = isUrl ? args.path : (existsSync(args.path) ? args.path : resolve(root, args.path))
          if (!isUrl && !existsSync(docFile)) {
            return `✗ Path does not exist on disk: ${args.path}${docFile === args.path ? '' : ` (also tried ${docFile})`}\n  Doc NOT registered (dead links are rejected).`
          }
          return await mutateDocs(root, (registry) => {
            const dup = (registry.docs || []).find(d => d.path === docFile || d.path === args.path)
            if (dup) return `Doc already registered: ${dup.id} (${dup.path}).`
            const doc = { id: nextDocId(registry), title: args.title, path: docFile, when: args.when, project: args.project || '', tags: splitList(args.tags), addedAt: new Date().toISOString() }
            registry.docs.push(doc)
            return `✓ Registered ${doc.id} "${doc.title}"\n  → ${doc.path}\n  when: ${doc.when}`
          })
        }
        const registry = loadDocs(root)
        let docs = registry.docs || []
        if (args.project) docs = docs.filter(d => d.project === args.project)
        if (args.tag) docs = docs.filter(d => (d.tags || []).includes(args.tag))
        if (docs.length === 0) {
          return 'No reference docs registered. Register one with nav_docs title=... path=... when=... (docs may live anywhere: absolute path, directory or URL).'
        }
        if (args.task) {
          const ranked = suggestDocs(registry, { taskText: args.task, projects: args.project ? [args.project] : [], modules: [] })
            .filter(d => docs.includes(d))
          if (ranked.length) {
            return [`Docs ranked for task "${args.task}":`, ...ranked.map(d => `  ${d.id} ${d.title}\n    → ${d.path}\n    when: ${d.when}`)].join('\n')
          }
        }
        return [`Reference docs (${docs.length}):`, ...docs.map(d => `  ${d.id} ${d.title}${d.project ? ` [${d.project}]` : ''}\n    → ${d.path}\n    when: ${d.when}`)].join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: docs')

  // ---- 6. nav_map — governance map for humans & agents (text tree / HTML mindmap) ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_map',
    description: 'Render the governance map. format=text: indented project→module→feature→file tree (agent orientation). format=html: self-contained progressive-expansion mindmap file written to disk (human view; open actions marked red, vector in header). `target` narrows BOTH renderers to projects/modules whose name matches. Read-only, generated from the index — never hand-edited.',
    parameters: {
      target: { type: 'string', description: 'Narrow the map to projects/modules whose name matches this substring (applies to text and html)' },
      format: { type: 'string', description: 'text (default) or html' }
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        const index = loadIndex(root)
        // Reconcile in memory before rendering (no write from a read-only renderer): an action
        // whose lease lapsed is NOT a live hold, so it must not paint its scope red while
        // nav_status — which does reconcile — reports zero live actions. One truth, two views.
        const ledgerForMap = loadActions(root)
        reconcileActions(ledgerForMap, { sessionId: sidOf(exec), ttlMs: ttlOf(config) })
        const S = scopeTargetsOfOpenActions(ledgerForMap)
        const target = args.target || ''
        if (args.format === 'html') {
          const vector = loadVector(root)
          const safe = String(target || 'workspace').replace(/[^A-Za-z0-9_-]+/g, '_')
          const outPath = resolve(root, '.internal', `map-${safe}.html`)
          const html = renderMapHtml(index, {
            title: `Project Nav Map${target ? ` — ${target}` : ''}`,
            vector, openActions: S, target
          })
          mkdirSync(dirname(outPath), { recursive: true })
          writeFileSync(outPath, html, 'utf-8')
          return `✓ Map generated: ${outPath}\nOpen it in a browser to view the progressive-expansion mindmap. Open actions: ${S.ids.length ? S.ids.join('; ') : 'none'}`
        }
        return renderTreeText(index, { target, openActions: S })
      } catch (e) { return err(e) }
    }
  })), 'project-nav: map')

  // ---- 7. nav_sync_docs — auto-align PROJECT.md feature map from the index ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_sync_docs',
    description: 'Once-Only alignment: regenerate the auto section (between <!-- nav:auto:start/end --> markers) of PROJECT.md from the index. Hand-written narrative outside the markers is never touched. Run after any index change; the marker section must never be hand-edited.',
    parameters: {
      path: { type: 'string', description: 'Target markdown file (default: PROJECT.md at the governed root)' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        // A relative path is resolved against the governed root, not process.cwd() (same rule as nav_docs).
        const relTarget = args.path || ''
        const docPath = relTarget
          ? (existsSync(resolve(relTarget)) ? resolve(relTarget) : resolve(root, relTarget))
          : resolve(root, 'PROJECT.md')
        const index = loadIndex(root)
        const vector = loadVector(root)
        const section = renderProjectDocSection(index, { vector, arch: loadArch(root) })
        // The marker replacement is a read-modify-write of a workspace file: two
        // sessions syncing at once would interleave and corrupt the auto section.
        return await withFileLock(root, 'PROJECT.md', () => {
          let content = ''
          if (existsSync(docPath)) content = readFileSync(docPath, 'utf-8')
          const START = '<!-- nav:auto:start -->'
          const END = '<!-- nav:auto:end -->'
          const s = content.indexOf(START)
          const e = content.indexOf(END)
          if (s !== -1 && e !== -1 && e > s) {
            content = content.slice(0, s) + section + content.slice(e + END.length)
          } else {
            content = (content ? content.replace(/\s*$/, '\n\n') : '') + section + '\n'
          }
          const tmp = docPath + '.tmp'
          writeFileSync(tmp, content, 'utf-8')
          renameSync(tmp, docPath)
          const nProjects = Object.keys(index.indexes?.projectToModules || {}).length
          const nFeatures = Object.keys(index.indexes?.featureToFiles || {}).length
          return `✓ ${docPath} auto-section aligned (source of truth: .internal/nav-index.json)\n  Coverage: ${nProjects} projects, ${nFeatures} features. Narrative content outside markers untouched.`
        })
      } catch (e) { return err(e) }
    }
  })), 'project-nav: sync-docs')

  // ---- 8. nav_status — health + open actions + cross-session concurrency ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_status',
    description: 'Health snapshot: index totals/coverage, mainline vector, cross-session concurrency (who holds which scope), and the OPEN action list — unfinished actions are the project drift signal. Call this before starting any task.',
    parameters: {},
    output: OUTPUT,
    async execute(_args, exec) {
      const sid = sidOf(exec)
      const ttl = ttlOf(config)
      try {
        const index = loadIndex(root)
        const m = index.metadata || {}
        const vector = loadVector(root)
        const { ledger } = await loadActionsReconciled(root, { sessionId: sid, ttlMs: ttl })
        const registry = loadDocs(root)
        const arch = loadArch(root)
        // 架构档新鲜度汇总（ADR-011 接线④）：架构层是核心，健康快照就必须报它——此前 4 档里
        // 过期 2 档而无人知，正是因为「档的状态」不在任何读取面上。
        let archDocStates = []
        try { archDocStates = listArchDocs(root) } catch { archDocStates = [] }
        const staleDocs = archDocStates.filter(d => !d.ok)
        const decisions = arch.decisions || []
        const lastDecision = decisions.length ? decisions[decisions.length - 1] : null
        // The architecture layer is this plugin's core, so the health snapshot has to show it:
        // how many decisions exist, and which anchors sit at/over the repeat-patch threshold.
        const hotAnchors = [...new Set((ledger.actions || []).filter(a => a.status === 'done' && a.anchor).map(a => a.anchor))]
          .map(anchor => ({ anchor, ...repeatPressure(arch, ledger.actions, anchor) }))
          .filter(p => p.count > 0 && p.count >= p.threshold - 1)
        const open = (ledger.actions || []).filter(a => a.status === 'planned' || a.status === 'in_progress')
        const live = open.filter(a => a.status === 'in_progress')
        const queued = open.filter(a => a.status === 'planned')
        const recent = (ledger.actions || []).slice(-5)
        // B1: real disk-drift detection — previously staleEntries/unmappedFiles were dead fields,
        // so files deleted/renamed on disk were invisible. Now actually probe the filesystem.
        let stale = []
        try { stale = findStaleFiles(index, root) } catch { /* drift probe must never break status */ }
        const age = iso => {
          const t = Date.parse(iso || '')
          if (Number.isNaN(t)) return '?'
          const min = Math.round((Date.now() - t) / 60000)
          return min < 1 ? 'just started' : (min < 60 ? `${min}min` : `${Math.floor(min / 60)}h${min % 60}min`)
        }
        const scopeOf = a => [
          (a.scope?.features || []).length ? `features=${a.scope.features.join(',')}` : '',
          (a.scope?.modules || []).length ? `modules=${a.scope.modules.join(',')}` : '',
          (a.scope?.files || []).length ? `files=${a.scope.files.join(',')}` : ''
        ].filter(Boolean).join(' ')
        // Live scope drift: has anything under a running action changed since its begin snapshot?
        const driftNote = a => {
          if (!a.scopeState) return ''
          try {
            const d = verifyScopeFingerprint(root, index, a.scopeState)
            if (d.ok) return ''
            const bits = []
            if (d.changed.length) bits.push('modified: ' + d.changed.join(','))
            if (d.removed.length) bits.push('vanished: ' + d.removed.join(','))
            if (d.added.length) bits.push('appeared: ' + d.added.join(','))
            return '\n    DRIFT since begin -> ' + bits.join(' | ')
          } catch { return '' }
        }
        const concurrency = [
          `Concurrency: ${live.length} live action(s) holding scope locks`,
          ...live.map(a => `  ${actorLabel(a)}\n    running ${age(a.lease?.renewedAt || a.startedAt)}${sid && a.owner?.sessionId === sid ? ' (yours)' : ''} · scope: ${scopeOf(a) || '(empty)'}\n    lease until ${a.lease?.renewedAt ? new Date(Date.parse(a.lease.renewedAt) + (a.lease.ttlMs || ttl)).toISOString() : '(none — will expire on next read)'}` + driftNote(a)),
          ...(queued.length ? [`  queued (planned, holding nothing yet): ${queued.map(a => `${a.id}${a.owner?.label ? ` by ${a.owner.label}` : ''}`).join('; ')}`] : [])
        ]
        const lines = [
          'Project Nav Status',
          `Root: ${root}`,
          `Index age: ${getIndexAge(root) || 'unknown'}`,
          `Coverage: ${m.coverage || 'unknown'}`,
          `Totals: ${m.totalFeatures ?? '?'} features, ${m.totalFiles ?? '?'} files, ${m.totalModules ?? '?'} modules, ${m.totalProjects ?? '?'} projects`,
          '',
          'Mainline Vector:',
          vector.doing ? `  Doing: ${vector.doing}` : '  Doing: (empty)',
          vector.next ? `  Next: ${vector.next}` : '  Next: (empty)',
          vector.notDoing ? `  Not Doing: ${vector.notDoing}` : '',
          vector.exitCondition ? `  Exit: ${vector.exitCondition}` : '',
          '',
          'Concurrency (multi-session):',
          ...concurrency,
          '',
          open.length
            ? `OPEN Actions (${open.length}) — drift signal, finish or abort:\n${open.map(a => `  ${a.id} [${a.status}] ${a.task}${a.owner?.label ? ` — ${a.owner.label}` : ''}`).join('\n')}`
            : 'Open Actions: none',
          stale.length
            ? `STALE Files (${stale.length}) — in index but missing on disk, update or re-register:\n${stale.map(s => `  ${s}`).join('\n')}`
            : 'Stale files: none (index matches disk)',
          `Architecture: ${decisions.length} decision(s)${lastDecision ? `, last ${lastDecision.id} on ${lastDecision.anchor}` : ' (none recorded yet)'}${hotAnchors.length ? ` — ⚠ near/over the repeat-patch gate: ${hotAnchors.map(p => `${p.anchor} ${p.count}/${p.threshold}`).join(', ')}` : ''}`,
          `Reference docs: ${(registry.docs || []).length} registered (nav_docs to list or register)`,
          archDocStates.length
            ? `Arch Docs: ${archDocStates.length} 档（新鲜 ${archDocStates.length - staleDocs.length} / 过期 ${staleDocs.length}）${staleDocs.length ? ' — 重生成后 nav_arch mode="stamp" 刷新: ' + staleDocs.map(d => d.path).join(', ') : ''}`
            : 'Arch Docs: 无（.internal/arch/ 为空 — 建议先出 L1 总览，再谈按指纹重生成）',
          '',
          recent.length ? `Recent actions:\n${recent.map(a => `  ${a.id} [${a.status}] ${a.task}`).join('\n')}` : ''
        ].filter(Boolean)
        return lines.join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: status')

  // ---- 9. nav_set_vector — mainline vector (vector.json is the source of truth) ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_set_vector',
    description: 'Set the mainline navigation vector (doing / next / notDoing / exitCondition). Omitted fields keep current values. Read fresh from disk by every tool call, so changes take effect immediately.',
    parameters: {
      doing: { type: 'string', description: 'Current focus' },
      next: { type: 'string', description: 'Next action' },
      notDoing: { type: 'string', description: 'Explicit anti-goals' },
      exit: { type: 'string', description: 'Completion criteria' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const next = await mutateVector(root, (v) => ({
          doing: args.doing ?? v.doing ?? '',
          next: args.next ?? v.next ?? '',
          notDoing: args.notDoing ?? v.notDoing ?? '',
          exitCondition: args.exit ?? v.exitCondition ?? ''
        }))
        return [
          '✓ Mainline vector updated:',
          `  Doing: ${next.doing}`,
          `  Next: ${next.next}`,
          `  Not Doing: ${next.notDoing}`,
          `  Exit: ${next.exitCondition}`
        ].join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: set-vector')
  // ---- 10. nav_adr — 架构层改动留痕（架构先行协议的第 3 个闸门） ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_adr',
    description: 'Architecture-first protocol: record an architecture decision for one anchor (feature / module / file / arch-doc). Required whenever a task changes the ARCHITECTURE (new module, scope move, interface change) and mandatory once the same anchor has accumulated three patches without one — otherwise local patches keep curing symptoms inside the same dead end. Recording a decision resets that anchor patch counter (the first-principles trigger).',
    parameters: {
      anchor: { type: 'string', required: true, description: 'The architecture node this decision belongs to: feature code, module name, file path, or .internal/arch/*.md doc' },
      reason: { type: 'string', required: true, description: 'Why the architecture must change now (the root need, not the symptom)' },
      decision: { type: 'string', required: true, description: 'What the architecture becomes after this decision' },
      impact: { type: 'string', description: 'Affected features/modules/files or cross-project impact' },
      action: { type: 'string', description: 'Related ledger action id, e.g. ACT-004 (optional)' }
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sid = sidOf(exec)
      try {
        const index = loadIndex(root)
        const chk = checkAnchor(index, root, args.anchor)
        if (!chk.ok) {
          return [
            `ERROR: anchor "${args.anchor}" is not an architecture node (${chk.hint}).`,
            '  Register the node first with nav_update (upsert), or anchor to an arch doc under .internal/arch/ — an unanchored ADR is not traceable.'
          ].join('\n')
        }
        const archBefore = loadArch(root)
        const pressure = repeatPressure(archBefore, (loadActions(root).actions || []), args.anchor)
        // "First decision" must mean FIRST DECISION, not "no patches had piled up":
        // pressure.count === 0 with prior ADRs on this anchor used to print the former.
        const prior = lastDecisionFor(archBefore, args.anchor)
        // Allocate the ADR id INSIDE the lock: two concurrent decisions must not
        // both read ADR-007 and both write ADR-007 (same class of bug as ACT ids).
        const d = await mutateArch(root, (arch) => {
          const decision = {
            id: nextDecisionId(arch),
            anchor: normalizePath(String(args.anchor)),
            anchorKind: chk.kind,
            reason: args.reason,
            decision: args.decision,
            impact: args.impact || '',
            action: args.action || '',
            session: sid || '',
            createdAt: new Date().toISOString()
          }
          arch.decisions.push(decision)
          return decision
        })
        return [
          `✓ ${d.id} recorded for anchor ${d.anchor} (${d.anchorKind})`,
          `  reason:   ${d.reason}`,
          `  decision: ${d.decision}`,
          ...(d.impact ? [`  impact:   ${d.impact}`] : []),
          pressure.count > 0
            ? `  Patch counter reset: ${pressure.count} patch(es) had accumulated on this anchor — those were local fixes; this is the architecture-level answer.`
            : (prior
              ? `  No patches had accumulated since ${prior.id} — recorded deliberately, not forced by the gate.`
              : '  First decision on this anchor.')
        ].join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: adr')

  // ---- 11. nav_arch — 架构文档层：过期管理 / 覆盖校验 / 指纹刷新 ----
  // 架构档（.internal/arch/*.md + 头部 arch-cache 指纹块）是项目的核心维护文档，也是 agent 开发前
  // 的主地图。这个工具把「档在哪、还新鲜吗、覆盖不覆盖这个目标」从手工 mtime 比对变成一次调用；
  // 除 stamp 外全程只读，且从不改写正文（正文 = arch-view 的 L2 读码提炼产出）。
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_arch',
    description: 'Architecture document layer: list = every .internal/arch doc with fingerprint freshness (expiry management) | check = which docs cover one target (feature/module/file) and whether they are fresh | stamp = refresh one doc\'s arch-cache header from its declared file list AFTER you regenerate its content. Read-only except stamp; rendering stays a projection outside the plugin.',
    parameters: {
      mode: { type: 'string', description: 'list (default) | check | stamp' },
      target: { type: 'string', description: 'check mode: feature code / module / file path / arch doc path' },
      path: { type: 'string', description: 'stamp mode: arch doc path, e.g. .internal/arch/project-nav-overview.md' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const mode = String(args.mode || 'list').trim().toLowerCase()
        if (mode === 'stamp') {
          if (!args.path) return 'ERROR: stamp 需要 path=<架构档路径>（如 .internal/arch/project-nav-overview.md）。'
          const rel = normalizePath(String(args.path).trim())
          const res = await withFileLock(root, 'arch-doc:' + rel, () => stampArchDoc(root, rel))
          if (!res.ok) return `ERROR: stamp 失败 —— ${res.reason}`
          return [
            `✓ 指纹已刷新: ${res.path}`,
            `  generated: ${res.generated}`,
            `  files: ${res.files} 项（按档内已声明的列表重取 mtime/size；正文未改动）`,
            ...res.rows.map(r => `    - ${r.path}  ${r.size}B  ${r.mtime}`)
          ].join('\n')
        }
        if (mode === 'check') {
          if (!args.target) return 'ERROR: check 需要 target=<功能码/模块/文件/档路径>。'
          const t = String(args.target).trim()
          let states = []
          try { states = archDocsFor(loadIndex(root), root, t) } catch (e) { return `ERROR: 覆盖判定失败 —— ${e.message}` }
          const stale = states.filter(s => !s.ok)
          const lines = [`架构覆盖检查: ${t}`, '  ' + renderArchPointer(states).replace(/\n\s*/g, '\n  ')]
          if (!states.length) lines.push('  → 无覆盖档：这个目标目前无法从架构层解释——要么补 L1（模块级总览），要么它本身就是架构修订任务。')
          else if (stale.length) lines.push('  → ⛔ 过期/未纳管的档视为设计已漂移，不可当现行事实读：重生成内容 → nav_arch mode="stamp" 刷新指纹，再据此开发。')
          else lines.push('  → 可用：档与它所描述的文件一致，可据此开工。')
          return lines.join('\n')
        }
        if (mode !== 'list') return `ERROR: mode 只支持 list / check / stamp（收到 "${args.mode}"）。`
        const docs = listArchDocs(root)
        if (!docs.length) {
          return '架构档: 0 档（.internal/arch/ 为空）——先出 L1 总览（arch-view 契约：arch-cache 指纹块 + 依赖图 + 索引外告警），此后每档按指纹过期重生成。'
        }
        const fresh = docs.filter(d => d.ok)
        const stale = docs.filter(d => !d.ok)
        const tzDocs = stale.filter(d => d.tzOnly)
        const realStale = stale.filter(d => !d.tzOnly)
        const flagOf = d => (d.ok ? '✓ 新鲜' : (d.noHeader ? '⚠ 无指纹头' : (d.tzOnly ? '⚠ 指纹写法不符' : '⛔ 过期')))
        const fmt = d => [
          `  ${flagOf(d)}  ${d.path}`,
          `      project=${d.project || '?'} · scope=${d.scope || '?'} · generated=${d.generated || '?'} · files=${(d.files || []).length}`,
          ...(d.ok ? [] : ((d.drifted || []).length ? d.drifted.slice(0, 5).map(x => `      漂移: ${x}`) : [`      ${d.reason || ''}`]))
        ].join('\n')
        return [
          `架构档: ${docs.length} 档（新鲜 ${fresh.length} / 过期 ${realStale.length}${tzDocs.length ? ` / 写法不符 ${tzDocs.length}` : ''}）`,
          ...docs.map(fmt),
          ...(tzDocs.length ? ['', '只需校正指纹（内容与代码一致）: ' + tzDocs.map(d => `nav_arch mode="stamp" path="${d.path}"`).join(' | ')] : []),
          ...(realStale.length ? ['', '需重生成内容后再刷新指纹: ' + realStale.map(d => `nav_arch mode="stamp" path="${d.path}"`).join(' | ')] : [])
        ].join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: arch')
}

function now_() {
  return new Date().toISOString()
}
