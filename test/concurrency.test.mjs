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
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
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
  const a = await call(tools, 'nav_plan', { task: 'A', features: 'PN-F01' }, 'session-A')
  const b = await call(tools, 'nav_plan', { task: 'B', features: 'DM-F01' }, 'session-B')
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
  await call(tools, 'nav_plan', { task: 'A', features: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'B', features: 'PN-F02' }, 'session-B')
  const beginA = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  assert.match(beginA, /in_progress/)
  const beginB = await call(tools, 'nav_mark', { id: 'ACT-002', action: 'begin' }, 'session-B')
  assert.match(beginB, /BLOCKED/, 'shared module must serialize: ' + beginB)
  assert.match(beginB, /queue position 1/)
})

test('derived-file overlap: different features in different modules, same file', async () => {
  const { tools } = await booted()
  // both scopes name a file that maps to the OTHER feature's file via the index
  await call(tools, 'nav_plan', { task: 'A', files: 'project-nav/host/index.js' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'B', features: 'PN-F01' }, 'session-B')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  const beginB = await call(tools, 'nav_mark', { id: 'ACT-002', action: 'begin' }, 'session-B')
  assert.match(beginB, /BLOCKED/)
  assert.match(beginB, /derived-file|file/, beginB)
})

test('wait=true queues until the holder finishes', async () => {
  const { tools } = await booted()
  await call(tools, 'nav_plan', { task: 'A', features: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'B', features: 'PN-F01' }, 'session-B')
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
  await call(tools, 'nav_plan', { task: 'A', features: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'B', features: 'PN-F01' }, 'session-B')
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
  await call(tools, 'nav_plan', { task: 'A1', features: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'A2', features: 'PN-F02' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'B1', features: 'DM-F01' }, 'session-B')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  const second = await call(tools, 'nav_mark', { id: 'ACT-002', action: 'begin' }, 'session-A')
  assert.match(second, /ERROR/)
  assert.match(second, /already holds/)
  const other = await call(tools, 'nav_mark', { id: 'ACT-003', action: 'begin' }, 'session-B')
  assert.match(other, /in_progress/, 'session B is unaffected by A\'s own busy state: ' + other)
})

test('only the holding session can close an action', async () => {
  const { tools } = await booted()
  await call(tools, 'nav_plan', { task: 'A', features: 'PN-F01' }, 'session-A')
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
  await Promise.all(scopes.map((f, i) => call(tools, 'nav_plan', { task: 'P' + i, features: f }, 'session-' + i)))
  const ledger = shared.loadActions(root)
  const ids = ledger.actions.map(a => a.id)
  assert.equal(ledger.actions.length, scopes.length, 'every concurrent plan must survive: ' + ids.join(','))
  assert.equal(new Set(ids).size, ids.length, 'ACT-ids must be unique: ' + ids.join(','))
})

test('occupied target is visible to other sessions in nav_query', async () => {
  const { tools } = await booted()
  await call(tools, 'nav_plan', { task: 'A', features: 'PN-F01' }, 'session-A')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  const asOther = await call(tools, 'nav_query', { target: 'project-nav/host/index.js' }, 'session-B')
  assert.match(asOther, /OCCUPIED/, asOther)
  assert.match(asOther, /session-A|session-/, asOther)
})

test('the user-facing case: same file named explicitly → conflict', async () => {
  const { tools } = await booted()
  await call(tools, 'nav_plan', { task: 'A edits host/index.js', files: 'host/index.js' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'B edits the same file, other path form', files: 'project-nav/host/index.js' }, 'session-B')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  const beginB = await call(tools, 'nav_mark', { id: 'ACT-002', action: 'begin', wait: false }, 'session-B')
  assert.match(beginB, /BLOCKED/, 'the same file in two path forms is still the same file: ' + beginB)
})

test('the user-facing case: disjoint directories → real parallelism', async () => {
  const { tools } = await booted()
  await call(tools, 'nav_plan', { task: 'A edits src/voice/', files: 'src/voice/mic.js' }, 'session-A')
  await call(tools, 'nav_plan', { task: 'B edits src/panel/', files: 'src/panel/tab.js' }, 'session-B')
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
  await call(tools, 'nav_plan', { task: 'A edits mic.js', files: 'src/voice/mic.js' }, 'session-A')
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
  await call(tools, 'nav_plan', { task: 'B edits tab.js', files: 'src/panel/tab.js' }, 'session-B')
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
  await call(tools, 'nav_plan', { task: 'C edits a.js', files: 'src/quiet/a.js' }, 'session-C')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-C')
  const done = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'done' }, 'session-C')
  assert.match(done, /Scope fingerprint verified/, done)
  assert.doesNotMatch(done, /drift since begin/i)
})

test('legacy entries (no owner) keep the old global single-lock behaviour', async () => {
  const { root, tools } = await booted()
  const legacy = { version: '1.0', actions: [{ id: 'ACT-001', task: 'legacy', plan: '', scope: { features: ['PN-F01'] }, status: 'in_progress', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: null }] }
  shared.saveActions(root, legacy)
  const plan = await call(tools, 'nav_plan', { task: 'B', features: 'DM-F01' }, 'session-B')
  assert.match(plan, /ACT-002|live action/, 'a legacy holder still blocks planning: ' + plan)
})

process.on('exit', () => { try { rmSync(join(tmpdir(), 'nav-conc-'), { recursive: true, force: true }) } catch {} })
