// test/tools-list.mjs — 工具面的**静态**契约扫描
//
// 为什么静态扫而不 import host：host 依赖 @deepseek-ai/dsh-tools（只在 profile 里解析），
// 测试机不一定有。更重要的是：工具面是**模型可见的契约面**，它的正确性正该由源码文本判定，
// 而不是运行起来看运气。扫的是 `ctx.tools.register(defineTool({ name: 'nav_x' ...` 这一形状。

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HOST = join(here, '..', 'host', 'index.js')

// 0.12.0 换代：工具面 6 → 5（nav_render 随落盘投影一起退场，ADR-268）。
export const NEW_TOOL_NAMES = ['nav_graph', 'nav_commit', 'nav_decide', 'nav_node', 'nav_set']
export const OLD_TOOL_NAMES = [
  'nav_query', 'nav_plan', 'nav_mark', 'nav_update', 'nav_docs',
  'nav_map', 'nav_sync_docs', 'nav_status', 'nav_set_vector', 'nav_adr', 'nav_arch',
  'nav_add_feature', 'nav_add_module', 'nav_add_doc', 'nav_scan',
  // 0.12.0 换代退役：nav_render 的唯一操作是"重生成落盘投影"，落盘面退场后它无事可做（ADR-268）。
  // 归入历史名：README/契约里提到它是**历史叙述**，不是"示例照抄即错"。
  'nav_render'
]

/** 扫描 host 源码里真正注册的工具（识别 defineTool({ name: 'nav_x'）。 */
export function scanTools(hostPath = HOST) {
  const src = readFileSync(hostPath, 'utf-8')
  const names = []
  const re = /defineTool\(\{\s*\n\s*name:\s*'([^']+)'/g
  let m
  while ((m = re.exec(src)) !== null) names.push(m[1])
  const counts = new Map()
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1)
  const duplicates = [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n)
  const schemas = names.map((name) => ({ name, params: paramsOf(src, name) }))
  return { names, duplicates, schemas, source: src }
}

/** 取某个工具 parameters 里的参数名（源码级提取，够用于契约断言）。 */
function paramsOf(src, toolName) {
  const start = src.indexOf(`name: '${toolName}'`)
  if (start < 0) return []
  const pStart = src.indexOf('parameters: {', start)
  if (pStart < 0) return []
  // 单趟词法扫描：① 花括号配平定出 parameters 块的边界；② `depth === 1` 处的
  // 裸标识符 = **顶层参数键**（depth 在此是"当前在几个花括号之内"）。
  //
  // ⚠ 为什么不按缩进匹配：旧写法把缩进写死成 /^\s{6}/，参数行 6→4 空格（**纯格式化**）
  //   即失配 ⇒ 静默返回 [] ⇒ 上界类判据退化成 `0 <= N` 恒真（本仓最忌的「空扫判绿」）。
  //   缩进是排版，不是结构。
  // ⚠ 为什么 `depth === 1` 要在**收下这个 token 时**判，而不是"遇到 { 之后"判：
  //   后者的深度已经变成 2，于是每个工具只抓得到**第 1 个**参数（值对象内层也被数成顶层键）。
  //   唯一正确的时序是：收 token 时该 token 尚未改变深度 ⇒ 顶层键恰恰只在 depth===1 时出现。
  // 空白与注释一律丢弃（故缩进、换行、单行/多行写法都不参与判定）；
  // 字符串字面量整体吃掉：description 里的 `{` / `}` / 逗号不得搅乱配平与切分。
  const params = []
  let depth = 0
  let quote = null // 处于字符串字面量时的终结符（' " `）
  let escaped = false
  let token = '' // 当前裸标识符 token（只在 depth===1 时可能成为参数键）
  // 收 token：只有"顶层 + 后面紧跟冒号"的裸标识符才是参数键。
  const flushToken = (atColon) => {
    if (token) {
      if (atColon && depth === 1) params.push(token)
      token = ''
    }
  }
  for (let j = src.indexOf('{', pStart); j < src.length; j++) {
    const ch = src[j]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '{') { depth++; continue }
    if (ch === '}') {
      depth--
      if (depth === 0) return params // parameters 块收口
      continue
    }
    if (ch === ':') { flushToken(true); continue }
    if (/[A-Za-z0-9_$]/.test(ch)) { token += ch; continue }
    flushToken(false) // 空白 / 逗号 / 其他：token 边界，非键
  }
  return params
}

/** 工具必须是"注册在 ctx.effect 内"的，否则卸载不干净（资源挂 ctx.effect 规范）。 */
export function effectMountedTools(hostPath = HOST) {
  const src = readFileSync(hostPath, 'utf-8')
  const total = (src.match(/ctx\.tools\.register\(defineTool\(/g) || []).length
  const mounted = (src.match(/ctx\.effect\(\(\)\s*=>\s*ctx\.tools\.register\(defineTool\(/g) || []).length
  return { total, mounted }
}
