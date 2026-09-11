// core/legacy.js — 旧账本 → 事件流（一次性迁移）
//
// 旧账本 = 5 个并列账本（nav-index / vector / nav-actions / nav-docs / nav-arch）。
// 迁移是**折叠的逆运算**：把它们读成事件，写进唯一事实源，然后归档为只读快照。
// 迁移跑完就不再有第二个真相（D4 的根治），所以只跑一次，且必须显式调用。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths, normSlashes, nowIso } from './paths.js'
import { appendEvents, rewriteVerified } from './log.js'
import { isGlob } from './scope.js'

const LEGACY_FILES = ['nav-index.json', 'vector.json', 'nav-actions.json', 'nav-docs.json', 'nav-arch.json']
const MARKER = 'migrated.json'

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf-8')) } catch { return null }
}

/** 迁移前的勘查：哪些旧账本存在、各有多少条目（干跑也用它）。 */
export function inspectLegacy(rootPath) {
  const dir = join(rootPath, '.internal')
  const found = {}
  for (const f of LEGACY_FILES) {
    const abs = join(dir, f)
    if (!existsSync(abs)) { found[f] = null; continue }
    const j = readJsonSafe(abs)
    found[f] = j === null
      ? { corrupt: true }
      : {
          corrupt: false,
          projects: j.projects ? Object.keys(j.projects).length : undefined,
          modules: j.modules ? Object.keys(j.modules).length : undefined,
          features: j.features ? Object.keys(j.features).length : undefined,
          files: j.projectPaths ? Object.keys(j.projectPaths).length : undefined,
          actions: Array.isArray(j.actions) ? j.actions.length : undefined,
          docs: Array.isArray(j.docs) ? j.docs.length : undefined,
          decisions: Array.isArray(j.decisions) ? j.decisions.length : undefined,
          vector: j.doing !== undefined ? true : undefined
        }
  }
  const marker = join(paths.legacyDir(rootPath), MARKER)
  return { files: found, alreadyMigrated: existsSync(marker), marker: existsSync(marker) ? readJsonSafe(marker) : null }
}

/**
 * 把旧账本折叠成事件草稿。纯函数（可测）。
 * @returns {{drafts:object[], warnings:string[]}}
 */
