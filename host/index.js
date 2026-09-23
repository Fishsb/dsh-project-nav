// @dsh-external/project-nav — 从架构出发的项目治理
//
// 核心理念（唯一上位约束）：
//   所有开发动作必须从架构出发。架构不出错，局部问题只是小问题；
//   架构错了，局部补得再好也是在错误骨架上堆砌。
//
// 架构（见 ARCHITECTURE.md）：
//   ① 事件流 .internal/events.jsonl  —— 唯一事实源（append-only）
//   ② 模型   .internal/runtime/…     —— 事件流的折叠（可丢弃，I3）
//   ③ 在场层 —— **零落盘**：治理摘要每轮注入 agent 上下文（0.12.0，接替落盘投影）
//   闸门 = 对模型的查询（七闸，全部在 nav_commit 内）
//
// 工具面 5：nav_graph / nav_commit / nav_decide / nav_node / nav_set

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { resolve } from 'node:path'
import {
  paths, normSlashes, key
} from '../core/paths.js'
import { loadModel, normalizeAnchor, pressureFor, coverage, REPEAT_PATCH_THRESHOLD, foldOnly } from '../core/model.js'
import { appendEvents, verifyLog, readEvents } from '../core/log.js'
import { reconcile, commitIntent, archiveIntent, inflightView, materialize } from '../core/commit.js'
import { locate, resolveScope, evidenceOf } from '../core/scope.js'
import { renderTreeText, vectorFields } from '../core/render.js'
import { listLocks } from '../core/lock.js'
import {
  splitList, parseKv, truncate, renderHealth, renderScopeTarget, renderGaps,
  renderDocs, renderAdrs, renderMap, renderCommitResult, renderImpact, renderPresence
} from '../core/format.js'
export const name = '@dsh-external/project-nav'
// `tools` 是工具注册面；`systemPrompt` 是**在场层**（0.12.0）——治理不再只等被调用，
// 而是每轮组装时把治理摘要注入 agent 上下文。两者都必须显式声明（Cordis 服务注入）。
export const inject = ['tools', 'systemPrompt']

