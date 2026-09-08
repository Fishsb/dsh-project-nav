// @dsh-external/project-nav — anti-drift governance for agent-maintained projects
// Design core: governance-first transaction loop (HANDOFF §14):
//   nav_query (scope) → nav_plan (register action) → nav_mark begin → change → nav_mark done
// 12 tools. Core logic lives in ../shared/index.js (single source, no duplication).

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { writeFileSync, mkdirSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import {
  loadIndex, saveIndex, getIndexAge,
  loadVector, saveVector,
  loadActions, saveActions, nextActionId,
  loadDocs, saveDocs, nextDocId, suggestDocs,
  queryIndex, partialSearch, normalizePath,
  renderTreeText, renderMapHtml, renderProjectDocSection,
  findStaleFiles, scopeTargetsOfOpenActions
} from '../shared/index.js'

// ---- Plugin metadata (Cordis contract) ----

export const name = '@dsh-external/project-nav'
export const inject = ['tools']

export const Config = z.object({
  // Personal default: the governed workspace root (D:\FF). Override via config
  // if the plugin is pointed at another workspace.
  root: z.string().default('D:/FF')
})

// ---- helpers ----

function err(e) {
  return `ERROR: ${e.message}`
}

function splitList(s) {
  return s ? String(s).split(',').map(x => x.trim()).filter(Boolean) : []
}

/** Does a query target fall inside an action's scope? (exact or suffix path match) */
function targetInScope(target, scope) {
  const t = normalizePath(target).toLowerCase();
  for (const f of (scope.features || [])) if (f.toLowerCase() === t) return true;
  for (const m of (scope.modules || [])) if (m.toLowerCase() === t) return true;
  for (const f of (scope.files || [])) {
    const nf = normalizePath(f).toLowerCase();
    // exact match, or target inside a scope DIRECTORY, or scope path expressed
    // relative to the query's directory. Bare filenames match only exactly —
    // prevents 'index.js' in scope from matching every index.js in the repo.
    if (t === nf) return true;
    if (nf.includes('/') && t.startsWith(nf + '/')) return true;
    if (t.includes('/') && nf.startsWith(t + '/')) return true;
  }
  return false;
}

/**
 * Scope gate: check open (planned/in_progress) actions against a query target.
 * Returns a human-readable gate notice (possibly empty).
 */
function scopeGate(ledger, target) {
  const open = (ledger.actions || []).filter(a => a.status === 'planned' || a.status === 'in_progress')
  if (open.length === 0) return ''
  const hit = open.find(a => targetInScope(target, a.scope || {}))
  if (hit) {
    return `Gate: this target is inside OPEN action ${hit.id} (${hit.status}) "${hit.task}". Changes here must run under that action.`
  }
  const list = open.map(a => `${a.id} [${a.status}] ${a.task}`).join('; ')
  return `⚠ Gate: ${open.length} open action(s) exist (${list}) and this target is NOT in their scope. Plan first (nav_plan) or finish them (nav_mark).`
}

/** Mainline gate heuristic: are the query hits referenced in doing/next text? */
function mainlineGate(vector, result) {
  const mainline = `${vector.doing || ''} ${vector.next || ''}`.toLowerCase().trim()
  // Only gate on module names — feature codes never appear in prose mainline
  // text, so matching them would warn on every query (noise → gate gets ignored).
  if (!mainline || result.modules.length === 0) return ''
  const referenced = result.modules.some(m => m.length >= 3 && mainline.includes(m.toLowerCase()))
  if (referenced) return ''
  return `⚠ Mainline: module(s) ${result.modules.join(', ')} not referenced in the mainline vector (doing/next). Confirm this is on-mainline, or update the vector (nav_set_vector).`
}

const OUTPUT = {
  schema: { type: 'string' },
  render: (_a, v) => [{ type: 'text', text: String(v) }]
}

// ---- plugin entry ----

export function apply(ctx, config) {
  const root = config.root

  // ---- 1. nav_query — bidirectional mapping + gates ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_query',
    description: 'Understand the scope of a change target BEFORE touching anything: query by file path or feature code to expand features/modules/projects, with open-action and mainline drift gates.',
    parameters: {
      target: { type: 'string', required: true, description: 'File path or feature code (e.g., PE-F01)' },
      format: { type: 'string', description: 'Output format: text (default) or json' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const index = loadIndex(root)
        const result = queryIndex(index, args.target)
        if (!result || (result.features.length === 0 && result.files.length === 0 && result.modules.length === 0)) {
          const partials = partialSearch(index, args.target)
          if (partials.length > 0) {
            return `No exact match for "${args.target}". Did you mean:\n${partials.map(m => `  - ${m}`).join('\n')}`
          }
          return `No mapping found for "${args.target}". Register it via nav_add_feature (and nav_add_module if needed).`
        }
        const notices = [scopeGate(loadActions(root), args.target), mainlineGate(loadVector(root), result)].filter(Boolean)
        if (args.format === 'json') return JSON.stringify({ ...result, notices }, null, 2)
        const lines = [
          `Query: ${result.query} (${result.type})`,
          `Features: ${result.features.join(', ') || 'none'}`,
          `Modules: ${result.modules.join(', ') || 'none'}`,
          `Projects: ${result.projects.join(', ') || 'none'}`,
          `Files:\n${result.files.map(f => `  → ${f}`).join('\n') || '  (none registered)'}`
        ]
        const vector = loadVector(root)
        if (vector.doing || vector.next) {
          lines.push('', 'Mainline Vector:')
          if (vector.doing) lines.push(`  Doing: ${vector.doing}`)
          if (vector.next) lines.push(`  Next: ${vector.next}`)
        }
        if (notices.length) lines.push('', ...notices)
        return lines.join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: query')

  // ---- 2. nav_plan — governance-first: register an action BEFORE changing anything ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_plan',
    description: 'Governance-first gate: register a change action (task + plan + scope) BEFORE executing any project change. Returns an ACT-id to begin/done with nav_mark. Refuses scope that collides with the mainline anti-goals (notDoing).',
    parameters: {
      task: { type: 'string', required: true, description: 'One-line task description' },
      plan: { type: 'string', description: 'Change plan summary derived from governance info' },
      features: { type: 'string', description: 'Comma-separated feature codes in scope' },
      modules: { type: 'string', description: 'Comma-separated module names in scope' },
      files: { type: 'string', description: 'Comma-separated file paths in scope' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const scope = {
          features: splitList(args.features),
          modules: splitList(args.modules),
          files: splitList(args.files)
        }
        if (!scope.features.length && !scope.modules.length && !scope.files.length) {
          return 'ERROR: scope is empty — provide at least one of features/modules/files so the action has a checkable scope.'
        }
        const vector = loadVector(root)
        // Mainline gate: refuse if scope collides with explicit anti-goals.
        const notDoing = (vector.notDoing || '').toLowerCase()
        if (notDoing) {
          const tokens = [...scope.features, ...scope.modules].map(x => x.toLowerCase()).filter(x => x.length >= 4)
          const collide = tokens.find(x => notDoing.includes(x))
          if (collide) {
            return `ERROR: scope collides with mainline anti-goal (notDoing: "${vector.notDoing}") via "${collide}". Re-scope the plan or update the vector first (nav_set_vector).`
          }
        }
        const ledger = loadActions(root)
        const index = loadIndex(root)
        // B4: scope-vs-index pre-validation at plan time — every scope item must either exist in the
        // index or be explicitly new. Silent unknowns are how a plan quietly points at the wrong target.
        const unknown = {
          features: scope.features.filter(f => !index.indexes?.featureToFiles?.[f] && !index.descriptions?.[f]),
          modules: scope.modules.filter(mod => !index.indexes?.moduleToFeatures?.[mod]),
          files: scope.files.filter(f => !(index.indexes?.fileToFeature || {})[f] && !existsSync(resolve(root, f)))
        }
        const unknownNote = (unknown.features.length || unknown.modules.length || unknown.files.length)
          ? `\n  ⚠ Scope items not found in index: features=[${unknown.features.join(', ')}] modules=[${unknown.modules.join(', ')}] files=[${unknown.files.join(', ')}]\n    If this task CREATES them, ignore. If it should MODIFY existing ones, the identifier is likely wrong — re-check with nav_query.`
          : ''
        const open = (ledger.actions || []).filter(a => a.status === 'in_progress')
        if (open.length) {
          // Enforce the AGENTS.md iron rule: one in_progress action at a time.
          return `ERROR: ${open.length} action(s) already in_progress (${open.map(x => x.id).join(', ')}) — finish with nav_mark done, or abort, before planning a new one.`
        }
        const action = {
          id: nextActionId(ledger),
          task: args.task,
          plan: args.plan || '',
          scope,
          status: 'planned',
          createdAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null
        }
        ledger.actions.push(action)
        saveActions(root, ledger)
        const warns = []
        if (!vector.doing) warns.push('⚠ Mainline vector "doing" is empty — set it (nav_set_vector) so drift can be detected.')
        // Reference-doc suggestions: consult BEFORE finalizing the plan (方案确认参考).
        const suggestions = suggestDocs(loadDocs(root), {
          taskText: `${args.task} ${args.plan || ''}`,
          projects: Object.keys(index.indexes?.projectToModules || {}),
          modules: scope.modules
        }).slice(0, 5)
        return [
          `✓ Action ${action.id} registered (planned): ${action.task}`,
          `  Scope: features=[${scope.features.join(', ')}] modules=[${scope.modules.join(', ')}] files=[${scope.files.join(', ')}]`,
          ...(unknownNote ? [unknownNote] : []),
          ...(suggestions.length ? [
            '',
            'Reference docs to consult at 方案确认 (read/fetch these before finalizing the plan):',
            ...suggestions.map(d => `  ${d.id} ${d.title}\n    → ${d.path}\n    when: ${d.when}`)
          ] : []),
          ...(warns.length ? ['', ...warns] : []),
          'Next: consult suggested docs, finalize plan, then nav_mark id="' + action.id + '" action=begin before touching files.'
        ].join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: plan')

  // ---- 3. nav_mark — action lifecycle: begin / done / abort ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_mark',
    description: 'Mark an action lifecycle transition: begin (planned→in_progress, BEFORE changes), done (in_progress→done, AFTER changes), abort (give up). The open-action list is the drift signal — never leave actions unfinished.',
    parameters: {
      id: { type: 'string', required: true, description: 'Action id from nav_plan (e.g., ACT-001)' },
      action: { type: 'string', required: true, description: 'One of: begin, done, abort' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const ledger = loadActions(root)
        const a = (ledger.actions || []).find(x => x.id === args.id)
        if (!a) return `ERROR: no action "${args.id}". Use nav_plan to create one.`
        const now = new Date().toISOString()
        if (args.action === 'begin') {
          if (a.status !== 'planned') return `ERROR: ${a.id} is "${a.status}", only "planned" actions can begin.`
          a.status = 'in_progress'; a.startedAt = now
        } else if (args.action === 'done') {
          if (a.status !== 'in_progress') return `ERROR: ${a.id} is "${a.status}", only "in_progress" actions can be done.`
          a.status = 'done'; a.completedAt = now
          // Delta close-out (OpenSpec archive semantics): surface index deltas the
          // agent must merge before this change counts as synced.
          const index = loadIndex(root)
          const f2f = index.indexes?.fileToFeature || {}
          const f2files = index.indexes?.featureToFiles || {}
          const missingFeatures = (a.scope?.features || []).filter(c => !f2files[c])
          const unregisteredFiles = (a.scope?.files || []).filter(f => !f2f[normalizePath(f)])
          var deltaLines = []
          if (missingFeatures.length) deltaLines.push(`  - 未登记功能（需 nav_add_feature）: ${missingFeatures.join(', ')}`)
          if (unregisteredFiles.length) deltaLines.push(`  - 索引外文件（需登记到所属功能，nav_update --field files）: ${unregisteredFiles.join(', ')}`)
        } else if (args.action === 'abort') {
          if (a.status !== 'planned' && a.status !== 'in_progress') return `ERROR: ${a.id} is already "${a.status}".`
          a.status = 'aborted'; a.completedAt = now
        } else {
          return 'ERROR: action must be one of: begin, done, abort.'
        }
        saveActions(root, ledger)
        const lines = [`✓ ${a.id} → ${a.status}: ${a.task}`]
        if (args.action === 'done') {
          lines.push('Delta close-out（合并进索引后本次变更才算同步完成）:')
          if (deltaLines.length) {
            lines.push(...deltaLines)
            lines.push('  修完后跑 nav_sync_docs 对齐 PROJECT.md 功能地图。')
          } else {
            lines.push('  ✓ scope 与索引一致，无缺口。跑 nav_sync_docs 对齐 PROJECT.md 功能地图。')
          }
        }
        return lines.join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: mark')

  // ---- 4. nav_update — sync descriptions / file lists ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_update',
    description: 'Update a field on a feature or module entry in the index. Special field "files" (features only) replaces the feature file list and rebuilds file↔feature mappings.',
    parameters: {
      target: { type: 'string', required: true, description: 'Feature code or module name' },
      field: { type: 'string', required: true, description: 'Field to update: name, userView, systemView, files (feature only), status, or any custom field' },
      value: { type: 'string', required: true, description: 'New value (for "files": comma-separated paths)' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const index = loadIndex(root)
        if (index.indexes?.featureToFiles?.[args.target]) {
          if (args.field === 'files') {
            // Replace file list and rebuild both directions of the mapping.
            const newList = splitList(args.value).map(normalizePath)
            for (const old of index.indexes.featureToFiles[args.target]) {
              const arr = index.indexes.fileToFeature[old]
              if (arr) index.indexes.fileToFeature[old] = arr.filter(c => c !== args.target)
            }
            index.indexes.featureToFiles[args.target] = newList
            for (const f of newList) {
              if (!index.indexes.fileToFeature[f]) index.indexes.fileToFeature[f] = []
              if (!index.indexes.fileToFeature[f].includes(args.target)) index.indexes.fileToFeature[f].push(args.target)
            }
            saveIndex(root, index)
            return `✓ Feature ${args.target} files replaced: ${newList.length} file(s), mappings rebuilt.`
          }
          if (!index.descriptions) index.descriptions = {}
          index.descriptions[args.target] = index.descriptions[args.target] || {}
          index.descriptions[args.target][args.field] = args.value
          index.descriptions[args.target].lastModified = now_()
          saveIndex(root, index)
          return `✓ Updated feature ${args.target}: ${args.field} = "${args.value}"`
        }
        if (index.indexes?.moduleToFeatures?.[args.target]) {
          if (!index.moduleMeta) index.moduleMeta = {}
          index.moduleMeta[args.target] = index.moduleMeta[args.target] || {}
          index.moduleMeta[args.target][args.field] = args.value
          index.moduleMeta[args.target].lastModified = now_()
          saveIndex(root, index)
          return `✓ Updated module ${args.target}: ${args.field} = "${args.value}"`
        }
        return `No feature or module named "${args.target}" found. Use nav_add_feature / nav_add_module to register new entries.`
      } catch (e) { return err(e) }
    }
  })), 'project-nav: update')

  // ---- 5. nav_add_feature ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_add_feature',
    description: 'Register a new feature with code, name, user/system views, and file list. Refuses duplicate codes.',
    parameters: {
      code: { type: 'string', required: true, description: 'Feature code (e.g., PE-F07)' },
      name: { type: 'string', required: true, description: 'Human-readable name' },
      userView: { type: 'string', description: 'User perspective description' },
      systemView: { type: 'string', description: 'System perspective description' },
      files: { type: 'string', description: 'Comma-separated file paths' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const index = loadIndex(root)
        if (index.indexes.featureToFiles[args.code]) {
          return `Feature ${args.code} already exists. Use nav_update to modify it.`
        }
        const fileList = splitList(args.files).map(normalizePath)
        index.indexes.featureToFiles[args.code] = fileList
        for (const file of fileList) {
          if (!index.indexes.fileToFeature[file]) index.indexes.fileToFeature[file] = []
          if (!index.indexes.fileToFeature[file].includes(args.code)) {
            index.indexes.fileToFeature[file].push(args.code)
          }
        }
        index.descriptions[args.code] = {
          name: args.name,
          userView: args.userView || '',
          systemView: args.systemView || '',
          createdAt: now_()
        }
        saveIndex(root, index)
        return `✓ Registered feature ${args.code} "${args.name}" with ${fileList.length} file(s)\n  ⚠ Feature not attached to any module — it will show under "orphan features". Attach via nav_add_module (features=<code>) to place it on the map.`
      } catch (e) { return err(e) }
    }
  })), 'project-nav: add-feature')

  // ---- 6. nav_add_module — complete the write path ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_add_module',
    description: 'Register (or update) a module: list its features, optionally attach it to a project. Completes the module/project write path so coverage metadata is real.',
    parameters: {
      module: { type: 'string', required: true, description: 'Module name (e.g., voice)' },
      features: { type: 'string', description: 'Comma-separated feature codes belonging to this module (empty = create module shell)' },
      project: { type: 'string', description: 'Project name to attach this module to' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const index = loadIndex(root)
        const feats = splitList(args.features)
        // B2: detect existing attachment before mutating, so re-attachment is transparent, not silent
        let attachNote = ''
        if (args.project) {
          const prevOwner = Object.entries(index.indexes.projectToModules || {})
            .find(([proj, mods]) => Array.isArray(mods) && mods.includes(args.module) && proj !== args.project)
          if (prevOwner) {
            attachNote = `\n  ⚠ Module "${args.module}" was already attached to project "${prevOwner[0]}" — it now appears on BOTH projects' maps. If this is a move, re-run nav_add_module with project="${prevOwner[0]}" to detach or update the map.`
          }
        }
        index.indexes.moduleToFeatures[args.module] = feats
        if (args.project) {
          if (!index.indexes.projectToModules[args.project]) index.indexes.projectToModules[args.project] = []
          if (!index.indexes.projectToModules[args.project].includes(args.module)) {
            index.indexes.projectToModules[args.project].push(args.module)
          }
        }
        saveIndex(root, index)
        return `✓ Module ${args.module}: ${feats.length} feature(s)` + (args.project ? `, attached to project ${args.project}` : '') + attachNote
      } catch (e) { return err(e) }
    }
  })), 'project-nav: add-module')

  // ---- 7. nav_add_doc — register a reference doc into the project reference foundation ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_add_doc',
    description: 'Register a reference document (local path, directory, or URL) into the project reference registry. The "when" field is the routing rule: which kinds of tasks must consult this doc. Consulted at plan-confirmation time.',
    parameters: {
      title: { type: 'string', required: true, description: 'Document title (e.g., "DSH 官方插件开发文档")' },
      path: { type: 'string', required: true, description: 'File path, directory, or URL of the doc' },
      when: { type: 'string', required: true, description: 'Task routing rule: keywords/phrases describing which tasks need this doc (e.g., "插件打包, 装载机制, dsh-tools API")' },
      project: { type: 'string', description: 'Project code the doc belongs to (e.g., PN-P01)' },
      tags: { type: 'string', description: 'Comma-separated tags for matching' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const registry = loadDocs(root)
        if (registry.docs.some(d => d.path === args.path)) {
          return `Doc already registered: ${registry.docs.find(d => d.path === args.path).id} (${args.path}). Use nav_docs to list.`
        }
        // B3: fail-closed on local dead links — a reference doc that can't be opened is worse than no doc,
        // because plan-confirmation routing will send the agent to a nonexistent file. URLs are not checked.
        const isUrl = /^https?:\/\//i.test(args.path)
        if (!isUrl && !existsSync(args.path)) {
          return `✗ Path does not exist on disk: ${args.path}\n  Doc NOT registered (dead links are rejected).\n  Fix: check the path for typos, create the file first, or pass an http(s) URL.`
        }
        const doc = {
          id: nextDocId(registry),
          title: args.title,
          path: args.path,
          when: args.when,
          project: args.project || '',
          tags: splitList(args.tags),
          addedAt: new Date().toISOString()
        }
        registry.docs.push(doc)
        saveDocs(root, registry)
        return `✓ Registered ${doc.id} "${doc.title}"\n  → ${doc.path}\n  when: ${doc.when}`
      } catch (e) { return err(e) }
    }
  })), 'project-nav: add-doc')

  // ---- 8. nav_docs — list / find reference docs (the reference foundation) ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_docs',
    description: 'List or find reference documents. No args = full registry. With task = rank docs whose "when" routing rule matches the task. Read/fetch the returned paths yourself as needed.',
    parameters: {
      task: { type: 'string', description: 'Task description to rank relevant docs for' },
      project: { type: 'string', description: 'Filter by project code' },
      tag: { type: 'string', description: 'Filter by tag' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const registry = loadDocs(root)
        let docs = registry.docs || []
        if (args.project) docs = docs.filter(d => d.project === args.project)
        if (args.tag) docs = docs.filter(d => (d.tags || []).includes(args.tag))
        if (docs.length === 0) {
          return 'No reference docs registered. Use nav_add_doc to register them (推荐存放位置：D:\\FF\\refs\\<项目>\\).'
        }
        if (args.task) {
          const ranked = suggestDocs(registry, { taskText: args.task, projects: args.project ? [args.project] : [], modules: [] })
            .filter(d => docs.includes(d))
          if (ranked.length) {
            return [`Docs ranked for task "${args.task}":`, ...ranked.map(d => `  ${d.id} ${d.title}\n    → ${d.path}\n    when: ${d.when}`)].join('\n')
          }
        }
        return [`Reference docs (${docs.length}):`, ...docs.map(d => `  ${d.id} ${d.title}${d.project ? ` [${d.project}]` : ''}\n    → ${d.path}\n    when: ${d.when}`)].join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: docs')

  // ---- 9. nav_map — governance map for humans & agents (text tree / HTML mindmap) ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_map',
    description: 'Render the governance map. format=text: indented project→module→feature→file tree (agent orientation). format=html: self-contained progressive-expansion mindmap file written to disk (human view; open actions marked red, vector in header). Read-only, generated from the index — never hand-edited.',
    parameters: {
      level: { type: 'string', description: 'workspace (default: all projects) | project | module' },
      target: { type: 'string', description: 'Project code/name or module name to zoom into (required for project/module levels)' },
      format: { type: 'string', description: 'text (default) or html' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const index = loadIndex(root)
        const S = scopeTargetsOfOpenActions(loadActions(root))
        const level = args.level || 'workspace'
        const target = args.target || ''
        if ((level === 'project' || level === 'module') && !target) {
          return 'ERROR: level=project/module requires target (project code/name or module name).'
        }
        if (args.format === 'html') {
          const vector = loadVector(root)
          const safe = String(target || 'workspace').replace(/[^A-Za-z0-9_-]+/g, '_')
          const outPath = resolve(root, '.internal', `map-${safe}.html`)
          const html = renderMapHtml(index, {
            title: `Project Nav Map${target ? ` — ${target}` : ''}`,
            vector, openActions: S
          })
          mkdirSync(dirname(outPath), { recursive: true })
          writeFileSync(outPath, html, 'utf-8')
          return `✓ Map generated: ${outPath}\nOpen it in a browser to view the progressive-expansion mindmap. Open actions: ${S.ids.length ? S.ids.join('; ') : 'none'}`
        }
        return renderTreeText(index, { target, openActions: S })
      } catch (e) { return err(e) }
    }
  })), 'project-nav: map')

  // ---- 10. nav_sync_docs — auto-align PROJECT.md feature map from the index ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_sync_docs',
    description: 'Once-Only alignment: regenerate the auto section (between <!-- nav:auto:start/end --> markers) of PROJECT.md from the index. Hand-written narrative outside the markers is never touched. Run after any index change; the marker section must never be hand-edited.',
    parameters: {
      path: { type: 'string', description: 'Target markdown file (default: PROJECT.md at the governed root)' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const docPath = resolve(args.path || root, args.path ? '' : 'PROJECT.md')
        const index = loadIndex(root)
        const vector = loadVector(root)
        const section = renderProjectDocSection(index, { vector })
        let content = ''
        if (existsSync(docPath)) content = readFileSync(docPath, 'utf-8')
        const START = '<!-- nav:auto:start -->'
        const END = '<!-- nav:auto:end -->'
        const s = content.indexOf(START)
        const e = content.indexOf(END)
        if (s !== -1 && e !== -1 && e > s) {
          content = content.slice(0, s) + section + content.slice(e + END.length)
        } else {
          content = (content ? content.replace(/\s*$/, '\n\n') : '') + section + '\n'
        }
        const tmp = docPath + '.tmp'
        writeFileSync(tmp, content, 'utf-8')
        renameSync(tmp, docPath)
        const nProjects = Object.keys(index.indexes?.projectToModules || {}).length
        const nFeatures = Object.keys(index.indexes?.featureToFiles || {}).length
        return `✓ ${docPath} auto-section aligned (source of truth: .internal/nav-index.json)\n  Coverage: ${nProjects} projects, ${nFeatures} features. Narrative content outside markers untouched.`
      } catch (e) { return err(e) }
    }
  })), 'project-nav: sync-docs')

  // ---- 11. nav_status — health + open actions (the drift signal) ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_status',
    description: 'Health snapshot: index totals/coverage, mainline vector, and the OPEN action list — unfinished actions are the project drift signal. Call this before starting any task.',
    parameters: {},
    output: OUTPUT,
    async execute() {
      try {
        const index = loadIndex(root)
        const m = index.metadata || {}
        const vector = loadVector(root)
        const ledger = loadActions(root)
        const registry = loadDocs(root)
        const open = (ledger.actions || []).filter(a => a.status === 'planned' || a.status === 'in_progress')
        const recent = (ledger.actions || []).slice(-5)
        // B1: real disk-drift detection — previously staleEntries/unmappedFiles were dead fields,
        // so files deleted/renamed on disk were invisible. Now actually probe the filesystem.
        let stale = []
        try { stale = findStaleFiles(index, root) } catch { /* drift probe must never break status */ }
        const lines = [
          'Project Nav Status',
          `Root: ${root}`,
          `Index age: ${getIndexAge(root) || 'unknown'}`,
          `Coverage: ${m.coverage || 'unknown'}`,
          `Totals: ${m.totalFeatures ?? '?'} features, ${m.totalFiles ?? '?'} files, ${m.totalModules ?? '?'} modules, ${m.totalProjects ?? '?'} projects`,
          '',
          'Mainline Vector:',
          vector.doing ? `  Doing: ${vector.doing}` : '  Doing: (empty)',
          vector.next ? `  Next: ${vector.next}` : '  Next: (empty)',
          vector.notDoing ? `  Not Doing: ${vector.notDoing}` : '',
          vector.exitCondition ? `  Exit: ${vector.exitCondition}` : '',
          '',
          open.length
            ? `OPEN Actions (${open.length}) — drift signal, finish or abort:\n${open.map(a => `  ${a.id} [${a.status}] ${a.task}`).join('\n')}`
            : 'Open Actions: none',
          stale.length
            ? `STALE Files (${stale.length}) — in index but missing on disk, update or re-register:\n${stale.map(s => `  ${s}`).join('\n')}`
            : 'Stale files: none (index matches disk)',
          `Reference docs: ${(registry.docs || []).length} registered (nav_docs to list, nav_add_doc to register)`,
          '',
          recent.length ? `Recent actions:\n${recent.map(a => `  ${a.id} [${a.status}] ${a.task}`).join('\n')}` : ''
        ].filter(Boolean)
        return lines.join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: status')

  // ---- 8. nav_set_vector — mainline vector (vector.json is the source of truth) ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nav_set_vector',
    description: 'Set the mainline navigation vector (doing / next / notDoing / exitCondition). Omitted fields keep current values. Read fresh from disk by every tool call, so changes take effect immediately.',
    parameters: {
      doing: { type: 'string', description: 'Current focus' },
      next: { type: 'string', description: 'Next action' },
      notDoing: { type: 'string', description: 'Explicit anti-goals' },
      exit: { type: 'string', description: 'Completion criteria' }
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const v = loadVector(root)
        const next = {
          doing: args.doing ?? v.doing ?? '',
          next: args.next ?? v.next ?? '',
          notDoing: args.notDoing ?? v.notDoing ?? '',
          exitCondition: args.exit ?? v.exitCondition ?? ''
        }
        saveVector(root, next)
        return [
          '✓ Mainline vector updated:',
          `  Doing: ${next.doing}`,
          `  Next: ${next.next}`,
          `  Not Doing: ${next.notDoing}`,
          `  Exit: ${next.exitCondition}`
        ].join('\n')
      } catch (e) { return err(e) }
    }
  })), 'project-nav: set-vector')
}

function now_() {
  return new Date().toISOString()
}
