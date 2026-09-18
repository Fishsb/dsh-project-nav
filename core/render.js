// core/render.js — 渲染投影（I2）
//
// 一切产出都是**模型的重渲染**，零手写：
//   PROJECT.md 标记区 · 模型文档（ARCH-MODEL.md）· 地图 text/html
// 手改渲染物 => 下一次渲染覆盖它（这就是 I2 的验法，不是靠"人别改"）。
//
// ⚠ 架构档（.internal/arch/*.md）**不再是本文件的事**：按 ARCHITECTURE §2，它已从
// "要维护的资产（sha1 指纹 + 新鲜度机检 + 行号重锚）"降级为**按需临时投影**。
// 需要把架构档纳入路由时，把它登记成普通的 artifact 节点（nav_node layer=artifact when=…），
// 用 nav_graph mode=docs 按任务检索 —— 复用已有机制，不新增一套指纹契约。

import { readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { normSlashes, key, paths } from './paths.js'
import { coverage, moduleBelongsTo } from './model.js'
import { rewriteVerified } from './log.js'

export const MARK_START = '<!-- nav:auto:start -->'
export const MARK_END = '<!-- nav:auto:end -->'

function truncate(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 收口表里的「查证申报」单元格 —— PN-S1/E3。
 *
 * 与 `core/format.js` 的 `planBrief` 同形。此处**刻意重复 3 行**而不抽公共模块：
 * 依赖方向是 `format → render`（`core/format.js:7`），render 反向 import format 会成环。
 * 抽公共模块则要新增文件 = 架构变更（ARCHITECTURE §9）—— 为 3 行付这个代价不值得。
 */
function planCell(plan, n = 60) {
  const s = String(plan ?? '').trim()
  if (!s) return '(未填)'
  const segs = s.split(/[；;\n]+/).filter((x) => x.trim()).length
  return `${truncate(s, n)}（${segs} 段）`
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function cell(s) {
  const t = String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
  return t === '' ? '—' : t
}

/** 项目 -> 模块 -> 功能 -> 文件 的缩进树（agent 导航）。 */
export function renderTreeText(model, { target = '', openActions = null } = {}) {
  const t = key(target)
  const match = (s) => !t || key(s).includes(t)
  const lines = []
  const cv = coverage(model)
  lines.push(`Mainline: doing=${model.vector?.doing || '(unset)'} | next=${model.vector?.next || '(unset)'}`)
  if (model.vector?.notDoing) lines.push(`Anti-goal (notDoing): ${model.vector.notDoing}`)
  lines.push(`Totals: ${cv.projects} project(s), ${cv.modules} module(s), ${cv.features} feature(s), ${cv.registeredFiles} file(s) mapped, ${cv.unregisteredFiles} unregistered, ${cv.retired} retired`)
  const openByFile = new Map()
  for (const c of model.openCommits) for (const f of c.files || []) openByFile.set(key(f), c.id)

  const projects = [...model.nodes.values()].filter((n) => n.layer === 'project' && n.status === 'active').sort((a, b) => a.name.localeCompare(b.name))
  const orphans = [...model.nodes.values()].filter((n) => n.layer === 'module' && n.status === 'active' && !n.project)

  for (const p of projects) {
    if (!match(p.name)) continue
    lines.push(`\n■ ${p.name}${p.meta?.path ? ` — ${p.meta.path}` : ''}`)
    const mods = [...model.nodes.values()].filter((n) => n.layer === 'module' && n.status === 'active' && moduleBelongsTo(n, p)).sort((a, b) => a.name.localeCompare(b.name))
    for (const m of mods) lines.push(...renderModule(model, m, match, openByFile, '  '))
  }
  for (const m of orphans) {
    if (!match(m.name)) continue
    lines.push(`\n◇ (unattached) ${m.name}`)
    lines.push(...renderModule(model, m, match, openByFile, '  '))
  }
  const loose = [...model.nodes.values()].filter((n) => n.layer === 'feature' && n.status === 'active' && !n.module)
  const looseShown = loose.filter((f) => match(f.name))
  if (looseShown.length) {
    lines.push(`\n◇ 未挂模块的功能 (${looseShown.length})`)
    for (const f of looseShown) lines.push(`  ○ ${f.name}${f.meta?.name ? ` — ${f.meta.name}` : ''}  [${(f.files || []).length} file(s)]`)
  }
  const arts = [...model.nodes.values()].filter((n) => n.layer === 'artifact' && n.status === 'active')
  if (arts.length && !t) lines.push(`\n◇ 参考文档工件 ${arts.length} 项（nav_graph mode=docs 看路由规则）`)
  if (!lines.some((l) => l.startsWith('■') || l.startsWith('◇ (unattached)'))) lines.push('\n(no match)')
  return lines.join('\n')
}

function renderModule(model, m, match, openByFile, indent) {
  const lines = []
  const feats = (m.features || []).map((c) => model.nodes.get(`feature:${key(c)}`)).filter(Boolean).filter((f) => f.status === 'active')
  lines.push(`${indent}▸ ${m.name}${m.meta?.name ? ` — ${m.meta.name}` : ''}  [${feats.length} feature(s)${m.meta?.status ? `, ${m.meta.status}` : ''}]`)
  if (!feats.length) lines.push(`${indent}  (no features registered)`)
  for (const f of feats) {
    lines.push(`${indent}  ○ ${f.name}${f.meta?.name ? ` — ${f.meta.name}` : ''}${f.meta?.userView ? `\n${indent}      用户视角: ${truncate(f.meta.userView, 100)}` : ''}`)
    for (const file of (f.files || []).slice(0, 12)) {
      const open = openByFile.get(key(file))
      lines.push(`${indent}      · ${file}${open ? `   🔴 ${open} 在途` : ''}`)
    }
    if ((f.files || []).length > 12) lines.push(`${indent}      · …(+${f.files.length - 12}，全量 = nav_graph mode=task target=${f.name})`)
  }
  return lines
}

/** 自包含离线 HTML 思维导图（人看）。 */
export function renderMapHtml(model, { title = 'Project Nav Map', target = '' } = {}) {
  const cv = coverage(model)
  const t = key(target)
  const match = (s) => !t || key(s).includes(t)
  const openByFile = new Map()
  for (const c of model.openCommits) for (const f of c.files || []) openByFile.set(key(f), c.id)
  const parts = []
  parts.push('<!doctype html><html lang="zh"><head><meta charset="utf-8">')
  parts.push(`<title>${esc(title)}</title>`)
  parts.push('<style>body{font:14px/1.6 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;margin:24px;color:#1f2328;background:#fff}details{margin:2px 0 2px 14px}summary{cursor:pointer}code{background:#f6f8fa;padding:1px 4px;border-radius:3px}.meta{color:#59636e;font-size:12px}.open{color:#b62324;font-weight:600}h1{font-size:20px}h2{font-size:16px}.hint{background:#f6f8fa;border-left:3px solid #8b949e;padding:8px 12px;margin:12px 0;font-size:13px}</style></head><body>')
  parts.push(`<h1>${esc(title)}</h1>`)
  parts.push('<div class="hint"><b>怎么读这张图</b>：■ 项目 -> ▸ 模块 -> ○ 功能 -> · 文件。🔴 表示该文件正被一笔在途改动占用。本图由 <code>nav_render</code> 从事件流折叠出的架构模型生成，<b>永不手改</b>（改了下一次渲染就覆盖）。</div>')
  parts.push(`<h2>主线</h2><div>doing: <b>${esc(model.vector?.doing || '(unset)')}</b><br>next: ${esc(model.vector?.next || '(unset)')}${model.vector?.notDoing ? `<br>anti-goal: ${esc(model.vector.notDoing)}` : ''}</div>`)
  parts.push(`<h2>总览</h2><div>${cv.projects} 项目 · ${cv.modules} 模块 · ${cv.features} 功能 · ${cv.registeredFiles} 登记文件 · ${cv.unregisteredFiles} 未登记 · ${cv.retired} 已退役 · ${model.openCommits.length} 在途</div>`)
  if (model.openCommits.length) {
    parts.push('<h2>在途改动</h2><ul>')
    for (const c of model.openCommits) parts.push(`<li class="open">${esc(c.id)} ${esc(c.task)} <span class="meta">anchor=${esc(c.anchor)} · ${(c.files || []).length} 文件</span></li>`)
    parts.push('</ul>')
  }
  if (model.decisions.length) {
    parts.push(`<h2>架构决策（${model.decisions.length} 条，全部）</h2><ul>`)
    for (const d of [...model.decisions].reverse()) parts.push(`<li>${esc(d.id)} <code>${esc(d.anchor)}</code> ${esc(truncate(d.decision, 110))}</li>`)
    parts.push('</ul>')
  }
  parts.push('<h2>架构地图</h2>')
  const projects = [...model.nodes.values()].filter((n) => n.layer === 'project' && n.status === 'active').sort((a, b) => a.name.localeCompare(b.name))
  for (const p of projects) {
    if (!match(p.name)) continue
    parts.push(`<details open><summary>■ <b>${esc(p.name)}</b> <span class="meta">${esc(p.meta?.path || '')}</span></summary>`)
    const mods = [...model.nodes.values()].filter((n) => n.layer === 'module' && n.status === 'active' && moduleBelongsTo(n, p)).sort((a, b) => a.name.localeCompare(b.name))
    for (const m of mods) {
      parts.push(`<details><summary>▸ <b>${esc(m.name)}</b> <span class="meta">${esc(m.meta?.name || '')}</span></summary>`)
      const feats = (m.features || []).map((c) => model.nodes.get(`feature:${key(c)}`)).filter((f) => f && f.status === 'active')
      for (const f of feats) {
        parts.push(`<details><summary>○ <b>${esc(f.name)}</b> <span class="meta">${esc(f.meta?.name || '')}</span></summary>`)
        if (f.meta?.userView) parts.push(`<div class="meta">用户视角: ${esc(f.meta.userView)}</div>`)
        if (f.meta?.systemView) parts.push(`<div class="meta">系统视角: ${esc(f.meta.systemView)}</div>`)
        parts.push('<ul>')
        for (const file of f.files || []) {
          const open = openByFile.get(key(file))
          parts.push(`<li><code>${esc(file)}</code>${open ? ` <span class="open">🔴 ${esc(open)} 在途</span>` : ''}</li>`)
        }
        if (!(f.files || []).length) parts.push('<li class="meta">待登记（nav_node target=&lt;功能码&gt; set=files=…）</li>')
        parts.push('</ul></details>')
      }
      if (!feats.length) parts.push('<div class="meta">(no features registered)</div>')
      parts.push('</details>')
    }
    parts.push('</details>')
  }
  parts.push(`<p class="meta">events=${model.eventCount} · 唯一事实源 = .internal/events.jsonl（本图由其重渲染，同模型必同字节）</p>`)
  parts.push('</body></html>')
  return parts.join('\n')
}

// ---- 投影：模型文档（人类可读的模型快照，供 git diff 审查） ----

export function renderModelDoc(model, { rootPath = '' } = {}) {
  const cv = coverage(model)
  const L = []
  L.push('# ARCH-MODEL — 架构模型快照')
  L.push('')
  L.push('> **本文件由 `nav_render` 生成，永不手写**（I2）。真相是 `.internal/events.jsonl`（append-only）；')
  L.push('> 本文件是它的折叠投影，供人阅读与 `git diff` 审查。删除 `.internal/runtime/` 后本文件仍可由事件流重建。')
  L.push('')
  L.push(`事件数：${model.eventCount}（确定性渲染：模型不变 ⇒ 字节不变 ⇒ 无噪声 diff）`)
  L.push('')
  L.push('## 主线向量')
  L.push('')
  L.push('| doing | next | notDoing | exitCondition |')
  L.push('|---|---|---|---|')
  L.push(`| ${cell(model.vector?.doing)} | ${cell(model.vector?.next)} | ${cell(model.vector?.notDoing)} | ${cell(model.vector?.exitCondition)} |`)
  L.push('')
  L.push('## 覆盖度')
  L.push('')
  L.push(`- 项目 ${cv.projects} · 模块 ${cv.modules} · 功能 ${cv.features} · 文档工件 ${cv.artifacts}`)
  L.push(`- 登记文件 ${cv.registeredFiles} · 未登记文件 ${cv.unregisteredFiles} · 已退役 ${cv.retired}`)
  L.push(`- 在途改动 ${model.openCommits.length} · 架构决策 ${model.decisions.length}`)
  L.push('')
  L.push('## 节点')
  L.push('')
  L.push('| 层 | id | 名称 | 归属 | 落点 | 证据 |')
  L.push('|---|---|---|---|---|---|')
  for (const n of [...model.nodes.values()].sort((a, b) => (a.layer === b.layer ? a.name.localeCompare(b.name) : a.layer.localeCompare(b.layer)))) {
    const parent = n.layer === 'module' ? n.project : n.layer === 'feature' ? n.module : n.layer === 'artifact' ? n.project : ''
    const files = (n.files || []).length ? `${n.files.length} 文件` : n.path ? `\`${n.path}\`` : '—'
    L.push(`| ${n.layer} | \`${n.id}\` | ${cell(n.name)}${n.status === 'retired' ? ' **(退役)**' : ''} | ${cell(parent)} | ${files} | ${n.layer === 'artifact' ? 'when=' + cell(truncate(n.when, 60)) : (n.updatedAt || '—')} |`)
  }
  L.push('')
  if (model.decisions.length) {
    L.push(`## 架构决策索引（ADR · 全部 ${model.decisions.length} 条，一条不列漏）`)
    L.push('')
    L.push('| ADR · id · 锚点 | 时间 | 架构变成什么（一句话） |')
    L.push('|---|---|---|')
    for (const d of model.decisions) {
      L.push(`| ADR · \`${d.id}\` · \`${d.anchor}\` | ${d.at.slice(0, 10)} | ${cell(truncate(d.decision, 120))} |`)
    }
    L.push('')
    L.push('*索引有意压扁了 reason / impact（是压缩不是丢条目）：单条决策的完整四字段走 `nav_graph mode=adrs anchor=<锚点>`，或在事件流 grep 该 ADR id。*')
    L.push('')
  }
  const open = model.openCommits
  if (open.length) {
    L.push('## 在途改动（按证据收口，与会话无关）')
    L.push('')
    for (const c of open) {
      L.push(`- **${c.id}** ${cell(c.task)} · anchor=\`${c.anchor}\` · ${(c.files || []).length} 文件 · at ${c.at}`)
    }
    L.push('')
  }
  const closed = model.commits.filter((c) => c.closes !== undefined).slice(-10).reverse()
  if (closed.length) {
    L.push(`## 最近的收口（共 ${model.commits.filter((c) => c.closes !== undefined).length} 笔，此处最近 10；全量在事件流，结构化取回 = \`nav_graph mode=json\`）`)
    L.push('')
    L.push('| id | 任务 | 锚点 | 收口依据 | 时间 | 查证申报 |')
    L.push('|---|---|---|---|---|---|')
    for (const c of closed) {
      const src = model.commits.find((x) => x.seq === c.closes)
      const o = src?.outcome || {}
      const bits = []
      if (o.evidence === 'archived') bits.push(`显式归档：${truncate(o.reason, 60)}`)
      else {
        if (o.modified?.length) bits.push(`改 ${o.modified.length}`)
        if (o.appeared?.length) bits.push(`新增 ${o.appeared.length}`)
        if (o.vanished?.length) bits.push(`消失 ${o.vanished.length}`)
        if (!bits.length) bits.push('证据变化')
      }
      // 申报取自**原始 open 笔**（src，:207 经 closes 回查）：闭笔事件结构性带 plan:''
      // （core/commit.js:111 对账收口 / :186 显式归档），照抄 c.plan 会得到"永远空白"的假绿。
      L.push(`| ${src ? src.id : `ACT-${c.closes}`} | ${cell(truncate(src?.task, 70))} | \`${cell(src?.anchor)}\` | ${bits.join(' / ')} | ${c.at.slice(0, 19).replace('T', ' ')} | ${cell(planCell(src?.plan))} |`)
    }
    L.push('')
  }
  if (model.stale.length) {
    L.push('## STALE 落点（登记了但磁盘上没有）')
    L.push('')
    for (const s of model.stale) L.push(`- \`${s.file}\` <- ${s.node}`)
    L.push('')
  }
  if (model.log.length) {
    L.push('## 模型自身的问题（不吞）')
    L.push('')
    for (const p of model.log) L.push(`- seq=${p.seq ?? '?'} :: ${p.problem}`)
    L.push('')
  }
  L.push('---')
  L.push('')
  L.push('*渲染物。手改即被下一次 `nav_render` 覆盖。*')
  return L.join('\n')
}

// ---- 投影：PROJECT.md 标记区 ----

/** 生成 PROJECT.md 的自动区（标记之间），标记外零触碰。 */
export function renderProjectSection(model) {
  const cv = coverage(model)
  const L = []
  L.push('## 项目地图（自动区 · 由 nav_render 从事件流生成，勿手改）')
  L.push('')
  L.push(`**主线**：doing = ${cell(model.vector?.doing)} ｜ next = ${cell(model.vector?.next)}`)
  if (model.vector?.notDoing) L.push(`**反目标（notDoing）**：${cell(model.vector.notDoing)}`)
  if (model.vector?.exitCondition) L.push(`**完成判据**：${cell(model.vector.exitCondition)}`)
  L.push('')
  L.push(`**覆盖度**：${cv.projects} 项目 · ${cv.modules} 模块 · ${cv.features} 功能 · ${cv.registeredFiles} 登记文件 · ${cv.unregisteredFiles} 未登记 · ${cv.retired} 已退役`)
  L.push('')
  const projects = [...model.nodes.values()].filter((n) => n.layer === 'project' && n.status === 'active').sort((a, b) => a.name.localeCompare(b.name))
  for (const p of projects) {
    // 归属从模块自身的 project 推导（不读注册时的快照）—— 否则"模块挂上了、地图上看不到"
    const mods = [...model.nodes.values()].filter((n) => n.layer === 'module' && n.status === 'active' && moduleBelongsTo(n, p))
    L.push(`### ${p.name}${p.meta?.path ? ` — \`${p.meta.path}\`` : ''}`)
    L.push('')
    for (const m of mods) {
      const feats = (m.features || []).map((c) => model.nodes.get(`feature:${key(c)}`)).filter((f) => f && f.status === 'active')
      L.push(`- **${m.name}**${m.meta?.name ? ` — ${m.meta.name}` : ''}（${feats.length} 功能）`)
      for (const f of feats) {
        const files = (f.files || []).length ? ` — ${(f.files || []).slice(0, 4).map((x) => `\`${x}\``).join('、')}${f.files.length > 4 ? ` 等 ${f.files.length} 个` : ''}` : ' — *待登记落点*'
        L.push(`  - \`${f.name}\`${f.meta?.name ? ` ${f.meta.name}` : ''}${files}`)
      }
    }
    if (!mods.length) L.push('- *(无模块)*')
    L.push('')
  }
  if (model.decisions.length) {
    L.push(`### 架构决策（ADR · 全部 ${model.decisions.length} 条，一条不列漏）`)
    L.push('')
    L.push('| id | 锚点 | 决策 | 时间 |')
    L.push('|---|---|---|---|')
    for (const d of model.decisions.slice().reverse()) {
      L.push(`| ${d.id} | \`${d.anchor}\` | ${cell(truncate(d.decision, 90))} | ${d.at.slice(0, 10)} |`)
    }
    L.push('')
  }
  const openList = model.openCommits
  L.push('### 在途改动')
  L.push('')
  if (!openList.length) L.push('*(无 — 所有改动都已按证据收口)*')
  else for (const c of openList) L.push(`- ${c.id} ${cell(c.task)}（anchor \`${c.anchor}\`，${(c.files || []).length} 文件）`)
  L.push('')
  L.push(`<sub>events=${model.eventCount} · 真相 = .internal/events.jsonl · 本区由其重渲染，同模型必同字节</sub>`)
  return L.join('\n')
}