export function legacyToDrafts(rootPath) {
  const dir = join(rootPath, '.internal')
  const drafts = []
  const warnings = []

  // ---- 真实旧索引用 **两套** 表达，必须都读（实测 D:\FF 的索引里 projects/modules/features 三表是空的）：
  //   · projectPaths + indexes.projectToModules + indexes.moduleToFeatures + descriptions  ← 权威
  //   · projects / modules / features 三表                                                   ← 旧形态，可能存在
  // 只读一套会把"模块→功能"的挂载关系整片丢掉（地图被拆散），所以两套合并。
  const index = readJsonSafe(join(dir, 'nav-index.json')) || {}
  const idx = index.indexes || {}
  const desc = index.descriptions || {}
  const moduleMeta = index.moduleMeta || {}

  const projectPaths = index.projectPaths || {}
  const projectToModules = idx.projectToModules || {}
  const moduleToFeatures = idx.moduleToFeatures || {}
  const fileToFeature = idx.fileToFeature || {}
  const featureToFiles = idx.featureToFiles || {}
  const legacyProjects = index.projects || {}
  const legacyModules = index.modules || {}
  const legacyFeatures = index.features || {}

  // ① 项目：两套键的并集
  const projectIds = new Set([...Object.keys(projectPaths), ...Object.keys(projectToModules), ...Object.keys(legacyProjects)])
  for (const id of projectIds) {
    const lm = legacyProjects[id] || {}
    drafts.push({
      kind: 'node', op: 'upsert', layer: 'project', id,
      fields: { name: lm.name || id, path: normSlashes(projectPaths[id] || lm.path || '') }
    })
  }

  // ② 模块：moduleToFeatures ∪ projectToModules 反查归属 ∪ legacy modules 表
  const moduleOwner = {}
  for (const [pid, mods] of Object.entries(projectToModules)) {
    for (const m of mods || []) moduleOwner[m] = pid
  }
  const moduleIds = new Set([...Object.keys(moduleToFeatures), ...Object.keys(moduleOwner), ...Object.keys(legacyModules)])
  for (const id of moduleIds) {
    const lm = legacyModules[id] || {}
    const mm = moduleMeta[id] || {}
    drafts.push({
      kind: 'node', op: 'upsert', layer: 'module', id,
      fields: {
        name: mm.name || lm.name || id,
        project: lm.project || moduleOwner[id] || '',
        features: Array.isArray(lm.features) ? lm.features : (moduleToFeatures[id] || []),
        status: lm.status
      }
    })
  }

  // ③ 功能：代码并集；落点 = featureToFiles ∪ fileToFeature 反查；归属 = 模块成员表
  const reverse = {}
  for (const [file, codes] of Object.entries(fileToFeature)) {
    for (const c of codes || []) {
      if (!reverse[c]) reverse[c] = new Set()
      reverse[c].add(normSlashes(file))
    }
  }
  const featureModule = {}
  for (const [mod, feats] of Object.entries(moduleToFeatures)) {
    for (const c of feats || []) if (!(c in featureModule)) featureModule[c] = mod
  }
  for (const [mod, lm] of Object.entries(legacyModules)) {
    for (const c of lm?.features || []) if (!(c in featureModule)) featureModule[c] = mod
  }
  const featureIds = new Set([...Object.keys(featureToFiles), ...Object.keys(reverse), ...Object.keys(legacyFeatures)])
  for (const code of featureIds) {
    const lf = legacyFeatures[code] || {}
    const d = desc[code] || {}
    const files = new Set([
      ...(lf.files || []).map(normSlashes),
      ...(featureToFiles[code] || []).map(normSlashes),
      ...(reverse[code] ? [...reverse[code]] : [])
    ])
    drafts.push({
      kind: 'node', op: 'upsert', layer: 'feature', id: code,
      fields: {
        name: d.name || lf.name || code,
        files: [...files].sort(),
        module: lf.module || featureModule[code] || '',
        userView: d.userView || lf.userView,
        systemView: d.systemView || lf.systemView,
        status: lf.status
      }
    })
  }
  // 成员表引用了但没有任何落点来源的功能 → 明确告警（不静默）
  for (const [mod, feats] of Object.entries(moduleToFeatures)) {
    for (const c of feats || []) if (!featureIds.has(c)) warnings.push(`模块 ${mod} 的成员表引用了功能 ${c}，索引里没有它的落点 → 按空落点登记`)
  }

  // ③b 落点路径口径对齐：旧索引里的落点是**项目相对**的（`src/host/app.js` 属于 `deepseek/prompt-enhancer-release`），
  //     而新模型的落点是**被治理根相对**的。不做这步对齐，全部落点都解析不到 —— 实测会得到 80/80 全 STALE 的假警报。
  const projectOfFeature = {}
  for (const [code, mod] of Object.entries(featureModule)) {
    const owner = moduleOwner[mod]
    if (owner) projectOfFeature[code] = owner
  }
  let qualified = 0
  const unresolvedFiles = []
  for (const d of drafts) {
    if (d.layer !== 'feature' || !(d.fields.files || []).length) continue
    const owner = projectOfFeature[d.id]
    const prefix = owner ? normSlashes(projectPaths[owner] || '') : ''
    const out = []
    for (const f of d.fields.files) {
      const rel = normSlashes(f)
      if (existsSync(join(rootPath, rel))) { out.push(rel); continue }              // 已经是 root 相对
      if (prefix && existsSync(join(rootPath, prefix, rel))) { out.push(`${prefix}/${rel}`); qualified++; continue }  // 项目相对 → 补前缀
      if (isGlob(rel)) { out.push(prefix ? `${prefix}/${rel}` : rel); continue }     // glob 不做存在性判定
      out.push(rel)
      unresolvedFiles.push(`${d.id}: ${rel}${prefix ? `（也试过 ${prefix}/${rel}）` : ''}`)
    }
    d.fields.files = [...new Set(out)].sort()
  }
  if (unresolvedFiles.length) warnings.push(`${unresolvedFiles.length} 个落点两处都找不到（已按原样登记，会在模型里报 STALE）: ${unresolvedFiles.slice(0, 5).join('; ')}${unresolvedFiles.length > 5 ? ' …' : ''}`)
  if (qualified) warnings.push(`${qualified} 个落点按所属项目补了路径前缀（旧索引是项目相对口径）`)

  // ④ 主线向量
  const vector = readJsonSafe(join(dir, 'vector.json'))
  if (vector) {
    drafts.push({ kind: 'set', vector: { doing: vector.doing || '', next: vector.next || '', notDoing: vector.notDoing || '', exitCondition: vector.exitCondition || '' } })
  }

  // ⑤ 参考文档工件
  const docs = readJsonSafe(join(dir, 'nav-docs.json'))
  for (const d of docs?.docs || []) {
    drafts.push({
      kind: 'node', op: 'upsert', layer: 'artifact', id: d.id || d.path || d.title,
      fields: { name: d.title || d.id, path: d.path || '', when: d.when || '', tags: d.tags || [], project: d.project || '' }
    })
  }

  // ⑥ 改动账本 → commit 事件（保持 open/closed 形态：收口仍按证据判定）
  //
  // 无证据的在途动作要**丢弃并报数**，不能带进来：
  // 新架构里"在途"意味着"有人正在改，改完按证据自动收口"；而 scopeFiles/scopeState 是 v0.4.0 才有的字段，
  // 更早的动作**全都没有**（实测本仓 45 个动作里 0 个有 scopeFiles）。没有证据 = 永远无法自动收口 = 永久孤儿，
  // 正是新架构要根除的东西。它们的历史记录仍然保留在归档的旧账本里。
  const actions = readJsonSafe(join(dir, 'nav-actions.json'))
  let droppedOpenNoEvidence = 0
  for (const a of actions?.actions || []) {
    const scope = a.scope || {}
    const files = Array.isArray(a.scopeFiles) ? a.scopeFiles.map(normSlashes) : []
    const evidence = a.scopeState || a.fingerprint?.files || {}
    const isOpen = a.status === 'planned' || a.status === 'in_progress' || a.status === 'expired'
    if (isOpen && !files.length && !Object.keys(evidence).length) { droppedOpenNoEvidence++; continue }
    drafts.push({
      kind: 'commit',
      phase: isOpen ? 'open' : 'closed',
      anchor: a.anchor || '',
      task: a.task || a.id || '(migrated action)',
      plan: a.plan || '',
      scope: { features: scope.features || [], modules: scope.modules || [], files: scope.files || [] },
      arch: a.archBasis ?? a.arch ?? null,
      actor: a.owner?.sessionId || a.owner?.label || null,
      files,
      evidence,
      outcome: isOpen ? null : { evidence: 'migrated', status: a.status, drift: a.drift || null },
      migratedFrom: a.id || null
    })
  }
  if (droppedOpenNoEvidence) warnings.push(`${droppedOpenNoEvidence} 个"在途"动作没有任何 scope 证据（旧版 v0.4.0 之前无此字段）→ 未迁移为在途意图（它们永远无法按证据收口，会变成永久孤儿；原始记录仍在归档的 nav-actions.json 里）`)

  // ⑦ 决策 → decide 事件
  const arch = readJsonSafe(join(dir, 'nav-arch.json'))
  for (const d of arch?.decisions || []) {
    drafts.push({
      kind: 'decide', anchor: d.anchor || '', reason: d.reason || '', decision: d.decision || '',
      impact: d.impact || '', action: d.action || null
    })
  }
  return { drafts, warnings }
}

