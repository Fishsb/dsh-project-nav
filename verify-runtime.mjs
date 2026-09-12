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
  const render = fs.readFileSync(`${BASE}/core/render.js`, 'utf-8')
  if (/stampArchDoc|listArchDocs|parseArchCache/.test(render)) bad('core/render.js 仍带架构档指纹机制')
  else ok('架构档指纹机制已移除')
} catch (e) { bad('换代面检查失败: ' + e.message) }

// ---------- 汇总（先收失败，再给结论 —— 纪律 ②） ----------
console.log('')
if (fails.length === 0) {
  console.log('=== 运行时面全部通过：安装实体可加载、可运行、契约完整 ===')
  process.exit(0)
}
console.log(`=== 运行时面 ${fails.length} 项未通过：**先别重启** ===`)
process.exit(1)
