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

/** Boot the real host module against a temp root and hand back its tool table + listeners. */
function boot(root, config = {}, sandboxPolicy = undefined) {
  const tools = new Map()
  const handlers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect: (fn) => { fn(); return () => {} },
    on: (name, listener) => { handlers.push({ name, listener }); return () => {} },
    get: (name) => (name === 'sandboxPolicy' ? sandboxPolicy : undefined),
    tools: { register: (t) => { tools.set(t.name, t); return () => {} } }
  }
  hostMod.apply(ctx, { root, ...config })
  return { tools, handlers }
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
  return { root, ...boot(root) }
}

test('workspace boundary: binds governed sessions once, and never touches the rest', async () => {
  const root = makeRoot()
  const appended = []
  const policy = { overrideOf: () => undefined }
  const { handlers } = boot(root, {}, policy)
  const start = handlers.find(h => h.name === 'agent/session-start')?.listener
  assert.ok(start, 'the boundary listener is registered at session start')

  const session = (cwd, id) => ({ header: { cwd }, append: (type, data) => appended.push({ id, type, data }) })

  // governed workspace → bound to workspace-write
  start({ agent: { id: 'session-a', session: session(join(root, 'project-nav'), 'session-a') } })
  assert.deepEqual(appended.map(a => a.type), ['sandbox/mode'])
  assert.equal(appended[0].data.mode, 'workspace-write')

  // the same session again (resume) already carries a mode → never appended twice
  policy.overrideOf = () => 'workspace-write'
  start({ agent: { id: 'session-a', session: session(join(root, 'project-nav'), 'session-a') } })
  assert.equal(appended.length, 1)

  // a user's explicit choice is respected, not overridden
  policy.overrideOf = () => 'danger-full-access'
  start({ agent: { id: 'session-b', session: session(join(root, 'project-nav'), 'session-b') } })
  assert.equal(appended.length, 1)

  // a directory inside the root that is not a registered project → untouched
  policy.overrideOf = () => undefined
  start({ agent: { id: 'session-c', session: session(join(root, 'scratch'), 'session-c') } })
  // outside the root entirely → untouched
  start({ agent: { id: 'session-d', session: session('C:\\elsewhere', 'session-d') } })
  // no cwd at all → untouched, and must not throw
  start({ agent: { id: 'session-e', session: { header: {}, append: () => assert.fail('must not append') } } })
  assert.equal(appended.length, 1)

  // autoBindWorkspace=false leaves even a governed session alone
  const off = boot(root, { autoBindWorkspace: false }, policy)
  assert.equal(off.handlers.filter(h => h.name === 'agent/session-start').length, 0)
})

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
  // The holder must be identifiable. The label carries the distinctive part of the id
  // (session-A → A): slicing the first 8 characters labelled every DSH session "session-".
  assert.match(asOther, /by session A\b/, asOther)
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

// ---- retire: the index lifecycle needs a deletion, or drift reports become noise ----

test('retire: a feature cascades its file mappings and module membership', async () => {
  const { root, tools } = await booted()
  const out = await call(tools, 'nav_update', { target: 'PN-F01', retire: true }, 'session-A')
  assert.match(out, /Retired feature PN-F01/)
  const idx = shared.loadIndex(root)
  assert.equal(idx.indexes.featureToFiles['PN-F01'], undefined, 'feature entry gone')
  assert.equal(idx.indexes.fileToFeature['project-nav/host/index.js'], undefined, 'sole-owned file mapping gone')
  assert.deepEqual(idx.indexes.moduleToFeatures['PN-M01'], ['PN-F02'], 'module membership cleaned')
  assert.equal(idx.descriptions['PN-F01'], undefined, 'description gone')
  assert.deepEqual(idx.indexes.fileToFeature['project-nav/shared/index.js'], ['PN-F02'], 'other features untouched')
})

test('retire: a file still owned by another feature keeps that owner', async () => {
  const { root, tools } = await booted()
  await call(tools, 'nav_update', { target: 'DM-F01', field: 'files', value: 'project-nav/host/index.js,demo/host/index.js' }, 'session-A')
  await call(tools, 'nav_update', { target: 'PN-F01', retire: true }, 'session-A')
  const idx = shared.loadIndex(root)
  assert.deepEqual(idx.indexes.fileToFeature['project-nav/host/index.js'], ['DM-F01'], 'the surviving owner must remain')
})

