// test/concurrency.test.mjs — multi-session concurrency regression
//
// Proves the core claim of the concurrency feature on the REAL host module:
//   * disjoint scopes run in parallel (no global one-action-at-a-time lock)
//   * overlapping scopes QUEUE (begin is refused while a live holder exists)
//   * wait=true queues until the holder closes out
//   * a lease whose session died EXPIREs instead of wedging the workspace
//   * concurrent planners never lose an action or duplicate an ACT-id
//
// The host module imports two bare packages (dsh-tools, schemastery) that only
// resolve inside a DSH profile, so this test compiles host/index.js with an
// in-memory stub for those two and the runner's own stubs for ctx.tools.register
// and ctx.logger. Everything else (shared core included) is the real code.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHARED_URL = new URL('../shared/index.js', import.meta.url).href

const dshToolsShim = 'data:text/javascript,' + encodeURIComponent(
  'export const defineTool = (t) => ({ __navTool: true, ...t });\nexport default { defineTool };\n'
)
const schemasteryShim = 'data:text/javascript,' + encodeURIComponent(
  'const mk = () => ({ default: (v) => ({ default: () => v, __v: v }) });\nconst z = { object: (shape) => ({ ...shape, __schema: true, default: (v) => ({ ...shape, ...v }) }), string: mk, number: mk, boolean: mk };\nexport default z;\nexport { z };\n'
)

const raw = readFileSync(new URL('../host/index.js', import.meta.url), 'utf-8')
const patched = raw
  .replace(/from '@deepseek-ai\/dsh-tools'/g, `from '${dshToolsShim}'`)
  .replace(/from '@deepseek-ai\/schemastery'/g, `from '${schemasteryShim}'`)
  .replace(/from '..\/shared\/index\.js'/, `from '${SHARED_URL}'`)
  .replace(/^import \{ resolve, dirname \} from 'node:path'$/m, "import { resolve as _resolve, dirname } from 'node:path'")
  .replace(/(?<![_\w.])resolve\(/g, '_resolve(')

// The host module is compiled from a real temp file so its remaining imports
// behave exactly as in production (a data: URL cannot resolve relatives).
const compileDir = mkdtempSync(join(tmpdir(), 'nav-host-'))
const hostFile = join(compileDir, 'host.mjs')
writeFileSync(hostFile, patched)
const hostMod = await import(pathToFileURL(hostFile).href)
const shared = await import(SHARED_URL)

const INDEX = {
  version: '1.0',
  projectPaths: { 'PN-P01': 'project-nav', DEMO: 'demo' },
  indexes: {
    featureToFiles: {
      'PN-F01': ['project-nav/host/index.js'],
      'PN-F02': ['project-nav/shared/index.js'],
      'DM-F01': ['demo/host/index.js']
    },
    fileToFeature: {
      'project-nav/host/index.js': ['PN-F01'],
      'project-nav/shared/index.js': ['PN-F02'],
      'demo/host/index.js': ['DM-F01']
    },
    moduleToFeatures: { 'PN-M01': ['PN-F01', 'PN-F02'], 'DM-M01': ['DM-F01'] },
    projectToModules: { 'PN-P01': ['PN-M01'], DEMO: ['DM-M01'] }
  },
  descriptions: { 'PN-F01': { name: 'host' }, 'PN-F02': { name: 'shared' }, 'DM-F01': { name: 'demo' } },
  moduleMeta: {}, metadata: {}
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nav-conc-'))
  mkdirSync(join(root, '.internal'), { recursive: true })
  writeFileSync(join(root, '.internal', 'nav-index.json'), JSON.stringify(INDEX, null, 2))
  writeFileSync(join(root, '.internal', 'vector.json'), JSON.stringify({ doing: 'concurrency', next: 'test' }))
  writeFileSync(join(root, '.internal', 'nav-actions.json'), JSON.stringify({ version: '1.1', actions: [] }))
  writeFileSync(join(root, '.internal', 'nav-docs.json'), JSON.stringify({ version: '1.0', docs: [] }))
  return root
}

/** Boot the real host module against a temp root and hand back its tool table. */
function boot(root, config = {}) {
  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    effect: (fn) => { fn(); return () => {} },
    tools: { register: (t) => { tools.set(t.name, t); return () => {} } }
  }
  hostMod.apply(ctx, { root, ...config })
  return tools
}

