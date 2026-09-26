// verify-runtime.mjs — 安装副本的**运行时**校验（静态 SHA256 对得上 ≠ 能加载）
//
// 用法：node verify-runtime.mjs [<安装实体目录>]
//   缺省 = C:\Users\lk\.dsh\profiles\web\node_modules\@dsh-external\project-nav
// 退出码 1 = 有项未通过 ⇒ 先别重启。
//
// ⚠ 版本无关：这里不写版本号，只断言**能力**。换代时若能力变了，改的是断言，不是文件名。
//   （旧做法 verify-<ver>-runtime.mjs 每换代多一份、旧的还留在仓里变成尾巴。）
//
// 为什么需要这一层：install/verify 的静态校验只能证明"字节对得上"。
// 打包错误、缺依赖、导出被改名、语法在目标 Node 上不合法 —— 静态校验全看不见。
// 本脚本对**安装实体**（不是仓库源码）做：加载 → 真跑 → 断言对外契约。
//
// ⚠ 写这类脚本的两条纪律（都是本脚本自己踩出来的）：
//   ① **只断言对外契约**。私有实现细节（如 core/model.js 的 buildEdges / projectDirsOf 故意不 export）
//      不该进断言 —— 那会造出"改实现就报红"的假红。
//   ② **失败就不许再打 OK**。第一版曾在断言失败后照样打印"导出齐全"，
//      即工具在自己的报告里撒谎 —— 比漏报更糟。所以下面每个阶段都先收集失败、后决定打印什么。
//
// 0.10.1 修掉的三处（留作回归判据）：
//   · `.d.ts` 曾被当代码扫 → 已由 `isCodeFile` 排除（实测成边数本就是 0，纯噪声：unresolved 42→17）。
//   · 退役锚点的历史补丁计数曾显示在 health → 已在 renderHealth 过滤。
//   · **计数闸曾把 closed 收口回执也当补丁数** → 已由 `isPatchRecord` 修正。
//     这是**真 bug**：每笔改动被计两次，阈值 3 实际在 ~1.5 笔就触发 ——
//     第一性原理触发器退化成"狼来了"，正是它最该避免的形态。
//
// 仍存在的已知取舍（不影响结论）：
//   · 字符串字面量里的 `import '...'` 理论上可能造假边；实测**零幻影边**（目标文件不存在 ⇒ 只进 unresolved）。

const DEFAULT_BASE = 'C:/Users/lk/.dsh/profiles/web/node_modules/@dsh-external/project-nav'
const BASE = (process.argv[2] || DEFAULT_BASE).replace(/\\/g, '/').replace(/\/+$/, '')
const url = (p) => `file:///${BASE}/${p}`

const fails = []
const ok = (m) => console.log('  [ OK ] ' + m)
const bad = (m) => { console.log('  [FAIL] ' + m); fails.push(m) }

console.log('')
console.log(`verify-runtime — 安装实体: ${BASE}`)
console.log('（这一层验的是"能不能跑"，不是"字节对不对"）')

// ---------- ① core 可加载 + 对外契约在位 ----------
console.log('① 加载面')
let scope, model, gates
try {
  scope = await import(url('core/scope.js'))
  model = await import(url('core/model.js'))
  gates = await import(url('core/gates.js'))
  // 只列**对外契约**（导出面）。私有实现细节不列 —— 见文件头纪律 ①。
  const want = [[scope, 'scanImports'], [scope, 'extractSpecifiers'], [scope, 'isTestPath'], [scope, 'locate'],
                [model, 'buildModel'], [model, 'loadModel'], [model, 'impactOf'], [model, 'pressureFor'],
                [gates, 'impactGate'], [gates, 'runGates']]
  const missing = want.filter(([mod, n]) => typeof mod[n] !== 'function').map(([, n]) => n)
  if (missing.length) bad('对外导出缺失: ' + missing.join(', '))
  else ok('core 三模块加载成功，对外导出齐全')
} catch (e) {
  bad('core 加载失败: ' + e.message)
}