test('retire: unknown target is refused; a project detaches its modules without deleting them', async () => {
  const { root, tools } = await booted()
  const bad = await call(tools, 'nav_update', { target: 'NOPE-F99', retire: true }, 'session-A')
  assert.match(bad, /^ERROR/)
  const out = await call(tools, 'nav_update', { target: 'DEMO', retire: true }, 'session-A')
  assert.match(out, /Retired project DEMO/)
  const idx = shared.loadIndex(root)
  assert.equal(idx.indexes.projectToModules['DEMO'], undefined, 'project entry gone')
  assert.deepEqual(idx.indexes.moduleToFeatures['DM-M01'], ['DM-F01'], 'modules survive a project retirement')
})

test('retire: refused while an open action still references the target', async () => {
  const { root, tools } = await booted()
  await call(tools, 'nav_plan', { task: 'work on PN-F01', anchor: 'PN-F01', features: 'PN-F01' }, 'session-A')
  const out = await call(tools, 'nav_update', { target: 'PN-F01', retire: true }, 'session-B')
  assert.match(out, /^ERROR/)
  assert.match(out, /open action/)
  const idx = shared.loadIndex(root)
  assert.ok(idx.indexes.featureToFiles['PN-F01'], 'nothing may be retired while work is in flight')
})

test('retire: a fileless feature (module member only) is retirable', async () => {
  const { root, tools } = await booted()
  await call(tools, 'nav_update', { target: 'PN-M01', features: 'PN-F01,PN-F02,NEW-F01' }, 'session-A')
  assert.equal(shared.loadIndex(root).indexes.featureToFiles['NEW-F01'], undefined, 'precondition: no files declared')
  const out = await call(tools, 'nav_update', { target: 'NEW-F01', retire: true }, 'session-A')
  assert.match(out, /Retired feature NEW-F01/)
  assert.deepEqual(shared.loadIndex(root).indexes.moduleToFeatures['PN-M01'], ['PN-F01', 'PN-F02'], 'membership cleaned')
})

test('retire: a reverse-only mapping is swept too (asymmetric index)', async () => {
  const { root, tools } = await booted()
  // The real workspace carried exactly this shape: fileToFeature points at a feature
  // that never declared the file forward, so a forward-only cleanup leaves an orphan
  // that keeps reporting a deleted file forever.
  const file = join(root, '.internal', 'nav-index.json')
  const raw = JSON.parse(readFileSync(file, 'utf-8'))
  raw.indexes.fileToFeature['ghost/file.mjs'] = ['PN-F02']
  writeFileSync(file, JSON.stringify(raw, null, 2))
  await call(tools, 'nav_update', { target: 'PN-F02', retire: true }, 'session-A')
  assert.equal(shared.loadIndex(root).indexes.fileToFeature['ghost/file.mjs'], undefined, 'the orphan must not survive')
})

// ---- scope file resolution: one rule, not three (v0.7.2) ----
// nav_plan's pre-check, nav_mark done's delta and the fingerprint snapshot each asked
// "is this scope file registered?" with a different rule, so a scope written from inside
// a project directory was reported as an unregistered file even though the index knew it.
// A false alarm at close-out is worse than no check: it teaches the agent to ignore the signal.

test('scope files: a project-relative spelling resolves instead of crying "unregistered"', async () => {
  const { root, tools } = await booted()
  // The index spells this file project-nav/host/index.js; the session sits in project-nav.
  mkdirSync(join(root, 'project-nav', 'host'), { recursive: true })
  writeFileSync(join(root, 'project-nav', 'host', 'index.js'), '// host\n')
  const plan = await call(tools, 'nav_plan', { task: 'touch host', anchor: 'PN-F01', files: 'host/index.js' }, 'session-A')
  assert.doesNotMatch(plan, /Scope items not found in index/, 'plan must not report the indexed file as unknown')
  const id = plan.match(/ACT-\d+/)[0]
  await call(tools, 'nav_mark', { id, action: 'begin' }, 'session-A')
  const done = await call(tools, 'nav_mark', { id, action: 'done' }, 'session-A')
  assert.doesNotMatch(done, /索引外文件/, 'close-out must not ask to register an already-registered file')
})

