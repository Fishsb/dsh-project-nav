// core/boundary.js — 工作区边界判定（纯函数）
//
// 边界本身是 harness 的（native sandbox）；插件只回答**一个**问题：
// 这个会话的 cwd 是否属于一个"被本仓治理、且工作自包含"的工作区。
//
// 契约沿自 v0.7.x 实测（事故事实不可丢弃）：
//   · 空白名单 / 缺输入 → ''（全函数：调用方依赖它绝不抛）
//   · 被治理 root 自身永不受治理（root 级边界＝允许写进每个项目，正是要防的漂移）
//   · 白名单项必须对应**已登记的现行项目**（F6：不登记的项目不构成许可）
//   · 命中返回 workspace 绝对路径（/ 分隔）；未命中或命中 root 自身返回 ''

import { normSlashes } from './paths.js'

export function governedWorkspaceOf(model, rootPath, cwd, allow = []) {
  const list = Array.isArray(allow) ? allow : String(allow || '').split(',').map((x) => x.trim()).filter(Boolean)
  if (!list.length || !cwd || !rootPath) return ''
  const norm = (p) => normSlashes(String(p || ''))
  const lower = (p) => norm(p).toLowerCase()
  const rootText = norm(rootPath)                 // 返回时保留登记时的大小写
  const c = lower(cwd)
  const root = lower(rootPath)
  if (c === root) return ''
  if (!c.startsWith(`${root}/`)) return ''

  const projects = []
  for (const n of model?.nodes?.values?.() || []) {
    if (n.layer !== 'project' || n.status !== 'active') continue
    projects.push({ name: n.name, path: norm(n.meta?.path || '') })
  }
  for (const a of list) {
    const ak = String(a).trim()
    if (!ak) continue
    const alk = lower(ak)
    if (c === alk) return ''
    for (const p of projects) {
      const pn = lower(p.name)
      // 白名单项必须匹配一个**已登记项目的名字或登记路径**；裸目录名不构成许可（F6）。
      if (pn !== alk && !(p.path && lower(p.path) === alk)) continue
      const abs = lower(p.path).startsWith(root) ? p.path : `${rootText}/${p.path}`
      if (c === lower(abs) || c.startsWith(`${lower(abs)}/`)) return norm(abs)
    }
  }
  return ''
}
