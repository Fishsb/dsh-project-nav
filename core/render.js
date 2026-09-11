// core/render.js — 渲染投影（I2）
//
// 一切产出都是**模型的重渲染**，零手写：
//   PROJECT.md 标记区 · 模型文档（ARCH-MODEL.md）· 地图 text/html · 架构档指纹指针
// 手改渲染物 => 下一次渲染覆盖它（这就是 I2 的验法，不是靠"人别改"）。

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { normSlashes, key, paths, nowIso } from './paths.js'
import { coverage, moduleBelongsTo } from './model.js'
import { rewriteVerified } from './log.js'

export const MARK_START = '<!-- nav:auto:start -->'
export const MARK_END = '<!-- nav:auto:end -->'

// ---- 最小 YAML 读（只支持本插件写出的扁平映射，够用且无依赖） ----

function parseFlatYaml(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w./-]*):\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

// ---- 架构档（.internal/arch/*.md） ----

/**
 * 解析架构档头部的 arch-cache 指纹块。
 * 兼容两种块格式（本插件写 YAML 块 `arch-cache: |-`，旧档为 ```arch-cache 围栏 JSON）。
 * @returns {{source:string|null, files:Array<{path:string,sha1:string}>, at:string|null, head:string|null}|null}
 */
export function parseArchCache(text) {
  const src = String(text || '').slice(0, 65536) // 窗口须容下整个 frontmatter：8000 会截断大声明档（79 文件 ≈ 8.1KB）→ 恒报未纳管
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  const front = fm ? parseFlatYaml(fm[1]) : {}
  let blockText = null
  const inline = front['arch-cache']
  if (inline !== undefined) {
    if (/^[|>]/.test(inline.trim())) {
      // YAML 块标量：取 frontmatter 内 arch-cache: 之后的缩进行。
      // 空行**不断块** —— 早期实现把正文前的空行当结束符，结果"有头文件却报未纳管"。
      const lines = fm[1].split(/\r?\n/)
      const start = lines.findIndex((l) => /^\s*arch-cache:/.test(l))
      if (start >= 0) {
        const collected = []
        for (let i = start + 1; i < lines.length; i++) {
          const l = lines[i]
          if (/^\s{2,}/.test(l)) { collected.push(l.trim()); continue }
          if (l.trim() === '') { collected.push(''); continue }
          break
        }
        blockText = collected.join('\n').trim() || null
      }
    } else {
      blockText = inline.trim()
    }
  }
  if (!blockText) {
    const fence = /```arch-cache\s*\n([\s\S]*?)```/.exec(src)
    if (fence) blockText = fence[1].trim()
  }
  if (!blockText) return null

  if (blockText.startsWith('{')) {
    try {
      const j = JSON.parse(blockText)
      return {
        source: 'json',
        files: Array.isArray(j.files) ? j.files.map((f) => ({ path: String(f.path ?? f.file), sha1: String(f.sha1 || '') })) : [],
        at: j.at || j.generated || null,
        head: j.head || null
      }
    } catch { return { source: 'json-invalid', files: [], at: null, head: null } }
  }
  const kv = parseFlatYaml(blockText)
  const files = []
  for (const [k, v] of Object.entries(kv)) {
    if (k === 'files' || k === 'at' || k === 'head') continue
    files.push({ path: k, sha1: String(v).trim() })
  }
  return { source: 'yaml', files, at: kv.at || null, head: kv.head || null }
}

function sha1OfFile(abs) {
  try { return createHash('sha1').update(readFileSync(abs)).digest('hex') } catch { return null }
}

