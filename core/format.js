// core/format.js — 渲染与解析的薄工具（不含业务判断）
//
// 一切"说给模型看"的文本都在这里成形，避免 host 里散落字符串模板。

import { key, normSlashes } from './paths.js'
import { coverage, moduleBelongsTo, filePressure, governanceSovereignty, governanceVitality, REPEAT_PATCH_THRESHOLD } from './model.js'
import { renderTreeText, vectorFields } from './render.js'
// 在途缓存 ⟷ 模型的差集：**从 commit.js 借来**的纯目录+数集派生，不是第二真相（见那边注释）。
import { inflightDrift } from './commit.js'

/** health 里「文件职责」一节最多显示多少个落点文件（排序在模型层，确定性）。 */
const FILE_PRESSURE_TOP = 8

export function splitList(s) {
  return s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []
}

/** 解析 `k=v,k2=v2` 形式的附加字段。 */
export function parseKv(pairs) {
  const out = {}
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const s = String(p)
    const i = s.indexOf('=')
    if (i < 0) continue
    const k = s.slice(0, i).trim()
    const v = s.slice(i + 1).trim()
    if (k) out[k] = v
  }
  return out
}

export function truncate(s, n = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 查证申报（`plan` 字段）的渲染形态 —— PN-S1。
 *
 * 为什么不直接输出原文：`plan` 是**裸串**，`"查过了"` 与完整三段声明在任何出口上等价
 * ⇒ 只渲原文时，"填了没有"这件事无法被断言，判据永不失败（与假绿同构）。
 * 故同打段数：`(未填)` / `<原文>（3 段）`。段数只按 `；`/`;`/换行切分 ——
 * 不做语义解析、不设阈值（非空率阈值口径本身就是错的：收口事件结构性带 plan:''）。
 */
export function planBrief(plan, n = 80) {
  const s = String(plan ?? '').trim()
  if (!s) return '(未填)'
  const segs = s.split(/[；;\n]+/).filter((x) => x.trim()).length
  return `${truncate(s, n)}（${segs} 段）`
}

export function renderHealth(model, { rootPath, opens, locks = [], inflight = [], logCheck = null } = {}) {
  const cv = coverage(model)
  const L = []
  L.push('Health')
  L.push(`  Root: ${rootPath}`)
  L.push(`  事件流: ${model.eventCount} 事件${logCheck ? (logCheck.ok ? '（seq 连续 ✓）' : `（⛔ ${logCheck.problems.length} 处异常）`) : ''}`)
  // ---- 层①：覆盖 ----
  L.push('')
  L.push('  【覆盖】')
  L.push(`  模型: 项目 ${cv.projects} · 模块 ${cv.modules} · 功能 ${cv.features} · 文档工件 ${cv.artifacts} · 已退役 ${cv.retired}`)
  // 落点分母：**三桶自证可加和**（磁盘文件 = 命中 + 未登记 + 显式跳过），差额非 0 时必须
  // 有名有姓地列出来 —— 旧读数把「登记**条目**」与「磁盘**文件**」并排成一行，
  // 两个分母不同却被当成一份账去减（治理根实测 156 + 3460 = 3607 > 3605，差 -2 且无处可查）。
  L.push(`  落点: 登记条目 ${cv.registeredEntries ?? cv.registeredFiles}（口径见下行）· 未登记 ${cv.unregisteredFiles} · STALE ${model.stale.length}`)
  if (cv.disk) {
    const d = cv.disk
    const w = cv.walk || {}
    // 截断**显式**：命中上限时读数必须写明，否则"缺口数"看起来是个完整的数（本仓无静默截断纪律）。
    const cut = w.truncated
      ? ` · ⚠ 已截断（走盘上限 ${w.max}，实得 ≥${w.atLeast} ⇒ 还有文件没走到，未登记数是**下界**）`
      : ` · 未截断（上限 ${w.max}，实得 ${w.counted}）`
    L.push(`  磁盘: ${d.files} 文件 = 命中 ${d.hit} + 未登记 ${d.unregistered} + 显式跳过(glob) ${d.skipped}` +
      `${d.balanced ? ' ✓ 可加和（差 0）' : ` ⛔ 差集 ${d.residual}（不平）`}${cut}`)
    const r = cv.registered || null
    if (r) {
      L.push(`  登记: ${r.entries} 条目 = 唯一键 ${r.uniqueKeys} + 重复条目 ${r.duplicateEntries}（glob 字面量 ${r.globEntries}）` +
        ` · 唯一键 = 在盘 ${r.onDisk} + 不在盘 ${r.offDisk}${r.onDisk + r.offDisk === r.uniqueKeys ? ' ✓' : ' ⛔（不平）'}`)
      // ⚠ 两侧分母不同 ⇒ 两个数**不能直接相减**。但把它们与磁盘侧摆在一起时，差额**有确定归属**，
      //   恒等式（可核，任一项都能在上面几行里找到）：
      //     登记条目 + 未登记 − 磁盘文件  ≡  不在盘 + 重复条目 + glob字面量 − 显式跳过
      //   推导：E = (K + DUP) + G 而 D = ON + U + S 且 H = ON
      //         ⇒ E + U − D = OFF + DUP + G − S。
      //   ⚠ 不要写成"E − (U + H)"：那是在拿登记条目减**磁盘侧两项之和**，量纲不成立，
      //     会给出一个无意义的负数（本席首版即犯此错，实测 -3452）—— 读数**不能**教人算错账。
      const lhs = (cv.registeredEntries ?? cv.registeredFiles) + d.unregistered - d.files
      const rhs = r.offDisk + r.duplicateEntries + r.globEntries - d.skipped
      L.push(`    ⚠ 两个分母（登记条目 / 磁盘文件）**不能直接相减**；摆在一起的差额有确定归属：` +
        `登记条目 + 未登记 − 磁盘文件 = ${lhs} ≡ 不在盘 ${r.offDisk} + 重复条目 ${r.duplicateEntries} + glob ${r.globEntries} − 跳过 ${d.skipped} = ${rhs}` +
        `${lhs === rhs ? ' ✓' : ' ⛔（恒等式不成立，请按上面几行逐项核对）'}`)
      if (r.offDiskFiles.length) {
        const shown = r.offDiskFiles.slice(0, 8)
        L.push(`    · 不在盘的登记落点 ${r.offDiskFiles.length}：${shown.join('、')}${r.offDiskFiles.length > shown.length ? ` …(+${r.offDiskFiles.length - shown.length}，全量 = nav_graph mode=json)` : ''}（同时计入上方 STALE）`)
      }
      if (r.misbucketed.length) {
        const shown = r.misbucketed.slice(0, 8)
        L.push(`    ⚠ 口径不一致 ${r.misbucketed.length}：这些文件按"未登记"计，其实登记在**非 feature 层**：${shown.join('、')}${r.misbucketed.length > shown.length ? ` …(+${r.misbucketed.length - shown.length}，全量 = nav_graph mode=json)` : ''}`)
      }
    }
  }
  // 四字段一律显式（唯一权威 = render.js 的 vectorFields）：缺席必须可分辨。
  const vf = vectorFields(model.vector)
  L.push(`  主线: doing=${vf.doing} | next=${vf.next}`)
  L.push(`  反目标(notDoing): ${vf.notDoing}`)
  L.push(`  完成判据(exitCondition): ${vf.exitCondition}`)
  L.push('')
  L.push(`  在途改动 (${opens.length}): ${opens.length ? '' : '(无)'}`)
  for (const c of opens) {
    const age = Math.round((Date.now() - Date.parse(c.at)) / 60000)
    L.push(`    · ${c.id} ${truncate(c.task, 70)} | anchor=${c.anchor} | ${(c.files || []).length} 文件 | ${age} 分钟前 | ${c.actor ? `actor=${String(c.actor).slice(0, 8)}` : 'actor=?'} | 查证申报 ${planBrief(c.plan, 40)}`)
  }
  // ---- 在途缓存 ⟷ 模型 的差集：**常驻一行**（可确定断言：两边 seq 数集比对）----
  //
  // 病根（2026-09-25 实测）：`writeInflight` / `clearInflight` 双双 `catch {}` 吞掉，
  // 而旧版这里只在"缓存非空"时打一句原始计数 —— 于是治理根"模型 22 笔在途 / inflight 目录 21 个文件"
  // 这种不一致**在任何一个可读面上都不存在**（不相等这件事没有任何出口）。
  // ⚠ "缓存可丢"（I3）说的是**收口判据不依赖它**（判据在事件流，I1），不是"它坏了可以不报"。
  //   两者混为一谈，缺陷就永远无声。判据本身也只读 **seq 数集**（不读内容、不计耗时）。
  //   ⚠ 不新增参数位：差集由**模型 + 磁盘缓存命名**当场派生（`inflightDrift`）——
  //     多开一个可选参数就多一个"宿主漏传即静默失效"的点，而这里根本不需要调用方记得喂。
  //   ⚠ 截断的取回路径写**真能取回**的地方：health 的 json 快照不含差集明细（host 未改），
  //     指到 mode=json 就是一句假承诺 —— 本仓最忌"训练人相信错的东西"。
  const dr = rootPath ? inflightDrift(rootPath, model) : null
  if (dr) {
    const head = `在途缓存 ⟷ 模型: 缓存 ${dr.cached} 个 / 模型 ${dr.open} 笔 / 差集 ${dr.read}`
    if (!dr.ok) {
      // ---- 第三态：「读不到」≠「不一致」（A2 裁决：读失败不得被当成差异）----
      // 病根（2026-09-25 实测）：`inflightDrift` 把 readdir 失败送进 `unreadable`，
      // 但**没有任何消费者** —— 这里只读 consistent/missing/extra/skipped，全仓 grep 无 dr.unreadable。
      // 后果不是"少报一句"：目录读不到时 files 为空集 ⇒ missing 凭空长出"模型有 open 而缓存缺 N 笔"
      // （点名 ACT-xxxx），health 打「**不一致**」并把人支去核对收口回执 ——
      // **拿读失败当差异**，正是本项要治的形态；它只是从 `catch {}` 搬进了注释。
      // 判据（读得到吗）与对账（一致吗）**不是同一个问题**，故必须先分流：
      // 这里既不打「不一致」、也不给差集明细（判据不可得时输出差集就是造差异）。
      // 与「一致时不报」（防狼来了）同源：报的是**亲眼看到的**那一态。
      L.push(`    ⚠ 在途缓存 ${dr.dir} **读不到** —— 不是"不一致"：对账判据（<seq>.json 数集）本次拿不到，不判差集`)
      for (const u of dr.unreadable) L.push(`       · ${u}`)
      L.push('       → 缓存可丢（I3），但「读不到」与「丢了」必须可辨；目录被占位/权限修好即恢复判定。')
    } else if (dr.consistent) {
      L.push(`    ${head}：一致（按 <seq>.json 数集比对，确定性）`)
    } else {
      L.push(`    ⚠ ${head} —— **不一致**（按 <seq>.json 数集比对，确定性）`)
      const MISS_TOP = 8
      const miss = dr.missing.slice(0, MISS_TOP).map((m) => m.id)
      L.push(`       · 模型有 open 而缓存缺 ${dr.missing.length} 笔${miss.length ? `: ${miss.join('、')}` : ''}`)
      if (dr.missing.length > miss.length) L.push(`         …(+${dr.missing.length - miss.length}，共 ${dr.missing.length} 笔；全量 = phase:open 的 commit 事件 .internal/events.jsonl)`)
      const EXTRA_TOP = 8
      const extra = dr.extra.slice(0, EXTRA_TOP).map((e) => e.id)
      L.push(`       · 缓存有而模型不在途 ${dr.extra.length} 个${extra.length ? `: ${extra.join('、')}` : ''}`)
      if (dr.extra.length > extra.length) L.push(`         …(+${dr.extra.length - extra.length}，共 ${dr.extra.length} 个；全量 = 目录 .internal/runtime/inflight/)`)
      L.push('       → 缓存是可丢的（I3），但"丢了 / 清不掉"必须可见；核对收口回执里有没有同期的失败行。')
    }
    // 未归类残骸**两个分支都要报**（放在 if 里就成了"一致时不提"的静默丢弃）。
    if (dr.skipped.length) {
      L.push(`       · ⚠ 未归类残骸 ${dr.skipped.length} 个（非 <seq>.json 命名，不计入差集）: ${dr.skipped.slice(0, 8).join('、')}${dr.skipped.length > 8 ? ` …(+${dr.skipped.length - 8}，共 ${dr.skipped.length} 个)` : ''}`)
    }
  } else if (inflight.length) {
    L.push(`    在途状态文件: ${inflight.length}（runtime 缓存，可丢）`)
  }
  L.push('')
  L.push(`  架构决策: ${model.decisions.length} 条${model.decisions.length ? `（最近 ${model.decisions[model.decisions.length - 1].id} @ ${model.decisions[model.decisions.length - 1].anchor}）` : ''}`)
  const pressure = [...model.patchPressure.values()].filter((p) => {
    if (p.sinceDecisionCount < 2) return false
    const n = model.nodes.get(p.anchor)
    return !(n && n.status === 'retired')     // 退役锚点的历史计数没有意义：它已不可能再被锚定
  })
  if (pressure.length) {
    L.push('  ⚠ 计数闸压力:')
    for (const p of pressure) L.push(`    · ${p.anchor} ${p.sinceDecisionCount}/${REPEAT_PATCH_THRESHOLD}（自 ${p.sinceDecision || '项目开始'}）`)
  }
  // 文件职责压力：一个文件被几个不同架构节点登记为落点。
  // 只报不拒 —— 拆不拆是架构判断（走 ADR），不是阈值判断。阈值 3 与计数闸同一量级：
  // 两个功能共用文件是正常设计，三个以上才是"这个文件在替多个功能兜底"。
  const fp = filePressure(model)
  if (fp.files.length) {
    L.push('')
    L.push(`  文件职责（登记落点派生 · 只读）：${fp.files.length} 个落点文件${fp.over.length ? ` · ⚠ ${fp.over.length} 个被 ≥${fp.threshold} 个节点共用` : ''}`)
    for (const f of fp.files.slice(0, FILE_PRESSURE_TOP)) {
      const names = f.owners.map((o) => o.name || o.id).join(' / ')
      L.push(`    ${f.over ? '⚠' : '·'} ${f.file} — 归属 ${f.ownerCount}（${names}）· 被引 ${f.din} · 引用 ${f.dout}`)
    }
    if (fp.files.length > FILE_PRESSURE_TOP) L.push(`    …(+${fp.files.length - FILE_PRESSURE_TOP}，全量 = nav_graph mode=json)`)
    if (fp.over.length) L.push(`    → ${fp.over.length} 个文件被 ≥${fp.threshold} 个节点共用（只读信号，不拒写入）`)
  }
  if (model.stale.length) {
    L.push('')
    L.push(`  STALE 落点 (${model.stale.length}) — 登记了但磁盘上没有:`)
    for (const s of model.stale.slice(0, 15)) L.push(`    · ${s.file} <- ${s.node}`)
    if (model.stale.length > 15) L.push(`    …(+${model.stale.length - 15}，全量 = nav_graph mode=gaps)`)
  }
  if (model.log.length) {
    L.push('')
    L.push(`  ⛔ 模型自身问题 (${model.log.length}) —— 不吞:`)
    for (const p of model.log.slice(0, 10)) L.push(`    · seq=${p.seq ?? '?'} ${truncate(p.problem, 110)}`)
    if (model.log.length > 10) L.push(`    …(+${model.log.length - 10}，全量 = 事件流逐条可查 .internal/events.jsonl)`)
  }
  if (locks.length) {
    L.push('')
    L.push(`  runtime 锁 (${locks.length}):`)
    for (const l of locks) L.push(`    · ${l.name} age=${Math.round(l.ageMs / 1000)}s pid=${l.pid ?? '?'}`)
  }

  // ---- 层②：主权（0.11.0 · 纯派生，零订阅） ----
  // 回答"项目是不是在插件之外自建了一套治理"。**只读上报，不删除、不拒绝写入**：
  // 删除是危险操作；接管的正确形态是"登记 + 通报 + 收敛"，不是破坏性抢占。
  const sov = governanceSovereignty(model)
  L.push('')
  L.push('  【主权】插件应独占治理；以下为插件之外的治理件（只读信号）')
  if (sov.sovereign) {
    L.push('  ✓ 未发现外来治理件——治理主权完整')
  } else {
    if (sov.runners.length) {
      L.push(`  ⚠ 外来治理入口 ${sov.runners.length} 个（**接管单元是入口**，不是它驱动的每个脚本）:`)
      for (const f of sov.runners.slice(0, 8)) L.push(`    · ${f}`)
    }
    if (sov.foreignScripts.length) {
      L.push(`  ⚠ 外来治理脚本 ${sov.foreignScripts.length} 件（疑似自建门禁）:`)
      for (const f of sov.foreignScripts.slice(0, 8)) L.push(`    · ${f}`)
      if (sov.foreignScripts.length > 8) L.push(`    …(+${sov.foreignScripts.length - 8}，全量 = nav_graph mode=json)`)
    }
    if (sov.parallelLedgers.length) {
      L.push(`  ⚠ 并行账本 ${sov.parallelLedgers.length} 件（插件之外的第二本账）:`)
      for (const f of sov.parallelLedgers.slice(0, 8)) L.push(`    · ${f}`)
    }
    L.push('  → 登记即接管（三档，按 when 的**首词**判定）：')
    L.push('      exempt    —— 确认保留，退出告警（理由可审计）')
    L.push('      refs      —— 领域适应度函数（管的是别的领域），退出"未知外来件"')
    L.push('      competing —— 确认与插件重叠的"第二本账"，**告警保留**但升级为"已接管·待收敛"')
    L.push('    ⚠ 本项只报告不处置：删除属危险操作，且产品/构建脚本常与治理脚本同名相似。')
  }
  if (sov.referenced.length || sov.exempted.length || sov.pendingConvergence.length) {
    L.push('')
    L.push(`  已接管登记: refs ${sov.referenced.length} · exempt ${sov.exempted.length} · competing（待收敛）${sov.pendingConvergence.length}`)
    for (const f of sov.pendingConvergence.slice(0, 6)) L.push(`    · 待收敛 ${f}`)
    if (sov.pendingConvergence.length > 6) L.push(`    …(+${sov.pendingConvergence.length - 6}，全量 = nav_graph mode=json)`)
  }

  // ---- 层③：活力（"治理被绕过"的只读信号） ----
  const vit = governanceVitality(model)
  L.push('')
  L.push('  【活力】')
  if (!vit.newestFile) {
    L.push('  最近改动: (无可判落点文件)')
  } else {
    L.push(`  最近改动: ${vit.newestFile} @ ${vit.newestAt}`)
    L.push(`  上次治理登记: ${vit.lastCommitAt || '(从未登记)'}`)
    if (vit.bypassed) {
      const mins = Math.round(vit.bypassedMs / 60000)
      L.push(`  ⚠ 治理可能被绕过：改动晚于登记 ${mins} 分钟（容差 60s，只读信号不拒写入）`)
      L.push('    → 若这次改动确实该登记，跑 nav_commit；若属未登记范围，先 nav_node 补登记。')
    } else if (vit.bypassedMs === null) {
      L.push('  · 尚无治理登记，无法判定绕过')
    } else {
      L.push('  ✓ 最近改动未晚于治理登记（无绕过迹象）')
    }
  }
  return L.join('\n')
}

export function renderScopeTarget(model, loc) {
  const L = []
  if (loc.kind === 'unknown') {
    L.push(`No mapping found for "${loc.target}".`)
    // PN-S2：零命中必须**给候选**，不是丢回一句"没有"（ARCHITECTURE §2②：少展示要可见且可取回）。
    const cands = loc.candidates || []
    const shown = cands.slice(0, 5)
    if (shown.length) {
      L.push(`  · 最接近的已登记节点（共 ${cands.length} 条候选，此处前 ${shown.length}；2-gram 重叠打分，确定性排序）：`)
      for (const c of shown) L.push(`      ${c.id}${c.name ? ` — ${truncate(c.name, 50)}` : ''}（重叠 ${c.score}）`)
      L.push('  · 若是其中某个：直接 nav_graph <它的 id> 取精确落点')
    } else {
      L.push('  · 候选 0 条 —— 目标词与任何已登记节点的 2-gram 都不重叠')
    }
    L.push('  · 若是新功能：nav_node target=<功能码> name=… userView=… files=…（登记落点）')
    L.push('  · 若是新模块：nav_node target=<模块名> features=<功能码,功能码> project=<项目>')
    L.push('  · 若是文件但未登记：nav_node target=<功能码> set=files=<逗号分隔路径>')
    return L.join('\n')
  }
  if (loc.kind === 'file') {
    L.push(`File: ${loc.file}`)
    if (!loc.owners.length) L.push('  ⚠ 该文件未被任何功能登记 -> 会算进"未登记"缺口')
    for (const o of loc.owners) {
      L.push(`  <- 功能 ${o.name}${o.meta?.name ? ` (${o.meta.name})` : ''}`)
      const mod = o.module ? model.nodes.get(`module:${key(o.module)}`) : null
      if (mod) {
        const proj = mod.project ? model.nodes.get(mod.project) || model.nodes.get(`project:${key(mod.project)}`) : null
        L.push(`     -> 模块 ${mod.name}${proj ? ` -> 项目 ${proj.name}` : ''}`)
      } else L.push('     -> (未挂模块)')
    }
    return L.join('\n')
  }
  const n = loc.node
  if (loc.kind === 'project') {
    L.push(`Project: ${n.name}${n.meta?.path ? ` — ${n.meta.path}` : ''}`)
    const mods = [...model.nodes.values()].filter((m) => m.layer === 'module' && m.status === 'active' && moduleBelongsTo(m, n))
    for (const m of mods) {
      const feats = (m.features || []).map((c) => model.nodes.get(`feature:${key(c)}`)).filter(Boolean)
      L.push(`  ▸ ${m.name} (${feats.length} 功能)`)
      for (const f of feats) L.push(`     ○ ${f.name}${f.meta?.name ? ` — ${f.meta.name}` : ''}  [${(f.files || []).length} 文件]`)
    }
    if (!mods.length) L.push('  (无模块)')
    return L.join('\n')
  }
  if (loc.kind === 'module') {
    L.push(`Module: ${n.name}${n.meta?.name ? ` — ${n.meta.name}` : ''}${n.project ? ` · project=${n.project}` : ' · (未归属项目)'}`)
    const feats = (n.features || []).map((c) => model.nodes.get(`feature:${key(c)}`)).filter(Boolean)
    for (const f of feats) {
      L.push(`  ○ ${f.name}${f.meta?.name ? ` — ${f.meta.name}` : ''}`)
      if (f.meta?.userView) L.push(`      用户视角: ${truncate(f.meta.userView, 110)}`)
      if (f.meta?.systemView) L.push(`      系统视角: ${truncate(f.meta.systemView, 110)}`)
      const fl = f.files || []
      for (const file of fl.slice(0, 15)) L.push(`      · ${file}`)
      if (fl.length > 15) L.push(`      · …(+${fl.length - 15}，全量 = nav_graph mode=task target=${f.name})`)
    }
    return L.join('\n')
  }
  if (loc.kind === 'artifact') {
    L.push(`Artifact: ${n.name}`)
    L.push(`  path: ${n.path}`)
    L.push(`  when (路由规则): ${n.when || '(未填)'}`)
    if (n.tags?.length) L.push(`  tags: ${n.tags.join(', ')}`)
    return L.join('\n')
  }
  // feature
  L.push(`Feature: ${n.name}${n.meta?.name ? ` — ${n.meta.name}` : ''}${n.status === 'retired' ? ' (已退役)' : ''}`)
  if (n.meta?.userView) L.push(`  用户视角: ${n.meta.userView}`)
  if (n.meta?.systemView) L.push(`  系统视角: ${n.meta.systemView}`)
  if (n.module) L.push(`  模块: ${n.module}`)
  else L.push('  模块: (未挂)')
  for (const file of n.files || []) {
    const stale = model.stale.some((s) => s.node === n.id && s.file === file)
    L.push(`  落点: ${file}${stale ? '  ⛔STALE(磁盘无此文件)' : ''}`)
  }
  if (!(n.files || []).length) L.push('  落点: (空 — 用 nav_node set=files=… 登记)')
  const inflight = model.openCommits.filter((c) => (c.files || []).some((f) => (n.files || []).includes(f)))
  for (const c of inflight) L.push(`  🔴 在途: ${c.id} ${truncate(c.task, 70)}`)
  const pressure = model.patchPressure.get(key(n.id))
  if (pressure) L.push(`  补丁计数: ${pressure.sinceDecisionCount}/${REPEAT_PATCH_THRESHOLD}（自 ${pressure.sinceDecision || '项目开始'}）`)
  return L.join('\n')
}

/**
 * 影响面（依赖图 · 文件精度）。这是"全局思想"的读侧入口：
 * 动手前看一眼——我改的东西，谁在引用；我又引用了谁。
 */
export function renderImpact(model, loc) {
  const files = loc.kind === 'file' ? [loc.file] : (loc.node?.files || [])
  const title = loc.kind === 'file'
    ? `File: ${loc.file}`
    : `${loc.kind}: ${loc.node?.name}${loc.node?.meta?.name ? ` — ${loc.node.meta.name}` : ''}`
  if (!files.length) return `${title}\n  落点: (空) —— 依赖图无话可说（先 nav_node files= 登记落点）`

  const inside = new Set(files.map(key))
  const mine = new Set(files.map(normSlashes))

  const outbound = new Map()          // 我的文件 → 它引用的 scope 外文件
  for (const f of mine) {
    const tos = (model.edges.fileEdges.get(f) || []).filter((t) => !inside.has(key(t)))
    if (tos.length) outbound.set(f, tos)
  }
  const inbound = new Map()           // scope 外文件 → 它引用的我的文件
  for (const [from, tos] of model.edges.fileEdges) {
    if (inside.has(key(from))) continue
    const hits = tos.filter((t) => inside.has(key(t)))
    if (hits.length) inbound.set(normSlashes(from), hits)
  }

  const L = [`${title}  —  ${files.length} 个落点文件`, '']
  L.push(`↓ 我引用谁（${outbound.size} 个落点有外部依赖）:`)
  if (!outbound.size) L.push('  (无 —— 不依赖任何 scope 外文件)')
  for (const [f, ts] of [...outbound].slice(0, 12)) L.push(`  ${f} → ${ts.slice(0, 6).join(', ')}${ts.length > 6 ? ` …+${ts.length - 6}` : ''}`)
  if (outbound.size > 12) L.push(`  …(+${outbound.size - 12}，全量 = nav_graph mode=json)`)

  const nodes = new Set()
  for (const f of inbound.keys()) for (const o of model.fileOwners.get(key(f)) || []) nodes.add(o)
  L.push('')
  L.push(`↑ 谁引用我 = 影响面（${inbound.size} 个文件 · ${nodes.size} 个节点）:`)
  if (!inbound.size) L.push('  (无 —— 没有 scope 外文件依赖它，这次改动是局部封闭的)')
  for (const [f, ts] of [...inbound].slice(0, 12)) L.push(`  ${f} ← 被 ${ts.slice(0, 6).join(', ')}${ts.length > 6 ? ` …+${ts.length - 6}` : ''} 引用`)
  if (inbound.size > 12) L.push(`  …(+${inbound.size - 12}，全量 = nav_graph mode=json)`)
  if (nodes.size) L.push(`  波及节点: ${[...nodes].slice(0, 12).join('、')}${nodes.size > 12 ? ` …+${nodes.size - 12}（全量 = nav_graph mode=json）` : ''}`)

  const e = model.edges
  const sc = e.scope || { mode: 'all', dirs: [], candidates: 0 }
  const where = sc.mode === 'projects'
    ? `已登记项目目录（${sc.dirs.length} 个）`
    : '全仓 fallback（取不到项目目录 ⇒ 降级为全量，绝不静默扫空）'
  L.push('')
  L.push(`依赖图: 范围=${where} · 候选 ${sc.candidates} 文件 → 扫 ${e.scanned} 个代码文件 · ${e.fileEdges.size} 条文件边 · 外部包 ${e.external.size} 个文件有 bare import`)
  if (e.unresolved.length) L.push(`  ⚠ ${e.unresolved.length} 条相对引用解析不到（未静默丢弃，用 mode=json 可取全量）`)
  if (e.skipped.length) L.push(`  跳过 ${e.skipped.length} 个超体量文件（打包产物，噪声大于信号）`)
  return L.join('\n')
}

export function renderGaps(model, { limit = 30 } = {}) {
  const L = []
  const den = model.denominator || null
  const w = den?.walk || null
  // ⚠ 截断与 STALE 名单一样，必须**在入口处**就说清：截断时"未登记 N"是下界不是总数。
  const cut = w && w.truncated ? `（⚠ 走盘已截断 @上限 ${w.max}，实得 ≥${w.atLeast} ⇒ 下面的未登记数是**下界**）` : ''
  L.push(`Gaps — 未登记文件 ${model.unregistered.length} · STALE 落点 ${model.stale.length}${cut}`)
  // 三桶自证：磁盘文件 = 命中 + 未登记 + 显式跳过。skip 桶不给出口就等于静默丢弃
  // （走盘跳过了、清单里又没有 ⇒ 它从任何读数里消失）。这里按节点聚合，全量走 mode=json。
  if (den) {
    const d = den.disk
    L.push(`  分母自证: 磁盘 ${d.files} = 命中 ${d.hit} + 未登记 ${d.unregistered} + 显式跳过(glob) ${d.skipped}` +
      `${d.balanced ? ' ✓ 可加和（差 0）' : ` ⛔ 差集 ${d.residual}（不平）`}`)
    if (den.skippedByGlob.length) {
      const byNode = new Map()
      for (const s of den.skippedByGlob) {
        if (!byNode.has(s.node)) byNode.set(s.node, [])
        byNode.get(s.node).push(s)
      }
      const globGroups = [...byNode.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
      L.push(`  显式跳过 ${den.skippedByGlob.length} 个文件（被登记 glob 覆盖 ⇒ 不算缺口，但**不是**被静默丢弃）:`)
      const TOPG = 6
      for (const [node, list] of globGroups.slice(0, TOPG)) {
        L.push(`    · ${list[0].glob} ← ${node} — ${list.length} 个（例: ${list.slice(0, 2).map((x) => x.file).join('、')}${list.length > 2 ? ` …+${list.length - 2}` : ''}）`)
      }
      if (globGroups.length > TOPG) L.push(`    · …另 ${globGroups.length - TOPG} 组 / ${den.skippedByGlob.length - globGroups.slice(0, TOPG).reduce((n, [, v]) => n + v.length, 0)} 个文件（全量 = nav_graph mode=json）`)
    }
    const r = den.registered
    if (r && (r.offDiskFiles.length || r.duplicateEntries || r.misbucketed.length)) {
      L.push(`  登记侧: ${r.entries} 条目 = 唯一键 ${r.uniqueKeys} + 重复条目 ${r.duplicateEntries} · 唯一键 = 在盘 ${r.onDisk} + 不在盘 ${r.offDisk}`)
      if (r.offDiskFiles.length) L.push(`    · 不在盘的登记落点（= 上面 STALE 的那 ${r.offDiskFiles.length} 条）: ${r.offDiskFiles.join('、')}`)
      if (r.misbucketed.length) L.push(`    ⚠ 口径不一致 ${r.misbucketed.length}：按"未登记"计，其实登记在**非 feature 层**: ${r.misbucketed.join('、')}`)
    }
  }
  if (model.unregistered.length) {
    // 按顶层目录聚合：每组计数 ⇒ 全量总数守恒（4,291 个名字压成几行，但没有任何文件被无声抹掉）
    const groups = new Map()
    for (const f of model.unregistered) {
      const slash = f.indexOf('/')
      const g = slash < 0 ? '(仓根散文件)' : f.slice(0, slash + 1)
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g).push(f)
    }
    const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    L.push('')
    L.push(`  未登记文件（磁盘上有、架构模型里没有落点 => 地图对它们失明）· 共 ${model.unregistered.length} 个，按顶层目录聚合：`)
    const TOP = 10
    for (const [g, fs] of sorted.slice(0, TOP)) {
      L.push(`    · ${g} — ${fs.length} 个（例: ${fs.slice(0, 2).join('、')}${fs.length > 2 ? ` …+${fs.length - 2}` : ''}）`)
    }
    if (sorted.length > TOP) L.push(`    · …另 ${sorted.length - TOP} 组 / ${model.unregistered.length - sorted.slice(0, TOP).reduce((n, [, fs]) => n + fs.length, 0)} 个文件（分组全量 = nav_graph mode=json）`)
    L.push('  -> nav_node target=<功能码> set=files=<路径> 把它挂到某个功能下')
  }
  if (model.stale.length) {
    L.push('')
    L.push(`  STALE（登记了但磁盘上没有 => 每次都会被报成漂移，假警报会腐蚀信号）· 共 ${model.stale.length} 条:`)
    for (const s of model.stale.slice(0, limit)) L.push(`    · ${s.file} <- ${s.node}`)
    if (model.stale.length > limit) L.push(`    · …(+${model.stale.length - limit}，全量 = nav_graph mode=json)`)
    L.push('  -> 真删了：nav_node target=<节点> retire=true；只是搬走：nav_node set=files=…')
  }
  // ⚠ 截断时**不得**判"无缺口"：没走到的文件当然也不会出现在缺口清单里，
  //   那句 ✓ 就成了"分母变小换来的假绿"（与裁断口径同族）。
  if (!model.unregistered.length && !model.stale.length) {
    if (w && w.truncated) L.push(`  ⚠ 未登记清单为空，但走盘@上限 ${w.max} 已截断（实得 ≥${w.atLeast}）⇒ **不能**判"无缺口"：没走到的文件不会出现在这里。`)
    else L.push('  ✓ 无缺口：登记与磁盘一致。')
  }
  return L.join('\n')
}

export function renderDocs(model, { task = '', project = '', tag = '' } = {}) {
  const arts = [...model.nodes.values()].filter((n) => n.layer === 'artifact' && n.status === 'active')
  let list = arts
  if (project) list = list.filter((a) => key(a.project) === key(project) || key(a.meta?.project) === key(project))
  if (tag) list = list.filter((a) => (a.tags || []).map(key).includes(key(tag)))
  if (!list.length) {
    return 'No reference docs registered.\n  用 nav_node target=<文档id> layer=artifact path=… when=… title=… 登记（when = 路由规则：哪类任务必须查它）。'
  }
  if (task) {
    const tk = key(task)
    const scored = list.map((a) => {
      let score = 0
      const when = key(a.when || '')
      if (when && tk) {
        for (const w of when.split(/[,，;；\s]+/).filter(Boolean)) if (w.length > 1 && tk.includes(w)) score += 3
      }
      if (key(a.name || '').split(/\s+/).some((w) => w.length > 1 && tk.includes(w))) score += 2
      for (const t of a.tags || []) if (tk.includes(key(t))) score += 2
      return { a, score }
    }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score)
    if (!scored.length) return `No doc matched task "${task}".\n  已登记 ${list.length} 份；可用 nav_graph mode=docs 全列。`
    const L = [`Docs for task "${truncate(task, 80)}" (${scored.length} 命中):`]
    for (const { a, score } of scored) L.push(`  · [${score}] ${a.name}\n      path: ${a.path}\n      when: ${a.when}`)
    return L.join('\n')
  }
  const L = [`Reference docs (${list.length}):`]
  for (const a of list) L.push(`  · ${a.name}${a.meta?.project ? ` [${a.meta.project}]` : ''}\n      path: ${a.path}\n      when: ${a.when || '(未填)'}`)
  return L.join('\n')
}

export function renderAdrs(model, { anchor = '', limit = 20 } = {}) {
  let list = model.decisions
  if (anchor) list = list.filter((d) => key(d.anchor) === key(anchor) || key(d.anchor).includes(key(anchor)))
  if (!list.length) return `No architecture decision recorded${anchor ? ` for anchor "${anchor}"` : ''}.\n  用 nav_decide anchor=… reason=… decision=… 登记（挂到节点上，决策天然有项目归属）。`
  const L = [`Architecture decisions (共 ${list.length} 条${anchor ? `, anchor=${anchor}` : ''}${list.length > limit ? `，此处最近 ${limit}；更早的按 anchor=<锚点> 或到事件流 grep ADR id` : ''}):`]
  for (const d of list.slice(-limit).reverse()) {
    L.push(`  · ${d.id} [${d.anchor}] ${d.at.slice(0, 10)}`)
    L.push(`      为什么必须改: ${truncate(d.reason, 150)}`)
    L.push(`      架构变成什么: ${truncate(d.decision, 150)}`)
    if (d.impact) L.push(`      影响面: ${truncate(d.impact, 130)}`)
  }
  return L.join('\n')
}

export function renderMap(model, { target = '' } = {}) {
  return renderTreeText(model, { target })
}

/**
 * 在场层（0.12.0）：**注入 agent 上下文的治理摘要**，零落盘。
 *
 * 这是被删除的落盘投影（PROJECT.md 标记区 / ARCH-MODEL.md / 地图）的 **agent 形态替代物**：
 * 那些文件的唯一读者是人，而 agent 不需要文件 —— 它需要**上下文里一直有治理**。
 *
 * ⚠ 三条硬约束（照抄可施工）：
 *  ① **只吃 `foldOnly` 的模型**（纯事件流，5.1ms），绝不 `buildModel`/`loadModel`
 *     —— 本函数在**每轮组装**时被调用，磁盘扫描（177ms）会拖慢每一次请求。
 *  ② **零写盘**：不落 runtime、不建锁、不追加事件（I3：删 runtime 零损失）。
 *  ③ **不知道的不说**：磁盘实况（STALE / 缺口 / 依赖图）不在廉价模型里，
 *     故这里**不报**它们 —— 报一个没算过的数就是假绿。
 *
 * 输出刻意短：常驻注入的内容按**每轮**计费，长文会挤掉真正的工作上下文。
 * 省略一律带 `共N` 交代（ARCHITECTURE §2②：少展示必须可见且可取回）。
 */
export function renderPresence(m) {
  if (!m) return ''
  const L = []
  const vf = vectorFields(m.vector)
  L.push('【project-nav · 治理在场】')
  L.push(`  主线: doing=${vf.doing} | next=${vf.next}`)
  L.push(`  反目标(notDoing): ${vf.notDoing}`)
  L.push(`  完成判据(exitCondition): ${vf.exitCondition}`)

  const opens = m.openCommits || []
  if (opens.length) {
    L.push(`  在途改动 (${opens.length}) —— 改前先看是否与你重叠:`)
    for (const c of opens.slice(0, 5)) {
      L.push(`    · ${c.id} ${truncate(c.task, 60)} | anchor=${c.anchor}`)
    }
    if (opens.length > 5) L.push(`    …(+${opens.length - 5}，全量 = nav_graph mode=health)`)
  } else {
    L.push('  在途改动 (0)')
  }

  // 计数闸压力：同一锚点反复补丁 = 该出架构决策了（第一性原理触发器）。
  const pressure = [...(m.patchPressure?.values() || [])].filter((p) => {
    if (p.sinceDecisionCount < 2) return false
    const n = m.nodes.get(p.anchor)
    return !(n && n.status === 'retired')
  })
  if (pressure.length) {
    L.push('  ⚠ 计数闸压力（同锚点反复补丁 ⇒ 该走 nav_decide 了）:')
    // 截断必须可在别处取回（ARCHITECTURE §2②；仓内 architecture.test.mjs 的"无静默截断"扫描器会扫这里）。
    const shownP = pressure.slice(0, 3)
    for (const p of shownP) L.push(`    · ${p.anchor} ${p.sinceDecisionCount}/${REPEAT_PATCH_THRESHOLD}`)
    if (pressure.length > shownP.length) {
      L.push(`    …(+${pressure.length - shownP.length}，共 ${pressure.length} 条；全量 = nav_graph mode=health)`)
    }
  }

  if (m.decisions?.length) {
    const last = m.decisions[m.decisions.length - 1]
    L.push(`  架构决策: ${m.decisions.length} 条（最近 ${last.id} @ ${last.anchor}）`)
  }
  // 模型自身的问题不吞（与 renderHealth 同一纪律）。
  if (m.log?.length) L.push(`  ⛔ 事件流异常 ${m.log.length} 处（全量 = nav_graph mode=health）`)

  L.push('  → 动手前: nav_commit(task, anchor, arch=) 登记；收口无需第二次调用（按证据自动收口）。')
  return L.join('\n')
}

/** 一笔 nav_commit 的结果文本（登记 / 被拒 / 自动收口）。 */
export function renderCommitResult(res, model) {
  const L = []
  if (res.reconcile?.closed?.length) {
    L.push(`自动收口 ${res.reconcile.closed.length} 笔（证据已变，与会话无关）:`)
    for (const { commit: c, diff } of res.reconcile.closed) {
      const bits = []
      if (diff.modified.length) bits.push(`改 ${diff.modified.length}`)
      if (diff.appeared.length) bits.push(`新增 ${diff.appeared.length}`)
      if (diff.vanished.length) bits.push(`消失 ${diff.vanished.length}`)
      L.push(`  ✓ ${c.id} ${truncate(c.task, 60)} — ${bits.join(' / ') || 'evidence changed'}`)
    }
    L.push('')
  }
  // ---- 在途缓存失败：登记回执**与**收口回执都要看得见 ----
  //
  // ⚠ 为什么收口回执也要有这一段：`clearInflight` 失败原先归 `catch {}`，
  // 于是"已收口（事件流里的事实）"与"残骸还留在缓存里（可读面上的不一致）"同时成立却无人说。
  // 精确性声明：这里只列**本次收口尝试里**清不掉的 —— 它不是账本，是回执。
  const faults = []
  if (res.inflightFault) faults.push({ op: 'write', id: res.commit?.id, error: res.inflightFault })
  const recFaulted = res.reconcile?.faulted || []
  for (const x of recFaulted) faults.push({ op: 'clear', id: x.id, error: x.error })
  if (faults.length) {
    L.push('⚠ 在途缓存失败 —— 缓存可丢（I3），但"丢了 / 清不掉"必须可见:')
    if (res.inflightFault) {
      L.push(`  ✗ ${res.commit?.id || '本笔'} 的在途缓存**写入失败**: ${truncate(res.inflightFault, 140)}`)
      L.push('     → 收口判据不受影响（证据快照写在事件流里，I1），但缓存差集会出现"模型有 open 而缓存缺"。')
    }
    for (const x of recFaulted) {
      L.push(`  ✗ ${x.id} 已收口（事件流），但其在途缓存**清理失败**: ${truncate(x.error, 140)}`)
      L.push('     → 该笔会在缓存里留下残骸（health 的差集一行会报出来）。')
    }
    L.push('    （详见 nav_graph mode=health 的「在途缓存 ⟷ 模型」一行）')
    L.push('')
  }

  if (res.status === 'blocked') {
    L.push('⛔ 闸门拒绝 — 本次改动未登记（先解决再动手）:')
    for (const b of res.gates.blocked) L.push(`  ${b.gate}: ${b.detail}`)
    for (const b of res.gates.blocked) if (b.hint) L.push(`     -> ${b.hint}`)
    const warns = res.gates.warnings
    if (warns.length) { L.push('  （同时的告警）'); for (const w of warns) L.push(`  ⚠ ${w.gate}: ${w.detail}`) }
    return L.join('\n')
  }
  if (res.status === 'rejected') {
    L.push(res.reason)
    if (res.hint) L.push(`  -> ${res.hint}`)
    if (res.materialized?.unresolved?.length) L.push(`  未解析: ${res.materialized.unresolved.join('; ')}`)
    return L.join('\n')
  }
  const c = res.commit
  L.push(`✓ 已登记 ${c.id} @ ${c.at}`)
  L.push(`  落点: ${res.materialized.files.length} 文件（索引 ${res.materialized.sources.fromIndex.length} / 字面量 ${res.materialized.sources.fromLiteral.length} / glob ${res.materialized.sources.fromGlob.length}）`)
  if (res.materialized.missing.length) L.push(`  ⚠ 解析未命中 (${res.materialized.missing.length}): ${res.materialized.missing.slice(0, 8).join('; ')}${res.materialized.missing.length > 8 ? ` …+${res.materialized.missing.length - 8}` : ''}`)
  if (res.materialized.unresolved.length) L.push(`  ⚠ 未登记标识 (${res.materialized.unresolved.length}): ${res.materialized.unresolved.slice(0, 8).join('; ')}${res.materialized.unresolved.length > 8 ? ` …+${res.materialized.unresolved.length - 8}` : ''}`)

  // ---- PN-S1/E1：查证申报（plan）的写入侧出口 ----
  // 此前 plan 只有写入面、零渲染出口（治理根 45 条非空 plan 对模型完全不可见）⇒ 填了等于没填。
  // 取值必须走**重载后的 model**：res.commit 只有 {id,seq,at}（core/commit.js:170-173）。
  const cur = model.commits.find((c) => c.seq === res.commit.seq)
  const declared = String(cur?.plan || '').trim()
  L.push('')
  L.push(`  查证申报: ${planBrief(cur?.plan)}`)
  const declWhy = []
  if (res.materialized.missing.length) declWhy.push(`${res.materialized.missing.length} 个落点磁盘上不存在/未登记`)
  const orphan = (res.materialized.files || []).filter((f) => !(model.fileOwners.get(key(f)) || []).length)
  if (orphan.length) declWhy.push(`${orphan.length} 个落点未登记到任何架构节点`)
  const press = model.patchPressure?.get(cur?.anchorKey || key(cur?.anchor))
  if (press && press.sinceDecisionCount >= REPEAT_PATCH_THRESHOLD - 1) {
    declWhy.push(`该锚点已有 ${press.sinceDecisionCount} 次补丁（阈值 ${REPEAT_PATCH_THRESHOLD}）`)
  }
  if (!declared && declWhy.length) {
    // 只报不拦：A 路线不新增闸位 ⇒ 本行阻断不了任何写入（它不是闸，是文本）。
    // 文案是**中性事实** —— plan 空串不可区分「没查」与「没填」，不得写成因果断言。
    L.push(`    ⚠ 本笔未附查证申报（${declWhy.join('；')}）—— 不拦截，仅留痕。`)
  }

  // ---- PN-S3：相关既有决策点名（"不重开已经关掉的议题"）----
  // ⚠ 施工期落点偏离会议草案（原定 gates.js:184-193 加一条纯查询）：**通过的闸其 detail 不渲染**
  // （本函数只渲 failed 列表），挂在闸上等于死文本 —— 与本次刚修掉的"写而不渲"同型。
  // 故点名落在可见路径上；闸门集合零变更（test/core.test.mjs 钉死七闸），也不新增参数位。
  const rel = (model.decisions || []).filter((d) => (d.anchorKey || key(d.anchor)) === (cur?.anchorKey || key(cur?.anchor)))
  const shownRel = rel.slice(-3)
  for (const d of shownRel) {
    L.push(`  相关既有决策: ${d.id}（${truncate(d.reason, 80)}）—— 动手前先读，别重开已关的议题`)
  }
  if (rel.length > shownRel.length) {
    L.push(`    …共 ${rel.length} 条既有决策，此处最近 ${shownRel.length}；全量 nav_graph mode=adrs anchor=<锚点>`)
  }
  L.push('')
  const failed = res.gates.results.filter((r) => !r.pass)
  if (!failed.length) {
    L.push(`闸门: ${res.gates.results.map((r) => `✓ ${r.gate}`).join(' ')}`)
  } else {
    const anchor = res.gates.results.find((r) => r.gate === 'anchor')
    if (anchor?.pass && anchor.detail) L.push(`  ${anchor.detail}`)
    for (const r of failed) {
      L.push(`  ${r.severity === 'reject' ? '⛔' : '⚠'} ${r.gate}: ${r.detail}`)
      if (r.hint) L.push(`     -> ${r.hint}`)
    }
    const passed = res.gates.results.filter((r) => r.pass).map((r) => r.gate)
    if (passed.length) L.push(`  ✓ ${passed.join(' / ')}`)
  }
  L.push('')
  L.push('收口无需动作：改完文件后，下一次任意工具调用会按证据自动收口（A1）。')
  return L.join('\n')
}
