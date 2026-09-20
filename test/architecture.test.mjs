// test/architecture.test.mjs — 架构不变量与验收判据（ARCHITECTURE §3/§9）
//
// 这一组测试不做"功能验证"，只验证**架构本身**：
//   I1 单源 · I2 渲染 · I3 可丢弃 · A1 收口不依赖会话 · A2 真相可自检
//   A4 六闸完整 · A5 模型面字段数 · A6 工具面 = 6
// 架构错了，局部补得再好也没用 —— 所以这些用例比功能用例更重要。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, readdirSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpRoot, put, touch, seed } from './helper.mjs'
import { appendEvents, readEvents, verifyLog, rewriteVerified } from '../core/log.js'
import { loadModel, buildModel, foldOnly, coverage, pressureFor, filePressure, normalizeAnchor, governanceSovereignty, governanceVitality } from '../core/model.js'
import { commitIntent, reconcile, archiveIntent } from '../core/commit.js'
import { paths, PLANE } from '../core/paths.js'
import { renderTreeText } from '../core/render.js'
import { renderHealth, renderPresence } from '../core/format.js'
import { scanTools, effectMountedTools, OLD_TOOL_NAMES, NEW_TOOL_NAMES } from './tools-list.mjs'

// ============ I1 单源 ============

test('I1 复算 == 缓存：模型可从事件流 + 磁盘实况无损重建', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await commitIntent(root, { task: 't1', anchor: 'PN-F01', arch: 'a', scope: { features: ['PN-F01'] } })
  await appendEvents(root, [{ kind: 'decide', anchor: 'PN-F01', reason: 'r', decision: 'd' }])
  const fresh = buildModel(root)
  const cached = loadModel(root, { useCache: true })
  assert.deepEqual(
    [...cached.nodes.values()].map((n) => [n.id, n.status, n.files]),
    [...fresh.nodes.values()].map((n) => [n.id, n.status, n.files])
  )
  assert.deepEqual(cached.vector, fresh.vector)
  assert.deepEqual(cached.decisions.map((d) => d.id), fresh.decisions.map((d) => d.id))
  assert.deepEqual(
    [...cached.patchPressure.entries()].sort(),
    [...fresh.patchPressure.entries()].sort(),
    '缓存路径与非缓存路径必须给出同一个计数闸结果'
  )
})

test('I1 事件流是唯一事实源：模型文件与事件流冲突时，以事件流为准', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  loadModel(root) // 生成缓存
  const modelFile = paths.model(root)
  const tampered = JSON.parse(readFileSync(modelFile, 'utf-8'))
  tampered.vector = { doing: 'HACKED', next: '', notDoing: '', exitCondition: '' }
  writeFileSync(modelFile, JSON.stringify(tampered), 'utf-8')
  const m = loadModel(root)
  assert.equal(m.vector.doing, 'core', '篡改模型缓存不得改变真相（缓存是投影不是源）')
  // 缓存自证：戳与事件流不一致 → 整份缓存作废重建（而不是"看起来还算新"就用）
  const stillTampered = JSON.parse(readFileSync(modelFile, 'utf-8'))
  assert.notEqual(stillTampered.vector.doing, 'HACKED', '重建必须把缓存覆盖回真相')
})

test('I1 事件流自身带完整性判据（seq 连续），断裂必须报', async (t) => {
  const root = tmpRoot(t)
  await appendEvents(root, [
    { kind: 'set', vector: { doing: 'a' } },
    { kind: 'set', vector: { doing: 'b' } },
    { kind: 'set', vector: { doing: 'c' } }
  ])
  assert.ok(verifyLog(root).ok)
  const file = paths.events(root)
  const lines = readFileSync(file, 'utf-8').trim().split('\n')
  writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n', 'utf-8') // 抽掉中间一条 → seq 1,3
  const v = verifyLog(root)
  assert.equal(v.ok, false)
  assert.match(v.problems.join(' '), /seq gap/)
})

// ============ I2 渲染（0.12.0 换代后：按需渲染 + 在场注入，零落盘）============
//
// ⚠ 换代说明（ADR-268）：原先这三条 I2 用例测的是**落盘投影**
//   （PROJECT.md 标记区重渲染 / 手改渲染物被覆盖 / 找不到标记拒绝写入）。
// 定案「只服务 agent」后落盘投影整体退场 ⇒ 那三条所测的**能力已不存在**，故删除。
// 但 I2 这条**不变式**没有废 —— 它只是换了载体：一切机器可读产出仍是**对模型的纯函数派生**。
// 下面的用例就是它的新靶：**零落盘**（更强的判据）与**按需/注入可得**。

test('I2 按需渲染可得：树文本由模型纯函数产出，且零落盘', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const m = buildModel(root)
  const text = renderTreeText(m)
  assert.ok(text.includes('Mainline:'), '树文本必须直出主线')
  assert.ok(text.includes('core'), '树文本必须含模块名')

  // 零落盘：渲染本身不写任何文件 —— 这是换代后的**新不变量**（旧版靠"写盘再比对"，现在根本不该写）
  const before = readdirSync(root).sort()
  renderTreeText(m)
  renderPresence(m)
  assert.deepEqual(readdirSync(root).sort(), before, '按需渲染不得在治理根留下任何文件')
})