/** Call one tool as one session (exec.agent.id is the SessionId the host reads). */
async function call(tools, name, args, sessionId) {
  const t = tools.get(name)
  if (!t) throw new Error('no tool ' + name)
  const exec = sessionId ? { agent: { id: sessionId } } : undefined
  return await t.execute(args, exec)
}

async function booted() {
  const root = makeRoot()
  return { root, tools: boot(root) }
}

test('disjoint scopes: two sessions hold live locks at the same time', async () => {
  const { tools } = await booted()
  const a = await call(tools, 'nav_plan', { task: 'A', features: 'PN-F01' , anchor: 'PN-F01' }, 'session-A')
  const b = await call(tools, 'nav_plan', { task: 'B', features: 'DM-F01' , anchor: 'PN-F01' }, 'session-B')
  assert.match(a, /ACT-001/)
  assert.match(b, /ACT-002/)
  const aId = /ACT-\d+/.exec(a)[0]
  const bId = /ACT-\d+/.exec(b)[0]
  const beginA = await call(tools, 'nav_mark', { id: aId, action: 'begin' }, 'session-A')
  const beginB = await call(tools, 'nav_mark', { id: bId, action: 'begin' }, 'session-B')
  assert.match(beginA, /in_progress/)
  assert.match(beginB, /in_progress/, 'a disjoint scope must NOT be blocked: ' + beginB)
})

test('same module (disjoint features) is still a conflict', async () => {
  const { tools } = await booted()
  await call(tools, 'nav_plan', { task: 'A', features: 'PN-F01' , anchor: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'B', features: 'PN-F02' , anchor: 'PN-F01' }, 'session-B')
  const beginA = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  assert.match(beginA, /in_progress/)
  const beginB = await call(tools, 'nav_mark', { id: 'ACT-002', action: 'begin' }, 'session-B')
  assert.match(beginB, /BLOCKED/, 'shared module must serialize: ' + beginB)
  assert.match(beginB, /queue position 1/)
})

test('derived-file overlap: different features in different modules, same file', async () => {
  const { tools } = await booted()
  // both scopes name a file that maps to the OTHER feature's file via the index
  await call(tools, 'nav_plan', { task: 'A', files: 'project-nav/host/index.js' , anchor: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'B', features: 'PN-F01' , anchor: 'PN-F01' }, 'session-B')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  const beginB = await call(tools, 'nav_mark', { id: 'ACT-002', action: 'begin' }, 'session-B')
  assert.match(beginB, /BLOCKED/)
  assert.match(beginB, /derived-file|file/, beginB)
})

test('wait=true queues until the holder finishes', async () => {
  const { tools } = await booted()
  await call(tools, 'nav_plan', { task: 'A', features: 'PN-F01' , anchor: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'B', features: 'PN-F01' , anchor: 'PN-F01' }, 'session-B')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  const pending = call(tools, 'nav_mark', { id: 'ACT-002', action: 'begin', wait: true, waitMs: 6000 }, 'session-B')
  await new Promise(r => setTimeout(r, 300))
  const done = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'done' }, 'session-A')
  assert.match(done, /done/)
  assert.match(done, /ACT-002/, 'done must announce the unblocked queued action: ' + done)
  const beginB = await pending
  assert.match(beginB, /in_progress/, 'queued session must start once the holder closes: ' + beginB)
})

test('lease expiry: a dead session never wedges the workspace', async () => {
  const { root, tools } = await booted()
  await call(tools, 'nav_plan', { task: 'A', features: 'PN-F01' , anchor: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'B', features: 'PN-F01' , anchor: 'PN-F01' }, 'session-B')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  // simulate: session-A crashed two hours ago, its lease lapsed
  const ledger = shared.loadActions(root)
  const act = ledger.actions.find(x => x.id === 'ACT-001')
  const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  act.startedAt = old
  act.lease = { acquiredAt: old, renewedAt: old, ttlMs: 60 * 1000 }
  shared.saveActions(root, ledger)
  const beginB = await call(tools, 'nav_mark', { id: 'ACT-002', action: 'begin' }, 'session-B')
  assert.match(beginB, /in_progress/, 'lapsed lease must self-heal: ' + beginB)
  const after = shared.loadActions(root)
  assert.equal(after.actions.find(x => x.id === 'ACT-001').status, 'expired')
})

