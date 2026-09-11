// core/lock.js — runtime/ 互斥（F1 两会话并发写覆盖回退 / F2 破锁竞态）
//
// F2 的正确处置被继承：破锁**不能**用 stat→unlink（会删掉别人刚建的新锁），
// 只能 rename 走再校验 token —— rename 只有一个赢家，其余拿到 ENOENT 主动退让。
//
// 锁只保护 runtime/ 与投影重写；事件流是 append-only，追加本身不需要锁（F1 的根治）。

import {
  mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync,
  statSync, existsSync, readdirSync
} from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { paths } from './paths.js'

const STALE_MS = 15000
const WAIT_MS = 25
const DEFAULT_TIMEOUT_MS = 20000

/**
 * 已持有的锁（可重入）。
 * 为什么必须可重入：`reconcile` 要在锁内追加事件，而追加本身也要锁同一份东西。
 * 若不可重入，第二个会话会在"自己等自己"上耗掉整个超时窗口 ——
 * 功能上看似没错，实际把并发退化成串行长等待，而且日志里查不出来。
 */
const heldLocks = new AsyncLocalStorage()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function lockFile(root, name) {
  return join(paths.locksDir(root), `${name}.lock`)
}

function readLock(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf-8'))
    return { token: j.token, pid: j.pid, at: j.at, name: j.name }
  } catch { return null }
}

/**
 * 抢锁。acquired=false 表示超时（调用方必须 fail-loud，不许静默继续写）。
 * @returns {Promise<{acquired: boolean, token?: string, holder?: object, broke?: boolean, reentrant?: boolean}>}
 */
export async function acquire(root, name, { timeoutMs = DEFAULT_TIMEOUT_MS, staleMs = STALE_MS } = {}) {
  const held = heldLocks.getStore()
  if (held && held.has(name)) return { acquired: true, token: held.get(name), reentrant: true }
  mkdirSync(paths.locksDir(root), { recursive: true })
  const file = lockFile(root, name)
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const deadline = Date.now() + timeoutMs
  let broke = false
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ token, pid: process.pid, at: Date.now(), name }), { flag: 'wx' })
      return { acquired: true, token, broke }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    // 有人持锁：过期则按 F2 处置 —— rename 到私有名，只有一个赢家。
    let st = null
    try { st = statSync(file) } catch { continue } // 刚被释放，立刻重试
    if (Date.now() - st.mtimeMs > staleMs) {
      const graveyard = `${file}.stale-${token}`
      try {
        renameSync(file, graveyard)
        broke = true
        try { unlinkSync(graveyard) } catch { /* 清理失败不影响正确性 */ }
      } catch { /* 别人先破锁 → 我们是输家，继续等 */ }
      continue
    }
    if (Date.now() > deadline) return { acquired: false, holder: readLock(file) }
    await sleep(WAIT_MS)
  }
}

export function release(root, name, token) {
  const held = heldLocks.getStore()
  if (held && held.get(name) === token) return true // 重入层自己会释放
  const got = readLock(lockFile(root, name))
  // token 校验：绝不释放别人的锁。
  if (!got || got.token !== token) return false
  try { unlinkSync(lockFile(root, name)); return true } catch { return false }
}

/** 锁内运行（finally 必释放）。超时 fail-loud —— 静默继续写就是 F1 本身。 */
export async function withLock(root, name, fn, opts = {}) {
  const res = await acquire(root, name, opts)
  if (!res.acquired) {
    const who = res.holder ? `pid=${res.holder.pid} at=${new Date(res.holder.at).toISOString()}` : 'unknown'
    throw new Error(`runtime lock "${name}" is held by another writer (${who}) — refusing to write concurrently. Retry after it finishes.`)
  }
  if (res.reentrant) return fn()
  const store = new Map(heldLocks.getStore() || [])
  store.set(name, res.token)
  try {
    return await heldLocks.run(store, fn)
  } finally {
    release(root, name, res.token)
  }
}

/** 诊断用：当前锁目录内容（nav_graph 健康视图展示）。 */
export function listLocks(root) {
  const dir = paths.locksDir(root)
  if (!existsSync(dir)) return []
  const out = []
  try {
    for (const f of readdirSync(dir)) {
      try {
        const st = statSync(join(dir, f))
        const held = readLock(join(dir, f))
        out.push({ name: f, ageMs: Date.now() - st.mtimeMs, pid: held?.pid ?? null })
      } catch { /* 单个锁文件读失败不影响列表 */ }
    }
  } catch { /* 诊断 best-effort */ }
  return out
}