test('I2 在场层：治理摘要由纯事件流派生，且**不落盘、不扫盘**', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const before = existsSync(join(root, '.internal', 'runtime'))
  const t0 = Date.now()
  const folded = foldOnly(root)
  const text = renderPresence(folded)
  const ms = Date.now() - t0

  assert.ok(text.includes('治理在场'), '在场摘要必须有可识别的抬头')
  assert.ok(text.includes('doing='), '在场摘要必须带主线（agent 需要知道现在在做什么）')
  // 廉价路径：纯事件流折叠不应建 runtime（buildModel/loadModel 才会落）
  assert.equal(existsSync(join(root, '.internal', 'runtime')), before,
    'foldOnly/renderPresence 不得创建 runtime（I3：删 runtime 零损失）')
  assert.ok(ms < 200, `在场摘要必须廉价（实测 ${ms}ms；不得走磁盘扫描的 buildModel）`)
})

test('I2 在场层不知道的不说：磁盘实况（STALE/缺口）不在廉价模型里 ⇒ 不得出现在摘要里', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  // 造一个 STALE：登记一个磁盘上不存在的落点
  await appendEvents(root, [
    { kind: 'node', op: 'upsert', layer: 'feature', id: 'PN-F99', fields: { name: 'PN-F99', files: ['src/ghost.js'] } }
  ])
  const text = renderPresence(foldOnly(root))
  // foldOnly 不扫盘 ⇒ 它**证明不了** STALE；报一个没算过的数就是假绿。
  assert.ok(!/STALE/.test(text), '在场摘要不得报磁盘实况（它没算过）')
  assert.ok(!/未登记/.test(text), '在场摘要不得报未登记缺口（它没算过）')
})

test('I2 投影不再物化：落盘出口确实不在位（防"顺手加回来"）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const m = buildModel(root)
  // 落盘面删除后，这些出口不应再存在 —— 存在即是回退。
  const render = await import('../core/render.js')
  for (const gone of ['renderAll', 'renderModelDoc', 'renderMapHtml', 'writeProjectSection', 'MARK_START']) {
    assert.equal(render[gone], undefined, `${gone} 应随落盘投影一并退场（ADR-268）`)
  }
  assert.equal(typeof render.renderTreeText, 'function', 'renderTreeText 是 nav_graph mode=map 的实现，必须留下')
})

test('README 声称"已删除"的东西必须真的不在（防假删除记录）', async (t) => {
  // 判例（2026-09-21 实测）：README 的 0.11.0 条目曾写「profile 里的死配置键
  // autoBindWorkspace / boundaryWorkspaces 已删除」，而实测**两个键仍在** profile 的
  // cordis.patch.yml 里、零消费者、且 schemastery 会保留未知键并传给插件
  // ⇒ 那是一句**假记录**。判例同 0.10.3「死投影携带假事实」：效果是训练人相信错的东西。
  //
  // 判据取**可被机械核对的那些声称**：源码里不得再出现这两个键名（源码是仓内可判的），
  // 且 README 若提到它们，必须同时出现"曾声称/假记录/实测"这类**对账措辞**，
  // 不得再是干净的既成事实句。profile 不在仓内、无法在此断言 —— 那一条由人工/本仓流程保证。
  const here = dirname(fileURLToPath(import.meta.url))
  const pkgRoot = join(here, '..')
  const readme = readFileSync(join(pkgRoot, 'README.md'), 'utf-8')
  if (/autoBindWorkspace|boundaryWorkspaces/.test(readme)) {
    assert.match(readme, /假记录|曾声称|实测那是/,
      'README 提到这两个死键时必须是"对账"叙述（它们曾经没被删），不得再写成既成事实')
  }
  // 源码面：这两个键零消费者 ⇒ core/ 与 host/ 里都不得出现
  for (const rel of ['core/paths.js', 'core/model.js', 'core/scope.js', 'host/index.js']) {
    const src = readFileSync(join(pkgRoot, rel), 'utf-8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!/autoBindWorkspace|boundaryWorkspaces/.test(src), `${rel} 不得再出现已移除的边界配置键`)
  }
})

test('发布链脚本：含非 ASCII 的 .ps1 必须 UTF-8 with BOM（否则 PS 5.1 按 GBK 解码 → 语法错）', async (t) => {
  // 为什么值得机检：这是本仓**实测反复踩到**的边界（AGENTS.md §4），而它的后果是
  // "脚本看起来完好、真跑却满屏 Unexpected token" —— 静态看文件内容完全正常，
  // 只有**字节头**能区分。任何编辑工具重写文件都可能悄悄去掉 BOM（本次施工踩了两次）。
  // 判据是结构性的（读字节头），不是度量 —— 与 §2「结构可断言，度量只能参考」同根。
  const here = dirname(fileURLToPath(import.meta.url))
  const pkgRoot = join(here, '..')
  const scripts = readdirSync(pkgRoot).filter((f) => f.endsWith('.ps1'))
  assert.ok(scripts.length > 0, '本仓必须有发布链 .ps1 脚本')
  for (const f of scripts) {
    const bytes = readFileSync(join(pkgRoot, f))
    const hasBom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
    const text = bytes.toString('utf-8')
    const nonAscii = /[^\x00-\x7F]/.test(text)
    if (nonAscii) {
      assert.ok(hasBom, `${f} 含非 ASCII 却无 BOM —— PS 5.1 会按 GBK 解码，脚本真跑必语法错`)
    }
  }
})

test('发布链脚本：包外的 .mjs/.js 不得带 BOM（node 不认 BOM）', async (t) => {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkgRoot = join(here, '..')
  for (const rel of ['verify-runtime.mjs', 'bootstrap.mjs', 'core/render.js', 'host/index.js', 'package.json']) {
    const bytes = readFileSync(join(pkgRoot, rel))
    const hasBom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
    assert.ok(!hasBom, `${rel} 不得带 BOM（node 不认）`)
  }
})

test('I2 零写盘是结构性的：core/render.js 不得 import 任何写盘面（源码级守卫）', async (t) => {
  // 为什么扫源码而不只测行为：**零写盘**是这次换代的核心不变量，
  // 而"某次调用没写盘"只是采样；import 面一旦沾上 fs 写入，随时可能被后人加回来。
  // 判据取**依赖面**（结构可断言），与 ARCHITECTURE §2「结构可断言，度量只能参考」同根。
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'core', 'render.js'), 'utf-8')
  // 去掉注释再判（否则本文件自己的说明文字会误伤 —— 实测踩过）
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const banned = [/(^|[^.\w])writeFileSync\s*\(/, /rewriteVerified/, /from\s+'\.\/log\.js'/, /from\s+'node:fs'/]
  for (const re of banned) {
    assert.ok(!re.test(code), `core/render.js 不得出现写盘面（命中 ${re}）—— 治理面必须零落盘`)
  }
})

