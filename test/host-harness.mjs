// test/host-harness.mjs — 真 host 代码 + 桩 ctx（升级旧套件的 data-URL shim 手法）
//
// 为什么值得这么绕：host/index.js 是**唯一**装配面，工具名 / 参数 / 闸门接线全在那里。
// 只做静态扫描只能证明"字符串写对了"；这里把 host 真编译一遍，用桩 ctx 真注册、真调用，
// 才能证明"工具真的在、闸门真的接在写入路径上"。
//
// 做法：把两个只在 profile 里解析的裸包换成 data: URL shim，把 ../core/*.js 换成 file: URL，
// 其余代码（全部领域逻辑）保持真实，编译到临时文件后导入。

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(here, '..')
const HOST = join(PKG, 'host', 'index.js')

const sha = (s) => `data:text/javascript,${encodeURIComponent(s)}`
const TOOLS_SHIM = sha('export const defineTool = (t) => ({ __tool: true, ...t });\nexport default { defineTool };')
// 0.12.0 在场层：post-execute 要造 UserMessage。官方 dsh-tool-jobs 同样从 dsh-llm 引（不声明为依赖），
// 在 profile 里可解析；测试环境没有它，故用最小同形替身 —— 但**同形必须含承重字段 `source`**。
// ⚠ 2026-09-21 真机故障的逃逸路径就是这里：旧 shim 写成 `(input) => ({ role:"user", ...input })`，
//   既不校验也不补 `source` ⇒ 注入漏了 source 也能全绿（"探针 PASS ≠ 生效"），
//   而真实宿主把 additionalContexts 追加为 inbox 消息后，下游 dsh-repeat-tool-reminder 的
//   agent/pre-step 会无保护地读 `message.source.kind` ⇒ TypeError ⇒ 整轮 turn/end 记 error。
//   ⇒ 现在**缺 source 即抛**：把这个假绿变成真闸（判据落在输出上，而不是落在"代码看起来对"）。
const LLM_SHIM = sha([
  'export const createUserMessage = (input) => {',
  '  const s = input && input.source;',
  '  if (!s || typeof s !== "object" || typeof s.kind !== "string") {',
  '    throw new Error("[host-harness] createUserMessage 缺 source：真实宿主会让整轮 turn/end 记 error（see host/index.js 注入注释）");',
  '  }',
  '  return { role: "user", ...input };',
  '};'
].join('\n'))
const SCHEMA_SHIM = sha([
  'const chain = (init) => {',
  '  const o = { __f: true, ...init };',
  '  o.default = (d) => chain({ ...o, __default: d });',
  '  o.required = () => chain({ ...o, __required: true });',
  '  o.description = (d) => chain({ ...o, __description: d });',
  '  return o;',
  '};',
  'const z = {',
  '  object: (shape) => chain({ __schema: true, ...shape }),',
  '  string: () => chain({ __type: "string" }),',
  '  number: () => chain({ __type: "number" }),',
  '  boolean: () => chain({ __type: "boolean" }),',
  '  array: (inner) => chain({ __type: "array", __inner: inner })',
  '};',
  'export default z;',
  'export { z };'
].join('\n'))

/**
 * 编译并导入真 host。
 * @returns {Promise<{mod:object, registered:Array, ctx:object, dispose:Function}>}
 */
