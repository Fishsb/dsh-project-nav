// shared/index.js — project-nav core layer (single source of truth)
// Used by host/index.js (tool registrations). No bare-package imports here —
// only node: builtins, so this file resolves from any loading context.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
const SESSION_LABEL_LEN = 8;

/** Per-process serialization: all cordis tools run in one process, so queue them first. */
let ledgerQueue = Promise.resolve();
function enqueue(task) {
  const run = ledgerQueue.then(task, task);
  ledgerQueue = run.then(() => undefined, () => undefined);
  return run;
}

// Synchronous sleep: the ledger critical sections are deliberately sync
// (a read-modify-write must not interleave with another await in-process).
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function lockPathFor(rootPath) {
  return resolve(rootPath, ACTIONS_FILENAME + '.lock');
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
 * Run one ledger critical section under an exclusive lock. A held lock re-enters
 * (token check) instead of deadlocking; a lock whose owner died is broken by the
 * lock file's own age, so a crashed session never blocks the workspace forever.
 */
export async function withLedgerLock(rootPath, fn) {
  return enqueue(() => {
    const lockPath = lockPathFor(rootPath);
    mkdirSync(dirname(lockPath), { recursive: true });
    const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() });
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
          if (holder && holder.token === token) return fn();   // re-entrant same holder
          let aged = false;
          try { aged = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch { aged = true; }
          if (aged) { try { unlinkSync(lockPath); } catch { /* another waiter won the break */ } continue; }
          if (Date.now() - started > LOCK_TIMEOUT_MS) {
            throw new Error(`[project-nav] ledger lock busy for ${LOCK_TIMEOUT_MS}ms (${lockPath}, held by pid ${holder?.pid ?? '?'} since ${holder?.at ?? '?'}). Another session is writing the action ledger; retry in a moment.`);
          }
          sleepSync(LOCK_WAIT_MS);
          continue;
        }
        throw e;
      }
    }
    try { return fn(); } finally { try { rmSync(lockPath, { force: true }); } catch { /* lock file already gone */ } }
  });
}

// ---- path helpers ----

/** Normalize a path for index keys: backslashes → forward slashes. */
export function normalizePath(p) {
  return String(p).replace(/\\/g, '/');
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
      projectToModules: {},
      functionToModule: {}
    },
    descriptions: {},
    moduleMeta: {},
    unmappedFiles: [],
    staleEntries: [],
    metadata: { totalFiles: 0, totalFeatures: 0, totalModules: 0, totalProjects: 0, coverage: 'empty' }
  };
}

export function loadIndex(rootPath) {
  return readJson(resolve(rootPath, INDEX_FILENAME), createEmptyIndex, { failLoud: true, label: 'nav index' });
}

export function saveIndex(rootPath, index) {
  index.generated = new Date().toISOString();
  recomputeMetadata(index);
  atomicWriteJson(resolve(rootPath, INDEX_FILENAME), index);
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
  return m;
}

// ---- mainline vector (vector.json is the single source of truth) ----

export function createDefaultVector() {
  return { doing: '', next: '', notDoing: '', exitCondition: '' };
}

export function loadVector(rootPath) {
  return readJson(resolve(rootPath, VECTOR_FILENAME), createDefaultVector, { label: 'vector' });
}

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
  return s ? s.slice(0, SESSION_LABEL_LEN) : 'unknown';
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
  // drop the project/module NAMES nav_plan accepts as scope entries — they are not files
  return filtered.filter(f => {
    const parts = f.split('/');
    if (parts.length > 1 && dirs.has(parts[0].toLowerCase())) return false;
    for (const proj of Object.keys(index.projectToModules || {})) if (f === proj) return false;
    return true;
  });
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
    if (a === undefined || a === 'missing') { removed.push(f); continue; }
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
 * 计数闸：同一锚点自「最近一次架构决策」以来累计的补丁数。
 * 补丁不单独建账本——**已完结且带锚点的动作就是补丁**（done 动作的投影），
 * 直接从动作账本推导，少一份要维护会漂移的数据。
 */
export function repeatPressure(arch, actions, anchor, { threshold = REPEAT_PATCH_THRESHOLD } = {}) {
  const a = normalizePath(String(anchor || ''));
  const since = lastDecisionFor(arch, anchor);
  const sinceAt = since?.createdAt || null;
  const list = (actions || []).filter(x => x.status === 'done'
    && normalizePath(String(x.anchor || '')) === a
    && (!sinceAt || String(x.completedAt || '') > String(sinceAt)));
  return { anchor: a, count: list.length, threshold, exceeded: list.length >= threshold, sinceDecision: since ? since.id : null, patches: list.map(p => p.id) };
}
// ---- reference docs registry (project reference foundation) ----