test('scope files: a genuinely new file is still surfaced as unregistered', async () => {
  const { root, tools } = await booted()
  const plan = await call(tools, 'nav_plan', { task: 'add a file', anchor: 'PN-F01', files: 'brand/new.mjs' }, 'session-A')
  assert.match(plan, /Scope items not found in index/, 'an unknown identifier must still be reported')
  const id = plan.match(/ACT-\d+/)[0]
  await call(tools, 'nav_mark', { id, action: 'begin' }, 'session-A')
  const done = await call(tools, 'nav_mark', { id, action: 'done' }, 'session-A')
  assert.match(done, /索引外文件/, 'close-out must still ask to register a genuinely new file')
})

// ---- the repeat-patch gate counts PATCHES, not bookkeeping (v0.7.3) ----
// Live evidence: a pure verification action (whose own close-out said "none of the scoped
// files changed") still incremented its anchor's patch counter, pushing it toward the gate.
// Counting that would force an architecture decision for work that never happened.

test('repeat-patch gate: an action that changed nothing is not counted as a patch', async () => {
  const { root, tools } = await booted()
  writeFileSync(join(root, 'work.mjs'), 'v1')
  const plan = await call(tools, 'nav_plan', { task: 'look only', anchor: 'PN-F01', files: 'work.mjs' }, 'session-A')
  const id = plan.match(/ACT-\d+/)[0]
  await call(tools, 'nav_mark', { id, action: 'begin' }, 'session-A')
  await call(tools, 'nav_mark', { id, action: 'done' }, 'session-A')
  const ledger = shared.loadActions(root)
  assert.equal(ledger.actions.find(a => a.id === id).noChange, true, 'byte-identical scope must be recorded as no-change')
  const pr = shared.repeatPressure(shared.loadArch(root), ledger.actions, 'PN-F01')
  assert.equal(pr.count, 0, 'a no-change action must not count toward the gate')
  assert.deepEqual(pr.skipped, [id], 'and it must be reported as skipped, not silently dropped')
})

test('repeat-patch gate: an action that did change a scoped file still counts', async () => {
  const { root, tools } = await booted()
  writeFileSync(join(root, 'work.mjs'), 'v1')
  const plan = await call(tools, 'nav_plan', { task: 'real patch', anchor: 'PN-F01', files: 'work.mjs' }, 'session-A')
  const id = plan.match(/ACT-\d+/)[0]
  await call(tools, 'nav_mark', { id, action: 'begin' }, 'session-A')
  writeFileSync(join(root, 'work.mjs'), 'v2 — actually patched')
  await call(tools, 'nav_mark', { id, action: 'done' }, 'session-A')
  const ledger = shared.loadActions(root)
  assert.notEqual(ledger.actions.find(a => a.id === id).noChange, true, 'a real change must not be marked no-change')
  assert.equal(shared.repeatPressure(shared.loadArch(root), ledger.actions, 'PN-F01').count, 1, 'a real patch must count')
})

test('repeat-patch gate: with no fingerprint evidence the action still counts (conservative)', async () => {
  const { root } = await booted()
  writeFileSync(join(root, '.internal', 'nav-actions.json'), JSON.stringify({
    version: '1.1',
    actions: [{ id: 'ACT-900', status: 'done', anchor: 'PN-F01', task: 'legacy action', completedAt: new Date().toISOString() }]
  }))
  const ledger = shared.loadActions(root)
  assert.equal(shared.repeatPressure(shared.loadArch(root), ledger.actions, 'PN-F01').count, 1, 'no evidence must never weaken the gate')
})

// ---- v0.7.4: the fingerprint must cover INDEXED files, and a lapsed lease is not a dead end ----
// Live measurement that motivated this block: 12 of 18 features (every feature of project-nav and
// shoucang) resolved to ZERO fingerprintable paths, because the index spells those files
// workspace-relative ("project-nav/host/index.js") and the scope resolver dropped any path whose
// first segment was a project directory. Drift was silently unreported.

