// core/scope.js — 落点解析（F4）与证据指纹
//
// F4 的教训：scope 解析曾丢路径，导致 12/18 个功能"指纹恒空"——闸门看起来在工作，
// 实际什么都没比。所以这里的原则是：
//   ① 索引键 ∪ 字面量 ∪ glob 展开，三者等权合并，谁都不许悄悄丢；
//   ② 解析不出来就**明说**（missing / unresolved），绝不返回一个空的、看起来很干净的 evidence。

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { normSlashes, key, relToRoot, insideRoot } from './paths.js'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.internal', 'dist', 'build', '.next', 'coverage', '.dsh-vision-toolkit', '.npm-cache'])
const GLOB_MAX = 400

/** glob → 正则（支持 ** / * / ?）。 */
export function globToRegExp(glob) {
  const g = normSlashes(glob)
  let re = '^'
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slashNext = g[i + 2] === '/'
        re += slashNext ? '(?:.*/)?' : '.*'
        i += slashNext ? 2 : 1
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('\\^$.|+()[]{}'.includes(c)) re += `\\${c}`
    else re += c
  }
  return new RegExp(re + '$')
}

export function isGlob(s) {
  return /[*?]/.test(String(s ?? ''))
}

/** 深度遍历 root 下的文件（root 相对路径），跳过噪声目录。 */
export function walkFiles(rootPath, { max = 5000 } = {}) {
  const out = []
  const walk = (dir, rel) => {
    if (out.length >= max) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= max) return
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
      } else if (e.isFile()) {
        out.push(rel ? `${rel}/${e.name}` : e.name)
      }
    }
  }
  walk(rootPath, '')
  return out
}

/** glob 展开（root 相对）。 */
export function expandGlob(rootPath, pattern) {
  const re = globToRegExp(pattern)
  return walkFiles(rootPath).filter((f) => re.test(f)).slice(0, GLOB_MAX)
}

/**
 * scope → 落点文件集合。
 *
 * @param {object} model 折叠后的架构模型
 * @param {{features?:string[], modules?:string[], files?:string[]}} scope
 * @returns {{files:string[], missing:string[], unresolved:string[], fromIndex:string[], fromLiteral:string[], fromGlob:string[]}}
 */
export function resolveScope(rootPath, model, scope = {}) {
  const files = new Set()
  const fromIndex = []
  const fromLiteral = []
  const fromGlob = []
  const unresolved = []

  // ① 索引键（模型落点）：功能码 / 模块名 → 其登记文件
  for (const code of scope.features || []) {
    const node = model.nodes.get(`feature:${key(code)}`)
    if (!node) { unresolved.push(`feature ${code} (not registered)`); continue }
    for (const f of node.files || []) { files.add(f); fromIndex.push(f) }
  }
  for (const name of scope.modules || []) {
    const node = model.nodes.get(`module:${key(name)}`)
    if (!node) { unresolved.push(`module ${name} (not registered)`); continue }
    for (const code of node.features || []) {
      const fn = model.nodes.get(`feature:${key(code)}`)
      if (fn) for (const f of fn.files || []) { files.add(f); fromIndex.push(f) }
      else unresolved.push(`feature ${code} of module ${name} (not registered)`)
    }
  }

  // ② 字面量路径（一律按被治理 root 解析；越界拒绝）
  const missing = []
  for (const raw of scope.files || []) {
    const s = String(raw).trim()
    if (!s) continue
    if (isGlob(s)) {
      const hits = expandGlob(rootPath, s)
      if (!hits.length) missing.push(`${s} (glob matched nothing)`)
      for (const h of hits) { files.add(h); fromGlob.push(h) }
      continue
    }
    if (!insideRoot(rootPath, s)) { missing.push(`${s} (outside governed root)`); continue }
    const rel = normSlashes(relToRoot(rootPath, s))
    files.add(rel)
    fromLiteral.push(rel)
    if (!exists(join(rootPath, rel))) missing.push(`${rel} (does not exist)`)
  }

  return {
    files: [...files].sort(),
    missing,
    unresolved,
    fromIndex: [...new Set(fromIndex)].sort(),
    fromLiteral: [...new Set(fromLiteral)].sort(),
    fromGlob: [...new Set(fromGlob)].sort()
  }
}

function exists(p) { try { return existsSync(p) } catch { return false } }

function sha1(file) {
  try { return createHash('sha1').update(readFileSync(file)).digest('hex') } catch { return null }
}

/**
 * 证据指纹：scope 内每个文件 {size, mtimeMs, sha1}。
 * 不存在的文件记 `exists:false`（F4：不存在的文件不能被误报为 vanished，也不能被静默丢弃）。
 */
export function evidenceOf(rootPath, files) {
  const entries = {}
  for (const rel of files) {
    const abs = join(rootPath, rel)
    try {
      const st = statSync(abs)
      if (!st.isFile()) { entries[rel] = { exists: false, kind: 'not-a-file' }; continue }
      entries[rel] = { exists: true, size: st.size, mtimeMs: Math.round(st.mtimeMs), sha1: sha1(abs) }
    } catch {
      entries[rel] = { exists: false }
    }
  }
  return entries
}

/**
 * 证据比对（收口的唯一判据 —— 与会话无关）。
 *
 * 顺序很重要：**先判存在性，再比内容**。
 * 若先比 sha1，一个被删除的文件（after.sha1 === undefined）与 before.sha1（字符串/null）
 * 不相等，就会把"消失"误报成"被修改" —— 收口证据会说谎，这是最不能接受的形态。
 */
export function diffEvidence(before = {}, after = {}) {
  const modified = []
  const vanished = []
  const appeared = []
  const unchanged = []
  for (const [rel, b] of Object.entries(before)) {
    const a = after[rel]
    if (!a) { vanished.push(rel); continue }
    const bEx = !!b.exists
    const aEx = !!a.exists
    if (bEx && !aEx) { vanished.push(rel); continue }
    if (!bEx && aEx) { appeared.push(rel); continue }
    if (!bEx && !aEx) { unchanged.push(rel); continue }
    if (b.sha1 !== a.sha1 || b.size !== a.size) { modified.push(rel); continue }
    unchanged.push(rel)
  }
  for (const rel of Object.keys(after)) if (!(rel in before)) {
    if (after[rel] && after[rel].exists === false) unchanged.push(rel)
    else appeared.push(rel)
  }
  const changed = modified.length > 0 || vanished.length > 0 || appeared.length > 0
  return { changed, modified, vanished, appeared, unchanged }
}

/**
 * nav_graph 用：目标 → 落点文件（用于"缺口/覆盖度"）。
 * 目标可以是功能码 / 模块名 / 项目 / 文件路径。
 */
export function locate(rootPath, model, target) {
  const t = String(target ?? '').trim()
  if (!t) return { kind: 'empty' }
  const asFile = normSlashes(t)
  const owners = model.fileOwners.get(key(asFile)) || []
  if (owners.length) return { kind: 'file', file: asFile, owners: owners.map((o) => model.nodes.get(o)).filter(Boolean) }

  for (const prefix of ['feature', 'module', 'project', 'artifact']) {
    const node = model.nodes.get(`${prefix}:${key(t)}`)
    if (node) return { kind: prefix, node }
  }
  // 名称/子串兜底（功能码之外的展示名）
  const hits = [...model.nodes.values()].filter((n) => key(n.name || '') === key(t) || key(n.id) === key(t))
  if (hits.length) return { kind: hits[0].layer, node: hits[0], ambiguous: hits.length > 1, hits }
  return { kind: 'unknown', target: t }
}
