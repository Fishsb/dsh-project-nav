// test/helper.mjs — 共享夹具：每个用例一个临时 root，绝不碰真实工作区

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
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
