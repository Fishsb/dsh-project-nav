// shared/index.js — project-nav core layer (single source of truth)
// Used by host/index.js (tool registrations). No bare-package imports here —
// only node: builtins, so this file resolves from any loading context.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const INDEX_FILENAME = '.internal/nav-index.json';
const VECTOR_FILENAME = '.internal/vector.json';
const ACTIONS_FILENAME = '.internal/nav-actions.json';
const DOCS_FILENAME = '.internal/nav-docs.json';

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

// ---- action ledger (anti-drift transaction log) ----

export function createEmptyActions() {
  return { version: '1.0', actions: [] };
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
  const attached = new Set();
  const projects = Object.entries(p2m).map(([name, mods]) => {
    attached.add(name);
    return {
      name,
      modules: mods.map(mod => {
        attached.add(mod);
        return {
          name: mod,
          features: (m2f[mod] || []).map(code => ({
            code,
            fname: descs[code]?.name || '',
            files: f2files[code] || []
          }))
        };
      })
    };
  });
  const orphans = Object.keys(m2f)
    .filter(mod => !attached.has(mod))
    .map(mod => ({ name: mod, features: (m2f[mod] || []).map(code => ({ code, fname: descs[code]?.name || '', files: f2files[code] || [] })) }));
  if (orphans.length) projects.push({ name: '(unattached modules)', modules: orphans, orphan: true });
  // orphan features: registered in featureToFiles but not listed under any module
  const inModules = new Set();
  for (const feats of Object.values(m2f)) for (const c of feats) inModules.add(c);
  const orphanFeatures = Object.keys(f2files)
    .filter(code => !inModules.has(code))
    .map(code => ({ code, fname: descs[code]?.name || '', files: f2files[code] || [] }));
  return { projects, orphanFeatures };
}

function scopeTargetsOfOpenActions(ledger) {
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
      lines.push(`  ▼ ${m.name}  (${m.features.length} features)${flag}`);
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
      lines.push(`      ${f.code} ${f.fname ? `- ${f.fname}` : ''}  ← 用 nav_add_module 挂到模块`);
      for (const file of f.files) lines.push(`          - ${file}`);
    }
  }
  if (S.ids.length) lines.push('', `Open actions (${S.ids.length}): ${S.ids.join('; ')}`);
  return lines.join('\n');
}

/**
 * Disk-drift check: indexed files that no longer exist on disk.
 * File keys are project-relative; resolve via index.projectPaths (project → dir
 * relative to workspace root), falling back to the workspace root.
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
      if (!existsSync(resolve(base, file))) stale.push(`${file} [${proj}]`);
    } catch { /* unreadable path — skip */ }
  }
  return stale;
}

/**
 * Render the auto-aligned PROJECT.md section (between nav:auto markers) from the index.
 * Markdown bullets handle long userView/systemView text better than tables.
 */
export function renderProjectDocSection(index, { vector = null } = {}) {
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
    const files = f.files.map(file => {
      const fo = S.files.has(file) ? ' style="color:#c0392b"' : '';
      const ff = S.files.has(file) ? ' 🔴' : '';
      return `<li class="file"${fo}>${esc(file)}${ff}</li>`;
    }).join('');
    if (!f.files.length) return `<li${style}>${esc(f.code)} ${esc(f.fname)}${flag} <span class="dim">(no files)</span></li>`;
    return `<li${style}><details><summary>${esc(f.code)} ${esc(f.fname)}${flag} <span class="dim">(${f.files.length} files)</span></summary><ul>${files}</ul></details></li>`;
  };
  const modHtml = (m) => {
    const inOpen = S.mods.has(m.name);
    const style = inOpen ? ' style="color:#c0392b;font-weight:600"' : '';
    const flag = inOpen ? ' 🔴' : '';
    return `<li><details open><summary${style}>${esc(m.name)}${flag} <span class="dim">(${m.features.length} features)</span></summary><ul>${m.features.map(featHtml).join('')}</ul></details></li>`;
  };
  const projHtml = (p) => `<li><details open><summary class="proj">${esc(p.name)} <span class="dim">(${p.modules.length} modules)</span></summary><ul>${p.modules.map(modHtml).join('')}</ul></details></li>`;
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
 .legend{font-size:12px;color:#888;margin-top:16px}
</style></head><body>
<h1>🗺️ ${esc(title)}</h1>
${vec ? `<div class="vector">🧭 ${vec}</div>` : ''}
${S.ids.length ? `<div class="open-actions">🔴 Open actions（红=在未完结动作范围内）: ${S.ids.map(esc).join('; ')}</div>` : ''}
<ul style="list-style:none;padding-left:0">
${projects.map(projHtml).join('\n')}
${orphanHtml}
</ul>
<div class="legend">自动生成自 nav-index.json · 永不手工编辑 · 点击 ▸ 渐进展开 · 🔴 = open action 范围内</div>
</body></html>`;
}