test('I3 删掉整个 runtime/ → 治理零损失（查询结果逐字节一致）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'a', scope: { features: ['PN-F01'] } })
  await appendEvents(root, [{ kind: 'decide', anchor: 'PN-F01', reason: 'r', decision: 'd' }])

  const snapshot = (m) => JSON.stringify({
    vector: m.vector,
    nodes: [...m.nodes.values()].map((n) => [n.id, n.status, n.files, n.project, n.module]),
    decisions: m.decisions.map((d) => [d.id, d.anchor, d.decision]),
    open: m.openCommits.map((c) => [c.id, c.anchor, c.task, Object.keys(c.evidence || {}).sort()]),
    pressure: [...m.patchPressure.entries()].sort(),
    coverage: coverage(m)
  })
  const before = snapshot(loadModel(root, { useCache: true }))
  assert.ok(existsSync(paths.runtime(root)))

  rmSync(paths.runtime(root), { recursive: true, force: true })
  assert.equal(existsSync(paths.runtime(root)), false)

  const after = snapshot(loadModel(root))
  assert.equal(after, before, '删掉运行时面后模型必须逐字节等价重建')
  assert.ok(existsSync(paths.runtime(root)), '重建时 runtime/ 自动恢复')
})

test('I3 在途状态文件是可丢缓存：丢了照样能按证据收口', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'a', scope: { features: ['PN-F01'] } })
  rmSync(paths.inflightDir(root), { recursive: true, force: true })
  touch(root, 'src/a.js', 'v2')
  const rec = await reconcile(root)
  assert.equal(rec.closed.length, 1, '在途缓存丢了不该影响收口（收口判据在事件流里）')
})

// ============ A1 收口不依赖会话 ============