export function createEmptyDocs() {
  return { version: '1.0', docs: [] };
}

export function loadDocs(rootPath) {
  return readJson(resolve(rootPath, DOCS_FILENAME), createEmptyDocs, { failLoud: true, label: 'reference docs registry' });
}

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
    lines.push(`▼ ${p.name}  (${p.modules.length} modules, ${nf} features)`);
    for (const m of p.modules) {
      const flag = S.mods.has(m.name) ? '  ← open action' : '';
      lines.push(`  ▼ ${m.name}${m.mname ? ` (${m.mname})` : ''}  (${m.features.length} features)${flag}`);
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
  const fileToProject = {};
  for (const [proj, mods] of Object.entries(p2m)) {
    for (const mod of mods) {
      for (const code of (m2f[mod] || [])) {
        for (const f of (f2files[code] || [])) {
          if (!fileToProject[f]) fileToProject[f] = proj;
        }
      }
    }
  }
  const stale = [];
  for (const [file, proj] of Object.entries(fileToProject)) {
    const base = paths[proj] ? resolve(rootPath, paths[proj]) : rootPath;
    try {
      if (!existsSync(resolve(base, file)) && !existsSync(resolve(rootPath, file))) {
        stale.push(`${file} [${proj}]`);
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
  const lines = ['<!-- nav:auto:start -->', '## 功能地图（自动对齐，勿手改）', '', '> 本节由 nav_sync_docs 从 .internal/nav-index.json 生成。编辑请走 nav_add_feature / nav_update / nav_add_module，然后重新同步。', ''];
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
export function renderMapHtml(index, { title = 'Project Nav Map', vector = null, openActions = null } = {}) {
  const { projects, orphanFeatures } = buildTree(index);
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
      const gap = desc ? '' : ' <span class="dim">— 无文件清单/无描述，待登记（nav_update --field files）</span>';
      return `<li${style}><details><summary>${esc(f.code)} ${esc(f.fname)}${flag} <span class="dim">(no files)</span></summary>${descHtml}${gap}</details></li>`;
    }
    return `<li${style}><details><summary>${esc(f.code)} ${esc(f.fname)}${flag} <span class="dim">(${f.files.length} files)</span></summary>${descHtml}<ul>${files}</ul></details></li>`;
  };
  const modHtml = (m) => {
    const inOpen = S.mods.has(m.name);
    const style = inOpen ? ' style="color:#c0392b;font-weight:600"' : '';
    const flag = inOpen ? ' 🔴' : '';
    const mlabel = m.mname ? ` <span class="dim">— ${esc(m.mname)}</span>` : '';
    return `<li><details open><summary${style}>${esc(m.name)}${mlabel}${flag} <span class="dim">(${m.features.length} features)</span></summary><ul>${m.features.map(featHtml).join('')}</ul></details></li>`;
  };
  const projHtml = (p) => {
    const pp = index.projectPaths?.[p.name] || '';
    return `<li><details open><summary class="proj">📁 ${esc(p.name)} <span class="dim">${esc(pp)} · ${p.modules.length} modules</span></summary><ul>${p.modules.map(modHtml).join('')}</ul></details></li>`;
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
<div class="howto">📖 <b>怎么读这张图</b>：层级为 <b>项目 → 模块 → 特征 → 文件</b>（点 ▸ 渐进展开）。<b>特征</b>（如 SC-S07）= 一条用户可感知的功能，展开后的小字是它的「用户视角 / 系统视角」说明；<b>文件</b> = 实现该特征的源码。🔴 红色 = 在未完结动作（open action）范围内，动这些文件前先处理对应动作。本图由 nav-index.json 自动生成，永不手工编辑。改动工作流：nav_query 查影响面 → nav_plan 登记动作 → 改代码 → nav_mark done 收口。</div>
<ul style="list-style:none;padding-left:0">
${projects.map(projHtml).join('\n')}
${orphanHtml}
</ul>
<div class="legend">生成自 .internal/nav-index.json（agent 自治理索引）· 🔴 = open action 范围内 · 灰字为辅助说明</div>
</body></html>`;
}