test('one in_progress per session (other sessions keep their lock)', async () => {
  const { tools } = await booted()
  await call(tools, 'nav_plan', { task: 'A1', features: 'PN-F01' , anchor: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'A2', features: 'PN-F02' , anchor: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'B1', features: 'DM-F01' , anchor: 'PN-F01' }, 'session-B')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  const second = await call(tools, 'nav_mark', { id: 'ACT-002', action: 'begin' }, 'session-A')
  assert.match(second, /ERROR/)
  assert.match(second, /already holds/)
  const other = await call(tools, 'nav_mark', { id: 'ACT-003', action: 'begin' }, 'session-B')
  assert.match(other, /in_progress/, 'session B is unaffected by A\'s own busy state: ' + other)
})

test('only the holding session can close an action', async () => {
  const { tools } = await booted()
  await call(tools, 'nav_plan', { task: 'A', features: 'PN-F01' , anchor: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  const stolen = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'done' }, 'session-B')
  assert.match(stolen, /ERROR/)
  assert.match(stolen, /held by/)
  const ok = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'done' }, 'session-A')
  assert.match(ok, /done/)
})

test('concurrent planners lose no action and duplicate no id', async () => {
  const { root, tools } = await booted()
  const scopes = ['PN-F01', 'PN-F02', 'DM-F01', 'PN-F01', 'DM-F01', 'PN-F02']
  await Promise.all(scopes.map((f, i) => call(tools, 'nav_plan', { task: 'P' + i, features: f , anchor: 'PN-F01' }, 'session-' + i)))
  const ledger = shared.loadActions(root)
  const ids = ledger.actions.map(a => a.id)
  assert.equal(ledger.actions.length, scopes.length, 'every concurrent plan must survive: ' + ids.join(','))
  assert.equal(new Set(ids).size, ids.length, 'ACT-ids must be unique: ' + ids.join(','))
})

test('occupied target is visible to other sessions in nav_query', async () => {
  const { tools } = await booted()
  await call(tools, 'nav_plan', { task: 'A', features: 'PN-F01' , anchor: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  const asOther = await call(tools, 'nav_query', { target: 'project-nav/host/index.js' }, 'session-B')
  assert.match(asOther, /OCCUPIED/, asOther)
  assert.match(asOther, /session-A|session-/, asOther)
})

test('the user-facing case: same file named explicitly → conflict', async () => {
  const { tools } = await booted()
  await call(tools, 'nav_plan', { task: 'A edits host/index.js', files: 'host/index.js' , anchor: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'B edits the same file, other path form', files: 'project-nav/host/index.js' , anchor: 'PN-F01' }, 'session-B')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  const beginB = await call(tools, 'nav_mark', { id: 'ACT-002', action: 'begin', wait: false }, 'session-B')
  assert.match(beginB, /BLOCKED/, 'the same file in two path forms is still the same file: ' + beginB)
})

test('the user-facing case: disjoint directories → real parallelism', async () => {
  const { tools } = await booted()
  await call(tools, 'nav_plan', { task: 'A edits src/voice/', files: 'src/voice/mic.js' , anchor: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'B edits src/panel/', files: 'src/panel/tab.js' , anchor: 'PN-F01' }, 'session-B')
  const beginA = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  const beginB = await call(tools, 'nav_mark', { id: 'ACT-002', action: 'begin' }, 'session-B')
  assert.match(beginA, /in_progress/, beginA)
  assert.match(beginB, /in_progress/, 'different directories must run in parallel: ' + beginB)
})



test('fingerprint drift: a file changed under the action is reported at done', async () => {
  const { root, tools } = await booted()
  mkdirSync(join(root, 'src', 'voice'), { recursive: true })
  const target = join(root, 'src', 'voice', 'mic.js')
  writeFileSync(target, 'original')
  await call(tools, 'nav_plan', { task: 'A edits mic.js', files: 'src/voice/mic.js' , anchor: 'PN-F01' }, 'session-A')
  const begin = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  assert.match(begin, /in_progress/)
  writeFileSync(target, 'somebody else rewrote this')   // another session / an editor / a cleanup
  const done = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'done' }, 'session-A')
  assert.match(done, /Scope drift since begin/, 'drift must be reported: ' + done)
  assert.match(done, /src\/voice\/mic\.js/)
  const led = shared.loadActions(root)
  assert.ok(led.actions[0].drift, 'drift must be recorded on the action')
  assert.deepEqual(led.actions[0].drift.changed, ['src/voice/mic.js'])
})

