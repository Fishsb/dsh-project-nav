// core/render.js — 按需渲染（0.12.0：**不再落盘**）
//
// ⚠ 换代说明（ADR-268）：本文件曾负责三个**落盘投影**（PROJECT.md 标记区 / .internal/ARCH-MODEL.md /
// 地图 HTML）。定案「治理面只服务 agent」后，它们的唯一读者（人）不再是需求 ⇒ 整体退场。
//
// 退场的不是「渲染」这个抽象，而是它的**物化**：渲染仍然成立（零手写、随时重生、没有过期），
// 只是不再写成文件 —— 出口改为两处，都只服务 agent：
//   · `nav_graph` 按需直出（mode=map / task / impact / health / json）
//   · **在场层**：每轮注入 agent 上下文（core/format.js 的 `renderPresence` + host 的 systemPrompt.section）
//
// 故本文件现在只保留**纯计算、零写盘**的渲染：`renderTreeText` 及其模块级辅助。
// ⚠ 零写盘是硬约束：本文件**不得** import 任何 fs 写入面（rewriteVerified 等）。
//    （历史上 runtime 文件的唯一写法是 rewriteVerified（F9）；本文件不再写盘，就不会造出第二种写法。）

import { key } from './paths.js'
import { coverage, moduleBelongsTo } from './model.js'

function truncate(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 主线向量四字段的**唯一格式化实现**（单一权威）。
 *
 * 为什么必须收成一处：向量此前在每个渲染站点被各自手写一遍（nav_set 回执 / health / presence /
 * tree），而它们对"未填"给出了**四种互不相同的语义** —— 回执四字段全显式 `(unset)`，health 与
 * presence 只显式 doing/next、另两个整行消失，tree 干脆不渲染 exitCondition。
 * 后果不是"少显示一行"，而是**失败不可观测**：新增字段时漏改一处、或某字段从未被渲染，
 * 都不会有任何信号 —— 正是本仓最忌的那种缺陷（同族：ACT-341「空扫不得判绿」）。
 *
 * 缺席语义统一为**显式 `(unset)`**（与 doing/next 既有语义、以及 `nav_set` 回执对齐）：
 * 整行消失会让 agent 无法区分"这个维度没填"与"这个字段不存在"。
 * ⚠ 放 render.js 而非 format.js，是为了**不成环**：format.js 已 import render.js
 * （`renderMap` 调 `renderTreeText`），反向再 import 就成环。依赖方向不变。
 */
export function vectorFields(vector) {
  const v = vector || {}
  const f = (x) => String(x || '').trim() || '(unset)'
  return { doing: f(v.doing), next: f(v.next), notDoing: f(v.notDoing), exitCondition: f(v.exitCondition) }
}

/** 项目 -> 模块 -> 功能 -> 文件 的缩进树（agent 导航）。 */
export function renderTreeText(model, { target = '', openActions = null } = {}) {
  const t = key(target)
  const match = (s) => !t || key(s).includes(t)
  const lines = []
  const cv = coverage(model)
  // 走唯一权威（见 vectorFields）：缺席**显式**，不给"整行消失"留口子。
  const vf = vectorFields(model.vector)
  lines.push(`Mainline: doing=${vf.doing} | next=${vf.next}`)
  lines.push(`Anti-goal (notDoing): ${vf.notDoing}`)
  lines.push(`Exit condition (exitCondition): ${vf.exitCondition}`)
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
