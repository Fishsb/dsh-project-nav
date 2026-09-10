// test/core.test.mjs — regression tests for the shared core layer.
// Run with: node --test test/*.test.mjs   (pnpm test)
// All disk IO happens under a per-test temp dir; never touches a real workspace.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  normalizePath, governedWorkspaceOf,
  createEmptyIndex, saveIndex, loadIndex,
  createDefaultVector, saveVector, loadVector,
  createEmptyActions, saveActions, loadActions, nextActionId,
  createEmptyDocs, saveDocs, loadDocs, nextDocId, suggestDocs,
  queryIndex, partialSearch,
  renderTreeText, renderMapHtml, renderProjectDocSection,
  findStaleFiles, scopeTargetsOfOpenActions, scopeFiles, sessionLabel,
  parseArchCache, archDocStatus, listArchDocs, archDocsFor, archDocsForScope,
  renderArchPointer, stampArchDoc
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

test('governedWorkspaceOf is opt-in per workspace and never governs the rest of the root', () => {
  const idx = createEmptyIndex()
  idx.projectPaths = { 'PN-P01': 'project-nav', alpha: 'deepseek/alpha' }
  const root = 'D:\\FF'

  // OPT-IN: an empty allow-list governs NOTHING, whatever the cwd is. The native mode has
  // exactly one writable root, so a session whose work reaches into ~/.dsh would be stopped
  // rather than protected — the caller must name the workspaces that are self-contained.
  assert.equal(governedWorkspaceOf(idx, root, 'D:\\FF\\project-nav'), '')
  assert.equal(governedWorkspaceOf(idx, root, 'D:\\FF', []), '')

  // allow by directory name / by project key / by relative path — all three spellings work
  assert.equal(normalizePath(governedWorkspaceOf(idx, root, 'D:\\FF\\project-nav\\host', ['project-nav'])), 'D:/FF/project-nav')
  assert.equal(normalizePath(governedWorkspaceOf(idx, root, 'D:/FF/project-nav', ['PN-P01'])), 'D:/FF/project-nav')
  assert.equal(normalizePath(governedWorkspaceOf(idx, root, 'D:/FF/deepseek/alpha', ['deepseek/alpha'])), 'D:/FF/deepseek/alpha')
  assert.equal(normalizePath(governedWorkspaceOf(idx, root, 'D:\\FF\\project-nav', 'project-nav')), 'D:/FF/project-nav')

  // allowed project but a cwd in a DIFFERENT workspace → untouched (each workspace is its own grant)
  assert.equal(governedWorkspaceOf(idx, root, 'D:\\FF\\deepseek\\alpha', ['project-nav']), '')
  // a directory inside the root that is not a registered project → untouched
  assert.equal(governedWorkspaceOf(idx, root, 'D:\\FF\\scratch', ['project-nav', 'scratch']), '')
  // outside the root entirely → untouched
  assert.equal(governedWorkspaceOf(idx, root, 'C:\\Users\\lk\\elsewhere', ['project-nav']), '')
  // a sibling whose name merely starts with the root's must not read as containment
  assert.equal(governedWorkspaceOf(idx, root, 'D:\\FFx', ['project-nav']), '')
  // the root itself is NEVER governed: a root-wide boundary would let a session write into
  // every project, which is the drift this exists to prevent.
  assert.equal(governedWorkspaceOf(idx, root, 'D:\\FF', ['project-nav', 'FF', 'D:/FF']), '')
  // an index with no project table has nothing to allow
  assert.equal(governedWorkspaceOf(createEmptyIndex(), root, 'D:\\FF\\project-nav', ['project-nav']), '')
  // missing inputs never throw — the caller relies on this being total
  assert.equal(governedWorkspaceOf(null, root, 'D:\\FF', ['project-nav']), '')
  assert.equal(governedWorkspaceOf(idx, root, '', ['project-nav']), '')
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

test('findStaleFiles probes orphan-feature files too (no module must not mean no check)', (t) => {
  const root = tmpRoot(t)
  writeFileSync(join(root, 'real.txt'), 'x')
  const idx = seededIndex(root)
  idx.indexes.featureToFiles['PE-F01'] = ['real.txt']
  idx.indexes.fileToFeature = { 'real.txt': ['PE-F01'] }
  idx.indexes.featureToFiles['PE-F02'] = ['ghost-orphan.txt']   // PE-F02 belongs to no module
  assert.deepEqual(findStaleFiles(idx, root), ['ghost-orphan.txt [orphan feature PE-F02]'])
})

test('findStaleFiles reports a shared missing file once, not once per owner', (t) => {
  const root = tmpRoot(t)
  const idx = seededIndex(root)
  idx.indexes.moduleToFeatures['editor'] = ['PE-F01', 'PE-F02']
  idx.indexes.featureToFiles['PE-F01'] = ['shared-ghost.txt']
  idx.indexes.featureToFiles['PE-F02'] = ['shared-ghost.txt']
  idx.indexes.fileToFeature = { 'shared-ghost.txt': ['PE-F01', 'PE-F02'] }
  assert.deepEqual(findStaleFiles(idx, root), ['shared-ghost.txt [alpha]'])
})

test('scopeFiles: project-prefixed index keys survive; bare project/module names are not files', (t) => {
  const root = tmpRoot(t)
  const idx = seededIndex(root)
  idx.projectPaths = { alpha: 'alpha-dir' }
  idx.indexes.featureToFiles['PE-F01'] = ['alpha-dir/src/main.js']   // workspace-relative index key
  assert.deepEqual(
    scopeFiles(idx, { features: ['PE-F01'] }, root),
    ['alpha-dir/src/main.js'],
    'an indexed file that starts with the project directory is a FILE, not a project name'
  )
  for (const name of ['alpha', 'editor', 'alpha-dir', 'ALPHA']) {
    assert.deepEqual(scopeFiles(idx, { files: [name] }, root), [], `"${name}" is a scope node, not a file`)
  }
  assert.deepEqual(scopeFiles(idx, { files: ['alpha-dir/src/other.js'] }, root), ['alpha-dir/src/other.js'])
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

test('sessionLabel carries the DISTINCTIVE part of a session id', () => {
  assert.equal(sessionLabel('session-5634c6bb-93f1-4994-9c26-7f124dedee72'), '5634c6bb')
  assert.notEqual(sessionLabel('session-aaaaaaaa-1'), sessionLabel('session-bbbbbbbb-2'))
  assert.equal(sessionLabel(''), 'unknown')
  assert.equal(sessionLabel('short'), 'short')
})

test('the index carries no dead tables, and metadata is stamped on every write', (t) => {
  const idx = createEmptyIndex()
  assert.deepEqual(Object.keys(idx.indexes), ['fileToFeature', 'featureToFiles', 'moduleToFeatures', 'projectToModules'])
  assert.equal(idx.functionToModule, undefined, 'legacy table nobody reads')
  assert.equal(idx.unmappedFiles, undefined, 'dead field (drift is probed live)')
  assert.equal(idx.staleEntries, undefined, 'dead field (drift is probed live)')
  const root = tmpRoot(t)
  saveIndex(root, seededIndex(root))
  const m = loadIndex(root).metadata
  assert.equal(typeof m.generated, 'string')
  assert.ok(Math.abs(Date.now() - Date.parse(m.generated)) < 60000, 'generated must be restamped by the write, not inherited')
})

test('generated docs never point at removed tools', (t) => {
  const root = tmpRoot(t)
  saveIndex(root, seededIndex(root))
  const sec = renderProjectDocSection(loadIndex(root), {})
  assert.doesNotMatch(sec, /nav_add_feature|nav_add_module|nav_add_doc/, sec)
  assert.match(sec, /nav_update/, 'the routing must name the tool that actually exists')
  const html = renderMapHtml(loadIndex(root), {})   // PE-F02 has no files → the gap hint renders
  assert.doesNotMatch(html, /--field/, html)
})

test('renderMapHtml honours target, and reports an empty match honestly', (t) => {
  const root = tmpRoot(t)
  saveIndex(root, seededIndex(root))
  const hit = renderMapHtml(loadIndex(root), { target: 'editor' })
  assert.match(hit, /PE-F01/)
  const miss = renderMapHtml(loadIndex(root), { target: 'no-such-thing' })
  assert.match(miss, /No project or module matching this target/, 'an empty narrowing must say so')
})

// ---- architecture docs layer (v0.8.0, ADR-011) ----
// 架构档 = .internal/arch/*.md + 头部 arch-cache 指纹块。这层的契约只有两条：新鲜度可机检、
// 覆盖可机检——两者都是「让 agent 在动手前被引导读档、动手后被提示档过期」的前提。

/** Write an arch doc whose header stamps the CURRENT disk state of `files`. */
function writeArchDoc(root, rel, { project = 'alpha', scope = 'overview', files = [] } = {}) {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  const rows = files.map(f => {
    const st = statSync(join(root, f))
    return `  - path: ${f}\n    mtime: ${new Date(st.mtimeMs).toISOString()}\n    size: ${st.size}`
  })
  const header = [
    '<!-- arch-cache',
    `generated: ${new Date().toISOString()}`,
    `project: ${project}`,
    `scope: ${scope}`,
    'files:',
    ...rows,
    '-->'
  ].join('\n')
  writeFileSync(abs, `${header}\n\n# ${scope}\n\nbody\n`)
  return abs
}

test('parseArchCache reads the fingerprint header contract', (t) => {
  const root = tmpRoot(t)
  writeFileSync(join(root, 'a.js'), 'x')
  const rel = '.internal/arch/proj-overview.md'
  writeArchDoc(root, rel, { project: 'PN-P01（project-nav）', scope: 'overview', files: ['a.js'] })
  const cache = parseArchCache(readFileSync(join(root, rel), 'utf-8'))
  assert.equal(cache.project, 'PN-P01（project-nav）')
  assert.equal(cache.scope, 'overview')
  assert.deepEqual(cache.files.map(f => f.path), ['a.js'])
  assert.equal(cache.files[0].size, 1)
  assert.equal(parseArchCache('# 没有指纹块'), null, 'a doc without the block is "unmanaged", not a crash')
})

test('archDocStatus: fresh while declared stamps hold, stale once a file moves', (t) => {
  const root = tmpRoot(t)
  writeFileSync(join(root, 'a.js'), 'x')
  writeArchDoc(root, '.internal/arch/d.md', { files: ['a.js'] })
  assert.equal(archDocStatus(root, '.internal/arch/d.md').ok, true)
  writeFileSync(join(root, 'a.js'), 'xx')   // size + mtime differ → the doc describes an older reality
  const stale = archDocStatus(root, '.internal/arch/d.md')
  assert.equal(stale.ok, false)
  assert.match(stale.drifted.join(' '), /a\.js/)
  const gone = archDocStatus(root, '.internal/arch/nope.md')
  assert.equal(gone.missing, true)
})

test('listArchDocs walks .internal/arch recursively and skips the render/ projection dir', (t) => {
  const root = tmpRoot(t)
  writeFileSync(join(root, 'a.js'), 'x')
  writeArchDoc(root, '.internal/arch/x.md', { files: ['a.js'] })
  writeArchDoc(root, '.internal/arch/sub/y.md', { files: ['a.js'] })
  mkdirSync(join(root, '.internal', 'arch', 'render'), { recursive: true })
  writeFileSync(join(root, '.internal', 'arch', 'render', 'shot.md'), '# projection artefact, not a doc')
  const docs = listArchDocs(root).map(d => d.path)
  assert.deepEqual(docs, ['.internal/arch/sub/y.md', '.internal/arch/x.md'])
})

test('archDocsFor matches by scope equality and by declared-file intersection', (t) => {
  const root = tmpRoot(t)
  const idx = seededIndex(root)                       // PE-F01 → src/main.js, module editor, project alpha
  writeFileSync(join(root, 'a.js'), 'x')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'main.js'), 'x')
  writeArchDoc(root, '.internal/arch/by-scope.md', { scope: 'PE-F01', files: ['a.js'] })
  writeArchDoc(root, '.internal/arch/by-file.md', { scope: 'overview', files: ['src/main.js'] })
  writeArchDoc(root, '.internal/arch/unrelated.md', { scope: 'other', files: ['a.js'] })
  const forFeature = archDocsFor(idx, root, 'PE-F01').map(d => d.path).sort()
  assert.deepEqual(forFeature, ['.internal/arch/by-file.md', '.internal/arch/by-scope.md'])
  // overview 档按 project 字段回退命中（档没声明该文件时仍算覆盖这个项目）
  assert.ok(archDocsFor(idx, root, 'editor').some(d => d.path === '.internal/arch/by-file.md'))
  // scope 混写 → 并集，按档去重
  const scoped = archDocsForScope(idx, root, { features: ['PE-F01'], modules: ['editor'], files: ['a.js'] })
  assert.deepEqual(scoped.map(d => d.path).sort(), ['.internal/arch/by-file.md', '.internal/arch/by-scope.md', '.internal/arch/unrelated.md'])
})

test('stampArchDoc refreshes the header from the declared list, refusing a broken declaration', (t) => {
  const root = tmpRoot(t)
  writeFileSync(join(root, 'a.js'), 'x')
  writeArchDoc(root, '.internal/arch/d.md', { files: ['a.js'] })
  writeFileSync(join(root, 'a.js'), 'xxxx')
  assert.equal(archDocStatus(root, '.internal/arch/d.md').ok, false)
  const res = stampArchDoc(root, '.internal/arch/d.md')
  assert.equal(res.ok, true)
  assert.equal(res.files, 1)
  assert.equal(archDocStatus(root, '.internal/arch/d.md').ok, true, 'after stamp the doc is fresh again')
  assert.match(readFileSync(join(root, '.internal/arch/d.md'), 'utf-8'), /# overview[\s\S]*body/, 'the body must survive the rewrite')
  rmSync(join(root, 'a.js'))
  const refused = stampArchDoc(root, '.internal/arch/d.md')
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /不存在/, 'a fingerprint pointing at air is worse than a loud failure')
})

test('stampArchDoc refuses a doc with no arch-cache header', (t) => {
  const root = tmpRoot(t)
  mkdirSync(join(root, '.internal', 'arch'), { recursive: true })
  writeFileSync(join(root, '.internal', 'arch', 'plain.md'), '# 没指纹块\n')
  const res = stampArchDoc(root, '.internal/arch/plain.md')
  assert.equal(res.ok, false)
  assert.match(res.reason, /arch-cache/)
})

test('renderArchPointer states freshness, staleness and the no-doc soft hint', (t) => {
  const root = tmpRoot(t)
  writeFileSync(join(root, 'a.js'), 'x')
  writeArchDoc(root, '.internal/arch/d.md', { files: ['a.js'] })
  const fresh = renderArchPointer([archDocStatus(root, '.internal/arch/d.md')])
  assert.match(fresh, /新鲜/)
  writeFileSync(join(root, 'a.js'), 'xxxx')
  const stale = renderArchPointer([archDocStatus(root, '.internal/arch/d.md')])
  assert.match(stale, /过期/)
  assert.match(stale, /nav_arch mode="stamp"/, 'a stale doc must come with the one command that fixes the fingerprint')
  assert.match(renderArchPointer([]), /暂无架构档/, 'no arch doc is a soft hint, never a hard block')
})

test('arch-cache mtime accepts both UTC and local-wall-clock renderings of one instant', (t) => {
  const root = tmpRoot(t)
  writeFileSync(join(root, 'a.js'), 'x')
  writeArchDoc(root, '.internal/arch/d.md', { files: ['a.js'] })
  const abs = join(root, '.internal', 'arch', 'd.md')
  const st = statSync(join(root, 'a.js'))
  const utc = new Date(st.mtimeMs).toISOString()
  const local = new Date(st.mtimeMs - new Date(st.mtimeMs).getTimezoneOffset() * 60000).toISOString()
  // 库里两种写法都在（project-nav 各档 = UTC 带毫秒；shoucang 各档 = 本地墙上时间且截到秒）——
  // 指纹记的是瞬时，不是字符串：两种渲染都必须算命中，否则一半的档会永久假过期。
  writeFileSync(abs, readFileSync(abs, 'utf-8').replace(utc, local.slice(0, 19) + 'Z'))
  const asLocal = archDocStatus(root, '.internal/arch/d.md')
  assert.equal(asLocal.ok, true, 'the local rendering of the same instant is not drift')
  if (local !== utc) {
    assert.equal(asLocal.localForm, true)
    assert.equal(asLocal.truncated, true, 'second-precision stamps are the same instant, not drift')
  }
  // 第三种偏移（既非 UTC 也非本机本地）= 写法不符：只报不静默放行，且指明 stamp 校正
  const offHours = -new Date().getTimezoneOffset() / 60
  const odd = offHours === -3 ? -4 : -3
  writeFileSync(abs, readFileSync(abs, 'utf-8').replace(local.slice(0, 19) + 'Z', new Date(st.mtimeMs + odd * 3600000).toISOString()))
  const oddStatus = archDocStatus(root, '.internal/arch/d.md')
  assert.equal(oddStatus.ok, false, 'an alien offset is still not fresh')
  assert.equal(oddStatus.tzOnly, true)
  assert.match(renderArchPointer([oddStatus]), /写法不符/)
  // 真正的代码漂移（size 变了）不得被降级成写法问题
  writeFileSync(join(root, 'a.js'), 'xxxxx')
  assert.equal(archDocStatus(root, '.internal/arch/d.md').tzOnly, false)
})


