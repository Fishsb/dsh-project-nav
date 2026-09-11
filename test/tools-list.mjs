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

export const NEW_TOOL_NAMES = ['nav_graph', 'nav_commit', 'nav_decide', 'nav_node', 'nav_render', 'nav_set']
export const OLD_TOOL_NAMES = [
  'nav_query', 'nav_plan', 'nav_mark', 'nav_update', 'nav_docs',
  'nav_map', 'nav_sync_docs', 'nav_status', 'nav_set_vector', 'nav_adr', 'nav_arch',
  'nav_add_feature', 'nav_add_module', 'nav_add_doc', 'nav_scan'
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
  // 取 parameters 块（按缩进配平的花括号扫描）
  let i = src.indexOf('{', pStart)
  let depth = 0
  let end = i
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++
    else if (src[end] === '}') { depth--; if (depth === 0) break }
  }
  const block = src.slice(i, end)
  const params = []
  const pr = /^\s{6}([A-Za-z_$][\w$]*):\s*\{/gm
  let m
  while ((m = pr.exec(block)) !== null) params.push(m[1])
  return params
}

/** 工具必须是"注册在 ctx.effect 内"的，否则卸载不干净（资源挂 ctx.effect 规范）。 */
export function effectMountedTools(hostPath = HOST) {
  const src = readFileSync(hostPath, 'utf-8')
  const total = (src.match(/ctx\.tools\.register\(defineTool\(/g) || []).length
  const mounted = (src.match(/ctx\.effect\(\(\)\s*=>\s*ctx\.tools\.register\(defineTool\(/g) || []).length
  return { total, mounted }
}