/**
 * 把自动区写回目标 md（标记内替换；无标记则**拒绝**而不是猜，Once-Only）。
 * @returns {{path, changed, markerMissing?:boolean}}
 */
export function writeProjectSection(rootPath, model, { relPath = 'PROJECT.md' } = {}) {
  const rel = normSlashes(relPath)
  const abs = join(rootPath, rel)
  if (!existsSync(abs)) {
    const body = `# ${rel.replace(/\.md$/, '')}\n\n${MARK_START}\n${renderProjectSection(model)}\n${MARK_END}\n`
    rewriteVerified(abs, body)
    return { path: rel, changed: true, created: true }
  }
  const text = readFileSync(abs, 'utf-8')
  const i = text.indexOf(MARK_START)
  const j = text.indexOf(MARK_END)
  if (i < 0 || j < 0 || j < i) return { path: rel, changed: false, markerMissing: true }
  const out = text.slice(0, i + MARK_START.length) + '\n' + renderProjectSection(model) + '\n' + text.slice(j)
  if (out === text) return { path: rel, changed: false }
  rewriteVerified(abs, out)
  return { path: rel, changed: true }
}

/** 与磁盘现值比对：相同则跳过写盘（确定性渲染 ⇒ 模型不变 ⇒ 文件不动 ⇒ 零 diff）。 */
function rewriteIfChanged(file, content) {
  const bytes = Buffer.byteLength(content, 'utf-8')
  if (existsSync(file) && readFileSync(file, 'utf-8') === content) return { bytes, changed: false }
  rewriteVerified(file, content)
  return { bytes, changed: true }
}

/** 全部投影一次重生成（nav_render 的实现）。体积只自报不设红线：限额会逼着削内容，是丢信息的路。 */
export function renderAll(rootPath, model, { now = Date.now() } = {}) {
  const results = { project: null, modelDoc: null, map: null }
  results.project = writeProjectSection(rootPath, model)
  const md = rewriteIfChanged(paths.modelDoc(rootPath), renderModelDoc(model))
  results.modelDoc = { path: normSlashes(relative(rootPath, paths.modelDoc(rootPath))), changed: md.changed, bytes: md.bytes }
  const mapRel = '.internal/runtime/map-workspace.html'
  const mp = rewriteIfChanged(join(rootPath, mapRel), renderMapHtml(model))
  results.map = { path: mapRel, changed: mp.changed, bytes: mp.bytes }
  return results
}