export const Config = z.object({
  root: z.string().default('')
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

  // ================= 工作区边界：已拆除（0.9.2） =================
  // 沙箱模式与审批策略是宿主原生能力（dsh-sandbox-policy 的全局默认 + dsh-permission-presets
  // 的三档预设 + UI 切换入口），本插件不再代宿主切换会话模式，也不再做可执行性探针。
  // 事故事实（v0.8.1 判据错导致永不绑 / v0.8.4 竞态把 fail-safe 变永久惰性）保留在
  // HANDOFF.md 与 docs/ 下的历史档，不再有活代码；依赖面从 ['tools','shell'] 收回 ['tools']。

  // ================= 在场层（0.12.0）：治理不再只等被调用 =================
  //
  // 病根（README §8 · 0.11.0 自述）：七闸只在 nav_commit 内跑 ⇒ **不调用它 = 完全绕行无痕迹**，
  // 治理根登记率仅 3%。根因不是闸门不够，而是治理只在被调用时存在。
  //
  // 落盘投影（PROJECT.md 标记区 / ARCH-MODEL.md / 地图）的唯一读者是人 ⇒ 定案「只服务 agent」
  // 后它们失去理由。其 agent 形态的替代物就是下面的**注入面**：把治理摘要直接放进 agent 上下文。
  //
  // 三条硬约束（缺一即是回退）：
  //  ① 走 foldOnly（纯事件流 5.1ms），**绝不**在组装期跑 buildModel（磁盘扫描 177ms，每轮白付）；
  //  ② **零写盘**（不落 runtime、不建锁、不追加事件）；
  //  ③ **不碰 0.11.0 已否决的观测层**：那里是"订阅并**记录活动事实**"（信息纯可派生、只能落 runtime
  //     ⇒ 违反 I1/I3）。这里是"把**已可派生的**状态**注入上下文**"，不记录、不落盘。
  //     **同一份信息，被消费 ≠ 被存储。**
  const presenceText = () => {
    try {
      return renderPresence(foldOnly(root))
    } catch {
      // 治理绝不能拖垮用户的会话：注入失败即静默降级为"不注入"。
      return ''
    }
  }
  /** 该会话是否在被治理的 root 里工作（不污染无关项目）。 */
  const governsAgent = (agent) => {
    const cwd = agent?.session?.meta?.cwd
    if (!cwd || !root) return true // 拿不到 cwd 时不拦：宁可注入，也不因宿主差异而静默失效
    return normSlashes(String(cwd)).toLowerCase().startsWith(normSlashes(root).toLowerCase())
  }

  if (ctx.systemPrompt?.section) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'project-nav:presence',
      // 与 DEPLOYMENT_PERSONA_SUFFIX 同区：人设之后、工具说明之前，属"部署级常驻指导"。
      order: 10200,
      // ⚠ 必须是**函数**：每轮组装求值（静态串会变成 spawn 期快照，治理状态一改就过期）。
      text: (c) => (c?.agent === undefined ? '' : (governsAgent(c.agent) ? presenceText() : ''))
    }), 'project-nav: presence section')
  } else if (ctx.logger?.warn) {
    ctx.logger.warn('[project-nav] systemPrompt 服务不可用 —— 在场层未装配（治理退化为仅被调用时存在）')
  }

  // ================= 在场层②：**已删除**（2026-09-21，见 ADR-276） =================
  //
  // 0.12.0 初版在此注册 `tools/post-execute`，在写入类工具之后用 `additionalContexts`
  // 注入一份治理摘要。**实测证明那是纯重复**，且它正是真机会话故障的载体：
  //
  //  ① **内容逐字重复**：P1 的 `systemPrompt.section` 的 `text` 是**函数**、**每轮组装都求值**
  //     （dsh-plan-mode 同用法，本仓已机检）。而本处注入调的是**同一个** `presenceText()`
  //     ⇒ 同一份文本每次模型请求已在系统提示里，这里再追加一份等于零新增信息。
  //     实测证据（真实会话日志，2026-09-20 会话 63972fea…）：`system/message` 每轮 1 份，
  //     而 `agent/inbox/spliced` 含同一文本 **24 条**（每次写类工具一条），累计 **~31KB** 纯冗余。
  //     判据 = ARCHITECTURE §2①「零信息重复必删」；在场层输出**按每轮计费**，重复尤其不可接受。
  //
  //  ② **它是崩溃面的唯一载体**：0.12.0 初版漏传 `source` 时，下游 dsh-repeat-tool-reminder 的
  //     `agent/pre-step` 无保护地读 `message.source.kind` ⇒ TypeError ⇒ 整轮
  //     `turn/end {kind:'error'}`（界面："Cannot read properties of undefined (reading 'kind')"）。
  //     ⚠ 关键结构事实：**P1 从不创建消息**（它只往系统提示里放一段文本）
  //     ⇒ 删掉 P2 之后，本插件**结构上不再有**这条故障路径 —— 不是"改对了"，是"该路径不存在了"。
  //     这比"补上 source"更强：补 source 是修好一个可能再次写错的点；删掉它则让整类错误无处发生。
  //
  // ③ **不做成"换个时机再注入"**：任何 `additionalContexts` 注入都回到同一个承重字段问题，
  //     而系统提示每轮已带最新治理 —— 再注入一次的收益恒为 0。
  //
  // ⇒ 治理在场收敛为**唯一一路**：`systemPrompt.section`（上面 P1）。
  //   机检守卫见 test/host.test.mjs「在场层只有一条注入路径」。

  // ---- 1. nav_graph — 读：模型查询 ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_graph',
    description: 'Query the architecture model (folded from the single-source event log). Read-only. Modes in `mode` below; text output is complete-by-default — anything condensed is marked "+N" with its full retrieval path, and mode=json is that path.',
    parameters: {
      mode: { type: 'string', description: 'task (default; expand a target) | impact | gaps | coverage | docs | adrs | map | health | json' },
      target: { type: 'string', description: 'task/impact/map: file / feature code / module / project; docs: task text to rank; adrs: anchor' },
      format: { type: 'string', description: 'text (default) | json (structured view matching the mode; matching mode=json returns the full model snapshot)' }
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
            out.push('')
            out.push(`影响面: nav_graph mode=impact target=${loc.kind === 'file' ? loc.file : loc.node?.name}`)
            const open = model.openCommits.filter((c) => (c.files || []).some((f) => files.includes(f)))
            if (open.length) { out.push(''); for (const c of open) out.push(`🔴 在途: ${c.id} ${c.task}（${c.actor ? `by ${String(c.actor).slice(0, 8)}，全文 = mode=json` : 'actor=?'}）`) }
            const pressure = model.patchPressure.get(key(loc.kind === 'file' ? loc.file : loc.node?.id))
            if (pressure && pressure.sinceDecisionCount >= 2) out.push(`⚠ 计数闸: ${pressure.anchor} ${pressure.sinceDecisionCount}/${REPEAT_PATCH_THRESHOLD}`)
            out.push('')
            out.push('下一步: 改前先 nav_commit（锚点 + scope + arch= 一句话），它跑七闸。')
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
        if (mode === 'impact') {
          const loc = locate(root, model, args.target)
          if (loc.kind === 'empty' || loc.kind === 'unknown') {
            return `No mapping found for "${args.target}" — 影响面要先有落点登记（nav_node target=<功能码> files=…）。`
          }
          return renderImpact(model, loc)
        }
        if (mode === 'map') return renderMap(model, { target: args.target || '' })
        if (mode === 'json') return j(snapshotOf(model, root, lastReconcile, 'json'))
        return renderHealth(model, { rootPath: root, opens: model.openCommits, inflight: inflightView(root), locks: listLocks(root), logCheck: verifyLog(root) })
      } catch (e) { return err(e) }
    }
  })), 'project-nav: nav_graph')

  // ---- 2. nav_commit — 写：登记改动意图（自动对账 + 七闸） ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_commit',
    description: 'Record a change intent BEFORE touching anything: anchor (architecture node) + scope + a one-line architecture reflection (arch=). Runs the seven gates. Closure needs no second call: when the scope evidence changes, the next tool call on any session closes it automatically (evidence-based, session-independent). mode=archive voids a stale intent explicitly.',
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
        const text = renderCommitResult(res, model)
        if (res.status === 'ok' && files.length) {
          return `${text}\n\n若这属于架构级改动，记得 nav_decide。`
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
    description: 'Create-or-update an architecture node (upsert), register a reference-doc artifact, or retire a node with cascade. Existing target = field update; absent target + creation fields = create. Arbitrary fields via set=k=v pairs.',
    parameters: {
      target: { type: 'string', description: 'Feature code / module name / project name / artifact id' },
      layer: { type: 'string', description: 'project | module | feature | artifact' },
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
      retire: { type: 'boolean', description: 'RETIRE with cascade (what gets dropped is reported in the result; nothing else is deleted). Refused while an in-flight commit references the target.' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
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
          // ⚠ 事件里的 id 必须是**该节点被写入时的裸标识**，不能写模型全 id：
          // 折叠时 ensure() 会再拼一次 `${layer}:${key(id)}`，写全 id 就成了
          // "retire of unknown …" 被丢弃，而工具却报成功（假绿）。
          // 可靠取法：模型节点 id **就是** `${layer}:${key(写入时的 id)}`，字面切掉前缀即可；
          // 若写入时用的是带前缀的 id（历史数据），回填会还原成同一形态。
          // 注意不能用 key() 折叠后的值去比对大小写敏感的登记名 —— 一律过 key()。
          const bareId = hit.id.slice(hit.layer.length + 1)
          const ref = model.openCommits.find((c) => (c.scope?.features || []).map(key).includes(key(bareId))
            || (c.scope?.modules || []).map(key).includes(key(bareId))
            || (c.files || []).map(key).includes(key(bareId)))
          if (ref) return `ERROR: "${hit.name}" 仍被在途改动 ${ref.id}（${ref.task}）引用。\n  改完文件后它会按证据自动收口；或 nav_commit mode=archive id=${ref.id} 归档后再 retired。`
          const [w] = await appendEvents(root, [{ kind: 'node', op: 'retire', layer: hit.layer, id: bareId }])
          const after = loadModel(root)
          const gone = after.nodes.get(hit.id)
          if (!gone || gone.status !== 'retired') {
            const allProblems = after.log || []
            const why = allProblems.slice(-3).map((p) => `    · seq=${p.seq ?? '?'} ${p.problem}${allProblems.length > 3 ? `（共 ${allProblems.length} 条，全量 = .internal/events.jsonl）` : ''}`).join('\n')
            return [`ERROR: 退役未生效 —— ${hit.layer} "${hit.name}" 仍是 ${gone ? gone.status : '缺失'}（事件 seq ${w.seq} 已写入）。`,
              '  模型自检报告:', why || '    · (无)', '  这是 bug，不是数据问题：请报告 host/index.js 的 nav_node retire 分支。'].join('\n')
          }
          const casc = hit.layer === 'feature' ? `文件映射 ${(hit.files || []).length} 条随之消失${hit.module ? `，从模块 ${hit.module} 摘除` : ''}`
            : hit.layer === 'module' ? `项目归属 ${hit.project || '(none)'} 摘除；其 ${(hit.features || []).length} 个功能存活（失去模块）`
              : `其模块被摘除而非删除（变为 unattached，会在导航树里暴露出来）`
          return [`✓ 已退役 ${hit.layer} ${hit.name}（事件 seq ${w.seq}，状态已核验 = retired）`, `  级联: ${casc}`, `  现在 active 节点 ${[...after.nodes.values()].filter((n) => n.status === 'active').length} 个。`, '  退役语义保留是 F3/F8 的要求：能删才不会永远留假 STALE。'].join('\n')
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
          L.push(`  落点: ${(now.files || []).length} 文件${(now.files || []).length ? ` (${now.files.slice(0, 5).join(', ')}${now.files.length > 5 ? `…+${now.files.length - 5}，全量 = nav_graph mode=json` : ''})` : ''}`)
          const unreg = (now.files || []).filter((f) => before.stale.some((s) => s.file === f))
          if (unreg.length) L.push(`  ⚠ 这些落点在磁盘上不存在（会算作 STALE）: ${unreg.join(', ')}`)
          if (now.module) L.push(`  模块: ${now.module}`)
        }
        if (layer === 'module' && now.project) L.push(`  项目: ${now.project}`)
        L.push('')
        L.push('下一步: 改完文件后下一次任意工具调用会按证据自动收口；治理摘要已常驻你的上下文。')
        return L.join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: nav_node')

  // ---- 5. nav_set — 写：根元数据 / 主线向量 ----
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
        const vf = vectorFields(vector)
        return [
          `✓ 主线向量已更新（事件 seq ${w.seq}）`,
          `  doing: ${vf.doing}`,
          `  next: ${vf.next}`,
          `  notDoing: ${vf.notDoing}`,
          `  exitCondition: ${vf.exitCondition}`,
          changed.length ? '' : '  (无字段变化)',
          changed.length ? '下一步: 向量已变更，下一次任意工具调用即按新向量治理（无需额外的渲染动作）。' : ''
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

// ---- nav_graph 的 JSON 快照：与所读 mode 一一对应（不是"另一种全量"）。
// ⚠ 这里刻意不放体积上限：上限会静默吞条目，是丢信息的路。
// 少展示必须可见（"+N" + 取回路径）；mode=json 显式要全量，就真给全量。
function healthSnapshot(model, rootPath, rec) {
  return {
    root: rootPath,
    builtAt: model.builtAt,
    events: model.eventCount,
    vector: {
      doing: model.vector?.doing || '', next: model.vector?.next || '',
      notDoing: model.vector?.notDoing || '', exitCondition: model.vector?.exitCondition || ''
    },
    coverage: coverage(model),
    // ---- 全量节点清单（0.12.0）----
    // 接替被删除的 ARCH-MODEL.md 节点表：那是落盘投影时代**唯一**的"一次拿全节点"出口，
    // 删掉它而不补这里 ⇒ agent 只能逐个 nav_graph <target> 猜（可观测性倒退）。
    // 刻意不 slice：少展示必须可见且可取回（ARCHITECTURE §2②）；退役节点**在列**（标灰不消失）。
    nodes: [...model.nodes.values()].map((n) => ({
      id: n.id, layer: n.layer, name: n.name, status: n.status,
      project: n.project || null, module: n.module || null,
      files: n.files || [], when: n.when || '', updatedAt: n.updatedAt || null
    })),
    openCommits: model.openCommits.map((c) => ({ id: c.id, task: c.task, anchor: c.anchor, files: c.files || [], at: c.at, plan: c.plan || '' })),
    // ---- 改动流水（0.12.0）----
    // 接替被删除的 renderModelDoc 收口表 —— 那是 **PN-S1/E3「唯一持久出口」**（README §8）。
    // ⚠ 折叠语义（**实测**，core/model.js:121-141）：收口时**原 open 笔被就地标 closed 并挂 `closes` = 自己的 seq**；
    // 而收口回执是**另一条 commit**（phase=closed，`closes` 为 undefined，`plan` 结构性为空串）。
    // 故：
    //   · `closes === seq` ⇒ 载有原始意图的笔（`plan` 就留在它身上，折叠不会覆盖）
    //   · `closes === undefined && phase==='closed'` ⇒ 回执，或 0.9 迁移来的历史已完成记录
    // ⚠ 不要用"回查 `closes` 指向的原始笔"来取 plan：`closes` 只写在**原笔自己**身上，
    // 那个"回查"恒等于取自己（0.12.0 实测：治理根 21 条带 closes 的记录里，`closes !== seq` 者 **0 条**）。
    // 旧版 renderModelDoc 的同名回查同属 no-op —— 值对、注释错。这里直取 `c.plan` 并把真相写明白。
    //
    // 本视图**不丢条目**（I1：真相可复算）；回执也保留，仅带 `receipt` 标记供消费方过滤。
    commits: model.commits.map((c) => ({
      id: `ACT-${c.seq}`, seq: c.seq, at: c.at, phase: c.phase || 'open',
      closes: c.closes ?? null,
      receipt: (c.phase === 'closed') && c.closes === undefined,
      closedIntent: c.closes !== undefined && c.closes === c.seq,
      anchor: c.anchor, task: c.task,
      plan: c.plan || '',
      files: c.files || [], scope: c.scope || null, arch: c.arch ?? null,
      outcome: c.outcome || null
    })),
    stale: model.stale,
    unregistered: model.unregistered,
    decisions: model.decisions.map((d) => ({ id: d.id, anchor: d.anchor, at: d.at, reason: d.reason, decision: d.decision, impact: d.impact || '' })),
    pressure: [...model.patchPressure.values()].filter((p) => p.sinceDecisionCount >= 1),
    lastReconcile: { closed: rec.closed.map((c) => c.commit.id), stillOpen: rec.stillOpen.map((c) => c.id) },
    logProblems: model.log
  }
}

function snapshotOf(model, rootPath, rec, mode, target) {
  const base = { mode, target: target || null, events: model.eventCount }
  switch (mode) {
    case 'coverage': return { ...base, coverage: coverage(model), staleCount: model.stale.length };
    case 'gaps': return { ...base, unregistered: model.unregistered, stale: model.stale };
    case 'adrs': return { ...base, total: model.decisions.length, decisions: model.decisions.map((d) => ({ id: d.id, anchor: d.anchor, at: d.at, reason: d.reason, decision: d.decision, impact: d.impact || '' })) };
    case 'docs': return { ...base, artifacts: [...model.nodes.values()].filter((n) => n.layer === 'artifact' && n.status === 'active').map((a) => ({ id: a.id, name: a.name, path: a.path, when: a.when || '', tags: a.tags || [] })) };
    case 'impact': {
      const loc = locate(rootPath, model, target);
      const files = loc.kind === 'file' ? [loc.file] : (loc.node?.files || []);
      const inside = new Set(files.map(key));
      const outbound = {}; const inbound = {};
      for (const f of files) {
        const tos = (model.edges.fileEdges.get(normSlashes(f)) || []).filter((t) => !inside.has(key(t)));
        if (tos.length) outbound[f] = tos;
      }
      for (const [from, tos] of model.edges.fileEdges) {
        const hits = tos.filter((t) => inside.has(key(t)));
        if (hits.length) inbound[normSlashes(from)] = hits;
      }
      return { ...base, kind: loc.kind, name: loc.kind === 'file' ? loc.file : loc.node?.name, outbound, inbound };
    }
    case 'task': {
      const loc = locate(rootPath, model, target);
      if (loc.kind === 'unknown' || loc.kind === 'empty') return { ...base, kind: loc.kind, view: null };
      return { ...base, kind: loc.kind, view: loc.kind === 'file' ? { file: loc.file, owners: loc.owners } : { id: loc.node?.id, name: loc.node?.name, status: loc.node?.status, files: loc.node?.files || [], module: loc.node?.module || null, project: loc.node?.project || null } };
    }
    default: return { ...healthSnapshot(model, rootPath, rec), mode, target: target || null };
  }
}
