// core/log.js — 事件流：唯一事实源（ARCHITECTURE §4）
//
// 这是全插件**唯一**的写入口面。所有长期状态都必须落成一行事件。
//
// F9 的根治在这里：写入只用「追加」或「整体重写 + 读回校验」，
// 不允许"保存一个旧对象"式的静默不落盘 —— appendEvents 追加后**必须读回**，
// 读回对不上就抛错（宁可不写，也不留一个看不见的裂缝）。

import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { paths, nowIso } from './paths.js'
import { withLock } from './lock.js'

export const EVENT_KINDS = ['commit', 'decide', 'node', 'set']

/**
 * 读取事件流。**宽容但有账**：
 *  - 空行忽略；坏行**不丢弃**——记入 corrupt 数组（静默丢弃 = 又一个假绿）。
 *  - 返回 { events, total, corrupt }
 */
export function readEvents(rootPath) {
  const file = paths.events(rootPath)
  if (!existsSync(file)) return { events: [], total: 0, corrupt: [] }
  const raw = readFileSync(file, 'utf-8')
  const events = []
  const corrupt = []
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      if (!ev || typeof ev !== 'object' || !ev.kind) throw new Error('missing kind')
      ev.seq = Number(ev.seq)
      if (!Number.isFinite(ev.seq)) throw new Error('missing seq')
      events.push(ev)
    } catch (e) {
      corrupt.push({ line: i + 1, reason: e.message, text: line.slice(0, 120) })
    }
  }
  events.sort((a, b) => a.seq - b.seq)
  return { events, total: lines.filter((l) => l.trim()).length, corrupt }
}

/** 下一个 seq（事件流自身即计数器；ID 由它派生，所以并发追加不可能撞 ID）。 */
export function nextSeq(rootPath) {
  const { events } = readEvents(rootPath)
  return events.length ? events[events.length - 1].seq + 1 : 1
}

/**
 * 追加事件。**整个「取 seq + 追加 + 读回」在锁内**，保证 seq 连续且无空洞。
 * 返回写入的事件（含分配到的 seq/at）。
 *
 * @param {string} rootPath
 * @param {Array<object>} drafts 不含 seq/at 的事件草稿
 * @param {{now?: number, actor?: string}} opts
 */
export async function appendEvents(rootPath, drafts, opts = {}) {
  if (!drafts || !drafts.length) return []
  const now = opts.now ?? Date.now()
  const at = nowIso(now)
  return withLock(rootPath, 'events', () => {
    const start = nextSeq(rootPath)
    const written = drafts.map((d, i) => {
      const ev = { seq: start + i, at, ...d }
      if (!EVENT_KINDS.includes(ev.kind)) throw new Error(`unknown event kind "${ev.kind}" (allowed: ${EVENT_KINDS.join(', ')})`)
      return ev
    })
    const file = paths.events(rootPath)
    mkdirSync(dirname(file), { recursive: true })
    const before = existsSync(file) ? readFileSync(file, 'utf-8') : ''
    appendFileSync(file, written.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')

    // F9 读回校验（三层，缺一不可）：
    //   ① 前缀不变 —— 追加不是覆盖；
    //   ② 追加段逐行解析且 seq/kind 一致 —— 写进去的就是打算写的；
    //   ③ seq 连续性 —— 事件流被外部截断/篡改时必须炸，绝不能"追加成功"地留下裂缝。
    const after = readFileSync(file, 'utf-8')
    if (!after.startsWith(before)) {
      throw new Error('event log write-back check FAILED: existing content changed — refusing to continue (concurrent writer?)')
    }
    const added = after.slice(before.length)
    const addedLines = added.split(/\r?\n/).filter((l) => l.trim())
    if (addedLines.length !== written.length) {
      throw new Error(`event log write-back check FAILED: expected ${written.length} appended line(s), read back ${addedLines.length}`)
    }
    for (let i = 0; i < written.length; i++) {
      let back
      try { back = JSON.parse(addedLines[i]) } catch (e) {
        throw new Error(`event log write-back check FAILED: appended line ${i + 1} is not valid JSON after write (${e.message})`)
      }
      if (back.seq !== written[i].seq || back.kind !== written[i].kind) {
        throw new Error(`event log write-back check FAILED at line ${i + 1}: seq/kind mismatch (wrote ${written[i].seq}/${written[i].kind}, read ${back.seq}/${back.kind})`)
      }
    }
    const all = after.split(/\r?\n/).filter((l) => l.trim())
    let expect = 1
    for (let i = 0; i < all.length; i++) {
      let seq = null
      try { seq = Number(JSON.parse(all[i]).seq) } catch { seq = null }
      if (seq !== expect) {
        throw new Error(`event log integrity FAILED: line ${i + 1} should carry seq ${expect} but ${seq === null ? 'is not valid JSON' : `carries ${seq}`} — the stream was truncated or tampered with; refusing to append on top of a broken stream`)
      }
      expect += 1
    }
    return written
  }, { timeoutMs: opts.timeoutMs ?? 15000 })
}

/**
 * I1 复算自检：seq 必须从 1 开始、严格 +1、无重复无空洞。
 * 返回 { ok, problems[] }（给 nav_graph health 与测试用）。
 */
export function verifyLog(rootPath) {
  const { events, corrupt } = readEvents(rootPath)
  const problems = []
  for (const c of corrupt) problems.push(`corrupt line ${c.line}: ${c.reason} :: ${c.text}`)
  let expect = 1
  for (const ev of events) {
    if (ev.seq !== expect) problems.push(`seq gap: expected ${expect}, found ${ev.seq}`)
    expect = ev.seq + 1
    if (!ev.at) problems.push(`seq ${ev.seq}: missing timestamp`)
  }
  return { ok: problems.length === 0, problems, count: events.length }
}

/** 整体重写一个 runtime 文件并读回校验（F9：只有这一种重写方式）。 */
export function rewriteVerified(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, file)
  const back = readFileSync(file, 'utf-8')
  if (back !== text) throw new Error(`write-back check FAILED for ${file}: content differs after write`)
  return true
}

/**
 * 日志戳：{size, mtimeMs, lines, digest}。
 * 模型缓存用它判断"事件流变了没有" —— 不必为了判断缓存是否有效而重新解析整个日志。
 *
 * digest 是必须的：只比 size+lines 时，一次**等长覆盖**（比如把 vector 事件改掉）
 * 不会改变任何一个计数，缓存就会带着被篡改的真相一直结账 —— 那就是第二个事实源。
 */
export function logStamp(rootPath) {
  const file = paths.events(rootPath)
  if (!existsSync(file)) return { size: 0, mtimeMs: 0, lines: 0, digest: 'empty' }
  try {
    const st = statSync(file)
    const raw = readFileSync(file, 'utf-8')
    const lines = raw.split(/\r?\n/).filter((l) => l.trim()).length
    const digest = createHash('sha1').update(raw).digest('hex')
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs), lines, digest }
  } catch {
    return { size: -1, mtimeMs: -1, lines: -1, digest: 'error' }
  }
}