test('fingerprint drift: a file that vanished under the action is reported', async () => {
  const { root, tools } = await booted()
  mkdirSync(join(root, 'src', 'panel'), { recursive: true })
  const target = join(root, 'src', 'panel', 'tab.js')
  writeFileSync(target, 'panel')
  await call(tools, 'nav_plan', { task: 'B edits tab.js', files: 'src/panel/tab.js' , anchor: 'PN-F01' }, 'session-B')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-B')
  rmSync(target, { force: true })
  const done = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'done' }, 'session-B')
  assert.match(done, /vanished/)
  assert.match(done, /src\/panel\/tab\.js/)
})

test('fingerprint clean run reports verification, not drift', async () => {
  const { root, tools } = await booted()
  mkdirSync(join(root, 'src', 'quiet'), { recursive: true })
  writeFileSync(join(root, 'src', 'quiet', 'a.js'), 'quiet')
  await call(tools, 'nav_plan', { task: 'C edits a.js', files: 'src/quiet/a.js' , anchor: 'PN-F01' }, 'session-C')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-C')
  const done = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'done' }, 'session-C')
  assert.match(done, /Scope fingerprint verified/, done)
  assert.doesNotMatch(done, /drift since begin/i)
})

test('legacy entries (no owner) keep the old global single-lock behaviour', async () => {
  const { root, tools } = await booted()
  const legacy = { version: '1.0', actions: [{ id: 'ACT-001', task: 'legacy', plan: '', scope: { features: ['PN-F01'] }, status: 'in_progress', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: null }] }
  shared.saveActions(root, legacy)
  const plan = await call(tools, 'nav_plan', { task: 'B', features: 'DM-F01' , anchor: 'PN-F01' }, 'session-B')
  assert.match(plan, /ACT-002|live action/, 'a legacy holder still blocks planning: ' + plan)
})

test('architecture-first: ambiguous scope still refuses to plan without an anchor', async () => {
  const { tools } = await booted()
  const out = await call(tools, 'nav_plan', { task: 'no anchor', features: 'PN-F01,DM-F01' }, 'session-A')
  assert.match(out, /requires anchor/, out)
  assert.doesNotMatch(out, /ACT-\d+/)
})

test('architecture-first: a single-target scope is auto-anchored (less friction, same gate)', async () => {
  const { root, tools } = await booted()
  const out = await call(tools, 'nav_plan', { task: 'auto anchored', features: 'PN-F01' }, 'session-A')
  assert.match(out, /自动取自 scope 的唯一功能 PN-F01/, out)
  const led = shared.loadActions(root)
  assert.equal(led.actions[0].anchor, 'PN-F01')
  assert.equal(led.actions[0].anchorKind, 'feature')
})

test('architecture-first: nav_plan refuses an anchor that is not an architecture node', async () => {
  const { tools } = await booted()
  const out = await call(tools, 'nav_plan', { task: 'bad anchor', features: 'PN-F01', anchor: 'NOPE-X99' }, 'session-A')
  assert.match(out, /不是真实架构节点/, out)
})

test('architecture-first: a real anchor is recorded on the action', async () => {
  const { root, tools } = await booted()
  const out = await call(tools, 'nav_plan', { task: 'anchored', features: 'PN-F01', anchor: 'PN-F01' }, 'session-A')
  assert.match(out, /Anchor: PN-F01 \(feature\)/, out)
  const led = shared.loadActions(root)
  assert.equal(led.actions[0].anchor, 'PN-F01')
  assert.equal(led.actions[0].anchorKind, 'feature')
})