test('fingerprint: a feature-scoped action fingerprints its indexed, project-prefixed files', async () => {
  const { root, tools } = await booted()
  mkdirSync(join(root, 'project-nav', 'host'), { recursive: true })
  const target = join(root, 'project-nav', 'host', 'index.js')
  writeFileSync(target, 'v1')
  const plan = await call(tools, 'nav_plan', { task: 'feature scope', anchor: 'PN-F01', features: 'PN-F01' }, 'session-A')
  const id = plan.match(/ACT-\d+/)[0]
  await call(tools, 'nav_mark', { id, action: 'begin' }, 'session-A')
  const st = shared.loadActions(root).actions[0].scopeState
  assert.ok(st, 'a feature scope must produce a fingerprint, not null')
  assert.deepEqual(Object.keys(st.files), ['project-nav/host/index.js'])
  writeFileSync(target, 'v2 — another session touched this while the action ran')
  const done = await call(tools, 'nav_mark', { id, action: 'done' }, 'session-A')
  assert.match(done, /Scope drift since begin/, done)
  assert.deepEqual(shared.loadActions(root).actions[0].drift.changed, ['project-nav/host/index.js'])
})

test('fingerprint: a feature-scoped no-op close-out now records noChange (patch-gate evidence)', async () => {
  const { root, tools } = await booted()
  mkdirSync(join(root, 'project-nav', 'host'), { recursive: true })
  writeFileSync(join(root, 'project-nav', 'host', 'index.js'), 'v1')
  const plan = await call(tools, 'nav_plan', { task: 'verify only', anchor: 'PN-F01', features: 'PN-F01' }, 'session-A')
  const id = plan.match(/ACT-\d+/)[0]
  await call(tools, 'nav_mark', { id, action: 'begin' }, 'session-A')
  await call(tools, 'nav_mark', { id, action: 'done' }, 'session-A')
  const a = shared.loadActions(root).actions.find(x => x.id === id)
  assert.equal(a.noChange, true, 'a feature-scoped bookkeeping action must be provable as no-change')
  assert.equal(shared.repeatPressure(shared.loadArch(root), shared.loadActions(root).actions, 'PN-F01').count, 0)
})

test('lapsed lease: the owner can still re-begin, close out late, or abort', async () => {
  const { root, tools } = await booted()
  const old = new Date(Date.now() - 45 * 60 * 1000).toISOString()
  const age = (ledger, id) => {
    const a = ledger.actions.find(x => x.id === id)
    a.startedAt = old
    a.lease = { acquiredAt: old, renewedAt: old, ttlMs: 60 * 1000 }
    shared.saveActions(root, ledger)
  }
  await call(tools, 'nav_plan', { task: 'long task', anchor: 'PN-F01', files: 'project-nav/host/index.js' }, 'session-A')
  await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  age(shared.loadActions(root), 'ACT-001')
  // expired must not be a terminal state: the owner re-acquires it
  const again = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'begin' }, 'session-A')
  assert.match(again, /Re-acquired/, again)
  assert.equal(shared.loadActions(root).actions[0].status, 'in_progress')
  assert.ok(shared.loadActions(root).actions[0].scopeState, 'a re-acquire must retake the fingerprint')
  // and it can be closed out late instead of being stranded
  age(shared.loadActions(root), 'ACT-001')
  const late = await call(tools, 'nav_mark', { id: 'ACT-001', action: 'done' }, 'session-A')
  assert.match(late, /Late close-out/, late)
  const closed = shared.loadActions(root).actions[0]
  assert.equal(closed.status, 'done')
  assert.equal(closed.lateCompletion, true)
  // abort is reachable from expired as well
  await call(tools, 'nav_plan', { task: 'give up', anchor: 'PN-F01', files: 'project-nav/host/index.js' }, 'session-A')
  await call(tools, 'nav_mark', { id: 'ACT-002', action: 'begin' }, 'session-A')
  age(shared.loadActions(root), 'ACT-002')
  const aborted = await call(tools, 'nav_mark', { id: 'ACT-002', action: 'abort' }, 'session-A')
  assert.match(aborted, /aborted/, aborted)
})

