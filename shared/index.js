// shared/index.js — project-nav core layer (single source of truth)
// Used by host/index.js (tool registrations). No bare-package imports here —
// only node: builtins, so this file resolves from any loading context.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync, rmSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const INDEX_FILENAME = '.internal/nav-index.json';
const VECTOR_FILENAME = '.internal/vector.json';
const ACTIONS_FILENAME = '.internal/nav-actions.json';
const DOCS_FILENAME = '.internal/nav-docs.json';

// ---- cross-process ledger lock ----
// The governed workspace is shared by all DSH sessions (one daemon, many
// sessions), so the ledger read-modify-write below is critical state: two
// sessions planning at once would compute the same ACT-id and the later rename
// would silently drop the earlier action. The lock is an exclusive-create file
// (O_EXCL) — the one primitive that works across processes on Windows — plus an
// in-process queue for same-process callers.

const LOCK_STALE_MS = 15000;
const LOCK_TIMEOUT_MS = 10000;
const LOCK_WAIT_MS = 50;
const LOCKS_DIR = '.internal/locks';
const SESSION_LABEL_LEN = 8;

/** Per-process serialization: all cordis tools run in one process, so queue them first. */
let workspaceQueue = Promise.resolve();
function enqueue(task) {
  const run = workspaceQueue.then(task, task);
  workspaceQueue = run.then(() => undefined, () => undefined);
  return run;
}

// Async sleep: the acquire loop must never block the event loop. The old
// synchronous sleep froze the whole daemon for up to LOCK_TIMEOUT_MS whenever the
// lock was contended — with several sessions that is a self-inflicted outage.
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Lock file for one target, kept under .internal/locks/ so the workspace root stays clean. */
export function lockPathFor(rootPath, name = 'nav-actions.json') {
  return resolve(rootPath, LOCKS_DIR, `${String(name).replace(/[\\/]/g, '_')}.lock`);
}

