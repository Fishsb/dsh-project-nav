// test/helper.mjs — 共享夹具：每个用例一个临时 root，绝不碰真实工作区

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { appendEvents } from '../core/log.js'

export function tmpRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pnx-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 写文件（自动建目录）。 */
export function put(root, rel, content = 'x') {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf-8')
  return abs
}

/** 改文件内容（触发证据变化）。 */
export function touch(root, rel, content) {
  writeFileSync(join(root, rel), content ?? `changed-${Date.now()}-${Math.random()}`, 'utf-8')
}

/**
 * 目录树快照：**文件与目录都收**，递归，相对路径 + 确定性排序（可比对、跨平台一致）。
 * ⚠ 为什么必须收目录：只收文件时 `mkdir runtime/x` 这类新写入在快照里**完全不可见**
 *   —— 实测：只收文件的那一版，往 `.internal/runtime/` 里新建目录后快照毫无变化，
 *   deepEqual 永远相等（恒真守卫，掩盖类缺陷）。目录是落盘的一种，漏掉它就等于没有判据。
 * `<不存在>` 哨兵：目录首现本身就是一次可比的树形变化。
 */
export function snapshotTree(dir) {
  if (!existsSync(dir)) return ['<不存在>']
  const out = []
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) { out.push('d ' + child); walk(join(d, e.name), child) }
      else out.push('f ' + child)
    }
  }
  walk(dir, '')
  return out.sort()
}

/**
 * 武装自证：在**临时目录**里人为制造一个新目录、一个新文件，断言快照确实随之变化。
 * 为什么必须有：`assert.deepEqual(snap(), before)` 在「快照恒返回同一常量/空集」时**也是绿的**
 *   —— 判据本身失效时不留下任何痕迹。这个函数先把快照函数证成**可证伪**的，
 *   再让它去判被测对象；"空集比对"从此过不了这一关。
 * @returns {string[]} 武装前的空目录快照（应恰为 []，供调用方复验基线）
 */
export function armSnapshotProbe() {
  const dir = mkdtempSync(join(tmpdir(), 'pnx-armed-'))
  try {
    const empty = snapshotTree(dir)
    assert.deepEqual(empty, [], '空临时目录的快照必须是空集（快照函数不得凭空造条目）')
    mkdirSync(join(dir, 'armed-dir'), { recursive: true })
    const withDir = snapshotTree(dir)
    assert.notDeepEqual(withDir, empty, '⚠ 快照对**新目录**不敏感 —— 这条判据盖不住任何落盘')
    writeFileSync(join(dir, 'armed-dir', 'armed-file.txt'), 'x', 'utf-8')
    assert.notDeepEqual(snapshotTree(dir), withDir, '⚠ 快照对**新文件**不敏感 —— 这条判据是空转的')
    return empty
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 建一个最小可用工作区：root + 一个文件 + 项目/模块/功能节点 + 主线向量。 */
export async function seed(root, { files = ['src/a.js'], feature = 'PN-F01', module = 'core', project = 'PN-P01' } = {}) {
  for (const f of files) put(root, f)
  await appendEvents(root, [
    { kind: 'node', op: 'upsert', layer: 'project', id: project, fields: { name: project, path: '.' } },
    { kind: 'node', op: 'upsert', layer: 'module', id: module, fields: { name: module, project, features: [feature] } },
    { kind: 'node', op: 'upsert', layer: 'feature', id: feature, fields: { name: feature, files, module } },
    { kind: 'set', vector: { doing: module, next: 'more', notDoing: 'forbidden-thing', exitCondition: 'done' } }
  ])
  return { feature, module, project, files }
}

export const FIXED_NOW = Date.parse('2026-09-11T10:00:00.000Z')