test('nav_map does not paint a lapsed action red (one truth with nav_status)', async () => {
  const { root, tools } = await booted()
  const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  writeFileSync(join(root, '.internal', 'nav-actions.json'), JSON.stringify({
    version: '1.1',
    actions: [{ id: 'ACT-900', task: 'crashed session', scope: { features: ['PN-F01'] }, status: 'in_progress', createdAt: old, startedAt: old, lease: { renewedAt: old, ttlMs: 60 * 1000 }, owner: { sessionId: 'dead' } }]
  }))
  const map = await call(tools, 'nav_map', {}, 'session-A')
  assert.doesNotMatch(map, /open action/, 'an expired lease is not a live hold: ' + map)
  assert.match(map, /PN-F01/, 'the map itself must still render')
})

test('retire is not blocked by a lapsed lease (a dead session must not wedge the index)', async () => {
  const { root, tools } = await booted()
  const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  writeFileSync(join(root, '.internal', 'nav-actions.json'), JSON.stringify({
    version: '1.1',
    actions: [{ id: 'ACT-900', task: 'dead session', scope: { features: ['PN-F01'] }, status: 'in_progress', createdAt: old, startedAt: old, lease: { renewedAt: old, ttlMs: 60 * 1000 }, owner: { sessionId: 'dead' } }]
  }))
  const out = await call(tools, 'nav_update', { target: 'PN-F01', retire: true }, 'session-A')
  assert.match(out, /Retired feature PN-F01/, out)
})

test('nav_update re-homes a module between projects (and detaches it with project="")', async () => {
  const { root, tools } = await booted()
  await call(tools, 'nav_update', { target: 'XX-M01', features: 'PN-F01', project: 'DEMO' }, 'session-A')
  assert.deepEqual(shared.loadIndex(root).indexes.projectToModules.DEMO, ['DM-M01', 'XX-M01'])
  const moved = await call(tools, 'nav_update', { target: 'XX-M01', project: 'PN-P01' }, 'session-A')
  assert.match(moved, /re-homed from DEMO to PN-P01/, moved)
  const idx = shared.loadIndex(root)
  assert.deepEqual(idx.indexes.projectToModules.DEMO, ['DM-M01'], 'the old attachment must be gone')
  assert.ok(idx.indexes.projectToModules['PN-P01'].includes('XX-M01'))
  const detached = await call(tools, 'nav_update', { target: 'XX-M01', project: '' }, 'session-A')
  assert.match(detached, /detached from project PN-P01/, detached)
  const after = shared.loadIndex(root)
  assert.ok(!Object.values(after.indexes.projectToModules).some(m => m.includes('XX-M01')), 'a detached module must not remain attached anywhere')
  assert.deepEqual(after.indexes.moduleToFeatures['XX-M01'], ['PN-F01'], 'detaching must not touch the module feature list')
})

test('a scope file that never existed is not reported as "vanished"', async () => {
  const { tools } = await booted()
  const plan = await call(tools, 'nav_plan', { task: 'create a file', anchor: 'PN-F01', files: 'brand/new.mjs' }, 'session-A')
  const id = plan.match(/ACT-\d+/)[0]
  await call(tools, 'nav_mark', { id, action: 'begin' }, 'session-A')
  const done = await call(tools, 'nav_mark', { id, action: 'done' }, 'session-A')
  assert.doesNotMatch(done, /vanished/, 'a file that was never created has not vanished: ' + done)
})

// ---- v0.7.4 (batch 2): declaration↔entity alignment, read-side truth, lock safety ----

test('nav_adr says "first decision" only when it really is the first on that anchor', async () => {
  const { tools } = await booted()
  const first = await call(tools, 'nav_adr', { anchor: 'PN-F01', reason: 'r1', decision: 'd1' }, 'session-A')
  assert.match(first, /First decision on this anchor/, first)
  const second = await call(tools, 'nav_adr', { anchor: 'PN-F01', reason: 'r2', decision: 'd2' }, 'session-A')
  assert.doesNotMatch(second, /First decision/, second)
  assert.match(second, /No patches had accumulated since ADR-001/, second)
})