// ---------- ② 真跑一遍（不是只看导出） ----------
console.log('② 运行面')
if (model?.buildModel) {
  try {
    const m = model.buildModel('D:/FF')
    if (!m.eventCount) bad('事件流读不到（数据面被动了？）')
    else ok(`事件流可读：${m.eventCount} 事件 · 项目 ${[...m.nodes.values()].filter((n) => n.layer === 'project' && n.status === 'active').length} 个`)

    if (m.edges.fileEdges.size === 0) bad('依赖图为空 —— 影响面闸会永远放行（假绿）')
    else ok(`依赖图非空：${m.edges.fileEdges.size} 个文件有出边 · 扫描范围 ${m.edges.scope.mode} · 实扫 ${m.edges.scanned} 文件`)

    const target = 'project-nav/core/model.js'
    const imp = model.impactOf(m, [target])
    const n = (imp.get(target) || []).length
    if (!n) bad(`impactOf 对 ${target} 返回空 —— 影响面不可用`)
    else ok(`影响面可用：${target} 被 ${n} 个 scope 外文件引用`)

    const g = gates.impactGate(m, { scope: { files: [target] }, materialized: { files: [target] } })
    if (typeof g?.severity !== 'string' && g?.pass !== true) bad('impactGate 返回值形状异常')
    else ok(`第七闸可调用：severity=${g.severity ?? '(pass)'}`)
  } catch (e) { bad('运行时执行失败: ' + e.message) }
} else {
  bad('跳过运行面（core/model.js 没加载成功）')
}

// ---------- ③ host 形状（真装配由源码侧 94 项测试覆盖） ----------
console.log('③ 装配面')
try {
  const h = await import(url('host/index.js'))
  if (h.name !== '@dsh-external/project-nav') bad(`host name = ${h.name}`)
  else if (typeof h.apply !== 'function') bad('host 缺 apply')
  else if (!Array.isArray(h.inject) || !h.inject.includes('tools')) bad(`host inject = ${JSON.stringify(h.inject)}`)
  else ok(`host 形状正确：name=${h.name} inject=${JSON.stringify(h.inject)}`)
} catch (e) { bad('host 加载失败: ' + e.message) }