/**
 * 执行迁移：写事件 → 归档旧账本 → 落标记。
 * **必须先干跑看过**（inspectLegacy）；迁移后旧账本只读快照，不再被任何代码读写。
 */
export async function migrateLegacy(rootPath, { now = Date.now() } = {}) {
  const info = inspectLegacy(rootPath)
  if (info.alreadyMigrated) {
    return { status: 'already-migrated', marker: info.marker }
  }
  const { drafts, warnings } = legacyToDrafts(rootPath)
  if (!drafts.length) {
    return { status: 'nothing-to-migrate', files: info.files, warnings }
  }
  const written = await appendEvents(rootPath, drafts, { now })

  // 归档：旧账本移入 .internal/legacy/（只读快照，不再被读写）
  const legacyDir = paths.legacyDir(rootPath)
  mkdirSync(legacyDir, { recursive: true })
  const archived = []
  for (const f of LEGACY_FILES) {
    const abs = join(rootPath, '.internal', f)
    if (!existsSync(abs)) continue
    const dest = join(legacyDir, f)
    try {
      renameSync(abs, dest)
      archived.push({ file: f, to: `.internal/legacy/${f}` })
    } catch (e) {
      warnings.push(`归档 ${f} 失败（迁移已完成，但旧文件仍在原位）：${e.message}`)
    }
  }
  const marker = {
    at: nowIso(now),
    events: written.length,
    seqRange: written.length ? [written[0].seq, written[written.length - 1].seq] : [],
    archived,
    warnings,
    note: '旧账本已折叠为事件流并归档为只读快照。任何后续治理数据只写 .internal/events.jsonl。'
  }
  rewriteVerified(join(legacyDir, MARKER), JSON.stringify(marker, null, 2))
  // 兼容旧标签
  try { writeFileSync(join(legacyDir, '.gitignore'), '# 只读快照，永不写入\n', 'utf-8') } catch { /* 非关键 */ }
  return { status: 'migrated', ...marker }
}
