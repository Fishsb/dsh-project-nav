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
  const ctx = {
    logger: {
      info: (m) => logs.push(`info: ${m}`),
      warn: (m) => logs.push(`warn: ${m}`),
      error: (m) => logs.push(`error: ${m}`)
    },
    tools: {
      register(tool) { registered.push(tool); return () => { const i = registered.indexOf(tool); if (i >= 0) registered.splice(i, 1) } }
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
      if (name === 'shell') return { resolve: () => ({}), run: async () => ({ exitCode: 0, sandbox: { runnerFailed: false } }) }
      return undefined
    }
  }
  return {
    ctx, registered, effects, listeners,
    byName: (n) => registered.find((t) => t.name === n),
    disposeAll: () => { for (const d of effects) if (typeof d === 'function') d() }
  }
}

/** 挂载 host 到桩 ctx：返回可调用工具的集合。
 *  services：额外的 ctx 服务替身（如 sandboxPolicy），供边界装配等分支用。 */
export async function mountHost(root, { config = {}, logs = [], services = {} } = {}) {
  const { mod, dispose } = await loadHost()
  const stub = stubCtx({ logs, services })
  mod.apply(stub.ctx, { root, boundaryWorkspaces: '', autoBindWorkspace: false, ...config })
  return {
    mod, stub, logs, dispose,
    tool: (name) => {
      const t = stub.byName(name)
      if (!t) throw new Error(`tool ${name} not registered (registered: ${stub.registered.map((x) => x.name).join(', ')})`)
      return t
    },
    /** 真调用（host 的 execute 返回字符串或字符串数组） */
    call: async (name, args = {}, exec = { agent: { id: 'test-session-0001' } }) => {
      const t = stub.byName(name)
      if (!t) throw new Error(`tool ${name} not registered`)
      const out = await t.execute(args, exec)
      return Array.isArray(out) ? out.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('\n') : String(out)
    }
  }
}