test('architecture-first: missing arch= reflection warns but does not block', async () => {
  const { tools } = await booted()
  const out = await call(tools, 'nav_plan', { task: 'no reflection', features: 'PN-F01', anchor: 'PN-F01' }, 'session-A')
  assert.match(out, /架构反思缺失/, out)
  assert.match(out, /ACT-001/)
  const withArch = await call(tools, 'nav_plan', { task: 'with reflection', features: 'DM-F01', anchor: 'DM-F01', arch: '架构成立，改动是局部的' }, 'session-B')
  assert.doesNotMatch(withArch, /架构反思缺失/)
  assert.match(withArch, /arch: 架构成立/)
})

test('architecture-first: three patches on one anchor trigger the repeat-patch gate', async () => {
  const { root, tools } = await booted()
  for (let i = 1; i <= 3; i++) {
    const id = 'ACT-00' + i
    await call(tools, 'nav_plan', { task: 'patch ' + i, features: 'PN-F01', anchor: 'PN-F01' }, 'session-A')
    await call(tools, 'nav_mark', { id, action: 'begin' }, 'session-A')
    const done = await call(tools, 'nav_mark', { id, action: 'done' }, 'session-A')
    if (i === 3) assert.match(done, /3 次补丁/, done)   // threshold message wording
  }
  const logged = shared.loadActions(root).actions.filter(a => a.status === 'done' && a.anchor === 'PN-F01')
  assert.equal(logged.length, 3, 'done actions carrying an anchor ARE the patch log — no separate ledger to drift')
  const next = await call(tools, 'nav_plan', { task: 'patch 4', features: 'PN-F01', anchor: 'PN-F01' }, 'session-A')
  assert.match(next, /计数闸触发/, next)
  assert.match(next, /nav_adr/, next)
})

test('architecture-first: a closed action cannot be closed twice (patch counted once)', async () => {
  const { root, tools } = await booted()
  await call(tools, 'nav_plan', { task: 'once', features: 'PN-F01', anchor: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  const first = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'done' }, 'session-A')
  assert.match(first, /done/)
  const second = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'done' }, 'session-A')   // must not double-count
  assert.match(second, /ERROR/, second)
  const doneCount = shared.loadActions(root).actions.filter(a => a.status === 'done' && a.anchor === 'PN-F01').length
  assert.equal(doneCount, 1)
})

test('architecture-first: nav_adr records a decision and resets the anchor counter', async () => {
  const { root, tools } = await booted()
  for (let i = 1; i <= 3; i++) {
    await call(tools, 'nav_plan', { task: 'patch ' + i, features: 'PN-F01', anchor: 'PN-F01' }, 'session-A')
    await call(tools, 'nav_mark', { id: 'ACT-00' + i, action: 'begin' }, 'session-A')
    await call(tools, 'nav_mark', { id: 'ACT-00' + i, action: 'done' }, 'session-A')
  }
  const bad = await call(tools, 'nav_adr', { anchor: 'NOPE-X99', reason: 'r', decision: 'd' }, 'session-A')
  assert.match(bad, /ERROR/, bad)
  const adr = await call(tools, 'nav_adr', { anchor: 'PN-F01', reason: '三次补丁说明职责过载', decision: '把闸门判定抽成独立层', impact: 'PN-F01 → PN-M02' }, 'session-A')
  assert.match(adr, /ADR-001/, adr)
  assert.match(adr, /Patch counter reset: 3/, adr)
  const arch = shared.loadArch(root)
  assert.equal(arch.decisions.length, 1)
  assert.equal(arch.decisions[0].anchor, 'PN-F01')
  const after = await call(tools, 'nav_plan', { task: 'after adr', features: 'PN-F01', anchor: 'PN-F01' }, 'session-B')
  assert.doesNotMatch(after, /计数闸触发/, 'a decision must reset the anchor pressure')
})
test('consolidated: nav_update creates AND updates features and modules (one registration tool)', async () => {
  const { root, tools } = await booted()
  const f = await call(tools, 'nav_update', { target: 'XX-F09', name: 'new feature', userView: 'u', systemView: 's', files: 'src/new.js' }, 'session-A')
  assert.match(f, /created/, f)
  const m = await call(tools, 'nav_update', { target: 'XX-M01', features: 'XX-F09', project: 'DEMO', name: 'mod' }, 'session-A')
  assert.match(m, /created/, m)
  const idx = shared.loadIndex(root)
  assert.deepEqual(idx.indexes.featureToFiles['XX-F09'], ['src/new.js'])
  assert.deepEqual(idx.indexes.moduleToFeatures['XX-M01'], ['XX-F09'])
  assert.ok(idx.indexes.projectToModules.DEMO.includes('XX-M01'), 'module attached to project')
  const upd = await call(tools, 'nav_update', { target: 'XX-F09', field: 'status', value: 'stable' }, 'session-A')
  assert.match(upd, /Updated feature XX-F09/, upd)
  assert.equal(shared.loadIndex(root).descriptions['XX-F09'].status, 'stable')
  const bad = await call(tools, 'nav_update', { target: 'XX-F09' }, 'session-A')
  assert.match(bad, /requires field \+ value/, bad)
})