test('nav_docs resolves a root-relative path against the governed root, not cwd', async () => {
  const { root, tools } = await booted()
  writeFileSync(join(root, 'docs-note.md'), 'x')
  const reg = await call(tools, 'nav_docs', { title: 'note', path: 'docs-note.md', when: 'anything' }, 'session-A')
  assert.match(reg, /Registered DOC-001/, reg)
  assert.equal(shared.loadDocs(root).docs[0].path, join(root, 'docs-note.md'), 'the stored path must be absolute and resolvable')
})

test('nav_status surfaces the architecture layer (decisions, last ADR, gate pressure)', async () => {
  const { tools } = await booted()
  const before = await call(tools, 'nav_status', {}, 'session-A')
  assert.match(before, /Architecture: 0 decision\(s\) \(none recorded yet\)/, before)
  await call(tools, 'nav_adr', { anchor: 'PN-F01', reason: 'r', decision: 'd' }, 'session-A')
  const after = await call(tools, 'nav_status', {}, 'session-A')
  assert.match(after, /Architecture: 1 decision\(s\), last ADR-001 on PN-F01/, after)
  // Pressure becomes visible BEFORE it trips, so the model can act on it.
  for (let i = 1; i <= 2; i++) {
    await call(tools, 'nav_plan', { task: 'p' + i, anchor: 'DM-F01', features: 'DM-F01' }, 'session-A')
    await call(tools, 'nav_mark', { id: 'ACT-00' + i, action: 'begin' }, 'session-A')
    await call(tools, 'nav_mark', { id: 'ACT-00' + i, action: 'done' }, 'session-A')
  }
  const hot = await call(tools, 'nav_status', {}, 'session-A')
  assert.match(hot, /near\/over the repeat-patch gate: DM-F01 2\/3/, hot)
})

test('nav_map target narrows both renderers (text + html)', async () => {
  const { root, tools } = await booted()
  const text = await call(tools, 'nav_map', { target: 'PN-P01' }, 'session-A')
  assert.match(text, /PN-F01/, text)
  assert.doesNotMatch(text, /DM-F01/, 'a narrowed map must not leak other projects: ' + text)
  await call(tools, 'nav_map', { target: 'PN-P01', format: 'html' }, 'session-A')
  const html = readFileSync(join(root, '.internal', 'map-PN-P01.html'), 'utf-8')
  assert.match(html, /PN-F01/)
  assert.doesNotMatch(html, /DM-F01/, 'the html renderer must honour target as well')
})

test('a nested lock acquire fails fast instead of deadlocking the queue', async () => {
  const { root } = await booted()
  await assert.rejects(
    () => shared.withFileLock(root, 'outer-probe', () => shared.withFileLock(root, 'inner-probe', () => 'never reached')),
    /nested lock acquire/,
    'nesting must be a loud error, not a silent hang'
  )
  assert.equal(await shared.withFileLock(root, 'after-probe', () => 'ok'), 'ok', 'the queue must stay usable')
  const lockDir = join(root, '.internal', 'locks')
  const left = existsSync(lockDir) ? readdirSync(lockDir) : []
  assert.deepEqual(left, [], 'no lock file may survive the guard: ' + left.join(','))
})

test('breaking an aged lock leaves no graveyard file behind', async () => {
  const { root } = await booted()
  const lockPath = shared.lockPathFor(root, 'graveyard-probe')
  mkdirSync(join(root, '.internal', 'locks'), { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ token: 'foreign-dead-owner', pid: 999999, at: new Date(Date.now() - 60000).toISOString() }))
  const backdated = (Date.now() - 60000) / 1000
  utimesSync(lockPath, backdated, backdated)
  assert.equal(await shared.withFileLock(root, 'graveyard-probe', () => 'acquired'), 'acquired')
  const left = readdirSync(join(root, '.internal', 'locks'))
  assert.deepEqual(left, [], 'the rename-based break must clean up after itself: ' + left.join(','))
})

process.on('exit', () => { try { rmSync(join(tmpdir(), 'nav-conc-'), { recursive: true, force: true }) } catch {} })