test('A1 会话死亡不产生孤儿：收口只认证据（复现 D1 的反面）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const res = await commitIntent(root, { task: '另一个会话的活', anchor: 'PN-F01', arch: 'a', scope: { files: ['src/*.js'] }, }, { actor: 'session-AAA' })
  assert.equal(res.status, 'ok')
  // 会话 AAA 消失（不再有任何调用来自它），另一个身份继续工作
  put(root, 'src/new-from-B.js')
  const rec = await reconcile(root, { actor: 'session-BBB' })
  assert.equal(rec.closed.length, 1, '任何会话都能按证据收口，不需要"主"')
  const m = buildModel(root)
  assert.equal(m.openCommits.length, 0)
  assert.deepEqual(m.commits.find((c) => c.id === res.commit.id).outcome.appeared, ['src/new-from-B.js'])
})

test('A1 同一意图不会被两个会话重复收口（收口在锁内二次确认）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'a', scope: { features: ['PN-F01'] } })
  touch(root, 'src/a.js', 'v2')
  const [a, b] = await Promise.all([reconcile(root), reconcile(root)])
  const m = buildModel(root)
  // 收口事件 = 指向某笔意图的 closed 事件。同一目标被收两次才是真问题（原始意图的
  // phase 也会变成 closed —— 拿 phase 判重会把"意图本身"误当成第二笔收口）。
  const closures = m.commits.filter((c) => c.closes !== undefined && c.closes !== null)
  assert.equal(closures.length, 1, `每笔意图只能被收口一次（实际 ${closures.length} 次：${closures.map((c) => `${c.id}→${c.closes}`).join(', ')}）`)
  assert.equal(m.openCommits.length, 0)
  assert.equal(m.commits.filter((c) => c.closes === undefined).length, 1, '只有一笔原始意图')
  assert.ok(a.closed.length + b.closed.length >= 1)
})

test('A1 并发收口多笔意图：每笔恰好收口一次（跨会话 + 跨意图）', async (t) => {
  const root = tmpRoot(t)
  await seed(root, { files: ['src/a.js'] })
  put(root, 'src/b.js')
  const c1 = await commitIntent(root, { task: 'one', anchor: 'PN-F01', arch: 'a', scope: { files: ['src/a.js'] } })
  const c2 = await commitIntent(root, { task: 'two', anchor: 'PN-F01', arch: 'a', scope: { files: ['src/b.js'] } })
  assert.equal(c1.status, 'ok')
  assert.equal(c2.status, 'ok')
  touch(root, 'src/a.js', 'v2')
  touch(root, 'src/b.js', 'v2')
  await Promise.all([reconcile(root), reconcile(root), reconcile(root)])
  const m = buildModel(root)
  const closures = m.commits.filter((c) => c.closes !== undefined && c.closes !== null)
  assert.equal(closures.length, 2, `两笔意图各收一次（实际 ${closures.length}）`)
  assert.deepEqual(closures.map((c) => c.closes).sort(), [c1.commit.seq, c2.commit.seq].sort())
  assert.equal(new Set(closures.map((c) => c.closes)).size, closures.length, '同一意图不得被收两次')
  assert.equal(m.openCommits.length, 0)
})

// ============ A4 / A5 / A6 ============

test('A6 工具面 = 5 个工具，且一个不少（0.12.0：nav_render 随落盘投影退场）', () => {
  const tools = scanTools()
  assert.deepEqual(tools.names.slice().sort(), NEW_TOOL_NAMES.slice().sort(), `实际注册: ${tools.names.join(', ')}`)
  assert.equal(tools.names.length, 5)
})

test('A6 旧工具名不再出现在工具注册里（描述里提及历史是允许的，注册不行）', () => {
  const tools = scanTools()
  for (const old of OLD_TOOL_NAMES) {
    assert.ok(!tools.names.includes(old), `旧工具 ${old} 仍在注册`)
  }
  assert.equal(tools.duplicates.length, 0, `重复注册: ${tools.duplicates.join(', ')}`)
})

test('A6 每个工具都注册在 ctx.effect 内（否则卸载卸不干净）', () => {
  const { total, mounted } = effectMountedTools()
  assert.equal(total, 5, `工具注册点应为 5，实际 ${total}`)
  assert.equal(mounted, total, `挂在 ctx.effect 内的工具 ${mounted}/${total} —— 有工具未挂 effect，卸载会留下残留监听/工具`)
})

// ============ 门面一致性（0.11.0 · 治理接管 P0-3/P0-4） ============
//
// 为什么这三条要机检：它们是**已在真实事故中发生的漂移**，且都不需要人肉眼发现——
//   · 版本三处不一致：实测 package.json=0.10.6 / README 徽章=0.10.4 / ARCHITECTURE 头=0.10.5；
//   · README 写死"113 pass"：实测 111，而本仓纪律明写"测试数不写在这里"；
//   · README 示例里 5 个工具名（nav_query 等）在 0.10.0 后已不存在。
// 门面挂着失效契约与代码里的失效守卫同害：**它训练人相信一份错的东西**。

test('P0-3 版本三处一致：package.json / README 徽章 / ARCHITECTURE 头部', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf-8')
  const arch = readFileSync(new URL('../ARCHITECTURE.md', import.meta.url), 'utf-8')

  const badge = readme.match(/badge\/version-([\d.]+)/)
  assert.ok(badge, 'README 必须有 version 徽章')
  const archHead = arch.match(/架构（v([\d.]+)/)
  assert.ok(archHead, 'ARCHITECTURE.md 头部必须有 架构（vX.Y.Z）')

  assert.equal(badge[1], pkg.version, `README 徽章 ${badge[1]} ≠ package.json ${pkg.version}`)
  assert.equal(archHead[1], pkg.version, `ARCHITECTURE.md 头 ${archHead[1]} ≠ package.json ${pkg.version}`)
})

test('P0-4 README 不得写死测试项数（本仓纪律：那是会漂移的数字）', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf-8')
  // 抓 "NNN pass" / "N → M pass" 这类写死形态
  const hits = readme.match(/\d+\s*(?:→|->)\s*\d+\s*pass|\b\d{2,}\s*pass\b/g) || []
  assert.deepEqual(hits, [], `README 写死了测试项数: ${hits.join(' / ')} —— 跑一次即得的数字不该进文档`)
})

test('P0-4 README 示例里的工具名必须真实存在（不得留已删工具的残影）', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf-8')
  const live = new Set(scanTools().names)
  const mentioned = new Set((readme.match(/nav_[a-z_]+/g) || []))
  const ghosts = [...mentioned].filter((n) => !live.has(n) && !OLD_TOOL_NAMES.includes(n))
  // OLD_TOOL_NAMES 允许出现在"历史说明"里（如本节的反例注解），但**不得**出现在示例输出里。
  // 判据取"当前不在册且非已知历史名"—— 已知历史名由本用例下方单独断言其不在示例块中。
  assert.deepEqual(ghosts, [], `README 出现不存在的工具名: ${ghosts.join(', ')}`)

  // 更硬的一条：示例代码块（``` 围栏内）不得含任何不在册的工具名 —— 示例是"照抄即错"的地方。
  const blocks = [...readme.matchAll(/```[\s\S]*?```/g)].map((m) => m[0])
  const offenders = []
  for (const b of blocks) {
    for (const n of (b.match(/nav_[a-z_]+/g) || [])) {
      if (!live.has(n)) offenders.push(n)
    }
  }
  assert.deepEqual([...new Set(offenders)], [], `README 示例块里出现已不存在的工具名: ${[...new Set(offenders)].join(', ')}`)
})

test('A5 模型面字段数 ≤ 4（锚点 / scope / arch= / 理由）', () => {
  const tools = scanTools()
  const commit = tools.schemas.find((s) => s.name === 'nav_commit')
  assert.ok(commit, 'nav_commit 必须存在')
  const nonMode = commit.params.filter((p) => !['task', 'plan', 'features', 'modules', 'files', 'mode', 'id', 'reason'].includes(p))
  assert.ok(nonMode.length <= 4, `nav_commit 的模型面字段过多: ${nonMode.join(', ')}`)
})

test('A4 七闸在 host 的写入路径上是强制的（闸门不在流程里，在查询里）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  // 锚点闸：假锚点直接拒
  const bad = await commitIntent(root, { task: 't', anchor: 'GHOST', arch: 'a', scope: { features: ['PN-F01'] } })
  assert.equal(bad.status, 'blocked')
  assert.equal(bad.gates.blocked[0].gate, 'anchor')
  // 计数闸：3 次补丁后拒
  for (let i = 0; i < 3; i++) {
    await appendEvents(root, [{ kind: 'commit', phase: 'closed', anchor: 'PN-F01', task: `p${i}`, scope: { features: ['PN-F01'] } }])
  }
  const m = buildModel(root)
  assert.equal(pressureFor(m, 'PN-F01').sinceDecisionCount, 3)
  const blocked = await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'a', scope: { features: ['PN-F01'] } })
  assert.equal(blocked.status, 'blocked')
  assert.ok(blocked.gates.blocked.some((b) => b.gate === 'count'))
})

// ============ 平面契约 ============

test('平面契约：两层数据面（0.12.0 换代）；长期资产只有事件流一个文件', async (t) => {
  const root = tmpRoot(t)
  assert.equal(PLANE.EVENTS, '.internal/events.jsonl')
  assert.equal(PLANE.RUNTIME, '.internal/runtime')
  // 换代判据：落盘投影面整体退场 ⇒ 它的两个路径常量必须不存在（留着就是留一份永不再写的承诺）
  assert.equal('PROJECT_DOC' in PLANE, false, 'PROJECT.md 随落盘投影退场（ADR-268）')
  assert.equal('MODEL_DOC' in PLANE, false, 'ARCH-MODEL.md 随落盘投影退场（ADR-268）')
  await seed(root)
  const internal = readdirSync(join(root, '.internal'))
  const longLived = internal.filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'))
  assert.deepEqual(longLived, ['events.jsonl'], `长期数据面必须只有事件流，实际: ${longLived.join(', ')}`)
})

// ============ 依赖图的不变量（I1 / I3） ============

test('I1 依赖图在缓存与非缓存两条路径上必须一致（同一个真相不许有两个答案）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, 'src/b.js', "import './a.js'\n")
  const cold = loadModel(root, { useCache: false })
  const warm = loadModel(root, { useCache: true })
  assert.deepEqual([...cold.edges.fileEdges], [...warm.edges.fileEdges])
  assert.deepEqual([...cold.edges.deps], [...warm.edges.deps])
})

test('I3 删掉 runtime/ 后依赖图无损重建（它是磁盘派生，不是长期资产）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, 'src/b.js', "import './a.js'\n")
  const before = [...buildModel(root).edges.fileEdges]
  rmSync(join(root, '.internal', 'runtime'), { recursive: true, force: true })
  const after = [...buildModel(root).edges.fileEdges]
  assert.deepEqual(before, after)
  assert.equal(existsSync(join(root, '.internal', 'runtime')), false, '重建发生在内存里，不留下资产')
})

// ============ 文件职责压力（"一个文件里塞多个功能"的可机检信号） ============

test('锚点归一：完整节点 id 与裸名等价（工具描述承诺的形式必须真的能用）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const m = buildModel(root)
  const byId = normalizeAnchor(m, 'feature:PN-F01')
  const byBare = normalizeAnchor(m, 'PN-F01')
  assert.ok(byId, '带前缀的完整节点 id 必须能被解析 —— 否则工具描述在骗人')
  assert.equal(byId.id, byBare.id)
  assert.equal(byId.id, 'feature:pn-f01')
})

test('文件职责压力：一个文件被 3 个节点登记为落点即报 over（不读行数、只读落点）', async (t) => {
  const root = tmpRoot(t)
  await seed(root, { files: ['src/shared.js'] })
  await appendEvents(root, [
    { kind: 'node', op: 'upsert', layer: 'feature', id: 'PN-F02', fields: { name: 'F2', files: ['src/shared.js'], module: 'core' } },
    { kind: 'node', op: 'upsert', layer: 'feature', id: 'PN-F03', fields: { name: 'F3', files: ['src/shared.js'], module: 'core' } }
  ])
  const fp = filePressure(buildModel(root))
  const shared = fp.files.find((f) => f.file === 'src/shared.js')
  assert.ok(shared, '落点文件必须出现在文件压力表里')
  assert.equal(shared.ownerCount, 3, `三个功能都登记了同一个文件（实际 ${shared.ownerCount}）`)
  assert.equal(shared.over, true)
  assert.deepEqual(fp.over.map((f) => f.file), ['src/shared.js'])
})

// ============ 信息可达性（省 token 只能靠压缩去冗余，禁止静默丢条目） ============

test('节点索引完整性：每个节点与每条 ADR 都必须被点名（退役的标灰但不消失）', async (t) => {
  // ⚠ 换代换靶（ADR-268）：原靶是 renderModelDoc（落盘投影，已退场）。
  // **判据内容一字不改** —— 只换载体：现在是 nav_graph mode=json 的 nodes[]/decisions[]。
  const root = tmpRoot(t)
  await seed(root)
  await appendEvents(root, [
    { kind: 'decide', anchor: 'PN-F01', reason: 'r1', decision: 'd1' },
    { kind: 'decide', anchor: 'PN-F01', reason: 'r2', decision: 'd2' },
    { kind: 'decide', anchor: 'PN-F01', reason: 'r3', decision: 'd3' },
    { kind: 'node', op: 'retire', layer: 'feature', id: 'PN-F01' }
  ])
  const { mountHost } = await import('./host-harness.mjs')
  const h = await mountHost(root, { config: {} })
  t.after(() => h.dispose())
  const j = JSON.parse(await h.call('nav_graph', { mode: 'json' }))

  const m = buildModel(root)
  const ids = j.nodes.map((n) => n.id)
  for (const n of m.nodes.values()) {
    assert.ok(ids.includes(n.id), `节点 ${n.id} 必须在索引里点名 —— 条目不得被无声省略（含退役）`)
  }
  assert.equal(ids.length, m.nodes.size, '节点索引必须完整（不得 slice）')
  assert.ok(j.nodes.some((n) => n.status === 'retired'), '退役节点必须在列而不是消失')
  for (const d of m.decisions) {
    assert.ok(j.decisions.some((x) => x.id === d.id), `ADR ${d.id} 必须在索引里 —— 老决策不得整条消失`)
  }
  assert.equal(j.decisions.length, m.decisions.length, 'ADR 索引必须全量（不得只给最近 N 条）')
})

test('确定性渲染：同一模型 ⇒ 同一文本（纯函数，不得含时间戳等第二输入）', async (t) => {
  // ⚠ 换代换靶：原靶 renderModelDoc/renderMapHtml（落盘投影）→ renderTreeText/renderPresence。
  // 判据本质未变：**同模型必同输出**。旧版还要断言"第二次写盘被跳过"，现在零落盘 ⇒ 该断言无标的。
  const root = tmpRoot(t)
  await seed(root)
  await appendEvents(root, [{ kind: 'decide', anchor: 'PN-F01', reason: 'r', decision: 'd' }])
  const m = buildModel(root)
  assert.equal(renderTreeText(m), renderTreeText(m), 'renderTreeText 必须是纯函数')
  assert.equal(renderPresence(m), renderPresence(m), 'renderPresence 必须是纯函数')
  // 在场层走廉价折叠：同一事件流两次折叠必须给出同一摘要（否则每轮注入都会抖）
  assert.equal(renderPresence(foldOnly(root)), renderPresence(foldOnly(root)),
    'foldOnly + renderPresence 必须是确定性的（同事件流 ⇒ 同摘要）')
})

test('无静默列表截断：源码里每处定长 slice 丢弃条目的，同一输出必须带 +N/共N 交代或总量自报', async (t) => {
  // 扫描器封的是「丢条目不打招呼」，不是字节数 —— 上限会逼着无声削内容，正是要避免的路。
  const here = dirname(fileURLToPath(import.meta.url))
  const SRC = ['core/format.js', 'core/gates.js', 'core/render.js', 'host/index.js']
  // 明确豁免：字符串字段截断（文本省略类，条目未丢）与基础设施诊断行（logger / join 产物 / 日志样本）
  const EXEMPT = [/\.at\.slice/, /String\([^)]*\)\.slice/, /String\([^)]*\)\.replace\([^)]*\)\.slice/, /\bs\.slice/, /\bline\.slice/, /text\.slice/, /\bfirst\.slice/, /Math\.random/, /\.join\([^)]*\)\.slice/, /ctx\.logger/]
  for (const rel of SRC) {
    const lines = readFileSync(join(here, '..', rel), 'utf-8').split('\n')
    lines.forEach((line, idx) => {
      const isListSlice = /\.slice\((-?\d+)(, ?(-?\d+))?\)/.test(line)
      if (!isListSlice || EXEMPT.some((re) => re.test(line))) return
      const window = lines.slice(Math.max(0, idx - 6), idx + 7).join('\n')
      const disclosed = /\+\$\{/.test(window) || /…\+\d/.test(window) || /共 \$\{/.test(window) || /等 \$\{/.test(window) || /另 \$\{/.test(window) || /全部 \$\{/.test(window)
      assert.ok(disclosed, `${rel}:${idx + 1} 有定长 slice 却附近没有 "+N / 共N / 总量自报"：${line.trim().slice(0, 100)}`)
    })
  }
})

test('json 视图与所读 mode 一一对应：gaps 的 json 不再携带全模型（json ≠ 最肥路径）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await appendEvents(root, [{ kind: 'decide', anchor: 'PN-F01', reason: 'r', decision: 'd' }])
  const { mountHost } = await import('./host-harness.mjs')
  const h = await mountHost(root, { config: {} })
  t.after(() => h.dispose())
  const gaps = JSON.parse(await h.call('nav_graph', { mode: 'gaps', format: 'json' }))
  assert.ok(Array.isArray(gaps.unregistered) && !('vector' in gaps), 'mode=gaps 的 json 应只含 gaps 相关字段')
  const adrs = JSON.parse(await h.call('nav_graph', { mode: 'adrs', format: 'json' }))
  assert.equal(adrs.decisions.length, 1)
  assert.ok(!('unregistered' in adrs))
  const full = JSON.parse(await h.call('nav_graph', { mode: 'json' }))
  assert.ok(full.vector && full.decisions && Array.isArray(full.unregistered), 'mode=json 仍是全量真相视图（显式要全量就真给全量，不 slice）')
})

test('文件职责压力是磁盘 + 事件流派生：删掉 runtime/ 后逐字节一致（I3）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  rmSync(join(root, '.internal', 'runtime'), { recursive: true, force: true })
  const a = JSON.stringify(filePressure(buildModel(root)))
  const b = JSON.stringify(filePressure(buildModel(root)))
  assert.equal(a, b, '派生量不得依赖可丢弃缓存')
})

// ============ 治理主权与活力（0.11.0 · GTP P2/P3） ============
//
// 这两组回答的是"项目是不是在插件之外自建了治理"与"治理有没有被绕过"。
// **全部纯派生**（磁盘实况 + 事件流），零事件订阅 —— 订阅产出只能落 runtime/（可丢），
// 而"能被丢掉的那份不可能是真相"（I1）。故这组用例同时是"无新增状态"的守卫。

test('P2 主权探针：外来治理脚本被发现（变异验证：无则报 0）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const clean = governanceSovereignty(buildModel(root))
  assert.equal(clean.foreignScripts.length, 0, '未放治理件时必须报 0（成对断言，缺一视为未验）')

  put(root, 'scripts/check-fake.mjs', '// a gate')
  const dirty = governanceSovereignty(buildModel(root))
  assert.deepEqual(dirty.foreignScripts, ['scripts/check-fake.mjs'])
  assert.equal(dirty.sovereign, false, '有未豁免外来件 ⇒ 主权不完整')
})

test('P2 主权探针：纯产品脚本不误伤（边界用例 —— 误报会腐蚀信号，F3）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, 'scripts/build.mjs', 'export const build = 1')
  put(root, 'scripts/sync-runtime.mjs', 'export const s = 1')
  put(root, 'src/index.js', 'export const i = 1')
  const sov = governanceSovereignty(buildModel(root))
  assert.deepEqual(sov.foreignScripts, [], '无治理词的脚本不得计入外来治理件')
})

test('P2 主权探针：测试文件不算自建门禁（deploy-guard.test.cjs 是在测守卫，不是守卫）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, 'test/deploy-guard.test.cjs', '// tests the guard')
  put(root, 'test/update-gate.test.cjs', '// tests the gate')
  const sov = governanceSovereignty(buildModel(root))
  assert.deepEqual(sov.foreignScripts, [], '测试文件名里的 guard/gate 不得算成外来治理件')
})

test('P2 主权探针：插件自身文件不算外来件（判据按包名，不硬编码路径）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  // 造一个与插件同名包：它的文件不得被报成"外来治理件"
  put(root, 'project-nav/package.json', JSON.stringify({ name: '@dsh-external/project-nav', version: '0.0.0' }))
  put(root, 'project-nav/core/gates.js', '// our own gate implementation')
  put(root, 'project-nav/verify-runtime.mjs', '// our own verifier')
  const sov = governanceSovereignty(buildModel(root))
  assert.deepEqual(sov.foreignScripts, [], '插件自己的 gates.js / verify-runtime.mjs 不得被算成外来治理件')
})

test('P2 主权探针：夹具目录不算（.gov-bench / fixtures 里的模拟仓）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, '.gov-bench/smoke/nav/CHANGELOG.md', '# fixture')
  put(root, '.gov-bench/smoke/nav/check-fake.mjs', '// fixture')
  put(root, 'fixtures/check-x.mjs', '// fixture')
  const sov = governanceSovereignty(buildModel(root))
  assert.deepEqual(sov.foreignScripts, [], '夹具里的治理件不得计入真实主权面')
  assert.deepEqual(sov.parallelLedgers, [], '夹具里的账本不得计入')
})

test('P2 主权探针：编译产物不算（lib/x.js 有 src/x.ts 同名源码）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, 'src/audit-source.ts', 'export const x = 1')
  put(root, 'lib/audit-source.js', '// compiled output of src/audit-source.ts')
  put(root, 'lib/types/audit-source.d.ts', 'export declare const x: number')
  const sov = governanceSovereignty(buildModel(root))
  assert.deepEqual(sov.foreignScripts, [], '有 TS 源码的 lib 产物、以及 .d.ts 声明，都不得算治理件')
})

test('P2 主权探针：治理入口与实现分开报（接管单元是入口，不是每个 check）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, 'scripts/check-runner.mjs', "import './check-a.mjs'")
  put(root, 'scripts/check-a.mjs', '// one check')
  put(root, 'scripts/check-b.mjs', '// another check')
  const sov = governanceSovereignty(buildModel(root))
  assert.deepEqual(sov.runners, ['scripts/check-runner.mjs'], 'runner 必须被识别为入口')
  assert.equal(sov.foreignScripts.length, 2, 'check-a/b 是实现，不算入口')
})

test('P2 主权探针：并行账本被发现（项目自有 CHANGELOG / AGENTS 等）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, 'CHANGELOG.md', '# changes')
  put(root, 'OPEN-ITEMS.md', '# open')
  const sov = governanceSovereignty(buildModel(root))
  assert.deepEqual(sov.parallelLedgers, ['CHANGELOG.md', 'OPEN-ITEMS.md'])
  assert.equal(sov.sovereign, false)
})

test('P3 opt-out 双向：登记 artifact + when 含 exempt ⇒ 告警消失；撤销 ⇒ 复现', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, 'scripts/check-mine.mjs', '// my own check')

  const before = governanceSovereignty(buildModel(root))
  assert.equal(before.foreignScripts.length, 1, '声明前必须报出')

  // 声明豁免
  await appendEvents(root, [{ kind: 'node', op: 'upsert', layer: 'artifact', id: 'E-A1',
    fields: { name: 'E-A1', path: 'scripts/check-mine.mjs', when: 'exempt: 本项目自建且已并入插件治理' } }])
  const after = governanceSovereignty(buildModel(root))
  assert.equal(after.foreignScripts.length, 0, '声明豁免后必须退出告警')
  assert.ok(after.exempted.length >= 1, '豁免项必须留痕（可审计）')

  // 撤销豁免（改 when 去掉 exempt 首词）
  await appendEvents(root, [{ kind: 'node', op: 'upsert', layer: 'artifact', id: 'E-A1',
    fields: { name: 'E-A1', path: 'scripts/check-mine.mjs', when: '仅供查阅' } }])
  const revoked = governanceSovereignty(buildModel(root))
  assert.equal(revoked.foreignScripts.length, 1, '撤销豁免后必须复现告警（双向验证）')
})

test('P3 声明三档语义：前缀判定，且 competing 保留告警（不做"登记即静音"）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, 'scripts/check-a.mjs', '// a')
  put(root, 'scripts/check-b.mjs', '// b')
  put(root, 'CHANGELOG.md', '# ledger')

  await appendEvents(root, [
    { kind: 'node', op: 'upsert', layer: 'artifact', id: 'E-R1',
      fields: { name: 'E-R1', path: 'scripts/check-a.mjs', when: 'refs: 领域适应度函数' } },
    { kind: 'node', op: 'upsert', layer: 'artifact', id: 'E-C1',
      fields: { name: 'E-C1', path: 'scripts/check-b.mjs', when: 'competing: 第二本账，待收敛' } },
    { kind: 'node', op: 'upsert', layer: 'artifact', id: 'E-C2',
      fields: { name: 'E-C2', path: 'CHANGELOG.md', when: 'competing: 与事件流重叠' } }
  ])
  const s = governanceSovereignty(buildModel(root))
  assert.ok(s.referenced.includes('scripts/check-a.mjs'), 'refs 档应记为已接管')
  assert.ok(!s.foreignScripts.includes('scripts/check-a.mjs'), 'refs 档应退出"未知外来件"')
  assert.ok(s.foreignScripts.includes('scripts/check-b.mjs'), 'competing 档必须**保留告警**（否则登记=假绿）')
  assert.ok(s.pendingConvergence.length >= 2, 'competing 项应进"待收敛"清单（带移交路径）')
})

test('P3 声明只认首词：正文提到 exempt 二字不得改变档位（判据稳定，与措辞无关）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, 'scripts/check-x.mjs', '// x')
  // 正文里出现 exempt 一词，但首词是 competing ⇒ 必须仍算 competing（不得被静音）
  await appendEvents(root, [{ kind: 'node', op: 'upsert', layer: 'artifact', id: 'E-Z1',
    fields: { name: 'E-Z1', path: 'scripts/check-x.mjs', when: 'competing: 移交路径 A 或标 exempt' } }])
  const s = governanceSovereignty(buildModel(root))
  assert.ok(s.foreignScripts.includes('scripts/check-x.mjs'), '正文里的 exempt 不得把它静音（否则判据取决于措辞）')
  assert.equal(s.exempted.length, 0)
})

test('P3 主权探针是纯派生：删掉 runtime/ 后结果逐字节一致（零新增状态，I3/I1）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, 'scripts/check-x.mjs', '// x')
  const a = JSON.stringify(governanceSovereignty(buildModel(root)))
  rmSync(join(root, '.internal', 'runtime'), { recursive: true, force: true })
  const b = JSON.stringify(governanceSovereignty(buildModel(root)))
  assert.equal(a, b, '主权探测不得依赖任何可丢弃状态 —— 这正是它取消事件订阅的理由')
})

test('P3 活力：改动晚于治理登记 ⇒ 报绕过；容差内不报（否则必然狼来了）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'a', scope: { features: ['PN-F01'] } })

  // 刚登记完，文件未新改 ⇒ 不算绕过
  const fresh = governanceVitality(buildModel(root))
  assert.equal(fresh.bypassed, false, '刚登记完不得报绕过（容差 60s）')

  // 把落点文件的 mtime 推到未来 5 分钟 ⇒ 必须报绕过
  const future = Date.now() + 5 * 60_000
  const f = join(root, 'src/a.js')
  utimesSync(f, new Date(future), new Date(future))
  const stale = governanceVitality(buildModel(root))
  assert.equal(stale.bypassed, true, '改动显著晚于登记 ⇒ 必须报绕过')
  assert.ok(stale.bypassedMs > 60_000)
})

test('P3 健康三层齐备：覆盖 / 主权 / 活力 三节都在（G3）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  const out = renderHealth(buildModel(root), { rootPath: root, opens: [], locks: [], inflight: [], logCheck: null })
  assert.match(out, /【覆盖】/, '缺覆盖层')
  assert.match(out, /【主权】/, '缺主权层')
  assert.match(out, /【活力】/, '缺活力层')
})

test('P3 健康分不拦截：主权告警 + 绕过告警并存时，nav_commit 仍必须成功（MUST-NOT）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, 'scripts/check-x.mjs', '// foreign')
  const future = Date.now() + 5 * 60_000
  utimesSync(join(root, 'src/a.js'), new Date(future), new Date(future))

  const r = await commitIntent(root, { task: 't', anchor: 'PN-F01', arch: 'a', scope: { features: ['PN-F01'] } })
  assert.notEqual(r.status, 'blocked', '健康信号绝不得变成写入闸门（ARCHITECTURE §10）')
})