function readLockFile(p) {
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/**
 * Run one critical section under an exclusive per-target lock. A stale lock (its
 * owner died mid-section) is broken by the lock file's own age, so a crashed
 * session never wedges the workspace.
 *
 * CONTRACT: a locked section must not acquire another lock — the in-process queue
 * is a single chain, so a nested acquire would deadlock. All mutation entry points
 * below obey this by touching exactly one file per section.
 */
/**
 * Nested-acquire guard. The in-process queue is a SINGLE chain, so a locked section that
 * acquires another lock waits for itself: the daemon hangs for ever (not merely until the
 * timeout). Tracked through async context, so a concurrent caller that is merely waiting its
 * turn is NOT misreported as nesting — only a lock taken inside another lock trips it.
 */
const lockContext = new AsyncLocalStorage();

export async function withFileLock(rootPath, name, fn) {
  if (lockContext.getStore()) {
    throw new Error(`[project-nav] nested lock acquire: "${name}" was requested inside another locked section. A locked section must touch exactly one file (the queue is a single chain, so nesting deadlocks instead of failing).`);
  }
  return enqueue(async () => {
    const lockPath = lockPathFor(rootPath, name);
    mkdirSync(dirname(lockPath), { recursive: true });
    const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = JSON.stringify({ token, pid: process.pid, at: new Date().toISOString(), target: name });
    const started = Date.now();
    let held = false;
    while (!held) {
      try {
        const fd = openSync(lockPath, 'wx');
        writeFileSync(fd, payload, 'utf-8');
        closeSync(fd);
        held = true;
      } catch (e) {
        if (e && e.code === 'EEXIST') {
          const holder = readLockFile(lockPath);
          let aged = false;
          try { aged = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch { aged = true; }
          if (aged) {
            // Break by RENAME, then verify identity. A stat-then-unlink races: the aged holder
            // could release and a third process create a fresh lock between those two calls, so
            // the unlink would delete THAT lock and two writers would sit inside the section.
            // Moving the exact file we are about to drop and comparing its token closes the
            // window; if we moved somebody else's fresh lock, it is put back and we back off.
            const graveyard = `${lockPath}.stale-${token}`;
            let moved = null;
            try { renameSync(lockPath, graveyard); moved = readLockFile(graveyard); } catch { /* another waiter won the break */ }
            if (moved && holder && moved.token !== holder.token) {
              try { renameSync(graveyard, lockPath); } catch { /* the fresh holder re-created it */ }
              await sleep(LOCK_WAIT_MS);
              continue;
            }
            try { unlinkSync(graveyard); } catch { /* already gone */ }
            continue;
          }
          if (Date.now() - started > LOCK_TIMEOUT_MS) {
            throw new Error(`[project-nav] lock busy for ${LOCK_TIMEOUT_MS}ms on ${name} (${lockPath}, held by pid ${holder?.pid ?? '?'} since ${holder?.at ?? '?'}). Another session is writing the same file; retry in a moment.`);
          }
          await sleep(LOCK_WAIT_MS);
          continue;
        }
        throw e;
      }
    }
    try {
      return await lockContext.run(true, () => fn());
    } finally { try { rmSync(lockPath, { force: true }); } catch { /* lock file already gone */ } }
  });
}

/** Ledger lock — a named convenience over the generic per-target file lock. */
export async function withLedgerLock(rootPath, fn) {
  return withFileLock(rootPath, 'nav-actions.json', fn);
}

// ---- mutation entry points (every read-modify-write of shared state goes here) ----
// A read-modify-write without a lock silently drops the other writer's update.
// That is exactly how PN-P01's index kept reverting: two sessions edited the same
// index, each wrote back its own snapshot, the later rename won. Every write path
// in host/ now goes through one of these; none of them nests another lock.

async function mutateJsonFile(rootPath, lockName, load, save, mutator) {
  return withFileLock(rootPath, lockName, async () => {
    const data = load(rootPath);
    const result = await mutator(data);
    save(rootPath, data);
    return result;
  });
}

export function mutateIndex(rootPath, mutator) {
  return mutateJsonFile(rootPath, 'nav-index.json', loadIndex, saveIndex, mutator);
}

export function mutateVector(rootPath, mutator) {
  return mutateJsonFile(rootPath, 'vector.json', loadVector, saveVector, mutator);
}

export function mutateDocs(rootPath, mutator) {
  return mutateJsonFile(rootPath, 'nav-docs.json', loadDocs, saveDocs, mutator);
}

export function mutateArch(rootPath, mutator) {
  return mutateJsonFile(rootPath, 'nav-arch.json', loadArch, saveArch, mutator);
}

// ---- path helpers ----

/** Normalize a path for index keys: backslashes → forward slashes. */
export function normalizePath(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Which governed workspace contains `cwd`? Returns the absolute workspace directory,
 * or '' when this plugin does not govern it.
 *
 * This is the ONE fact the harness cannot supply. The harness already knows that a
 * session's cwd is its workspace and that `workspace-write` confines writes to it; what
 * it cannot know is which directories THIS deployment chooses to govern. So the plugin
 * contributes exactly this decision and nothing else — enforcement, the approval path,
 * and projecting the policy into the model's context all stay native (ADR-014).
 *
 * The boundary is OPT-IN PER WORKSPACE (`allow`), because the native mode has exactly one
 * writable root: the session cwd. A session whose real work reaches outside that root —
 * anything maintaining ~/.dsh (memory library, skills, profile deployment) — would be
 * stopped, not protected. So an EMPTY allow-list governs NOTHING, and a caller opts in only
 * the workspaces whose work is self-contained.
 *
 * `allow` entries match a project by its key, its relative path, or its directory name
 * (case-insensitive). The root itself is never governed: a root-wide boundary would let a
 * session write into every project, which is the drift this exists to prevent.
 */
export function governedWorkspaceOf(index, rootPath, cwd, allow = []) {
  const fold = (p) => normalizePath(p || '').trim().replace(/\/+$/, '').toLowerCase();
  const base = (p) => {
    const parts = normalizePath(p || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1].toLowerCase() : '';
  };
  const within = (p, zone) => p === zone || p.startsWith(zone + '/');
  const c = fold(cwd);
  const root = fold(rootPath);
  if (!c || !root || !within(c, root)) return '';
  const permit = (Array.isArray(allow) ? allow : String(allow || '').split(','))
    .map(x => fold(x)).filter(Boolean);
  if (permit.length === 0) return ''; // opt-in: nothing is governed by default
  for (const [key, rel] of Object.entries(index?.projectPaths || {})) {
    const name = String(rel);
    if (!permit.includes(fold(key)) && !permit.includes(fold(name)) && !permit.includes(base(name))) continue;
    const dir = resolve(rootPath, name);
    const zone = fold(dir);
    if (zone && within(c, zone)) return dir;
  }
  return '';
}

// ---- atomic JSON IO ----

/**
 * Atomic JSON write: mkdir -p, write to temp file, rename into place.
 * Prevents truncated JSON on crash (which previously caused silent index loss).
 */
export function atomicWriteJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

function readJson(filePath, fallbackFactory, { failLoud = false, label = 'data' } = {}) {
  if (!existsSync(filePath)) return fallbackFactory();
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    if (failLoud) {
      // Corrupted state must NEVER be silently replaced by an empty object —
      // the next write would wipe the real data (pre-0.2.0 data-loss path).
      throw new Error(`[project-nav] ${label} file is corrupted: ${filePath} (${e.message}). Fix or restore it manually; refusing to continue with empty state.`);
    }
    return fallbackFactory();
  }
}

// ---- nav index ----

export function createEmptyIndex() {
  return {
    generated: new Date().toISOString(),
    version: '1.0',
    indexes: {
      fileToFeature: {},
      featureToFiles: {},
      moduleToFeatures: {},
      projectToModules: {}
    },
    descriptions: {},
    moduleMeta: {},
    metadata: { totalFiles: 0, totalFeatures: 0, totalModules: 0, totalProjects: 0, coverage: 'empty' }
  };
}

export function loadIndex(rootPath) {
  return readJson(resolve(rootPath, INDEX_FILENAME), createEmptyIndex, { failLoud: true, label: 'nav index' });
}

/** LOW-LEVEL unlocked write. Production code must go through mutateIndex() — a bare
 *  read-modify-write here loses the other writer's update (the v0.7.0 bug class). */
export function saveIndex(rootPath, index) {
  index.generated = new Date().toISOString();
  recomputeMetadata(index);
  atomicWriteJson(resolve(rootPath, INDEX_FILENAME), index);
}

/**
 * What kind of node is `target` in this index? The single source of truth shared by
 * the retire pre-check in the host and retireEntry itself — keeping the rule in one
 * place is what stops the two from disagreeing (a fileless feature exists only as a
 * module member, and a forward-only check would call it unknown).
 * Returns 'feature' | 'module' | 'project' | null.
 */
export function indexEntryKind(index, target) {
  const id = normalizePath(String(target == null ? '' : target).trim());
  const ix = index.indexes || {};
  const featureToFiles = ix.featureToFiles || {};
  const moduleToFeatures = ix.moduleToFeatures || {};
  const projectToModules = ix.projectToModules || {};
  const isMember = Object.keys(moduleToFeatures).some(mod => (moduleToFeatures[mod] || []).includes(id));
  if (featureToFiles[id] || (isMember && !moduleToFeatures[id])) return 'feature';
  if (moduleToFeatures[id]) return 'module';
  if (projectToModules[id]) return 'project';
  return null;
}

/**
 * Retire one index entry — the inverse of the upsert path (pure; the caller
 * supplies the lock).
 *
 * The index is the source of truth for what EXISTS, so a deletion has to be
 * expressible: without retirement a removed feature/module/project stays mapped
 * forever and `nav_status` reports permanent false STALE — and that alarm
 * fatigue trains the model to ignore the drift signal this plugin exists for.
 *
 * Cascade rules (no half-retired node is left behind):
 *   feature → drop its file mappings in BOTH directions — a full reverse sweep, so an
 *             entry pointing at this feature without being declared forward is cleaned
 *             too (asymmetric data would otherwise survive as an unreachable orphan);
 *             a file another feature still owns keeps that owner. Also drops its module
 *             memberships and description. A feature that exists only as a module member
 *             (a registered capability with no code yet) is retirable as well.
 *   module  → drop its feature list, its project attachments, its meta/description;
 *             the FEATURES survive (they may legitimately belong elsewhere)
 *   project → detach its modules; the MODULES survive and surface as unattached
 *
 * Returns null when the target is not a known entry. When a module and a project
 * share a name, one call retires one layer — repeat to retire the next.
 */
export function retireEntry(index, target) {
  const id = normalizePath(String(target == null ? '' : target).trim());
  const ix = index.indexes || (index.indexes = {});
  const featureToFiles = ix.featureToFiles || (ix.featureToFiles = {});
  const fileToFeature = ix.fileToFeature || (ix.fileToFeature = {});
  const moduleToFeatures = ix.moduleToFeatures || (ix.moduleToFeatures = {});
  const projectToModules = ix.projectToModules || (ix.projectToModules = {});

  if (indexEntryKind(index, target) === 'feature') {
    const memberOf = Object.keys(moduleToFeatures).filter(mod => (moduleToFeatures[mod] || []).includes(id));
    const declared = featureToFiles[id] ? [...featureToFiles[id]] : [];
    delete featureToFiles[id];
    // Full reverse sweep (not just the forward-declared files): the index can carry a
    // reverse entry that no feature declares forward, and leaving it behind would keep
    // reporting a deleted file forever.
    const touched = new Set(declared);
    for (const file of Object.keys(fileToFeature)) {
      const list = fileToFeature[file] || [];
      if (!list.includes(id)) continue;
      touched.add(file);
      const rest = list.filter(code => code !== id);
      if (rest.length) fileToFeature[file] = rest;
      else delete fileToFeature[file];
    }
    for (const mod of memberOf) moduleToFeatures[mod] = moduleToFeatures[mod].filter(code => code !== id);
    if (index.descriptions) delete index.descriptions[id];
    return { kind: 'feature', files: [...touched], modules: memberOf };
  }

  if (moduleToFeatures[id]) {
    const features = [...moduleToFeatures[id]];
    delete moduleToFeatures[id];
    const projects = [];
    for (const proj of Object.keys(projectToModules)) {
      if ((projectToModules[proj] || []).includes(id)) {
        projectToModules[proj] = projectToModules[proj].filter(mod => mod !== id);
        projects.push(proj);
      }
    }
    if (index.moduleMeta) delete index.moduleMeta[id];
    if (index.descriptions) delete index.descriptions[id];
    return { kind: 'module', features, projects };
  }

  if (projectToModules[id]) {
    const modules = [...projectToModules[id]];
    delete projectToModules[id];
    if (index.projectPaths) delete index.projectPaths[id];
    return { kind: 'project', modules };
  }

  return null;
}

export function getIndexAge(rootPath) {
  const indexPath = resolve(rootPath, INDEX_FILENAME);
  if (!existsSync(indexPath)) return null;
  try {
    return statSync(indexPath).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Recompute all totals from the actual index tables — no more hardcoded coverage. */
export function recomputeMetadata(index) {
  const m = index.metadata || (index.metadata = {});
  m.totalFeatures = Object.keys(index.indexes?.featureToFiles || {}).length;
  m.totalFiles = Object.keys(index.indexes?.fileToFeature || {}).length;
  m.totalModules = Object.keys(index.indexes?.moduleToFeatures || {}).length;
  m.totalProjects = Object.keys(index.indexes?.projectToModules || {}).length;
  m.coverage = m.totalFeatures === 0 ? 'empty' : (m.totalModules > 0 && m.totalProjects > 0 ? 'partial' : 'features-only');
  // Stamp the recomputation time too: it used to keep whatever the previous writer's value was
  // (the live index carried a 2026-09-08 stamp while its tables moved on), which reads as drift.
  m.generated = new Date().toISOString();
  return m;
}

// ---- mainline vector (vector.json is the single source of truth) ----

export function createDefaultVector() {
  return { doing: '', next: '', notDoing: '', exitCondition: '' };
}

export function loadVector(rootPath) {
  return readJson(resolve(rootPath, VECTOR_FILENAME), createDefaultVector, { label: 'vector' });
}

/** LOW-LEVEL unlocked write. Production code must go through mutateVector(). */
export function saveVector(rootPath, vector) {
  vector.updatedAt = new Date().toISOString();
  atomicWriteJson(resolve(rootPath, VECTOR_FILENAME), vector);
}

// ---- action ledger (anti-drift transaction log; multi-session leases) ----

export function createEmptyActions() {
  return { version: '1.1', actions: [] };
}

/** Default lease TTL: long enough for a real task, short enough to self-heal. */
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

/** Compact session identity of the caller (the agent's SessionId). */
export function selfOwner(sessionId, extra = {}) {
  return { sessionId: sessionId ? String(sessionId) : '', label: sessionLabel(sessionId), ...extra };
}

export function sessionLabel(sessionId) {
  const s = String(sessionId || '');
  if (!s) return 'unknown';
  // DSH session ids all start with the literal "session-" (session-5634c6bb-…), so slicing the
  // first 8 characters labelled EVERY session the same ("session-") and the concurrency
  // messages could not tell two holders apart. Slice the distinctive part instead.
  const core = s.startsWith('session-') ? s.slice('session-'.length) : s;
  return core.slice(0, SESSION_LABEL_LEN) || s.slice(0, SESSION_LABEL_LEN);
}

/** Is this action a live, unexpired lock on its scope? */
export function isLeaseExpired(action, now = Date.now()) {
  if (!action || action.status !== 'in_progress') return false;
  const renewed = action.lease?.renewedAt || action.startedAt;
  if (!renewed) return true;
  const t = Date.parse(renewed);
  if (Number.isNaN(t)) return true;
  return (now - t) > (action.lease?.ttlMs || DEFAULT_LEASE_TTL_MS);
}

/**
 * Non-mutating view of the ledger: a lease that lapsed (crashed/closed session)
 * is reported as `expired`, and the acting session's own in-progress leases are
 * renewed. Renewal on read is the heartbeat — the agent never has to ping.
 */
export function reconcileActions(ledger, { sessionId = null, ttlMs = DEFAULT_LEASE_TTL_MS, now = Date.now() } = {}) {
  ledger.version = ledger.version || '1.1';
  ledger.actions = ledger.actions || [];
  const iso = new Date(now).toISOString();
  const sid = sessionId ? String(sessionId) : '';
  const expired = [];
  const renewed = [];
  for (const a of ledger.actions) {
    if (isLeaseExpired(a, now)) {
      a.status = 'expired';
      a.completedAt = iso;
      a.expiredAt = iso;
      expired.push(a);
      continue;
    }
    if (a.status === 'in_progress' && sid && a.owner?.sessionId === sid) {
      a.lease = { ...(a.lease || {}), renewedAt: iso, ttlMs: a.lease?.ttlMs || ttlMs };
      renewed.push(a.id);
    }
  }
  return { ledger, expired, renewed };
}

/**
 * Load the ledger and reconcile it. `writeBack` persists expiries and renewals
 * (renewals are throttled so the lock is not taken on every read).
 */
export async function loadActionsReconciled(rootPath, { sessionId = null, ttlMs = DEFAULT_LEASE_TTL_MS, writeBack = true, renewThrottleMs = 60000 } = {}) {
  return withLedgerLock(rootPath, () => {
    const ledger = loadActions(rootPath);
    const snap = () => JSON.stringify(ledger.actions.map(a => [a.id, a.status, a.lease?.renewedAt || null]));
    const before = snap();
    const { expired, renewed } = reconcileActions(ledger, { sessionId, ttlMs });
    const lastRenew = ledger.lastRenewAt ? Date.parse(ledger.lastRenewAt) : 0;
    const dueRenew = renewed.length > 0 && (Date.now() - (Number.isNaN(lastRenew) ? 0 : lastRenew) > renewThrottleMs);
    if (writeBack && (expired.length > 0 || dueRenew) && snap() !== before) {
      if (dueRenew) ledger.lastRenewAt = new Date().toISOString();
      saveActions(rootPath, ledger);
    }
    return { ledger, expired: expired.map(a => a.id), renewed };
  });
}

/** Mutation entry point: read-reconcile-mutate-save, all inside the ledger lock. */
export async function mutateActions(rootPath, { sessionId = null, ttlMs = DEFAULT_LEASE_TTL_MS } = {}, mutator) {
  return withLedgerLock(rootPath, async () => {
    const ledger = loadActions(rootPath);
    const { expired } = reconcileActions(ledger, { sessionId, ttlMs });
    const result = await mutator(ledger, { expiredIds: expired.map(a => a.id) });
    saveActions(rootPath, ledger);
    return result;
  });
}

export function loadActions(rootPath) {
  return readJson(resolve(rootPath, ACTIONS_FILENAME), createEmptyActions, { failLoud: true, label: 'action ledger' });
}

export function saveActions(rootPath, ledger) {
  atomicWriteJson(resolve(rootPath, ACTIONS_FILENAME), ledger);
}

/** Next action id: ACT-001, ACT-002, ... (max existing + 1). */
export function nextActionId(ledger) {
  let max = 0;
  for (const a of ledger.actions || []) {
    const m = /^ACT-(\d+)$/.exec(a.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `ACT-${String(max + 1).padStart(3, '0')}`;
}

// ---- scope concurrency (the multi-session core) ----
// A workspace is shared by several sessions working at once. Only actions whose
// SCOPES OVERLAP have to serialize; disjoint scopes run in parallel. Three
// layers are compared, and all three are needed — the derived-file layer is the
// one that catches "different features, same file".

/** Basenames of known project directories (0.2.x indexes carry projectPaths). */
export function projectDirNames(index) {
  const out = new Set();
  for (const p of Object.values(index?.projectPaths || {})) {
    const parts = normalizePath(p).split('/').filter(Boolean);
    if (parts.length) out.add(parts[parts.length - 1].toLowerCase());
  }
  return out;
}

/**
 * Canonical comparable form of a scope file path: workspace-relative, forward
 * slashes, lower case, with a leading `<projectDir>/` collapsed — so
 * "project-nav/host/index.js" and "host/index.js" compare EQUAL.
 */
export function canonPath(p, dirNames = null) {
  let s = normalizePath(p).trim().replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
  if (!s) return '';
  const parts = s.split('/').filter(Boolean);
  if (parts.length > 1 && dirNames && dirNames.has(parts[0])) s = parts.slice(1).join('/');
  return s;
}

/** Modules the index associates with any of these features/modules. */
export function scopeOwnModules(index, scope = {}) {
  const m2f = index?.indexes?.moduleToFeatures || {};
  const f2f = index?.indexes?.fileToFeature || {};
  const out = new Set(scope.modules || []);
  // features name modules directly…
  const feats = new Set(scope.features || []);
  // …and FILES name features (which name modules): an action scoped by file
  // still occupies the module that file belongs to.
  const dirs = projectDirNames(index);
  for (const file of (scope.files || [])) {
    const c = canonPath(file, dirs);
    for (const [k, codes] of Object.entries(f2f)) {
      if (canonPath(k, dirs) === c) for (const code of codes) feats.add(code);
    }
  }
  for (const [mod, feats2] of Object.entries(m2f)) {
    if ((feats2 || []).some(c => feats.has(c))) out.add(mod);
  }
  return out;
}

/** Every file the index associates with any of these features/modules. */
export function scopeOwnFiles(index, scope = {}) {
  const f2files = index?.indexes?.featureToFiles || {};
  const m2f = index?.indexes?.moduleToFeatures || {};
  const codes = new Set(scope.features || []);
  for (const m of (scope.modules || [])) for (const c of (m2f[m] || [])) codes.add(c);
  const out = new Set();
  for (const c of codes) for (const f of (f2files[c] || [])) out.add(f);
  return out;
}

/**
 * Do these two scopes overlap? Returns { kind, what } or null when they are
 * disjoint. `derived-file` = the two features/modules resolve to a shared
 * indexed file, a REAL conflict even though the declared scopes differ.
 */
export function scopeConflict(aScope = {}, bScope = {}, { index = null } = {}) {
  const norm = v => String(v).toLowerCase();
  const hit = (xs, ys) => {
    const set = new Set((ys || []).map(norm));
    return (xs || []).find(x => set.has(norm(x))) || null;
  };
  const dirs = index ? projectDirNames(index) : null;
  const sub = (xs, ys) => {
    for (const x0 of (xs || [])) {
      const x = canonPath(x0, dirs);
      if (!x) continue;
      for (const y0 of (ys || [])) {
        const y = canonPath(y0, dirs);
        if (!y) continue;
        if (x === y) return `${x0} = ${y0}`;
        if (x.startsWith(y + '/') || y.startsWith(x + '/')) return `${x0} overlaps ${y0}`;
      }
    }
    return null;
  };
  const feat = hit(aScope.features, bScope.features);
  if (feat) return { kind: 'feature', what: feat };
  const mod = hit(aScope.modules, bScope.modules);
  if (mod) return { kind: 'module', what: mod };
  // Feature codes carry no path, so two DIFFERENT features can still be two
  // changes in the same module. Without this layer, "different features ⇒ no
  // conflict" is simply wrong on a module-granular index.
  if (index) {
    const aMods = [...scopeOwnModules(index, aScope)];
    const bMods = [...scopeOwnModules(index, bScope)];
    const viaMod = hit(aMods, bMods);
    if (viaMod) return { kind: 'module', what: `${viaMod} (via feature)` };
  }
  const file = sub(aScope.files, bScope.files);
  if (file) return { kind: 'file', what: file };
  if (index) {
    const aFiles = [...scopeOwnFiles(index, aScope)];
    const bFiles = [...scopeOwnFiles(index, bScope)];
    const derived = sub(aFiles, bFiles);
    if (derived) return { kind: 'derived-file', what: derived };
  }
  return null;
}

/**
 * Conflict check against the LIVE locks only (in_progress). Planned actions are
 * intentions, not holds — treating them as blockers would serialize sessions
 * that never actually start.
 */
export function checkScopeConflicts(ledger, action, { index = null, now = Date.now(), includePlanned = false } = {}) {
  const stat = includePlanned ? ['planned', 'in_progress'] : ['in_progress'];
  const conflicts = [];
  for (const other of ledger.actions || []) {
    if (other.id === action.id) continue;
    if (!stat.includes(other.status)) continue;
    if (isLeaseExpired(other, now)) continue;
    const c = scopeConflict(action.scope || {}, other.scope || {}, { index });
    if (c) conflicts.push({ action: other, kind: c.kind, what: c.what, own: !!action.owner?.sessionId && other.owner?.sessionId === action.owner.sessionId });
  }
  return conflicts;
}

/** The live action already held by this session (one in_progress per session). */
export function sessionBusyWith(ledger, sessionId, { now = Date.now() } = {}) {
  const sid = String(sessionId || '');
  return (ledger.actions || []).find(a => a.status === 'in_progress' && a.owner?.sessionId === sid && !isLeaseExpired(a, now)) || null;
}

/**
 * Queue position: how many actions must finish before this one could start.
 * Counted over conflicting actions that hold a lease (in_progress) plus planned
 * blockers queued ahead of it.
 */
export function queuePosition(ledger, action, { index = null, now = Date.now() } = {}) {
  const conflicts = checkScopeConflicts(ledger, action, { index, now, includePlanned: true });
  const ahead = conflicts.map(c => c.action).filter(o => o.status === 'in_progress' || (o.createdAt || '') < (action.createdAt || ''));
  return { ahead: ahead.length, ids: ahead.map(a => a.id) };
}

/** One-line view of a live action holder. */
export function actorLabel(action) {
  const sid = action?.owner?.sessionId;
  const who = sid ? `session ${action.owner.label || sessionLabel(sid)}` : 'legacy session (pre-0.3.0 ledger entry)';
  return `${action.id} [${action.status}] "${action.task}" by ${who}${action.owner?.cwd ? ` @ ${action.owner.cwd}` : ''}`;
}

/** Multi-line view of a conflict set, for gate messages. */
export function describeConflicts(conflicts) {
  return conflicts.map(c => {
    const bits = [
      c.action.scope?.features?.length ? `features=${c.action.scope.features.join(',')}` : '',
      c.action.scope?.modules?.length ? `modules=${c.action.scope.modules.join(',')}` : '',
      c.action.scope?.files?.length ? `files=${c.action.scope.files.join(',')}` : ''
    ].filter(Boolean).join(' ');
    return `  - ${actorLabel(c.action)} — overlap ${c.kind}: ${c.what}${bits ? `\n    scope: ${bits}` : ''}`;
  });
}

// ---- scope fingerprints (anti-drift: did somebody else touch my files?) ----
// A lease stops two sessions from STARTING on the same scope. A fingerprint catches
// what a lease cannot: files that changed or vanished WHILE the action was running
// (another session, an editor, a cleanup, a force-push). Taken at begin, re-read at
// done — reported, never silently swallowed, and never a hard block on finished work.

/** Expand a sub-scope to concrete files: indexed features/modules + literal paths. */
export function scopeFiles(index, scope = {}, rootPath = '.') {
  const out = new Set();
  const f2files = index?.indexes?.featureToFiles || {};
  const m2f = index?.indexes?.moduleToFeatures || {};
  const codes = new Set(scope.features || []);
  for (const m of (scope.modules || [])) for (const c of (m2f[m] || [])) codes.add(c);
  for (const c of codes) for (const f of (f2files[c] || [])) out.add(normalizePath(f));
  const dirs = projectDirNames(index);
  for (const raw of (scope.files || [])) {
    const f = normalizePath(raw);
    if (f.includes('*') || f.includes('?')) {
      const star = f.search(/[*?]/);
      const slash = f.lastIndexOf('/', star);
      const base = slash >= 0 ? f.slice(0, slash) : '';
      const rest = f.slice(slash + 1);
      const rx = globToRegExp(rest);
      let entries = [];
      try { entries = readdirSync(resolve(rootPath, base), { recursive: true }); } catch { entries = []; }
      for (const e of entries) {
        const rel = normalizePath(typeof e === 'string' ? e : e.name);
        if (rx.test(rel.split('/').pop())) out.add(normalizePath(base ? base + '/' + rel : rel));
      }
    } else out.add(f);
  }
  const filtered = [...out].filter(Boolean);
  if (!index) return filtered;
  // Drop the project/module NAMES that nav_plan also accepts as scope entries — they are not
  // files. The match must be EXACT (project name / project directory basename / module name):
  // the previous shape compared the first path SEGMENT against the project directories, which
  // also deleted genuine index keys. An index may spell a file workspace-relative
  // ("project-nav/host/index.js"), and those legitimately start with the project directory, so
  // the fingerprint silently came out empty. v0.7.4 measured 12 of 18 features (every feature
  // of project-nav and shoucang) with zero fingerprintable paths: drift went unreported and the
  // patch counter lost its noChange evidence. The v0.4.0 contract says the scope is
  // 「索引推出文件 ∪ 字面量路径 ∪ glob 展开」 — this restores the first leg.
  const bare = new Set([
    ...Object.keys(index.indexes?.projectToModules || {}),
    ...Object.keys(index.indexes?.moduleToFeatures || {}),
    ...dirs
  ].map(n => String(n).toLowerCase()));
  return filtered.filter(f => !bare.has(f.toLowerCase()));
}

/** Minimal glob to RegExp for scope patterns (only * ? ** are meaningful here). */
function globToRegExp(glob) {
  const SPECIAL = '.*+?^()[]|' + String.fromCharCode(36) + '{}' + String.fromCharCode(92);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '.';
    else if (SPECIAL.includes(c)) re += String.fromCharCode(92) + c;
    else re += c;
  }
  return new RegExp('^' + re + '~END~'.replace('~END~', String.fromCharCode(36)));
}

/** Disk location of a scope file: absolute, workspace-relative, or project-relative. */
export function resolveScopeFile(rootPath, file, index = null) {
  for (const cand of [file, resolve(rootPath, file)]) {
    try { if (existsSync(cand)) return cand; } catch { /* unreadable — try next */ }
  }
  for (const rel of Object.values(index?.projectPaths || {})) {
    const cand = resolve(rootPath, rel, file);
    try { if (existsSync(cand)) return cand; } catch { /* try next */ }
  }
  return null;
}

/**
 * Which indexed feature(s) own this file? The single source of truth for "is this scope
 * file registered?" — index-aware in the same way resolveScopeFile is, so a scope written
 * from inside a project directory (`host/index.js`) is not mistaken for an unregistered
 * file merely because the index spells it `project-nav/host/index.js`.
 *
 * Comparison folds case and separators (canonPath). A suffix match is accepted only when
 * exactly one index entry can fit — never guess between two candidates.
 * Returns feature codes, or null when the index does not know the file.
 */
export function indexedOwnersOf(rootPath, file, index = null) {
  const f2f = index?.indexes?.fileToFeature || {};
  const keys = Object.keys(f2f);
  if (keys.length === 0) return null;
  const want = canonPath(file);
  if (!want) return null;
  const byCanon = new Map(keys.map(k => [canonPath(k), k]));
  const direct = byCanon.get(want);
  if (direct) return [...f2f[direct]];
  const abs = resolveScopeFile(rootPath, file, index);
  if (abs) {
    const rel = canonPath(relative(rootPath, abs));
    const hit = byCanon.get(rel);
    if (hit) return [...f2f[hit]];
    const near = keys.filter(k => { const c = canonPath(k); return c.endsWith('/' + rel) || rel.endsWith('/' + c); });
    if (near.length === 1) return [...f2f[near[0]]];
  }
  return null;
}

function fileStamp(abs) {
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    const stamp = { size: st.size, mtime: Math.round(st.mtimeMs) };
    if (st.size <= 262144) stamp.sha1 = createHash('sha1').update(readFileSync(abs)).digest('hex').slice(0, 12);
    return stamp;
  } catch {
    return null;
  }
}

/** Snapshot the files a scope owns: { file: {size, mtime, sha1} | 'missing' } */
export function snapshotScopeFiles(rootPath, index, scope) {
  const snap = {};
  // The declared literal paths ARE part of the scope even when the index does not
  // know them yet (new files, private paths); features/modules come from the index.
  const targets = new Set(scopeFiles(index, scope, rootPath));
  for (const f of (scope?.files || [])) if (!f.includes('*') && !f.includes('?')) targets.add(normalizePath(f));
  for (const f of targets) {
    const abs = resolveScopeFile(rootPath, f, index);
    snap[f] = abs ? (fileStamp(abs) || 'unreadable') : 'missing';
  }
  return snap;
}

/** Diff a snapshot against disk now: changed (content/time) / removed / added. */
export function verifyScopeFingerprint(rootPath, index, scopeState, scope = null) {
  const before = scopeState?.files || {};
  const effective = scopeState?.scope || scope || {};
  // An empty scope means "nothing to compare", NOT "everything vanished".
  const hasScope = (effective.files || []).length > 0 || (effective.features || []).length > 0 || (effective.modules || []).length > 0;
  const now = hasScope ? snapshotScopeFiles(rootPath, index, effective) : { ...before };
  const changed = []; const removed = []; const added = [];
  for (const [f, b] of Object.entries(before)) {
    const a = now[f];
    if (a === undefined || a === 'missing') {
      // "vanished" needs evidence that the file existed at begin. A literal scope entry that was
      // ALREADY missing then (a file the task was going to create) must not be reported as gone
      // just because the task chose not to create it — the same spirit as the empty-scope rule
      // ("nothing to compare" ≠ "everything vanished"). A drift alarm only stays useful while it
      // is trustworthy.
      if (typeof b === 'object' && b !== null) removed.push(f);
      continue;
    }
    if (b === 'missing' || b === 'unreadable' || typeof b !== 'object') continue;
    if (typeof a !== 'object') { changed.push(f); continue; }
    if (b.size !== a.size || b.mtime !== a.mtime || b.sha1 !== a.sha1) changed.push(f);
  }
  for (const f of Object.keys(now)) if (!(f in before)) added.push(f);
  return { changed, removed, added, ok: changed.length === 0 && removed.length === 0 };
}

// ---- architecture-first protocol (核心治理理念的可执行形态) ----
// 理念（lk 2026-09-10 定调）：所有开发动作从架构出发；架构不出错，过程中的小问题影响
// 就是局部的。任何任务在动作之前先做架构思考（是否需要调整架构），而不是拿到指令直接
// 动手——否则会在同一个死胡同反复打补丁、拆东墙补西墙，永远解决不了根本需求。
//
// 三个闸门把这句话变成工具拦得住的规则：
//   ① 锚点闸  每个动作必须锚定架构节点（功能/模块/文件/架构文档），无锚点 = 架构思考缺失
//   ② 计数闸  同一锚点累计 N 次补丁仍无架构决策 → 强制回架构层（不靠灵感自查）
//   ③ 决策闸  架构层改动留 ADR（锚点 + 触发原因 + 决策 + 影响面），可回溯可复盘

const ARCH_FILENAME = '.internal/nav-arch.json';

/** 同一锚点累计补丁达到该阈值 → 升格要求架构决策（第一性原理的触发线）。 */
export const REPEAT_PATCH_THRESHOLD = 3;

export function createEmptyArch() {
  return { version: '1.0', decisions: [] };
}

export function loadArch(rootPath) {
  return readJson(resolve(rootPath, ARCH_FILENAME), createEmptyArch, { failLoud: true, label: 'architecture ledger' });
}

/** LOW-LEVEL unlocked write. Production code must go through mutateArch(). */
export function saveArch(rootPath, arch) {
  atomicWriteJson(resolve(rootPath, ARCH_FILENAME), arch);
}

/** Next architecture decision id: ADR-001, ADR-002, ... */
export function nextDecisionId(arch) {
  let max = 0;
  for (const d of arch.decisions || []) {
    const m = /^ADR-(\d+)$/.exec(d.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `ADR-${String(max + 1).padStart(3, '0')}`;
}

/** 锚点是否指向真实架构节点：功能码 / 模块名 / 索引内文件 / 磁盘实存文件 / 架构文档。 */
export function checkAnchor(index, rootPath, anchor) {
  if (!anchor || !String(anchor).trim()) return { ok: false, kind: null, hint: '锚点为空' };
  const a = normalizePath(String(anchor).trim());
  const f2f = index?.indexes?.fileToFeature || {};
  const f2files = index?.indexes?.featureToFiles || {};
  const m2f = index?.indexes?.moduleToFeatures || {};
  if (/^[A-Z]{2,}-[A-Z]?\d+$/i.test(a) && (f2files[a] || index?.descriptions?.[a])) return { ok: true, kind: 'feature' };
  if (m2f[a]) return { ok: true, kind: 'module' };
  if (f2f[a]) return { ok: true, kind: 'file' };
  try {
    if (existsSync(resolve(rootPath, a))) return { ok: true, kind: /\.internal\/arch\/.*\.md$/.test(a) ? 'arch-doc' : 'file' };
  } catch { /* unreadable → 继续判定 */ }
  return { ok: false, kind: null, hint: '既不在索引内，也不在磁盘上' };
}

/** 锚点最近一次架构决策（同一 anchor 取最新 createdAt）。 */
export function lastDecisionFor(arch, anchor) {
  const a = normalizePath(String(anchor || ''));
  const hits = (arch?.decisions || []).filter(d => normalizePath(String(d.anchor || '')) === a);
  if (!hits.length) return null;
  return hits.slice().sort((x, y) => String(x.createdAt || '').localeCompare(String(y.createdAt || '')))[hits.length - 1];
}

/**
 * 计数闸：同一锚点自「最近一次架构决策」以来累计的**补丁**数。
 * 补丁不单独建账本——**已完结、带锚点、且真的动过东西的动作**就是补丁（done 动作的投影），
 * 直接从动作账本推导，少一份要维护会漂移的数据。
 *
 * 「动过东西」只认**正面证据**：done 时指纹证明 scope 内 changed/removed/added 三者全空
 * （动作上记 `noChange`），则该动作是验证/记账而非补丁，不计入。没有证据（如空 scope 无
 * scopeState）一律照旧计入——宁可保守多计，也不弱化闸门。
 * 为什么较真：计数闸的用途是发现「同一死胡同反复打补丁」；把没动过东西的动作算进去，
 * 会逼出没有架构内容的 ADR，ADR 通胀后核心决策账本就成了噪音。
 */
export function repeatPressure(arch, actions, anchor, { threshold = REPEAT_PATCH_THRESHOLD } = {}) {
  const a = normalizePath(String(anchor || ''));
  const since = lastDecisionFor(arch, anchor);
  const sinceAt = since?.createdAt || null;
  const done = (actions || []).filter(x => x.status === 'done'
    && normalizePath(String(x.anchor || '')) === a
    && (!sinceAt || String(x.completedAt || '') > String(sinceAt)));
  const list = done.filter(x => x.noChange !== true);
  const skipped = done.filter(x => x.noChange === true).map(x => x.id);
  return { anchor: a, count: list.length, threshold, exceeded: list.length >= threshold, sinceDecision: since ? since.id : null, patches: list.map(p => p.id), skipped };
}
// ---- architecture docs layer (.internal/arch/*.md + 头部 arch-cache 指纹块) ----
// 架构文档 = 项目的核心维护文档（lk 2026-09-08 拍板）：「开发前读它拿数据怎么流、逻辑怎么判、
// 循环在等什么；代码变更后按指纹过期重生成」。本层只做三件可机检的事——**找档、判新鲜、判覆盖**，
// 好让 nav_query / nav_plan / nav_mark / nav_status 的读取面自带「本目标的架构档在哪、还新鲜吗」。
// 边界（ADR-011）：渲染（SVG/HTML 投影）不进插件——投影零维护，归 arch-view skill 侧脚本；
// 工具不复制架构内容，档本身（含指纹块）仍是唯一事实源，此处只读它、从不代写正文。

const ARCH_DOCS_DIR = '.internal/arch';

/**
 * 解析一份架构档头部的 arch-cache 指纹块。契约（arch-view 存档指纹格式）：
 *   <!-- arch-cache
 *   generated: <ISO>
 *   project: <名>
 *   scope: <overview | 模块名 | 特征码>
 *   files:
 *     - path: <相对 root 的路径>
 *       mtime: <ISO>
 *       size: <字节>
 *   -->
 * 没有指纹块 → null（不是错误，是「未纳管」：下次重生成时补上即可）。
 */
export function parseArchCache(text) {
  const m = /<!--\s*arch-cache\s*\n([\s\S]*?)-->/m.exec(String(text || ''));
  if (!m) return null;
  const head = { generated: '', project: '', scope: '' };
  const files = [];
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const item = /^\s*-\s*path:\s*(.+?)\s*$/.exec(line);
    if (item) { files.push({ path: normalizePath(item[1]), mtime: '', size: null }); continue; }
    const kv = /^\s*([A-Za-z_]+):\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    if (files.length && (k === 'mtime' || k === 'size')) {
      const cur = files[files.length - 1];
      if (k === 'mtime') cur.mtime = v; else cur.size = Number(v);
      continue;
    }
    if (k === 'generated') head.generated = v;
    else if (k === 'project') head.project = v;
    else if (k === 'scope') head.scope = v;
  }
  return { ...head, files, raw: m[0] };
}

/**
 * 一档的新鲜度：指纹块声明的每个文件是否仍与记录一致——mtime 或 size **任一**不同即过期
 * （arch-view 铁律：宁可重生成一次，也不让 agent 读到与代码不符的架构描述）。
 * 无指纹块 / 档案缺失返回 ok:false 并带上原因，由调用方决定是告警还是软提示。
 */
export function archDocStatus(rootPath, relPath, { text = null } = {}) {
  const rel = normalizePath(relPath);
  let content = text;
  if (content === null || content === undefined) {
    try { content = readFileSync(resolve(rootPath, rel), 'utf-8'); }
    catch { return { path: rel, ok: false, missing: true, reason: '档案不存在', project: '', scope: '', generated: '', files: [], drifted: [] }; }
  }
  const cache = parseArchCache(content);
  if (!cache) return { path: rel, ok: false, noHeader: true, reason: '无 arch-cache 指纹头', project: '', scope: '', generated: '', files: [], drifted: [] };
  const drifted = [];
  const drift = [];
  let localForm = false;
  let truncated = false;
  for (const f of cache.files) {
    let st = null;
    try { st = statSync(resolve(rootPath, f.path)); } catch { st = null; }
    if (!st || !st.isFile()) { drifted.push(`${f.path}（磁盘上不存在）`); drift.push({ path: f.path, kind: 'missing' }); continue; }
    const nowIso = new Date(st.mtimeMs).toISOString();
    if (f.size !== null && Number.isFinite(f.size) && st.size !== f.size) {
      drifted.push(`${f.path}（size ${f.size}→${st.size}）`);
      drift.push({ path: f.path, kind: 'size', from: f.size, to: st.size });
      continue;
    }
    if (f.mtime && f.mtime !== nowIso) {
      // 历史档里同一个瞬时有多套写法：UTC 带毫秒（`toISOString`，project-nav 各档）与「本地墙上
      // 时间当 UTC 写、且截到秒」（shoucang 各档，2026-09-10 那次校准把它定为约定）。指纹记的是
      // **瞬时**而不是字符串，所以「同一瞬时 + 任意渲染 + 秒级截断」都算命中——否则一半的档会永久
      // 假过期，而假警报正是「模型学会忽略漂移信号」的起点。真正的改动仍会被 size、文件缺失，或
      // 超过 1 秒的瞬时差捕获（同一秒内且同字节数的改写才可能漏，代价可接受）。
      const recMs = Date.parse(f.mtime);
      const localMs = st.mtimeMs - new Date(st.mtimeMs).getTimezoneOffset() * 60000;
      const NEAR_MS = 1000;
      if (Number.isFinite(recMs) && Math.abs(recMs - st.mtimeMs) < NEAR_MS) {
        if (recMs !== st.mtimeMs) truncated = true;
        continue;
      }
      if (Number.isFinite(recMs) && Math.abs(recMs - localMs) < NEAR_MS) {
        localForm = true;
        if (recMs !== localMs) truncated = true;
        continue;
      }
      // 既不是 UTC 也不是本机本地渲染（例如在别的时区按整点写的档）：报「写法不符」，只需 stamp
      // 校正；不能与「代码真漂移」混为一谈——后者要求重生成内容，前者只要重写指纹。
      const shiftMs = recMs - Date.parse(nowIso);
      const hours = shiftMs / 3600000;
      const tz = Number.isFinite(shiftMs) && shiftMs !== 0 && shiftMs % 3600000 === 0 && Math.abs(hours) <= 24;
      drift.push({ path: f.path, kind: tz ? 'tz' : 'mtime', from: f.mtime, to: nowIso, shiftHours: tz ? hours : 0 });
      drifted.push(tz
        ? `${f.path}（mtime 记 ${f.mtime} / 实际 ${nowIso}，差 ${hours}h —— 既非 UTC 也非本机本地时间）`
        : `${f.path}（mtime ${f.mtime}→${nowIso}）`);
    }
  }
  // tzOnly：全部漂移都只是写法不符（无 size 变化、无文件缺失）→ 内容大概率仍与代码一致。
  const tzOnly = drift.length > 0 && drift.every(d => d.kind === 'tz');
  return { path: rel, ok: drifted.length === 0, project: cache.project, scope: cache.scope, generated: cache.generated, files: cache.files.map(f => f.path), drifted, drift, tzOnly, localForm, truncated };
}

/** `.internal/arch` 下全部架构档（递归）。`render/` 是投影产物目录，不算档。 */
export function listArchDocs(rootPath) {
  const base = resolve(rootPath, ARCH_DOCS_DIR);
  let entries = [];
  try { entries = readdirSync(base, { recursive: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const rel = normalizePath(typeof e === 'string' ? e : e.name);
    if (!/\.md$/i.test(rel)) continue;
    if (rel.startsWith('render/') || rel.includes('/render/')) continue;
    out.push(archDocStatus(rootPath, `${ARCH_DOCS_DIR}/${rel}`));
  }
  return out.sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

/**
 * 覆盖判定：target（功能码 / 模块 / 文件 / 档路径）→ 覆盖它的架构档。
 * 三条命中规则，全部可机检、不做模糊猜测：① target 就是档路径；② 档的 scope 字段等于 target；
 * ③ 档声明的文件与 target 展开出的文件有交集。另加一条受限回退：scope=overview 的档，其
 * project 字段里出现 target 所属项目名/代码即算覆盖（只对 overview 生效，避免跨项目误配）。
 */
export function archDocsFor(index, rootPath, target) {
  const t = normalizePath(String(target || '').trim());
  if (!t) return [];
  const docs = listArchDocs(rootPath);
  if (!docs.length) return [];
  const q = queryIndex(index, t) || { features: [], modules: [], files: [], projects: [] };
  const m2f = index?.indexes?.moduleToFeatures || {};
  const f2files = index?.indexes?.featureToFiles || {};
  const p2m = index?.indexes?.projectToModules || {};
  const targets = new Set();
  // queryIndex 只分「功能码 vs 其它（一律当文件）」，所以模块名/功能名要在这里自己展开成文件与项目：
  // 少了这一步，一个模块级 target 会既拿不到成员文件、也拿不到所属项目（覆盖判定静默变空）。
  const features = new Set([...(q.features || []), ...(q.files || []).filter(f => f2files[f])]);
  const modules = new Set([...(q.modules || []), ...(m2f[t] ? [t] : [])]);
  for (const f of (q.files || [])) targets.add(normalizePath(f));
  const projectHints = new Set((q.projects || []).map(p => String(p).toLowerCase()));
  for (const mod of modules) {
    for (const code of (m2f[mod] || [])) features.add(code);
    for (const [proj, mods] of Object.entries(p2m)) if ((mods || []).includes(mod)) projectHints.add(String(proj).toLowerCase());
  }
  for (const code of features) {
    for (const f of (f2files[code] || [])) targets.add(normalizePath(f));
    for (const [proj, mods] of Object.entries(p2m)) {
      const owner = (mods || []).find(m => (m2f[m] || []).includes(code));
      if (owner) projectHints.add(String(proj).toLowerCase());
    }
  }
  const tCanon = canonPath(t).toLowerCase();
  return docs.filter(d => {
    if (d.path === t) return true;
    if (String(d.scope || '').trim() && canonPath(String(d.scope).trim()).toLowerCase() === tCanon) return true;
    if ((d.files || []).some(f => targets.has(normalizePath(f)) || canonPath(f).toLowerCase() === tCanon)) return true;
    if (String(d.scope || '').trim().toLowerCase() === 'overview') {
      const proj = String(d.project || '').toLowerCase();
      for (const h of projectHints) if (h.length >= 3 && proj.includes(h)) return true;
    }
    return false;
  });
}

/** scope（features/modules/files 混写）→ 覆盖它的架构档并集（按档路径去重）。 */
export function archDocsForScope(index, rootPath, scope = {}) {
  const out = new Map();
  for (const t of [...(scope.features || []), ...(scope.modules || []), ...(scope.files || [])]) {
    for (const d of archDocsFor(index, rootPath, t)) if (!out.has(d.path)) out.set(d.path, d);
  }
  return [...out.values()];
}

/** 一行（或两行）架构档指针：新鲜 / ⛔过期 / ⚠指纹写法不符 / 无档软提示（不阻塞）。 */
export function renderArchPointer(states, { label = '架构档' } = {}) {
  const list = states || [];
  if (!list.length) {
    return `${label}: 该目标暂无架构档（软提示，不阻塞）——建议本次方案确认时顺带出 L1 总览，或按 arch-view 契约补 L2。`;
  }
  const parts = list.map(s => {
    if (s.missing) return `${s.path}（档案不存在）`;
    if (s.noHeader) return `${s.path}（无指纹头 → nav_arch mode="stamp" path="${s.path}" 补）`;
    if (s.ok) return `${s.path}（新鲜）`;
    const flag = s.tzOnly ? '⚠指纹写法不符' : '⛔过期';
    return `${s.path}（${flag}：${s.drifted.slice(0, 2).join('、')}${s.drifted.length > 2 ? ` 等 ${s.drifted.length} 项` : ''}）`;
  });
  const tzDocs = list.filter(s => !s.ok && !s.missing && !s.noHeader && s.tzOnly);
  const stale = list.filter(s => !s.ok && !s.missing && !s.noHeader && !s.tzOnly);
  const tail = [];
  if (tzDocs.length) {
    tail.push(`  ⚠ ${tzDocs.map(d => d.path).join('、')} 只是指纹写法不符（文件未变）→ nav_arch mode="stamp" path="${tzDocs[0].path}" 一次校正，无需重生成内容。`);
  }
  if (stale.length) {
    tail.push(`  过期档 = 设计已漂移，不可当现行事实读：重生成内容后跑 nav_arch mode="stamp" path="${stale[0].path}" 刷新指纹。`);
  }
  return `${label}: ${parts.join(' / ')}${tail.length ? '\n' + tail.join('\n') : ''}`;
}

/**
 * 刷新一档的 arch-cache 指纹头：按档内**已声明**的 files 列表重取 mtime/size。内容由 agent 读码
 * 重生成，指纹由工具写——手抄 mtime 正是漂移的来源（工具化替代手工比对是本次接入的实质）。
 * 声明文件在磁盘上缺失 = 拒绝写（宁可显性失败，也不写一份指向空气的指纹）。
 * 调用方须包在 withFileLock 内（单一写入路径，与 index/docs/arch 账本同规矩）。
 */
export function stampArchDoc(rootPath, relPath) {
  const rel = normalizePath(relPath);
  const abs = resolve(rootPath, rel);
  let content;
  try { content = readFileSync(abs, 'utf-8'); } catch { return { ok: false, reason: `找不到架构档：${abs}` }; }
  const cache = parseArchCache(content);
  if (!cache) return { ok: false, reason: '该档没有 arch-cache 指纹头——先按契约在文档头部写入（含 files: 列表），再 stamp。' };
  if (!cache.files.length) return { ok: false, reason: 'arch-cache 指纹头的 files: 列表为空——先声明本档覆盖哪些文件。' };
  const rows = [];
  const missing = [];
  for (const f of cache.files) {
    let st = null;
    try { st = statSync(resolve(rootPath, f.path)); } catch { st = null; }
    if (!st || !st.isFile()) { missing.push(f.path); continue; }
    rows.push({ path: f.path, mtime: new Date(st.mtimeMs).toISOString(), size: st.size });
  }
  if (missing.length) return { ok: false, reason: `以下声明文件在磁盘上不存在，拒绝刷新指纹（宁可显性失败）：${missing.join(', ')}` };
  const generated = new Date().toISOString();
  const block = [
    '<!-- arch-cache',
    `generated: ${generated}`,
    `project: ${cache.project}`,
    `scope: ${cache.scope}`,
    'files:',
    ...rows.map(r => `  - path: ${r.path}\n    mtime: ${r.mtime}\n    size: ${r.size}`),
    '-->'
  ].join('\n');
  // 函数式替换：指纹块里可能出现 $ 序列，字符串式 replace 会把它当替换模式解释。
  const next = content.replace(cache.raw, () => block);
  const tmp = abs + '.tmp';
  writeFileSync(tmp, next, 'utf-8');
  renameSync(tmp, abs);
  return { ok: true, path: rel, generated, files: rows.length, rows };
}

// ---- reference docs registry (project reference foundation) ----

export function createEmptyDocs() {
  return { version: '1.0', docs: [] };
}

export function loadDocs(rootPath) {
  return readJson(resolve(rootPath, DOCS_FILENAME), createEmptyDocs, { failLoud: true, label: 'reference docs registry' });
}

/** LOW-LEVEL unlocked write. Production code must go through mutateDocs(). */
export function saveDocs(rootPath, registry) {
  atomicWriteJson(resolve(rootPath, DOCS_FILENAME), registry);
}

/** Next doc id: DOC-001, DOC-002, ... */
export function nextDocId(registry) {
  let max = 0;
  for (const d of registry.docs || []) {
    const m = /^DOC-(\d+)$/.exec(d.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `DOC-${String(max + 1).padStart(3, '0')}`;
}

/**
 * Suggest reference docs for a planned action (used at 方案确认 time).
 * Matching heuristic: project match +2; each `when` keyword, tag, or module
 * name appearing in the task text +1. Returns docs sorted by score (desc).
 */
export function suggestDocs(registry, { taskText = '', projects = [], modules = [] } = {}) {
  const t = String(taskText).toLowerCase();
  const scored = [];
  for (const doc of registry.docs || []) {
    let score = 0;
    if (doc.project && projects.includes(doc.project)) score += 2;
    for (const kw of splitWhenKeywords(doc.when)) {
      if (kw && t.includes(kw.toLowerCase())) score += 1;
    }
    for (const tag of doc.tags || []) {
      if (tag && t.includes(tag.toLowerCase())) score += 1;
    }
    for (const m of modules) {
      if (m && String(doc.when || '').toLowerCase().includes(m.toLowerCase())) score += 1;
    }
    if (score > 0) scored.push({ score, doc });
  }
  return scored.sort((a, b) => b.score - a.score).map(x => x.doc);
}

function splitWhenKeywords(when) {
  return String(when || '').split(/[,，;；、\s]+/).map(s => s.trim()).filter(s => s.length >= 2);
}

// ---- query ----

/**
 * Query the index — by feature code or file path. Returns all related mappings.
 */
export function queryIndex(index, target) {
  if (!index || !target) return null;

  const result = {
    query: target,
    type: null,
    features: [],
    modules: [],
    files: [],
    projects: []
  };

  const isFeatureCode = /^[A-Z]{2,}-[FPSD]\d+$/i.test(target);

  if (isFeatureCode) {
    result.type = 'feature';
    result.features = [target];
    if (index.indexes?.featureToFiles?.[target]) {
      result.files = index.indexes.featureToFiles[target];
    }
    if (index.indexes?.moduleToFeatures) {
      for (const [mod, features] of Object.entries(index.indexes.moduleToFeatures)) {
        if (features.includes(target)) result.modules.push(mod);
      }
    }
  } else {
    result.type = 'file';
    result.files = [target];
    const normalizedTarget = normalizePath(target);

    if (index.indexes?.fileToFeature?.[normalizedTarget]) {
      result.features = index.indexes.fileToFeature[normalizedTarget];
    } else if (index.indexes?.fileToFeature?.[target]) {
      result.features = index.indexes.fileToFeature[target];
    }

    for (const feat of result.features) {
      if (index.indexes?.moduleToFeatures) {
        for (const [mod, features] of Object.entries(index.indexes.moduleToFeatures)) {
          if (features.includes(feat) && !result.modules.includes(mod)) {
            result.modules.push(mod);
          }
        }
      }
    }
  }

  if (index.indexes?.projectToModules) {
    for (const proj of Object.keys(index.indexes.projectToModules)) {
      const projModules = index.indexes.projectToModules[proj];
      if (result.modules.some(m => projModules.includes(m))) {
        result.projects.push(proj);
      }
    }
  }

  return result;
}

/** Loose suggestion search when nothing matched exactly. */
export function partialSearch(index, target) {
  const allKeys = [
    ...Object.keys(index.indexes?.fileToFeature || {}),
    ...Object.keys(index.indexes?.featureToFiles || {}),
    ...Object.keys(index.indexes?.moduleToFeatures || {}),
    ...Object.keys(index.indexes?.projectToModules || {})
  ];
  const t = String(target).toUpperCase();
  return allKeys.filter(k => k.toUpperCase().includes(t)).slice(0, 5);
}

// ---- map rendering (nav_map: text tree + HTML mindmap; pure, read-only) ----

/**
 * Build a nested project→module→feature tree from the index.
 * Orphan modules (registered but attached to no project) land under "(unattached)".
 * Orphan features (registered but attached to no module) are returned separately —
 * they would otherwise be INVISIBLE in every map/doc view (governance blind spot).
 */
export function buildTree(index) {
  const p2m = index.indexes?.projectToModules || {};
  const m2f = index.indexes?.moduleToFeatures || {};
  const f2files = index.indexes?.featureToFiles || {};
  const descs = index.descriptions || {};
  const modMeta = index.moduleMeta || {};
  const featNode = code => ({
    code,
    fname: descs[code]?.name || '',
    uv: descs[code]?.userView || '',
    sv: descs[code]?.systemView || '',
    files: f2files[code] || []
  });
  const attached = new Set();
  const projects = Object.entries(p2m).map(([name, mods]) => {
    attached.add(name);
    return {
      name,
      modules: mods.map(mod => {
        attached.add(mod);
        return {
          name: mod,
          mname: modMeta[mod]?.name || '',
          features: (m2f[mod] || []).map(featNode)
        };
      })
    };
  });
  const orphans = Object.keys(m2f)
    .filter(mod => !attached.has(mod))
    .map(mod => ({ name: mod, mname: modMeta[mod]?.name || '', features: (m2f[mod] || []).map(featNode) }));
  if (orphans.length) projects.push({ name: '(unattached modules)', modules: orphans, orphan: true });
  // orphan features: registered in featureToFiles but not listed under any module
  const inModules = new Set();
  for (const feats of Object.values(m2f)) for (const c of feats) inModules.add(c);
  const orphanFeatures = Object.keys(f2files)
    .filter(code => !inModules.has(code))
    .map(code => ({ code, fname: descs[code]?.name || '', files: f2files[code] || [] }));
  return { projects, orphanFeatures };
}

export function scopeTargetsOfOpenActions(ledger) {
  const open = (ledger.actions || []).filter(a => a.status === 'planned' || a.status === 'in_progress');
  const feats = new Set(); const mods = new Set(); const files = new Set(); const ids = [];
  for (const a of open) {
    ids.push(`${a.id}[${a.status}] ${a.task}`);
    for (const f of a.scope?.features || []) feats.add(f);
    for (const m of a.scope?.modules || []) mods.add(m);
    for (const f of a.scope?.files || []) files.add(normalizePath(f));
  }
  return { feats, mods, files, ids };
}

/** Render the map as an indented text tree. */
export function renderTreeText(index, { target = '', openActions = null } = {}) {
  const { projects, orphanFeatures } = buildTree(index);
  let shown = projects;
  if (target) {
    const t = String(target).toLowerCase();
    shown = projects.filter(p => p.name.toLowerCase().includes(t) || p.modules.some(m => m.name.toLowerCase().includes(t)));
    if (shown.length === 0 && orphanFeatures.length === 0) return `No project or module matching "${target}" in the map.`;
  }
  const S = openActions || { feats: new Set(), mods: new Set(), files: new Set(), ids: [] };
  const lines = [];
  for (const p of shown) {
    const nf = p.modules.reduce((n, m) => n + m.features.length, 0);
    lines.push(`▼ ${p.name}  (${p.modules.length} module${p.modules.length === 1 ? '' : 's'}, ${nf} feature${nf === 1 ? '' : 's'})`);
    for (const m of p.modules) {
      const flag = S.mods.has(m.name) ? '  ← open action' : '';
      lines.push(`  ▼ ${m.name}${m.mname ? ` (${m.mname})` : ''}  (${m.features.length} feature${m.features.length === 1 ? '' : 's'})${flag}`);
      for (const f of m.features) {
        const flag2 = S.feats.has(f.code) ? '  ← open action' : '';
        lines.push(`      ${f.code} ${f.fname ? `- ${f.fname}` : ''}${flag2}`);
        for (const file of f.files) {
          const flag3 = S.files.has(file) ? '  ← open action' : '';
          lines.push(`          - ${file}${flag3}`);
        }
      }
    }
  }
  if (orphanFeatures.length) {
    lines.push(`▼ ⚠️ orphan features（未挂模块，地图盲区）(${orphanFeatures.length})`);
    for (const f of orphanFeatures) {
      lines.push(`      ${f.code} ${f.fname ? `- ${f.fname}` : ''}  ← nav_update target=<模块> features=<功能码> project=<项目> 挂到模块`);
      for (const file of f.files) lines.push(`          - ${file}`);
    }
  }
  if (S.ids.length) lines.push('', `Open actions (${S.ids.length}): ${S.ids.join('; ')}`);
  return lines.join('\n');
}

/**
 * Disk-drift check: indexed files that no longer exist on disk.
 * Index keys come in two shapes: project-relative ("host/index.js") and
 * workspace-relative ("shoucang/client.js", with the project dir prefix).
 * Resolve via index.projectPaths for the former; accept either shape —
 * only flag stale when NEITHER resolves on disk.
 */
export function findStaleFiles(index, rootPath) {
  const p2m = index.indexes?.projectToModules || {};
  const m2f = index.indexes?.moduleToFeatures || {};
  const f2files = index.indexes?.featureToFiles || {};
  const paths = index.projectPaths || {};
  // feature → owning project (first declaration wins), derived from project → module → feature.
  const featureProject = {};
  for (const [proj, mods] of Object.entries(p2m)) {
    for (const mod of mods) {
      for (const code of (m2f[mod] || [])) {
        if (!featureProject[code]) featureProject[code] = proj;
      }
    }
  }
  // Probe EVERY feature in featureToFiles. Walking project→module→feature skipped orphan
  // features entirely (a registered capability no module lists), so a file deleted from an
  // orphan stayed invisible forever. One entry per file: a file shared by several features is
  // reported once, not once per owner.
  const fileInfo = new Map();
  for (const [code, files] of Object.entries(f2files)) {
    for (const f of (files || [])) {
      const cur = fileInfo.get(f);
      if (!cur) fileInfo.set(f, { proj: featureProject[code] || null, codes: [code] });
      else {
        cur.codes.push(code);
        if (!cur.proj && featureProject[code]) cur.proj = featureProject[code];
      }
    }
  }
  // An orphan has no project to resolve against, so every declared project root is a candidate
  // (conservative: never report STALE for a file that resolves under ANY known root).
  const allRoots = [rootPath, ...Object.values(paths).map(p => resolve(rootPath, p))];
  const stale = [];
  for (const [file, info] of fileInfo) {
    const bases = info.proj && paths[info.proj] ? [resolve(rootPath, paths[info.proj]), rootPath] : allRoots;
    try {
      if (!bases.some(base => existsSync(resolve(base, file)))) {
        stale.push(info.proj ? `${file} [${info.proj}]` : `${file} [orphan feature ${info.codes.join('/')}]`);
      }
    } catch { /* unreadable path — skip */ }
  }
  return stale;
}

/**
 * Render the auto-aligned PROJECT.md section (between nav:auto markers) from the index.
 * Markdown bullets handle long userView/systemView text better than tables.
 */
export function renderProjectDocSection(index, { vector = null, arch = null } = {}) {
  const { projects, orphanFeatures } = buildTree(index);
  const m2f = index.indexes?.moduleToFeatures || {};
  const lines = ['<!-- nav:auto:start -->', '## 功能地图（自动对齐，勿手改）', '', '> 本节由 nav_sync_docs 从 .internal/nav-index.json 生成。登记与修改一律走 nav_update（upsert：新功能给 files=，新模块给 features=/project=，退役给 retire=true），然后重新同步。', ''];
  for (const p of projects) {
    const nf = p.modules.reduce((n, m) => n + m.features.length, 0);
    lines.push(`### ${p.name}（${p.modules.length} 模块 / ${nf} 功能）`, '');
    for (const m of p.modules) {
      if (m.features.length === 0) { lines.push(`- 模块 **${m.name}**（未登记功能）`); continue; }
      lines.push(`- 模块 **${m.name}**`);
      for (const f of m.features) {
        const d = index.descriptions?.[f.code] || {};
        const parts = [`  - **${f.code}** ${f.fname || d.name || ''}`];
        if (d.userView) parts.push(`用户：${d.userView}`);
        if (d.systemView) parts.push(`系统：${d.systemView}`);
        lines.push(parts.join(' — '));
        if (f.files.length) lines.push(`    - 文件：${f.files.join(', ')}`);
      }
    }
    lines.push('');
  }
  if (orphanFeatures.length) {
    lines.push('### ⚠️ orphan features（未挂模块，待收敛）', '');
    for (const f of orphanFeatures) lines.push(`- **${f.code}** ${f.fname}`, `  - 文件：${f.files.join(', ') || '（无）'}`);
    lines.push('');
  }
  if (vector && (vector.doing || vector.next)) {
    lines.push('### 主线向量（自动对齐）', '');
    if (vector.doing) lines.push(`- **Doing**: ${vector.doing}`);
    if (vector.next) lines.push(`- **Next**: ${vector.next}`);
    if (vector.notDoing) lines.push(`- **Not Doing**: ${vector.notDoing}`);
    if (vector.exitCondition) lines.push(`- **Exit**: ${vector.exitCondition}`);
    lines.push('');
  }
  if (arch && (arch.decisions || []).length) {
    lines.push('### 架构决策（ADR，自动对齐）', '');
    for (const d of arch.decisions) {
      lines.push('- **' + d.id + '** `' + d.anchor + '` — ' + d.decision);
      if (d.reason) lines.push('  - 触发原因：' + d.reason);
      if (d.impact) lines.push('  - 影响面：' + d.impact);
    }
    lines.push('');
  }
  lines.push('<!-- nav:auto:end -->');
  return lines.join('\n');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render a self-contained progressive-expansion mindmap HTML (no CDN, offline-safe).
 * Progressive disclosure: <details open> at project/module level, files collapsed.
 * Status coloring: red = inside an open action scope; vector summary in header.
 */
export function renderMapHtml(index, { title = 'Project Nav Map', vector = null, openActions = null, target = '' } = {}) {
  const built = buildTree(index);
  // Same narrowing rule as renderTreeText, so `target` means ONE thing across both renderers
  // (it used to be ignored here: a "zoom into PN-P01" map still contained every other project).
  const t = String(target || '').trim().toLowerCase();
  const projects = t
    ? built.projects.filter(p => p.name.toLowerCase().includes(t) || p.modules.some(m => m.name.toLowerCase().includes(t)))
    : built.projects;
  const orphanFeatures = t
    ? built.orphanFeatures.filter(f => String(f.code).toLowerCase().includes(t) || String(f.fname || '').toLowerCase().includes(t))
    : built.orphanFeatures;
  const S = openActions || { feats: new Set(), mods: new Set(), files: new Set(), ids: [] };
  const v = vector || {};
  const featHtml = (f) => {
    const inOpen = S.feats.has(f.code);
    const style = inOpen ? ' style="color:#c0392b;font-weight:600"' : '';
    const flag = inOpen ? ' 🔴' : '';
    const desc = [f.uv ? `用户：${esc(f.uv)}` : '', f.sv ? `系统：${esc(f.sv)}` : ''].filter(Boolean).join('<br>');
    const descHtml = desc ? `<div class="feat-desc">${desc}</div>` : '';
    const files = f.files.map(file => {
      const fo = S.files.has(file) ? ' style="color:#c0392b"' : '';
      const ff = S.files.has(file) ? ' 🔴' : '';
      return `<li class="file"${fo}>${esc(file)}${ff}</li>`;
    }).join('');
    if (!f.files.length) {
      const gap = desc ? '' : ' <span class="dim">— 无文件清单/无描述，待登记（nav_update field="files" value="..."）</span>';
      return `<li${style}><details><summary>${esc(f.code)} ${esc(f.fname)}${flag} <span class="dim">(no files)</span></summary>${descHtml}${gap}</details></li>`;
    }
    return `<li${style}><details><summary>${esc(f.code)} ${esc(f.fname)}${flag} <span class="dim">(${f.files.length} files)</span></summary>${descHtml}<ul>${files}</ul></details></li>`;
  };
  const modHtml = (m) => {
    const inOpen = S.mods.has(m.name);
    const style = inOpen ? ' style="color:#c0392b;font-weight:600"' : '';
    const flag = inOpen ? ' 🔴' : '';
    const mlabel = m.mname ? ` <span class="dim">— ${esc(m.mname)}</span>` : '';
    return `<li><details open><summary${style}>${esc(m.name)}${mlabel}${flag} <span class="dim">(${m.features.length} feature${m.features.length === 1 ? '' : 's'})</span></summary><ul>${m.features.map(featHtml).join('')}</ul></details></li>`;
  };
  const projHtml = (p) => {
    const pp = index.projectPaths?.[p.name] || '';
    return `<li><details open><summary class="proj">📁 ${esc(p.name)} <span class="dim">${esc(pp)} · ${p.modules.length} module${p.modules.length === 1 ? '' : 's'}</span></summary><ul>${p.modules.map(modHtml).join('')}</ul></details></li>`;
  };
  const vec = [
    v.doing ? `<b>Doing:</b> ${esc(v.doing)}` : '',
    v.next ? `<b>Next:</b> ${esc(v.next)}` : '',
    v.notDoing ? `<b>Not Doing:</b> ${esc(v.notDoing)}` : '',
    v.exitCondition ? `<b>Exit:</b> ${esc(v.exitCondition)}` : ''
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  const orphanHtml = orphanFeatures.length
    ? `<li><details><summary class="proj" style="color:#c0392b">⚠️ orphan features（未挂模块）<span class="dim">(${orphanFeatures.length})</span></summary><ul>${orphanFeatures.map(featHtml).join('')}</ul></details></li>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
 body{font-family:"Segoe UI",system-ui,sans-serif;margin:24px;color:#1a1a2e;background:#fafafa;max-width:1100px}
 h1{font-size:20px;border-bottom:2px solid #dee2e6;padding-bottom:8px}
 .vector{background:#eef3ff;border:1px solid #d0d9f0;border-radius:8px;padding:10px 14px;margin:12px 0;font-size:13px}
 .open-actions{background:#fdeeee;border:1px solid #f0c4c4;border-radius:8px;padding:10px 14px;margin:12px 0;font-size:13px;color:#c0392b}
 details{margin:2px 0}
 details ul{list-style:none;padding-left:22px;border-left:1px dashed #ccc;margin:4px 0}
 summary{cursor:pointer;padding:2px 4px;border-radius:4px;user-select:none}
 summary:hover{background:#eceff5}
 summary.proj{font-weight:700;font-size:15px}
 li{margin:1px 0;font-size:13.5px}
 li.file{color:#555;font-family:Consolas,monospace;font-size:12.5px}
 .dim{color:#888;font-weight:400;font-size:12px}
 .feat-desc{color:#444;font-size:12.5px;margin:4px 0 4px 22px;padding:6px 10px;background:#f4f6fa;border-left:3px solid #c9d4e8;border-radius:0 4px 4px 0;line-height:1.6}
 .howto{background:#f0f7f0;border:1px solid #cfe3cf;border-radius:8px;padding:10px 14px;margin:12px 0;font-size:12.5px;color:#2e4d2e;line-height:1.8}
 .legend{font-size:12px;color:#888;margin-top:16px}
</style></head><body>
<h1>🗺️ ${esc(title)}</h1>
${vec ? `<div class="vector">🧭 ${vec}</div>` : ''}
${S.ids.length ? `<div class="open-actions">🔴 Open actions（红=在未完结动作范围内）: ${S.ids.map(esc).join('; ')}</div>` : ''}
<div class="howto">📖 <b>怎么读这张图</b>：层级为 <b>项目 → 模块 → 特征 → 文件</b>（点 ▸ 渐进展开）。<b>特征</b>（如 SC-S07）= 一条用户可感知的功能，展开后的小字是它的「用户视角 / 系统视角」说明；<b>文件</b> = 实现该特征的源码。🔴 红色 = 在未完结动作（open action）范围内，动这些文件前先处理对应动作。本图由 nav-index.json 自动生成，永不手工编辑。改动工作流：nav_query 查影响面 → nav_plan 登记动作（必带 anchor 锚定架构节点；单目标自动取锚）→ 改代码 → nav_mark done 收口；同一锚点反复补丁会触发计数闸，此时先 nav_adr 出架构决策再动手。</div>
<ul style="list-style:none;padding-left:0">
${projects.map(projHtml).join('\n')}
${orphanHtml}
${(!projects.length && !orphanFeatures.length) ? '<p class="dim">No project or module matching this target.</p>' : ''}
</ul>
<div class="legend">生成自 .internal/nav-index.json（agent 自治理索引）· 🔴 = open action 范围内 · 灰字为辅助说明</div>
</body></html>`;
}