// ---------- ④ 换代面（已删机制确实装不上车） ----------
console.log('④ 换代面')
try {
  const fs = await import('node:fs')
  if (fs.existsSync(`${BASE}/core/legacy.js`)) bad('core/legacy.js 仍在安装实体里')
  else ok('core/legacy.js 确实不在安装实体里')
  // ⚠ 本轮修正（2026-09-26）：本段此前是 `fs.readFileSync` + `RegExp.test` —— **子串判定打在源码文本上**。
  //   它有两个方向都会出错（两个方向都实测过）：
  //     ① **假红**：一句**历史叙述注释**（例 `// 历史叙述：renderAll / renderModelDoc 随 0.12.0 退场`）
  //        就把**并不在位**的出口报成"换代未生效"——而记录退场的注释正是本文件上方就在写的东西。
  //     ② 与「能力在位」那一侧互为镜像：子串命中既不等于符号在位、也不等于机制在位。
  //   现判据取**导出面符号**（= 本文件下方 `renderTreeText` 已有写法，也是
  //   `test/architecture.test.mjs` 的 `render[gone] === undefined` 同款），
  //   **不取源码子串**。代价（显式记下，别当没发生）：非导出的内部函数被重新引入时，
  //   符号面看不见 —— 这一点与测试侧既有口径一致（同款判据在测试侧本就是这个覆盖度）。
  //
  // ⚠ 加载必须**逐个兜住**（实测踩到）：`core/format.js` 自己 import 了 `renderTreeText`，
  //   故 render.js 一坏，`await import(core/format.js)` 会抛；若它与下面的检查共用外层 try，
  //   整个 ④ 段会塌成一句「换代面检查失败」—— 剩下的 nav_render / systemPrompt.section 两项
  //   **不再上报**，正是本仓最忌的「失败不可观测」。故各模块单独 try，
  //   加载不上的项按「**未验，不是通过**」显式报出（同 verify-install.ps1 的 node 缺失分支）。
  let renderMod = null
  try { renderMod = await import(url('core/render.js')) } catch (e) {
    bad(`core/render.js 未加载 ⇒ 「已删机制不在位」与 renderTreeText 两项**未验**（不是通过）: ${e.message}`)
  }
  if (renderMod) {
    const archDoc = ['stampArchDoc', 'listArchDocs', 'parseArchCache']
      .filter((n) => renderMod[n] !== undefined)
    if (archDoc.length) bad(`core/render.js 仍带架构档指纹机制: ${archDoc.join(', ')}`)
    else ok('架构档指纹机制已移除')

    // 0.12.0 换代：落盘投影整体退场（ADR-268）。
    // 判据是**已删机制不在位** —— 留存即是回退（"先落盘再注入"就等于把删掉的投影换个名字加回来）。
    const fallen = ['renderAll', 'renderModelDoc', 'renderMapHtml', 'writeProjectSection', 'MARK_START']
      .filter((n) => renderMod[n] !== undefined)
    if (fallen.length) bad(`落盘投影出口仍在 core/render.js: ${fallen.join(', ')} —— 换代未生效`)
    else ok('落盘投影出口已退场（render.js 零写盘）')
    if (typeof renderMod.renderTreeText !== 'function') bad('renderTreeText 缺失（nav_graph mode=map 会坏）')
    else ok('renderTreeText 在位（按需渲染保留）')
  }

  // 在场层：诊断该暴露的能力必须在位。
  // ⚠ 同 ① 的纪律：只看**符号**（typeof），不看源码子串。子串判定的失效是**双向**的（两种都实测过）：
  //   ① 假绿 —— `export function foldOnlyV2` 里含子串 `export function foldOnly`，
  //      于是把能力改名后旧判据照样报"在位"：实测 model.js 与 host 同步改名的一致重构下，
  //      整个脚本 EXIT=0「全部通过」，而 foldOnly 已经不存在了。
  //   ② 假红 —— 注释或说明文字里出现该串即报"缺失"。
  //   符号级没有这两个方向：改名 ⇒ 报红；改名后注释留档 ⇒ 不误报。
  let fmt = null
  try { fmt = await import(url('core/format.js')) } catch (e) {
    // 只报**一条**：加载失败与「未验」是同一件事，拆两行会让一个根因产出两条噪声。
    bad(`core/format.js 未加载 ⇒ renderPresence 一项**未验**（不是通过）: ${e.message}`)
  }
  if (fmt) {
    if (typeof fmt.renderPresence !== 'function') bad('core/format.js 缺 renderPresence（在场层文本成形）')
    else ok('renderPresence 在位（在场层）')
  }
  // foldOnly 已在 ① 从 model 模块取到，这里复用同一份加载结果（不重复 import、不读源码文本）
  if (typeof model?.foldOnly !== 'function') bad('core/model.js 缺 foldOnly（在场层廉价路径）')
  else ok('foldOnly 在位（纯事件流折叠，不扫盘）')
  // ⚠ 以下两项**本轮刻意未改**（越界 + 改法本身不成立，见工作项报告）：
  //   · 现状是子串判定打在**含注释的原文**上，两个方向都会错（实测：注释提 `name: 'nav_render'`
  //     报假红；装配真改成 `systemPrompt.sections(` 而注释留名时报假绿 EXIT=0）；
  //   · 但「补一道去注释剥离」**在这个文件上不成立**：`host/index.js` 的字符串字面量里有
  //     `/*`（`.internal/arch/*.md`），正则 `/\*[\s\S]*?\*\//` 会错配，实测一口吃掉 19KB 真代码
  //     （含工具注册区），把 `nav_render` 的真阳性也一起吃没 —— 假绿比原病更重。
  //     同一道剥离在 `verify-install.ps1` 的 `$hostCode` 上也存在同一风险。
  //   ⇒ 正确的收口方向是把这两项从「打源码文本」改成**符号/行为级**（与本文件 ①③ 同款），
  //     那需要桩 ctx 或工具面扫描器，超出本文件既有范式，留给后续波次。
  const host = fs.readFileSync(`${BASE}/host/index.js`, 'utf-8')
  if (/name: 'nav_render'/.test(host)) bad('host 仍注册 nav_render —— 工具面应为 5')
  else ok('nav_render 已退场（工具面 = 5）')
  if (!/systemPrompt\.section\(/.test(host)) bad('host 未装配 systemPrompt 在场层 —— 治理退回"只在被调用时存在"')
  else ok('在场层已装配（systemPrompt.section）')
} catch (e) { bad('换代面检查失败: ' + e.message) }

// ---------- 汇总（先收失败，再给结论 —— 纪律 ②） ----------
console.log('')
if (fails.length === 0) {
  console.log('=== 运行时面全部通过：安装实体可加载、可运行、契约完整 ===')
  process.exit(0)
}
console.log(`=== 运行时面 ${fails.length} 项未通过：**先别重启** ===`)
process.exit(1)