export async function loadHost() {
  let src = readFileSync(HOST, 'utf-8')
  src = src
    .replace(/from '@deepseek-ai\/dsh-tools'/g, `from '${TOOLS_SHIM}'`)
    .replace(/from '@deepseek-ai\/schemastery'/g, `from '${SCHEMA_SHIM}'`)
    .replace(/import\('@deepseek-ai\/dsh-llm'\)/g, `import('${LLM_SHIM}')`)
  // ../core/*.js → 绝对 file: URL（临时文件目录里没有相对结构）
  src = src.replace(/from '(\.\.\/core\/[^']+)'/g, (_m, rel) => `from '${pathToFileURL(resolve(dirname(HOST), rel)).href}'`)

  const dir = mkdtempSync(join(tmpdir(), 'navx-host-'))
  const file = join(dir, 'host.mjs')
  writeFileSync(file, src, 'utf-8')
  const mod = await import(pathToFileURL(file).href)
  return { mod, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * 桩 ctx：收集工具注册、effect 释放、事件监听。
 * 这是"装配面"的最小可观测替身 —— 不做任何业务判断。
 */
export function stubCtx({ logs = [], services = {} } = {}) {
  const registered = []
  const effects = []
  const listeners = new Map()
  const sections = []        // 0.12.0 在场层：收集 systemPrompt.section 注册
  const ctx = {
    logger: {
      info: (m) => logs.push(`info: ${m}`),
      warn: (m) => logs.push(`warn: ${m}`),
      error: (m) => logs.push(`error: ${m}`)
    },
    tools: {
      register(tool) { registered.push(tool); return () => { const i = registered.indexOf(tool); if (i >= 0) registered.splice(i, 1) } }
    },
    // 在场层（0.12.0）：桩替身只记录注册，返回真实 disposer（与官方 section() 同形）。
    systemPrompt: {
      section(sec) {
        sections.push(sec)
        return () => { const i = sections.indexOf(sec); if (i >= 0) sections.splice(i, 1) }
      },
      getSectionOrder: () => 10200
    },
    effect(fn) {
      const d = fn()
      effects.push(d)
      return () => { if (typeof d === 'function') d() }
    },
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
      return () => { const arr = listeners.get(name) || []; const i = arr.indexOf(handler); if (i >= 0) arr.splice(i, 1) }
    },
    get(name) {
      if (Object.prototype.hasOwnProperty.call(services, name)) return services[name]
      return undefined
    }
  }
  return {
    ctx, registered, effects, listeners, sections,
    byName: (n) => registered.find((t) => t.name === n),
    /** 在场层文本：取第一个 section 的实参，按组装上下文求值（模拟 DSH 每轮组装）。 */
    presenceText: (assembleCtx = { agent: { session: { meta: {} } } }) => {
      const s = sections.find((x) => x.name === 'project-nav:presence')
      if (!s) return null
      return typeof s.text === 'function' ? s.text(assembleCtx) : s.text
    },
    /** 触发 post-execute 监听器（waterfall 语义：next() 给原结果）。 */
    firePostExecute: async (exec, result) => {
      const handlers = listeners.get('tools/post-execute') || []
      let decision = { kind: 'accept', value: result }
      for (const handler of handlers) {
        const prev = decision
        decision = await handler(exec, result, async () => prev)
      }
      return decision
    },
    disposeAll: () => { for (const d of effects) if (typeof d === 'function') d() }
  }
}

/** 挂载 host 到桩 ctx：返回可调用工具的集合。
 *  services：额外的 ctx 服务替身。 */
export async function mountHost(root, { config = {}, logs = [], services = {} } = {}) {
  const { mod, dispose } = await loadHost()
  const stub = stubCtx({ logs, services })
  mod.apply(stub.ctx, { root, ...config })
  return {
    mod, stub, logs, dispose,
    tool: (name) => {
      const t = stub.byName(name)
      if (!t) throw new Error(`tool ${name} not registered (registered: ${stub.registered.map((x) => x.name).join(', ')})`)
      return t
    },
    /** 在场层（0.12.0）：取注入文本（按组装上下文求值）。 */
    presenceText: (assembleCtx) => stub.presenceText(assembleCtx),
    /** 在场层（0.12.0）：触发 post-execute。（见 stubCtx.firePostExecute） */
    firePostExecute: (exec, result) => stub.firePostExecute(exec, result),
    /** 真调用（host 的 execute 返回字符串或字符串数组） */
    call: async (name, args = {}, exec = { agent: { id: 'test-session-0001' } }) => {
      const t = stub.byName(name)
      if (!t) throw new Error(`tool ${name} not registered`)
      const out = await t.execute(args, exec)
      return Array.isArray(out) ? out.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('\n') : String(out)
    }
  }
}
