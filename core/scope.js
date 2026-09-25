// core/scope.js — 落点解析（F4）· 证据指纹 · import 静态扫描（依赖图数据源）
//
// F4 的教训：scope 解析曾丢路径，导致 12/18 个功能"指纹恒空"——闸门看起来在工作，
// 实际什么都没比。所以这里的原则是：
//   ① 索引键 ∪ 字面量 ∪ glob 展开，三者等权合并，谁都不许悄悄丢；
//   ② 解析不出来就**明说**（missing / unresolved），绝不返回一个空的、看起来很干净的 evidence。
//
// 本文件是「磁盘实况」的采集面：走文件、解析落点、算证据、**抽依赖边**。
// 依赖边由 import 静态扫描派生（ARCHITECTURE §1），确定性、零 LLM —— 见文件末尾 scanImports。

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { normSlashes, key, relToRoot, insideRoot, PLANE, p, RUNTIME_FILES } from './paths.js'
import { rewriteVerified } from './log.js'

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

/** 测试/规格文件：任何源码改动都预期会牵动它们 —— 影响面告警不把它们当"意外下游"（否则闸门变狼来了）。 */
export function isTestPath(rel) {
  const s = normSlashes(rel).toLowerCase()
  return /(^|\/)(test|tests|__tests__|spec)\//.test(s) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(s)
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
 * 仓内文件索引：`key(路径) → 磁盘上的真实拼写`。**从模型取，不额外扫盘。**
 *
 * 为什么从模型取：磁盘实况（走过的文件清单 + 登记的落点）**已经在模型里**——
 * `unregistered` = 磁盘上有、登记里没有；节点 `files` = 登记落点（保留事件流里的真实拼写）。
 * 再走一次盘等于同一份事实算两遍（治理根实测 walkFiles 51ms/次，而 resolveScope 每笔在途都要调）。
 *
 * 三条取舍：
 *   ① 登记落点走**节点**而不是 `fileOwners` 的键：后者被 `key()` 折叠过，会丢大小写；
 *   ② glob 落点不进索引 —— 它本身不是文件路径（与 `staleOf` 同一判据）；
 *   ③ `stale`（登记了但磁盘上没有）**减掉** —— 索引要回答的是"磁盘上真有什么"，
 *      留着不存在的登记路径只会制造假歧义（歧义会压住本可解析的落点）。
 *
 * 模型不含磁盘实况时（`foldOnly` 路径）退回 `walkFiles`：宁可慢，也不许静默给出空索引
 * —— 空索引会把所有本仓相对登记判成 does not exist，那正是本函数要修的形态。
 */
function diskIndexFor(rootPath, model) {
  const idx = new Map()
  const add = (p, real) => { const k = key(p); if (k && !idx.has(k)) idx.set(k, normSlashes(real)) }
  const hasDiskView = model && (model.fileOwners || model.unregistered)
  if (hasDiskView) {
    for (const n of model.nodes?.values() || []) {
      if (n.status !== 'active') continue
      for (const f of n.files || []) { if (!isGlob(f)) add(f, f) }
    }
    for (const f of model.unregistered || []) add(f, f)
    // ③ 减掉登记了但磁盘上没有的：索引 = 磁盘上真有什么
    for (const s of model.stale || []) idx.delete(key(s.file))
    return idx
  }
  for (const f of walkFiles(rootPath)) add(f, f)
  return idx
}

/** 仓内**同后缀**命中集（确定性排序）：`src/x.ts` 命中 `shoucang/src/x.ts`。 */
function suffixHits(index, rel) {
  const t = key(rel)
  if (!t) return []
  const hits = []
  for (const [k, real] of index) { if (k === t || k.endsWith('/' + t)) hits.push(real) }
  return hits.sort()
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

  // ② 字面量路径（越界拒绝）—— **解析优先级是确定的**，绝不瞎选：
  //    ① 治理根相对命中 ⇒ 取根（既有语义，最高优先，不许被项目命中改写）；
  //    ② 根下没有、仓内恰有**唯一一份**同后缀文件 ⇒ 取它（本仓相对登记由此可达）；
  //    ③ 多份命中（歧义）⇒ 明说 ambiguous，**一个候选都不选**，原始登记仍留在 scope；
  //    ④ 零命中 ⇒ 仍登记（供将来 appeared 收口），显式报 does not exist。
  //
  // ⚠ 为什么要 ②：按**本仓相对**登记的落点（如 `src/x.ts`，真实在 `shoucang/src/x.ts`）
  //   曾恒解析成 `<root>/src/x.ts` ⇒ 恒不存在 ⇒ 证据恒 {exists:false} ⇒ diffEvidence 判 unchanged
  //   ⇒ 收口永不发生（僵尸在途）。只报"不存在"时它看起来像文件被删了，实为**解析错位**。
  const missing = []
  // 索引**惰性构建**：只有真的走到 ②/③ 才需要它。全部字面量都根相对命中时零额外开销
  // ——治理根实测构建一次 6.2ms，而 reconcile 每笔在途都要调 resolveScope。
  let index = null
  const indexOf = () => { if (!index) index = diskIndexFor(rootPath, model); return index }
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
    // ① 治理根相对优先
    if (exists(join(rootPath, rel))) continue
    const hits = suffixHits(indexOf(), rel)
    // ③ 歧义：绝不瞎选（不把任何候选写进 files —— 写了就是替调用方猜）
    if (hits.length > 1) { missing.push(`${rel} (ambiguous: ${hits.length} candidates — ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? `, +${hits.length - 5} more` : ''})`); continue }
    // ② 唯一命中 ⇒ 记成真实路径（files 里已登记的是原始写法，故这里补一条真实路径）
    if (hits.length === 1) { files.add(hits[0]); fromLiteral.push(hits[0]); continue }
    // ④ 零命中：仍登记（它会以 appeared 被收口），但显式报出
    missing.push(`${rel} (does not exist)`)
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

/**
 * 内容指纹。**失败不返回 null，返回原因** —— 「读不到」与「读出来的内容」必须可区分：
 * 被压成 null 的失败，比对时与任何 sha1 都不相等 ⇒ 会被读成"内容变了"（静默收口的来源）。
 */
function sha1Of(file) {
  try { return { sha1: createHash('sha1').update(readFileSync(file)).digest('hex') } }
  catch (e) { return { reason: e?.code || e?.message || 'UNREADABLE' } }
}

/**
 * 证据指纹：scope 内每个文件落在**三态**之一。
 *   ① 存在且可读   → {exists:true, size, mtimeMs, sha1}
 *   ② 存在但读不到 → {exists:true, size, mtimeMs, unreadable:'EPERM…'}（statSync 成功、readFileSync 失败）
 *   ③ 确实不存在   → {exists:false}（F4：不存在的文件不能被误报为 vanished，也不能被静默丢弃）
 *
 * ⚠ ② 必须与①的"内容变了"可区分：过去读失败被压成 sha1:null，比对时与任何值都不等
 * ⇒ 收口把"读不到"判成"改过了"，笔记被静默收掉（收口证据说谎）。
 */
export function evidenceOf(rootPath, files) {
  const entries = {}
  for (const rel of files) {
    const abs = join(rootPath, rel)
    try {
      const st = statSync(abs)
      if (!st.isFile()) { entries[rel] = { exists: false, kind: 'not-a-file' }; continue }
      const h = sha1Of(abs)
      entries[rel] = h.sha1 !== undefined
        ? { exists: true, size: st.size, mtimeMs: Math.round(st.mtimeMs), sha1: h.sha1 }
        : { exists: true, size: st.size, mtimeMs: Math.round(st.mtimeMs), unreadable: h.reason }
    } catch {
      entries[rel] = { exists: false }
    }
  }
  return entries
}

/**
 * 一条证据是否"存在但读不到"，并给出原因。
 * 两代都认：新 evidenceOf 带 `unreadable`；旧事件流里的历史证据只有
 * "exists:true 而 sha1 缺席/null" —— 那同样是**没有内容可比**，不得当成"变了"。
 */
function unreadableReason(e) {
  if (!e || !e.exists) return null
  if (typeof e.unreadable === 'string') return e.unreadable
  if (e.sha1 === null || e.sha1 === undefined) return 'unreadable'
  return null
}

/**
 * 证据比对（收口的唯一判据 —— 与会话无关）。
 *
 * 顺序很重要：**先判存在性，再判可读性，最后比内容**。
 * ① 若先比 sha1，一个被删除的文件（after.sha1 === undefined）与 before.sha1 不相等，
 *    就会把"消失"误报成"被修改"；
 * ② 若把"读不到"混进内容比较（读失败曾记 sha1:null），它与任何 sha1 都不相等，
 *    就会把"没读到"误报成"改过了" —— 两者都是**收口证据说谎**，最不能接受的形态。
 * 因此读不到**不算 changed**，而是进 `unreadable` 作为显式原因回传给调用方（不得吞）。
 * 向后兼容：既有五键 unchanged / modified / vanished / appeared / changed 语义不变，只新增 unreadable。
 */
export function diffEvidence(before = {}, after = {}) {
  const modified = []
  const vanished = []
  const appeared = []
  const unchanged = []
  const unreadable = []
  const rerouted = []
  const noteUnreadable = (rel, reason) => { unreadable.push({ file: rel, reason: reason || 'unreadable' }) }
  for (const [rel, b] of Object.entries(before)) {
    const a = after[rel]
    if (!a) { vanished.push(rel); continue }
    const bEx = !!b.exists
    const aEx = !!a.exists
    if (bEx && !aEx) { vanished.push(rel); continue }
    if (!bEx && aEx) { appeared.push(rel); continue }
    if (!bEx && !aEx) { unchanged.push(rel); continue }
    const bU = unreadableReason(b)
    const aU = unreadableReason(a)
    if (bU || aU) { noteUnreadable(rel, bU && aU ? `before: ${bU}; after: ${aU}` : (aU || bU)); continue }
    if (b.sha1 !== a.sha1 || b.size !== a.size) { modified.push(rel); continue }
    unchanged.push(rel)
  }
  for (const rel of Object.keys(after)) if (!(rel in before)) {
    if (after[rel] && after[rel].exists === false) unchanged.push(rel)
    else if (after[rel] && unreadableReason(after[rel])) noteUnreadable(rel, unreadableReason(after[rel]))
    else appeared.push(rel)
  }
  // ---- 解析漂移（rerouted）：**同一字面量的解析归属变了**，不是文件变了 ----
  //
  // 为什么必须单列（2026-09-25 独立复核实证，两种形态都会「造假事实」）：
  //   ① 登记一个**尚不存在**的字面量（合法：新文件本该以 appeared 被收口），随后别处出现
  //      一个**同名但毫不相干**的文件 ⇒ 解析命中它 ⇒ 旧逻辑记 appeared:'<别处的文件>'
  //      ⇒ 收口该笔并在 append-only 事件流里写下**因果错误的事实**；
  //   ② 先唯一命中、随后出现同名 ⇒ 决议退化为歧义 ⇒ 真实路径从 files 里消失
  //      ⇒ 旧逻辑记 vanished:'<真实路径>' ⇒ **没有任何文件变化却判 changed**。
  //
  // 判据：一条在途意图的证据面，只能因「它**自己解析出的那些实体**」的存在性/内容变化而变化；
  //       「文本 → 实体的归属关系」变了 ⇒ 判据**不可判**，与「读不到」同族，不得当成 changed。
  //
  // 归属规则（与 resolveScope 的优先级链同源）：一个证据键 K 归属于**首个**形如
  //   K 自身、或 `<前缀>/K` 且该前缀不含 '/' 的字面量。前缀带 '/' 的路径**不吸收**内容键，
  //   因为两侧都出现的那个内容键（如 core/scope.js）本身也是字面量，归它自己。
  const keysBefore = Object.keys(before)
  const keysAfter = Object.keys(after)
  const ownerOf = (k, keys) => {
    const cands = keys.filter((l) => l === k || k.endsWith('/' + l))
    if (!cands.length) return null
    cands.sort((x, y) => x.split('/').length - y.split('/').length || (x < y ? -1 : x > y ? 1 : 0))
    return (keys.includes(cands[0]) && cands[0] === k) ? cands[0] : (cands.find((c) => c !== k && !c.includes('/')) || cands[0])
  }
  const groupOf = (keys) => {
    const g = new Map()
    for (const k of keys) {
      const o = ownerOf(k, keys)
      if (o === null) continue
      if (!g.has(o)) g.set(o, new Set())
      g.get(o).add(k)
    }
    return g
  }
  const gBefore = groupOf(keysBefore)
  const gAfter = groupOf(keysAfter)
  for (const [literal, setB] of gBefore) {
    const setA = gAfter.get(literal)
    if (!setA) continue
    const sb = [...setB].sort().join('|')
    const sa = [...setA].sort().join('|')
    if (sb === sa) continue                    // 归属未变 ⇒ 与漂移无关
    rerouted.push({ literal, before: [...setB].sort(), after: [...setA].sort() })
  }
  // 漂移项从"变化"里摘掉：归属变了不是文件变了
  for (const { before: bs, after: as } of rerouted) {
    for (const arr of [modified, vanished, appeared]) {
      for (const k of [...bs, ...as]) {
        const i = arr.indexOf(k); if (i >= 0) arr.splice(i, 1)
      }
    }
  }
  const changed = modified.length > 0 || vanished.length > 0 || appeared.length > 0
  return { changed, modified, vanished, appeared, unchanged, unreadable, rerouted }
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
  // 零命中不再只丢回一个词：给**确定性候选**（PN-S2）。
  // 候选只从模型折叠量取（nodes / fileOwners），**不扫盘** —— 扫盘实测 80ms / 4471 文件，
  // 而"给候选"要的是廉价提示，不是精确检索。同一输入 ⇒ 同一输出（I1 可复算）。
  return { kind: 'unknown', target: t, candidates: candidatesFor(model, t) }
}

/**
 * 目标词的确定性候选（PN-S2）：2-gram 重叠打分。
 *
 * 为什么是 2-gram 而不是"模糊匹配库"：中英混排时子串匹配对中文几乎失效
 * （实测自然语言任务 5/5 零命中），而 2-gram 是零依赖、确定性的最小改法。
 * 不引入阈值 —— 排序后取前 N，分数原样展示给调用方判断。
 */
export function candidatesFor(model, target) {
  const t2 = key(target)
  const q = bigrams(t2)
  const scored = []
  // ① 落点文件的后缀命中：`fileOwners` 的键是 **root 相对路径**，
  //    故实测 `core/log.js` MISS、`project-nav/core/log.js` HIT —— 用后缀补齐这一档。
  if (t2.includes('/')) {
    for (const [f, owners] of model.fileOwners) {
      if (f === t2 || f.endsWith(`/${t2}`) || t2.endsWith(`/${f}`)) {
        for (const o of owners) scored.push({ id: o, layer: 'file', name: f, score: 99 })
      }
    }
  }
  if (q.size) {
    for (const n of model.nodes.values()) {
      if (n.status === 'retired') continue
      const hay = bigrams(key(`${n.id} ${n.name || ''}`))
      let hit = 0
      for (const g of q) if (hay.has(g)) hit++
      if (hit) scored.push({ id: n.id, layer: n.layer, name: n.name || '', score: hit })
    }
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  // **不在此处截断**：截断是展示层的事，且必须带"共 N 条"交代（ARCHITECTURE §2②）。
  return scored
}

/** 2-gram 集合（只保留字母/数字/汉字，去掉标点与空白 ⇒ 同输入同输出）。 */
function bigrams(s) {
  const t = String(s).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, '')
  const out = new Set()
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
  return out
}

// ================= import 静态扫描（依赖图 · 确定性、零 LLM） =================
//
// 依赖图是**派生数据**：它属于「磁盘实况」，不属于事件流（ARCHITECTURE §3）。
// 所以这里只做确定性文本抽取 + 路径解析 —— 不猜、不推断、不调模型。
//
// 三条已知取舍，都往"宁缺勿编"倒（幻影边会污染全局视图，比缺边更糟）：
//   ① 注释里的 import 会被剥掉（轻量剥离：块注释 + 行注释，保留 `https://` 这类 URL）；
//   ② 字符串里恰好长得像 import 的文本，极少数情况下仍会被抽到 —— 可接受，因为边只做告警信号。
//      实测：这类文本因为目标文件通常不存在，只会进 unresolved，**不会造成幻影边**。
//   ③ `.d.ts` / `.d.mts` / `.d.cts` 是**类型声明**，不是运行时模块 —— 不扫。
//      实测它们成边数为 0，只贡献 unresolved 噪声（D:\FF 上 42 条里 21 条来自它）。

const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'])
const DECL_RE = /\.d\.(ts|mts|cts)$/i
const RESOLVE_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']
const INDEX_NAMES = ['index.js', 'index.mjs', 'index.cjs', 'index.ts', 'index.tsx']

/** 是不是"有运行时依赖的代码文件"（声明档不算）。 */
function isCodeFile(rel) {
  const s = normSlashes(String(rel))
  if (DECL_RE.test(s)) return false
  return CODE_EXTS.has(extname(s).toLowerCase())
}

/** 剥注释（保留 URL 里的 `//`）。 */
export function stripComments(src) {
  return String(src ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// 匹配的是**说明符**而不是整条语句 ⇒ 跨行 import 天然被覆盖（`\s` 含换行）。
const SPEC_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,              // import/export … from '…'
  /\bimport\s*['"]([^'"]+)['"]/g,            // import '…'（副作用）
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,  // import('…')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g  // require('…')
]

/** 从源码文本抽出模块说明符（去重，**保持源码出现顺序**）。 */
export function extractSpecifiers(src) {
  const text = stripComments(src)
  const hits = []
  for (const re of SPEC_PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) hits.push({ at: m.index, spec: m[1] })
  }
  // 必须按出现位置排序：逐条正则各扫一遍会按"模式"而非"源码顺序"分组，
  // 那样同一份源码的说明符顺序就取决于模式表的书写顺序 —— 顺序成了隐式契约。
  hits.sort((a, b) => a.at - b.at)
  const out = []
  const seen = new Set()
  for (const h of hits) {
    if (!h.spec || seen.has(h.spec)) continue
    seen.add(h.spec)
    out.push(h.spec)
  }
  return out
}

/** 说明符 → 仓内相对路径。解析不出返回 null（外部包 / 解析不到）。候选顺序固定 ⇒ 结果确定。 */
function resolveSpecifier(fromRel, spec, index) {
  if (!spec.startsWith('.')) return null            // bare specifier = 外部包，不进节点图
  const base = normSlashes(join(dirname(fromRel), spec)).replace(/^\.\//, '')
  const cands = [base]
  for (const e of RESOLVE_EXTS) cands.push(base + e)
  const m = base.match(/\.(js|mjs|cjs)$/)
  // TS ESM 惯例：源码写 './x.js'，磁盘上却是 x.ts
  if (m) for (const e of RESOLVE_EXTS) cands.push(`${base.slice(0, -m[0].length)}${e}`)
  for (const n of INDEX_NAMES) cands.push(`${base}/${n}`)
  for (const c of cands) { const hit = index.get(key(c)); if (hit) return hit }
  return null
}

/**
 * 扫描代码文件，构建**文件级依赖图**（ARCHITECTURE §1 的「谁引用谁」）。
 *
 * @param {string} rootPath 被治理根
 * @param {string[]|null} files 已走出的文件清单（复用调用方的 walkFiles，不重复走盘）
 * @returns {{edges: Map<string,string[]>, external: Map<string,string[]>,
 *            unresolved: string[], skipped: string[], scanned: number}}
 *   edges      fromRel → [toRel]（仓内文件依赖，排序去重）
 *   external   fromRel → [spec]（bare specifier，外部包；可见但不进节点图）
 *   unresolved 解析不到的**相对**引用（不静默丢 —— F4 的精神）
 *   skipped    超体量未扫的文件（打包产物：噪声大于信号）
 */
export function scanImports(rootPath, files = null, { maxFiles = 4000, maxBytes = 256 * 1024 } = {}) {
  const all = files || walkFiles(rootPath)
  const index = new Map()                            // key(rel) → rel（磁盘上的真实拼写）
  for (const f of all) index.set(key(f), normSlashes(f))

  const edges = new Map()
  const external = new Map()
  const unresolved = []
  const skipped = []
  let scanned = 0

  for (const rel of all) {
    if (scanned >= maxFiles) break
    if (!isCodeFile(rel)) continue
    let src
    try {
      const buf = readFileSync(join(rootPath, rel))
      if (buf.length > maxBytes) { skipped.push(normSlashes(rel)); continue }
      src = buf.toString('utf-8')
    } catch { continue }
    scanned++
    const outs = new Set()
    const exts = new Set()
    for (const spec of extractSpecifiers(src)) {
      if (!spec.startsWith('.')) { exts.add(spec); continue }
      const to = resolveSpecifier(rel, spec, index)
      if (to === null) { unresolved.push(`${normSlashes(rel)} -> ${spec}`); continue }
      if (to !== normSlashes(rel)) outs.add(to)      // 自引用不成边
    }
    if (outs.size) edges.set(normSlashes(rel), [...outs].sort())
    if (exts.size) external.set(normSlashes(rel), [...exts].sort())
  }

  return { edges, external, unresolved: [...new Set(unresolved)].sort(), skipped: skipped.sort(), scanned }
}

// ---- 依赖图扫描缓存（0.11.0 · 治理接管 P0-1） ----
//
// 为什么要有它：`scanImports` 是**纯磁盘派生**的重活（实测治理根 2730 个代码文件 ≈ 360ms），
// 而每次工具调用都会重建模型 ⇒ 每次都白付这一笔。
//
// 为什么它可以缓存：它是 `事件流 + 磁盘实况` 里的**磁盘实况**那一半 —— 只要"磁盘没变"，
// 结论必然不变。所以失效判据必须是**磁盘指纹**，而不是时间、不是次数。
//
// ⚠ 缓存**不是第二个真相**（I1）的保证在于：指纹覆盖**文件清单 + 每个被扫文件的 size + mtimeMs**。
//   任何一项变了 ⇒ 整份缓存作废重扫。若指纹漏项（例如只看清单不看内容），
//   改了 import 却命中旧缓存 ⇒ 依赖图变旧 ⇒ 影响面闸误判。**这是本函数唯一的风险点。**
//
// 落点：`runtime/`（可丢，I3）。删掉它只是重算，不是数据丢失。

const SCAN_CACHE_FILE = RUNTIME_FILES.SCAN_CACHE

/** 扫描缓存指纹：文件清单 + 每个被扫代码文件的 size/mtimeMs（确定性排序）。 */
function scanFingerprint(rootPath, files) {
  const code = files.filter(isCodeFile).map(normSlashes).sort()
  const parts = []
  for (const rel of code) {
    try {
      const s = statSync(join(rootPath, rel))
      parts.push(`${rel}:${s.size}:${Math.round(s.mtimeMs)}`)
    } catch {
      parts.push(`${rel}:gone`)           // 读不到也要进指纹：它的出现/消失本身就是变化
    }
  }
  return { count: code.length, digest: parts.join('\n') }
}

/**
 * 带缓存的 `scanImports`：磁盘未变则复用 `runtime/` 里的上次结果。
 *
 * @returns {{result: object, fromCache: boolean, fingerprint: object}}
 *   `fromCache` 是**可确定断言**的命中标志 —— 判据用它，不用耗时（耗时是代理指标，会漂）。
 */
export function scanImportsCached(rootPath, files = null, opts = {}) {
  const all = files || walkFiles(rootPath)
  const fp = scanFingerprint(rootPath, all)
  const cachePath = p(rootPath, PLANE.RUNTIME, SCAN_CACHE_FILE)

  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf-8'))
    if (cached?.fingerprint?.digest === fp.digest && cached?.fingerprint?.count === fp.count) {
      return {
        fromCache: true,
        fingerprint: fp,
        result: {
          edges: new Map(cached.edges || []),
          external: new Map(cached.external || []),
          unresolved: cached.unresolved || [],
          skipped: cached.skipped || [],
          scanned: cached.scanned || 0
        }
      }
    }
  } catch { /* 缓存缺失/损坏 ⇒ 重扫（这就是缓存的语义：随时可丢） */ }

  const result = scanImports(rootPath, all, opts)
  try {
    rewriteVerified(cachePath, JSON.stringify({
      fingerprint: fp,
      edges: [...result.edges],
      external: [...result.external],
      unresolved: result.unresolved,
      skipped: result.skipped,
      scanned: result.scanned
    }, null, 2))
  } catch { /* 缓存写失败不影响正确性（与 model 缓存同策略） */ }
  return { fromCache: false, fingerprint: fp, result }
}