let cachedHead = { at: 0, value: null }
/** 当前 HEAD commit（epoch 标记；git 不可用时为 null，不阻塞任何事）。 */
export function headCommit(rootPath) {
  if (Date.now() - cachedHead.at < 5000) return cachedHead.value
  let v = null
  try {
    v = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: rootPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { v = null }
  cachedHead = { at: Date.now(), value: v }
  return v
}

/**
 * 一个架构档的新鲜度。判据 = 声明文件的 sha1 是否与当前一致（D2 的机检面）。
 * @returns {{path,exists,fresh,reason,files:Array<{path,status}>,declared:number,noHeader:boolean}}
 */
export function archDocState(rootPath, relPath, { text = null } = {}) {
  const rel = normSlashes(relPath)
  const abs = join(rootPath, rel)
  if (!existsSync(abs)) return { path: rel, exists: false, fresh: false, reason: 'file missing', files: [], declared: 0, noHeader: false }
  const body = text ?? readFileSync(abs, 'utf-8')
  const cache = parseArchCache(body)
  if (!cache) return { path: rel, exists: true, fresh: false, reason: 'no arch-cache header (未纳管)', files: [], declared: 0, noHeader: true }
  if (cache.source === 'json-invalid') return { path: rel, exists: true, fresh: false, reason: 'arch-cache header unparsable', files: [], declared: 0, noHeader: false }
  if (!cache.files.length) return { path: rel, exists: true, fresh: false, reason: 'arch-cache declares no source files', files: [], declared: 0, noHeader: false }

  const files = []
  let staleCount = 0
  for (const f of cache.files) {
    const fAbs = join(rootPath, f.path)
    if (!existsSync(fAbs)) { files.push({ path: f.path, status: 'missing' }); staleCount++; continue }
    const cur = sha1OfFile(fAbs)
    if (!f.sha1) { files.push({ path: f.path, status: 'unstamped' }); staleCount++; continue }
    if (cur !== f.sha1) { files.push({ path: f.path, status: 'changed' }); staleCount++; continue }
    files.push({ path: f.path, status: 'same' })
  }
  if (staleCount) {
    const bad = files.filter((f) => f.status !== 'same')
    return {
      path: rel, exists: true, fresh: false,
      reason: `声明 ${cache.files.length} 个源文件中有 ${staleCount} 个已变（${bad.map((f) => `${f.path}:${f.status}`).join(', ')}）`,
      files, declared: cache.files.length, noHeader: false, at: cache.at
    }
  }
  const head = headCommit(rootPath)
  const headNote = cache.head && head && cache.head !== head ? `（HEAD 已从 ${cache.head} 前移到 ${head}，但声明文件内容未变 -> 仍视为新鲜）` : ''
  return { path: rel, exists: true, fresh: true, reason: `声明 ${cache.files.length} 文件的 sha1 全部一致${headNote}`, files, declared: cache.files.length, noHeader: false, at: cache.at, head: cache.head }
}

/** 列出全部架构档的新鲜度。 */
export function listArchDocs(rootPath) {
  const dir = paths.archDir(rootPath)
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    const rel = normSlashes(relative(rootPath, join(dir, f)))
    try { out.push(archDocState(rootPath, rel)) } catch (e) { out.push({ path: rel, exists: true, fresh: false, reason: `read failed: ${e.message}`, files: [], declared: 0 }) }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** 覆盖某个目标的架构档（按声明文件 + 文件名启发匹配）。 */
export function archDocsFor(rootPath, model, target) {
  const docs = listArchDocs(rootPath)
  const t = String(target ?? '').trim()
  if (!t) return docs
  const owners = model.fileOwners.get(key(t)) || []
  const ownerFiles = new Set([normSlashes(t)])
  for (const o of owners) {
    const n = model.nodes.get(o)
    for (const f of n?.files || []) ownerFiles.add(normSlashes(f))
  }
  const tk = key(t)
  return docs.filter((d) => {
    if (key(d.path).includes(tk)) return true
    return (d.files || []).some((f) => ownerFiles.has(key(f.path)) || key(f.path).includes(tk))
  })
}

/** 重写架构档的 arch-cache 头（stamp 的唯一实现）。正文其余部分零触碰。 */
export function stampArchDoc(rootPath, relPath, { now = Date.now() } = {}) {
  const rel = normSlashes(relPath)
  const abs = join(rootPath, rel)
  if (!existsSync(abs)) throw new Error(`arch doc not found: ${rel}`)
  const text = readFileSync(abs, 'utf-8')
  const cache = parseArchCache(text)
  const declared = (cache?.files || []).map((f) => normSlashes(f.path)).filter(Boolean)
  if (!declared.length) {
    throw new Error(`arch doc ${rel} declares no source files in its arch-cache header — nothing to stamp. Add the declared file list to the header first (it is the doc's contract).`)
  }
  const lines = ['arch-cache: |-']
  for (const f of declared) {
    const sha = sha1OfFile(join(rootPath, f))
    if (!sha) throw new Error(`declared file missing on disk: ${f} (refusing to stamp a doc against a file that does not exist)`)
    lines.push(`  ${f}: ${sha}`)
  }
  lines.push(`  at: ${nowIso(now)}`)
  const head = headCommit(rootPath)
  if (head) lines.push(`  head: ${head}`)
  const block = lines.join('\n')

  let out
  const fm = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(text)
  if (fm && /^arch-cache:/m.test(fm[2])) {
    const linesOfFm = fm[2].split(/\r?\n/)
    const kept = []
    for (let i = 0; i < linesOfFm.length; i++) {
      if (/^arch-cache:/.test(linesOfFm[i])) { while (i + 1 < linesOfFm.length && /^\s{2,}/.test(linesOfFm[i + 1])) i++; continue }
      kept.push(linesOfFm[i])
    }
    out = fm[1] + [...kept, ...block.split('\n')].join('\n') + fm[3] + text.slice(fm[0].length)
  } else if (fm) {
    out = fm[1] + fm[2] + '\n' + block + fm[3] + text.slice(fm[0].length)
  } else {
    out = `---\n${block}\n---\n\n${text}`
  }
  if (out === text) return { path: rel, changed: false, declared: declared.length }
  rewriteVerified(abs, out)
  return { path: rel, changed: true, declared: declared.length }
}

// ---- 投影：地图 text / html ----

function truncate(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
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
    if ((f.files || []).length > 12) lines.push(`${indent}      · …(+${f.files.length - 12} more)`)
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
    parts.push('<h2>架构决策</h2><ul>')
    for (const d of model.decisions.slice(-8).reverse()) parts.push(`<li>${esc(d.id)} <code>${esc(d.anchor)}</code> ${esc(truncate(d.decision, 110))}</li>`)
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
  parts.push(`<p class="meta">generated ${esc(nowIso())} · events=${model.eventCount} · 唯一事实源 = .internal/events.jsonl</p>`)
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
  L.push(`生成时间：${nowIso()} · 事件数：${model.eventCount}`)
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
    L.push('## 架构决策（ADR）')
    L.push('')
    for (const d of model.decisions) {
      L.push(`### ${d.id} · ${d.anchor}`)
      L.push('')
      L.push(`- 时间：${d.at}${d.action ? ` · 关联：${d.action}` : ''}`)
      L.push(`- 为什么必须改：${cell(d.reason)}`)
      L.push(`- 架构变成什么：${cell(d.decision)}`)
      if (d.impact) L.push(`- 影响面：${cell(d.impact)}`)
      L.push('')
    }
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
    L.push('## 最近的收口（证据变化 -> 自动收口）')
    L.push('')
    L.push('| id | 任务 | 锚点 | 收口依据 | 时间 |')
    L.push('|---|---|---|---|---|')
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
      L.push(`| ${src ? src.id : `ACT-${c.closes}`} | ${cell(truncate(src?.task, 70))} | \`${cell(src?.anchor)}\` | ${bits.join(' / ')} | ${c.at.slice(0, 19).replace('T', ' ')} |`)
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
    L.push('### 架构决策（ADR）')
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
  L.push(`<sub>生成于 ${nowIso()} · events=${model.eventCount}</sub>`)
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

/** 全部投影一次重生成（nav_render 的实现）。 */
export function renderAll(rootPath, model, { now = Date.now() } = {}) {
  const results = { project: null, modelDoc: null, map: null, archDocs: [] }
  results.project = writeProjectSection(rootPath, model)
  rewriteVerified(paths.modelDoc(rootPath), renderModelDoc(model))
  results.modelDoc = { path: normSlashes(relative(rootPath, paths.modelDoc(rootPath))), changed: true }
  const mapRel = '.internal/runtime/map-workspace.html'
  rewriteVerified(join(rootPath, mapRel), renderMapHtml(model))
  results.map = { path: mapRel, changed: true }
  return results
}
