// test/core.test.mjs — regression tests for the shared core layer.
// Run with: node --test test/*.test.mjs   (pnpm test)
// All disk IO happens under a per-test temp dir; never touches a real workspace.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizePath,
  createEmptyIndex, saveIndex, loadIndex,
  createDefaultVector, saveVector, loadVector,
  createEmptyActions, saveActions, loadActions, nextActionId,
  createEmptyDocs, saveDocs, loadDocs, nextDocId, suggestDocs,
  queryIndex, partialSearch,
  renderTreeText, renderMapHtml, renderProjectDocSection,
  findStaleFiles, scopeTargetsOfOpenActions
} from '../shared/index.js'

function tmpRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pn-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function seededIndex(root) {
  // PE-F01 (editor module of project alpha) + orphan feature PE-F02
  const idx = createEmptyIndex()
  idx.indexes.featureToFiles['PE-F01'] = ['src/main.js']
  idx.indexes.fileToFeature['src/main.js'] = ['PE-F01']
  idx.indexes.featureToFiles['PE-F02'] = [] // registered but attached to no module → orphan
  idx.indexes.moduleToFeatures['editor'] = ['PE-F01']
  idx.indexes.projectToModules['alpha'] = ['editor']
  idx.descriptions['PE-F01'] = { name: 'Editor', userView: 'edit', systemView: 'edit sys' }
  idx.descriptions['PE-F02'] = { name: 'Orphan' }
  return idx
}

test('normalizePath turns backslashes into forward slashes', () => {
  assert.equal(normalizePath('host\\index.js'), 'host/index.js')
  assert.equal(normalizePath('a/b/c'), 'a/b/c')
})

test('index/vector/actions/docs round-trip through atomic JSON in a temp root', (t) => {
  const root = tmpRoot(t)
  saveIndex(root, createEmptyIndex())
  assert.ok(existsSync(join(root, '.internal', 'nav-index.json')))
  assert.equal(loadIndex(root).metadata.coverage, 'empty')

  saveVector(root, createDefaultVector())
  const v = loadVector(root)
  assert.equal(v.doing, '')
  assert.equal(v.next, '')
  assert.equal(v.notDoing, '')
  assert.equal(v.exitCondition, '')
  assert.equal(typeof v.updatedAt, 'string') // saveVector stamps updatedAt

  saveActions(root, createEmptyActions())
  assert.deepEqual(loadActions(root).actions, [])

  saveDocs(root, createEmptyDocs())
  assert.deepEqual(loadDocs(root).docs, [])
})

test('metadata recompute derives totals instead of hardcoding', (t) => {
  const root = tmpRoot(t)
  saveIndex(root, seededIndex(root))
  const m = loadIndex(root).metadata
  assert.equal(m.totalFeatures, 2)
  assert.equal(m.totalFiles, 1)
  assert.equal(m.totalModules, 1)
  assert.equal(m.totalProjects, 1)
  assert.equal(m.coverage, 'partial')
})

test('queryIndex resolves feature codes and file paths in both directions', (t) => {
  const root = tmpRoot(t)
  saveIndex(root, seededIndex(root))
  const byFeature = queryIndex(loadIndex(root), 'PE-F01')
  assert.equal(byFeature.type, 'feature')
  assert.deepEqual(byFeature.files, ['src/main.js'])
  assert.deepEqual(byFeature.modules, ['editor'])
  assert.deepEqual(byFeature.projects, ['alpha'])
  const byFile = queryIndex(loadIndex(root), 'src/main.js')
  assert.equal(byFile.type, 'file')
  assert.deepEqual(byFile.features, ['PE-F01'])
})

test('partialSearch offers loose suggestions on near-miss targets', (t) => {
  const root = tmpRoot(t)
  saveIndex(root, seededIndex(root))
  // 'EDIT' is a case-insensitive substring of index key 'editor'
  assert.ok(partialSearch(loadIndex(root), 'EDIT').includes('editor'))
})

test('nextActionId / nextDocId increment past existing entries', () => {
  const ledger = createEmptyActions()
  ledger.actions.push({ id: 'ACT-001' }, { id: 'ACT-009' })
  assert.equal(nextActionId(ledger), 'ACT-010')
  const reg = createEmptyDocs()
  reg.docs.push({ id: 'DOC-003' })
  assert.equal(nextDocId(reg), 'DOC-004')
})

test('suggestDocs scores by project match and when-keywords', () => {
  const reg = createEmptyDocs()
  reg.docs.push(
    { id: 'DOC-001', title: 'plugin guide', path: '/x', when: '插件开发, 工具注册', tags: ['gov'], project: 'PN-P01' },
    { id: 'DOC-002', title: 'other', path: '/y', when: '音频', tags: [], project: '' }
  )
  const hits = suggestDocs(reg, { taskText: '把插件打包发布到 github', projects: ['PN-P01'], modules: [] })
  assert.deepEqual(hits.map(d => d.id), ['DOC-001'])
})

test('scopeTargetsOfOpenActions collects only open action scopes', () => {
  const ledger = createEmptyActions()
  ledger.actions.push(
    { id: 'ACT-001', status: 'planned', task: 'a', scope: { features: ['PE-F01'], modules: [], files: [] } },
    { id: 'ACT-002', status: 'done', task: 'b', scope: { features: ['PE-F99'], modules: [], files: [] } }
  )
  const s = scopeTargetsOfOpenActions(ledger)
  assert.ok(s.feats.has('PE-F01'))
  assert.ok(!s.feats.has('PE-F99'))
  assert.equal(s.ids.length, 1)
})

test('findStaleFiles flags only files missing on disk', (t) => {
  const root = tmpRoot(t)
  writeFileSync(join(root, 'real.txt'), 'x')
  const idx = seededIndex(root)
  idx.indexes.featureToFiles['PE-F01'] = ['real.txt', 'ghost.txt']
  idx.indexes.fileToFeature['real.txt'] = ['PE-F01']
  idx.indexes.fileToFeature['ghost.txt'] = ['PE-F01']
  const stale = findStaleFiles(idx, root)
  assert.deepEqual(stale, ['ghost.txt [alpha]'])
})

test('renderTreeText shows project tree and orphan features', (t) => {
  const root = tmpRoot(t)
  saveIndex(root, seededIndex(root))
  const tree = renderTreeText(loadIndex(root), {})
  assert.ok(tree.includes('▼ alpha'))
  assert.ok(tree.includes('PE-F01'))
  assert.ok(tree.includes('PE-F02')) // orphan feature section
})

test('renderProjectDocSection emits nav:auto markers and derived bullets', (t) => {
  const root = tmpRoot(t)
  saveIndex(root, seededIndex(root))
  const sec = renderProjectDocSection(loadIndex(root), { vector: { doing: 'x', next: '', notDoing: '', exitCondition: '' } })
  assert.ok(sec.includes('<!-- nav:auto:start -->'))
  assert.ok(sec.includes('<!-- nav:auto:end -->'))
  assert.ok(sec.includes('### alpha'))
  assert.ok(sec.includes('**PE-F01**'))
  assert.ok(sec.includes('Doing**'))
})

test('renderMapHtml is a self-contained HTML document', (t) => {
  const root = tmpRoot(t)
  saveIndex(root, seededIndex(root))
  const html = renderMapHtml(loadIndex(root), {})
  assert.ok(html.includes('<!DOCTYPE html>'))
  assert.ok(html.includes('alpha'))
  assert.ok(html.includes('PE-F01'))
})