test('consolidated: nav_docs registers and queries in one tool', async () => {
  const { tools } = await booted()
  const target = join(process.cwd(), 'package.json')
  const reg = await call(tools, 'nav_docs', { title: 'handbook', path: target, when: '并发, 指纹, 闸门' }, 'session-A')
  assert.match(reg, /Registered DOC-001/, reg)
  const dup = await call(tools, 'nav_docs', { title: 'x', path: target, when: 'y' }, 'session-A')
  assert.match(dup, /already registered/, dup)
  const ranked = await call(tools, 'nav_docs', { task: '我要改并发与指纹' }, 'session-A')
  assert.match(ranked, /DOC-001/, ranked)
  const dead = await call(tools, 'nav_docs', { title: 't', path: join(process.cwd(), 'no-such-file.md'), when: 'w' }, 'session-A')
  assert.match(dead, /does not exist/, dead)
  const partial = await call(tools, 'nav_docs', { title: 't' }, 'session-A')
  assert.match(partial, /requires title \+ path \+ when/, partial)
})

test('consolidated: nav_sync_docs derives an ADR section from the architecture ledger', async () => {
  const { root, tools } = await booted()
  await call(tools, 'nav_adr', { anchor: 'PN-F01', reason: 'r', decision: '抽层', impact: 'PN-M01' }, 'session-A')
  const out = await call(tools, 'nav_sync_docs', {}, 'session-A')
  assert.match(out, /auto-section aligned/, out)
  const md = readFileSync(join(root, 'PROJECT.md'), 'utf-8')
  assert.match(md, /架构决策（ADR，自动对齐）/, md)
  assert.match(md, /ADR-001/)
})

// ---- v0.7.0 (G2): every read-modify-write of shared state is serialized ----
// Without a lock these are classic lost-update races: two writers each load the
// same snapshot, each write it back, and the later rename silently drops the
// other's work. That is exactly how PN-P01's index kept reverting.

test('G2: concurrent index writers lose no update', async () => {
  const { root, tools } = await booted()
  const codes = Array.from({ length: 8 }, (_, i) => 'CW-F0' + (i + 1))
  await Promise.all(codes.map((code, i) =>
    call(tools, 'nav_update', { target: code, name: 'w' + i, files: 'src/w' + i + '.js' }, 'session-' + i)))
  const idx = shared.loadIndex(root)
  const missing = codes.filter(c => !idx.indexes.featureToFiles[c])
  assert.deepEqual(missing, [], 'every concurrent create must survive; missing: ' + missing.join(','))
  const files = codes.map((_, i) => 'src/w' + i + '.js')
  const unmapped = files.filter(f => !(idx.indexes.fileToFeature[f] || []).length)
  assert.deepEqual(unmapped, [], 'every file mapping must survive; missing: ' + unmapped.join(','))
})

test('G2: concurrent reference-doc registrations lose no doc', async () => {
  const { root, tools } = await booted()
  const files = ['package.json', 'README.md', 'README.en.md', 'LICENSE', 'HANDOFF.md', 'host/cordis.patch.yml']
    .map(f => join(process.cwd(), f))
  await Promise.all(files.map((p, i) =>
    call(tools, 'nav_docs', { title: 'doc' + i, path: p, when: 'kw' + i }, 'session-' + i)))
  const registry = shared.loadDocs(root)
  assert.equal(registry.docs.length, files.length, 'every concurrent registration must survive')
  const ids = registry.docs.map(d => d.id)
  assert.equal(new Set(ids).size, ids.length, 'DOC ids must be unique: ' + ids.join(','))
})

test('G2: concurrent architecture decisions get distinct ADR ids', async () => {
  const { root, tools } = await booted()
  const anchors = ['PN-F01', 'PN-F02', 'DM-F01', 'PN-M01']
  await Promise.all(anchors.map((a, i) =>
    call(tools, 'nav_adr', { anchor: a, reason: 'r' + i, decision: 'd' + i }, 'session-' + i)))
  const arch = shared.loadArch(root)
  assert.equal(arch.decisions.length, anchors.length, 'every concurrent decision must survive')
  const ids = arch.decisions.map(d => d.id)
  assert.equal(new Set(ids).size, ids.length, 'ADR ids must be unique: ' + ids.join(','))
})

test('G2: locks are released — no lock file survives a mixed write burst', async () => {
  const { root, tools } = await booted()
  await Promise.all([
    call(tools, 'nav_update', { target: 'LK-F01', name: 'x', files: 'src/lk.js' }, 'session-A'),
    call(tools, 'nav_set_vector', { doing: 'lk' }, 'session-B'),
    call(tools, 'nav_adr', { anchor: 'PN-F01', reason: 'r', decision: 'd' }, 'session-C'),
    call(tools, 'nav_sync_docs', {}, 'session-D')
  ])
  const lockDir = join(root, '.internal', 'locks')
  const left = existsSync(lockDir) ? readdirSync(lockDir).filter(f => f.endsWith('.lock')) : []
  assert.deepEqual(left, [], 'no lock file may be left behind: ' + left.join(','))
})

// The tests above prove no update is lost. This one proves the primitive itself:
// mutual exclusion holds even when a section contains an await (the point where a
// synchronous read-modify-write would otherwise interleave), a lock whose owner
// died is broken by age instead of wedging the workspace, and the lock is released.

test('G2: the file lock is mutually exclusive, stale-safe and always released', async () => {
  const { root } = await booted()
  const order = []
  await Promise.all([1, 2, 3].map(n => shared.withFileLock(root, 'primitive-probe', async () => {
    order.push('enter' + n)
    await new Promise(r => setTimeout(r, 25))
    order.push('exit' + n)
  })))
  assert.equal(order.length, 6)
  for (let i = 0; i < order.length; i += 2) {
    assert.match(order[i], /^enter/, 'sections must not interleave: ' + order.join(','))
    assert.match(order[i + 1], /^exit/, 'sections must not interleave: ' + order.join(','))
  }

  // A foreign lock abandoned by a dead owner must be broken, not waited on. The
  // staleness signal is the lock FILE's mtime (a crashed process cannot forge it),
  // so the simulation backdates the file itself — writing an old `at` payload with
  // a fresh mtime is NOT a dead owner and must still block.
  const lockPath = shared.lockPathFor(root, 'primitive-probe')
  mkdirSync(join(root, '.internal', 'locks'), { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ token: 'foreign-dead-owner', pid: 999999, at: new Date(Date.now() - 60000).toISOString() }))
  const backdated = (Date.now() - 60000) / 1000
  utimesSync(lockPath, backdated, backdated)
  const t0 = Date.now()
  const got = await shared.withFileLock(root, 'primitive-probe', () => 'acquired')
  assert.equal(got, 'acquired', 'an aged foreign lock must be broken')
  assert.ok(Date.now() - t0 < 5000, 'breaking must be immediate, not the full timeout')
  assert.equal(existsSync(lockPath), false, 'the lock must be released when the section ends')
})

process.on('exit', () => { try { rmSync(join(tmpdir(), 'nav-conc-'), { recursive: true, force: true }) } catch {} })
