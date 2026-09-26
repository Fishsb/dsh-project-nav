// test/architecture.test.mjs — 架构不变量与验收判据（ARCHITECTURE §3/§9）
//
// 这一组测试不做"功能验证"，只验证**架构本身**：
//   I1 单源 · I2 渲染 · I3 可丢弃 · A1 收口不依赖会话 · A2 真相可自检
//   A4 七闸完整 · A5 模型面字段数 · A6 工具面 = 5（数字以同文件断言为准，跑一次即得）
// 架构错了，局部补得再好也没用 —— 所以这些用例比功能用例更重要。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, readdirSync, utimesSync, chmodSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { tmpRoot, put, touch, seed, snapshotTree, armSnapshotProbe } from './helper.mjs'
import { appendEvents, readEvents, verifyLog, rewriteVerified, EVENT_KINDS } from '../core/log.js'
import { loadModel, buildModel, foldOnly, coverage, pressureFor, filePressure, normalizeAnchor, governanceSovereignty, governanceVitality } from '../core/model.js'
import { evidenceOf, diffEvidence } from '../core/scope.js'
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
  // ① 武装自证必须**先于**被测判据：先证明快照真能发现新写入，再拿它去判在场层。
  armSnapshotProbe()
  // ② 顺序硬约束：seed 的 appendEvents 走 withLock，**必然**建出 .internal/runtime/locks
  //    —— 那是合法写入，不属在场层。故快照只能取在 seed **之后**、在场调用**之前**；
  //    若取在 seed 之前，快照把锁建目录一起算作"在场层新增"，判据会红在错误的地方。
  await seed(root)
  const snap = () => snapshotTree(join(root, '.internal'))
  // 取证（不是断言）：seed 之后是**非空**树 —— 下面比对的绝不是"空集比空集"。
  console.log('  [在场层零落盘] 在场调用前 .internal 快照 = ' + JSON.stringify(snap()))
  const before = snap()
  const t0 = Date.now()
  const folded = foldOnly(root)
  const text = renderPresence(folded)
  const ms = Date.now() - t0

  assert.ok(text.includes('治理在场'), '在场摘要必须有可识别的抬头')
  assert.ok(text.includes('doing='), '在场摘要必须带主线（agent 需要知道现在在做什么）')
  // 廉价路径 + 零落盘：纯事件流折叠不得新增**目录或文件**（buildModel/loadModel 才会落）
  // ⚠ 判据是「在场层这一步没有新增」，不是「runtime/ 不存在」—— 后者恒假，见上。
  assert.deepEqual(snap(), before,
    'foldOnly/renderPresence 不得新建任何目录或文件（I2 治理面零落盘；含 runtime 缓存）')
  assert.ok(existsSync(join(root, '.internal', 'runtime')), '前置事实：seed 已建 runtime（本判据的比对基线非空）')
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
  // ⚠ 判据形态在 2026-09-25 由「按名字」换成「按结构」—— 旧版硬编码 5 个文件名，
  // 于是**名单之外的任何新文件带 BOM 都恒绿**：实测给 core/model.js 注入 BOM，套件仍 54/54 全绿。
  // 这是「判据挂在名字上」的通病（同日另一处：verify-install.ps1 判「数据面 = 2 层」时只匹配
  // 'PROJECT_DOC|MODEL_DOC' 两个名字，删掉 PLANE.LEGACY 它不报）—— 名单守住的只是**当时想到的名字**。
  // 现在按结构扫：仓内所有 .mjs/.js/.cjs/.json 一律不得带 BOM。
  // 排除规则只按**机制**、不按名字：dot 目录（.git/.roundtable/.internal/.verify-tmp…，本就不进包）
  // 与 node_modules（依赖，非本仓源）。
  const here = dirname(fileURLToPath(import.meta.url))
  const pkgRoot = join(here, '..')
  const offenders = []
  let scanned = 0
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { walk(join(dir, e.name), r); continue }
      if (!/\.(mjs|js|cjs|json)$/.test(e.name)) continue
      scanned++
      const bytes = readFileSync(join(dir, e.name))
      if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) offenders.push(r)
    }
  }
  walk(pkgRoot, '')
  // 空集扫描 = 判据无从生效（与「缺产物不许静默 pass」同一条纪律）
  assert.ok(scanned > 0, '扫描面为空 —— 判据没生效，不许静默通过')
  assert.deepEqual(offenders, [], `下列文件带 BOM（node 不认）: ${offenders.join(', ')}`)
})

test('发布链跨面：产物 tarball 必须与源码逐字节一致（"改了源码没 repack" 必须红）', async (t) => {
  // 为什么这条要进套件：四套件里 `grep -E 'tgz|tar|pack'` 命中 0 ⇒ **「源码改了但没重打包」
  // 在套件内结构上看不见**，它当时只被包外的 verify-install.ps1 ③ 抓（而 ③ 要跑 PS + 读 profile），
  // 于是"改完 core/ 忘了 npm pack"能一路绿到用户重启那一刻。
  // 判据 = **两集合求差**，不含任何文件名清单：tarball 成员集合 vs package.json 派生出的进包集合。
  // 三条：① 成员集合相等（多一个=打包规则与声明分叉，少一个=声明里写了却没进包）
  //       ② 每个成员与仓库源码的 SHA256 逐字节一致（=「树 = 包」）
  //       ③ 产物自身的压缩内容里没有"更旧"的历史 —— 由 ② 覆盖，不重复判。
  // ⚠ 产物不存在时**不许静默 pass**（那正是本仓记过的"假绿"形态）：显式失败并指向 npm pack。
  const here = dirname(fileURLToPath(import.meta.url))
  const pkgRoot = join(here, '..')
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'))
  const tgz = join(pkgRoot, `dsh-external-project-nav-${pkg.version}.tgz`)
  if (!existsSync(tgz)) {
    assert.fail(`${pkg.version} 的产物不存在（${tgz}）—— 先 npm pack --cache .npm-cache；缺产物==发布链断，不许静默跳过`)
  }

  // tar 解析：只认 ustar 头（npm pack 产物实测全部为 type='0' 普通文件，见 2026-09-25 探针）
  const raw = gunzipSync(readFileSync(tgz))
  const packed = new Map()
  for (let off = 0; off + 512 <= raw.length;) {
    const name = raw.toString('utf8', off, off + 100).replace(/\0.*$/, '')
    if (!name) break
    const size = parseInt(raw.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim(), 8) || 0
    packed.set(name.replace(/^package\//, ''), createHash('sha256').update(raw.subarray(off + 512, off + 512 + size)).digest('hex'))
    off += 512 + Math.ceil(size / 512) * 512
  }
  assert.ok(packed.size > 0, 'tar 解析出 0 个成员 —— 解析失败即判据无从生效，不许静默通过')

  // 期望集合从 package.json 派生（与 install.ps1 / verify-install.ps1 ② 同一来源）
  const want = []
  for (const top of [...pkg.files, 'package.json', 'README.md', 'LICENSE']) {
    const abs = join(pkgRoot, top)
    if (!existsSync(abs)) continue
    if (statSync(abs).isDirectory()) {
      const walk = (d) => readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p); else want.push(relative(pkgRoot, p).replace(/\\/g, '/'))
      })
      walk(abs)
    } else if (!want.includes(top)) want.push(top)
  }
  assert.deepEqual([...packed.keys()].sort(), [...want].sort(),
    '产物成员集合必须与 package.json files[] 派生出的进包集合相等（多=打包规则与声明分叉，少=声明了却没进包）')

  const drift = []
  for (const [rel, sha] of packed) {
    const src = join(pkgRoot, rel)
    if (!existsSync(src)) { drift.push(`${rel}（源码不在）`); continue }
    const actual = createHash('sha256').update(readFileSync(src)).digest('hex')
    if (actual !== sha) drift.push(rel)
  }
  assert.deepEqual(drift, [], `源码与产物不一致（忘 repack？）: ${drift.join(', ')} —— 改完源码必须 npm pack --cache .npm-cache`)
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

  // ⚠ 前置非空断言（2026-09-25 复核席实测的空判据）：下面的 upper-bound 是 `nonMode.length <= 4`，
  // 而 paramsOf 抽不到参数时返回 **[]** ⇒ nonMode 恒空 ⇒ `0 <= 4` 恒真。
  // 也就是说：抽取面一旦失配（曾把 `^\s{6}` 写成 `^\s{8}`），这条判据**看起来还是绿的**，
  // 却已经一个字段都没在看 —— 这正是本仓最忌的「空扫判绿」（同族 ACT-341 / A2）。
  // 所以先证明抽取面真的抽到了东西，再谈上界。
  assert.ok(commit.params.length > 0,
    '⚠ 空扫：nav_commit 一个参数都没抽到（上界判据会退化成 0<=4 恒真）—— 先修参数抽取面，别让判据空转')
  for (const req of ['task', 'anchor']) {
    assert.ok(commit.params.includes(req),
      `⚠ 空扫：nav_commit 的必填参数 ${req} 未被抽到（实际抽到: [${commit.params.join(', ')}]）—— 抽取面失配时上界判据恒真`)
  }

  const nonMode = commit.params.filter((p) => !['task', 'plan', 'features', 'modules', 'files', 'mode', 'id', 'reason'].includes(p))
  assert.ok(nonMode.length <= 4, `nav_commit 的模型面字段过多: ${nonMode.join(', ')}`)
})

// ============ A2 三态证据（读不到 ≠ 改了）============
//
// 病根（2026-09-25 复核席变异实测）：core/scope.js 的 `if (bU || aU)` 短路曾被改掉，
// **四套件全绿** —— 也就是说「读不到 ≠ 改了」这条命门（静默收口）当时没有任何守卫。
//
// 为什么它是命门：读失败一旦混进内容比较（读失败曾记 sha1:null，与任何 sha1 都不相等），
// 收口就会把「没读到」判成「改过了」⇒ 笔记被静默收掉，而收口证据本身在说谎。
//
// ⚠ 夹具平台边界（本仓实测，跨平台）：本机是 Windows，两条常见造法**都不成立** ——
//   · `chmodSync(file, 0o000)` 在 win32 上被忽略：实测 stat OK / read OK（返回真实内容）；
//   · 「打开句柄 + unlink」在 Node 上会直接删掉名字：实测 unlink 后 statSync 是 ENOENT
//     ⇒ 那是**第三态（确实不存在）**，不是「存在但读不到」，喂给它就把判据喂错了靶。
// 而 FS 层制造 EPERM 会红在**非管理员/非 Windows** 的机器上（CI 上绝大多数不是管理员）
// ⇒ 不许变成假红。故本用例走任务书给出的退路②：**直接构造三态输入喂纯函数**（确定性、平台无关），
// 并把「真实 FS 三态」作为**有则验、无则显式 SKIP 且打印原因**的加强项（不是静默跳过）。
//
// 三条断言各自能独立抓住一种改法（不是一条判据的多份抄写）：
//   ① evidenceOf  —— 抓住「读不到压成 sha1:null」；
//   ② diffEvidence —— 抓住「bU || aU 短路被改掉」（读失败被丢进 modified）；
//   ③ reconcile   —— 抓住「收口不看 unreadable、照写 closed」（静默收口）。

/**
 * 「存在但读不到」的真实 FS 夹具：造得出就返回绝对路径，造不出返回 null（原因由调用方打印）。
 *
 * ⚠ 平台约束（本仓实测）：`chmod` 在 win32 上被忽略（0o000 照样读得到），
 * 而"打开句柄 + unlink"会真的把名字删掉（那落到**第三态**，不是第二态）⇒ 本机两条路都不通。
 * 故本函数只负责**尝试**：造不出来就返回 null，由调用方显式 SKIP（不静默、也不假红）。
 *
 * ⚠ 权限必须有人负责收尾：只读目录会让 rmSync EACCES ⇒ 清理失败会红在**夹具**上而不是判据上。
 * 调用方为此在 `t.after` 里先 chmod 恢复再删树（见用例）。
 */
function makeUnreadableFixture(abs) {
  if (process.platform !== 'win32') {
    try { chmodSync(abs, 0o000) } catch { /* 落到只读目录探针 */ }
    if (!readSucceeds(abs)) return abs
  }
  // 兜底：可读文件放进**不可读目录**（stat 命中、read 被拒）。
  try { chmodSync(dirname(abs), 0o000) } catch { /* noop */ }
  if (!readSucceeds(abs)) return abs
  try { chmodSync(dirname(abs), 0o755) } catch { /* noop */ }
  return null
}

function readSucceeds(abs) {
  try { readFileSync(abs); return true } catch { return false }
}

test('A2 三态：存在但读不到 ≠ 改了 —— evidence/diff/reconcile 三级都必须可区分', async (t) => {
  // ---------- 主判据（纯函数级，确定性、平台无关）----------
  const REL = 'src/locked.js'
  const REAL_SHA = 'a'.repeat(40)
  const before = { [REL]: { exists: true, size: 10, mtimeMs: 1000, sha1: REAL_SHA } }
  const unreadable = { [REL]: { exists: true, size: 10, mtimeMs: 1001, unreadable: 'EPERM' } }

  // ① evidenceOf：读不到的第三态必须可区分（不是 exists:false，也不是裸 sha1:null）
  const probe = mkdtempSync(join(tmpdir(), 'pnx-unreadable-'))
  // 先恢复权限、再删树：夹具可能把 probe 目录 chmod 成 0o000（POSIX 上的兜底试探），
  // 若直接 rmSync 会 EACCES ⇒ 那是**夹具清理失败**，会红在错误的地方（等于假红）。
  t.after(() => { try { chmodSync(probe, 0o755) } catch { /* win32 无此语义 */ } ; rmSync(probe, { recursive: true, force: true }) })
  writeFileSync(join(probe, 'readable.js'), 'readable', 'utf-8')

  // 平台无关的两条**结构性**断言（任何机器都跑）：
  //   · 可读文件 → 真 sha1；· 不存在 → exists:false 且**不出现 sha1 键**。
  // 合起来封的是"把读失败压成 sha1:null"那种折法 —— null 与任何 sha1 都不相等，
  // 于是比对时必被读成"内容变了"（静默收口的来源）。
  const eRead = evidenceOf(probe, ['readable.js'])['readable.js']
  assert.equal(eRead.exists, true)
  assert.match(String(eRead.sha1), /^[0-9a-f]{40}$/, '可读文件必须给出真 sha1（不是 null、不是占位）')
  assert.equal(eRead.unreadable, undefined, '可读文件不得带 unreadable（第三态不得被误报）')
  const eGone = evidenceOf(probe, ['nope.js'])['nope.js']
  assert.equal(eGone.exists, false, '确实不存在 → exists:false（第三态与第二态必须可区分）')
  assert.ok(!Object.hasOwn(eGone, 'sha1'), '不存在时不得挂一个 sha1 占位（sha1 键的缺席本身就是语义）')

  // 真实 FS 夹具：造得出就验满第三态，造不出**显式 SKIP 并打印原因**（不静默、也不假红）
  const fx = join(probe, 'locked-by-fs.js')
  writeFileSync(fx, 'locked', 'utf-8')
  const real = makeUnreadableFixture(fx)
  if (real) {
    const es = evidenceOf(probe, ['locked-by-fs.js'])['locked-by-fs.js']
    assert.equal(es.exists, true, '真实 FS 夹具：必须落在第三态（stat 成功 ⇒ 不是 existed:false）')
    assert.equal(typeof es.unreadable, 'string', '真实 FS 夹具：必须带 unreadable 原因')
    assert.equal(es.sha1, undefined, '读不到时不得凭空造 sha1（内容根本没读到）')
    assert.deepEqual(diffEvidence({ 'locked-by-fs.js': es }, { 'locked-by-fs.js': es }).modified, [],
      '真实 FS 夹具：自己与自己比绝不能算 modified')
  } else {
    console.log(`  [A2 真实 FS 夹具 SKIP] platform=${process.platform} —— chmod(0o000) 与只读目录在本平台都不生效（实测 win32 两者皆被忽略）；` +
      '第三态在本机改由纯函数构造覆盖（②③），未降级为假绿')
  }

  // ② diffEvidence：读不到 vs 有值 —— 不得判 changed，且原因必须在 unreadable 通道里
  const d = diffEvidence(before, unreadable)
  assert.equal(d.changed, false, '读不到 ≠ 改了：读失败不得被判成内容变化（静默收口的来源）')
  assert.deepEqual(d.modified, [], '读不到的文件不得进 modified（那是把"没读到"说成"改过了"）')
  assert.deepEqual(d.vanished, [], '读不到不得被说成消失')
  assert.deepEqual(d.appeared, [])
  assert.deepEqual(d.unreadable.map((u) => u.file), [REL], '原因必须列在 unreadable 通道里（不得吞）')
  assert.ok(d.unreadable[0].reason.includes('EPERM'), `unreadable 必须带可读原因，实际 ${JSON.stringify(d.unreadable)}：读失败的因由不得只丢一个词`)
  // 反向配对（同一夹具下）：真改了仍必须报 changed —— 否则上一条可以被"永远返回 changed:false"骗过
  const d2 = diffEvidence(before, { [REL]: { exists: true, size: 11, mtimeMs: 2002, sha1: 'b'.repeat(40) } })
  assert.equal(d2.changed, true, '成对断言：真改了必须报 changed（缺这一半，上面那条可被恒 false 骗过）')
  // 历史事件流兼容：只有 "exists:true 而 sha1 缺席" 的旧证据，同样不得算"变了"
  const dOld = diffEvidence({ [REL]: { exists: true, sha1: null } }, unreadable)
  assert.equal(dOld.changed, false, '旧证据（sha1:null 无 unreadable 字段）同样不得判 changed')

  // ③ reconcile：读不到 ⇒ 不得写 closed 事件，仍 open 且带可读原因
  const root = tmpRoot(t)
  await seed(root, { files: ['src/a.js'] })
  const c = await commitIntent(root, { task: 'A2 三态', anchor: 'PN-F01', arch: 'a', scope: { files: ['src/a.js'] } })
  assert.equal(c.status, 'ok')
  const eventsFile = paths.events(root)
  const linesOf = () => readFileSync(eventsFile, 'utf-8').split(/\r?\n/).filter((l) => l.trim())
  // 逐行改写：只动那一份事件的 evidence 与它的 sha1 —— 不得引入坏行（seq 连续性必须保住）
  const events = readEvents(root).events
  writeFileSync(eventsFile, events.map((ev) => {
    if (ev.kind !== 'commit' || ev.phase !== 'open') return JSON.stringify(ev)
    const f = Object.keys(ev.evidence || {})[0]
    return JSON.stringify({ ...ev, evidence: { ...ev.evidence, [f]: { ...ev.evidence[f], unreadable: 'EPERM' } } })
  }).join('\n') + '\n', 'utf-8')
  assert.equal(verifyLog(root).ok, true, '前置：改写后事件流自身必须仍完整（否则下面的收口判据红在错误的地方）')

  const rec = await reconcile(root)
  const closedEvents = readEvents(root).events.filter((ev) => ev.kind === 'commit' && ev.phase === 'closed')
  assert.equal(closedEvents.length, 0, '读不到 ⇒ 不得写 closed 事件（这就是"静默收口"：拿读失败当改过了）')
  assert.equal(rec.closed.length, 0)
  assert.equal(rec.stillOpen.length, 1, '应仍 open（读不到不是"没变"，也不是"已收"）')
  assert.equal(rec.stillOpen[0].reason, 'unreadable', '仍 open 必须把原因带出去，不得只丢一个 reason:unchanged')
  assert.ok(String(Array.isArray(rec.stillOpen[0].unreadable) ? JSON.stringify(rec.stillOpen[0].unreadable) : rec.stillOpen[0].unreadable).includes('EPERM'),
    '原因必须可读（调用方要看得见"为什么没收"）')

  // 反向配对：把 unreadable 去掉（恢复正常可读）⇒ 必须回到可收口状态
  // —— 否则上一条可以被"reconcile 永远不收口"骗过。
  writeFileSync(eventsFile, events.map((ev) => JSON.stringify(ev)).join('\n') + '\n', 'utf-8')
  put(root, 'src/a.js', 'changed-by-A2-probe')
  const rec2 = await reconcile(root)
  assert.equal(rec2.closed.length, 1, '成对断言：证据恢复正常后必须能收口（缺这一半，上一条可被"永不收口"骗过）')
  assert.equal(readEvents(root).events.filter((ev) => ev.kind === 'commit' && ev.phase === 'closed').length, 1)
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

test('A4 事件模型 = 4 种 kind（ARCHITECTURE §5 的架构事实，加第 5 种即红）', async (t) => {
  // 病根（2026-09-25 复核席变异实测）：给 `core/log.js` 的 EVENT_KINDS 加第 5 种 ⇒ **四套件全绿**。
  // 而 ARCHITECTURE §5 的章节标题与表格都写死「事件模型（4 种 kind，唯一写入面）」——
  // 架构事实没有任何机检，改它就等于悄悄改了架构（且没人会发现）。
  //
  // 判据刻意**双侧**都取：
  //   · 运行时面：EVENT_KINDS 常量本身（这是"唯一写入面"实际拒绝未知 kind 的依据）；
  //   · 契约面：ARCHITECTURE §5 的表格（文档说 4 种就必须真的是那 4 种，反之亦然）。
  // 只取一侧都会被"改一边忘另一边"绕过。
  const CONTRACT_KINDS = ['commit', 'decide', 'node', 'set']
  assert.equal(EVENT_KINDS.length, 4, `事件模型必须恰为 4 种 kind（ARCHITECTURE §5），实际 ${EVENT_KINDS.length}: ${EVENT_KINDS.join(', ')}`)
  assert.deepEqual([...EVENT_KINDS].sort(), [...CONTRACT_KINDS].sort(),
    `kind 集合必须与契约 §5 的四个逐字一致，实际 ${EVENT_KINDS.join(', ')}`)

  // 契约面：从 ARCHITECTURE §5 解析出表格里列出的 kind，与常量集合比对
  const arch = readFileSync(new URL('../ARCHITECTURE.md', import.meta.url), 'utf-8')
  const sec = arch.split(/\n(?=## )/).find((s) => /^## 5\./.test(s))
  assert.ok(sec, 'ARCHITECTURE 必须有 §5（事件模型）—— 找不到就是契约被搬走了')
  const head = sec.split('\n')[0]
  assert.match(head, /4 种 kind/, `§5 标题必须写明 kind 种数（判据要与文档对得上），实际: ${head}`)
  const tableKinds = [...sec.matchAll(/^\| \`([a-z]+)\` \|/gm)].map((m) => m[1]).sort()
  assert.deepEqual(tableKinds, [...CONTRACT_KINDS].sort(),
    `§5 表格列出的 kind 必须恰为四个，实际 ${tableKinds.join(', ')} —— 文档与 EVENT_KINDS 必须同源`)

  // 行为面（端到端）：未知 kind 必须在**写入时**被拒 —— 常量改了而闸门没跟上，这里会红
  const root = tmpRoot(t)
  await seed(root)
  await assert.rejects(
    () => appendEvents(root, [{ kind: 'drift', anchor: 'PN-F01' }]),
    /unknown event kind/,
    '未知 kind 必须被 appendEvents 拒绝（EVENT_KINDS 是唯一写入面的实际闸门，不是陈列品）'
  )
})

// ============ 平面契约 ============

test('平面契约：两层数据面（0.12.0 换代）；长期资产只有事件流一个文件', async (t) => {
  const root = tmpRoot(t)
  // ⚠ 判据必须是**结构派生**的，不能是名字名单（2026-09-25 修 · 本项根因）。
  // 旧版断言 `'PROJECT_DOC' in PLANE === false` / `'MODEL_DOC' in PLANE === false`：
  // 它只能守住写它那一刻想到的那两个名字 —— 任何**别的**平面常量（新增的、残留的、改名的）
  // 它一律看不见。实测：往 core/paths.js 注入 `PLANE.LEGACY` 后旧断言仍全绿
  // （一道"数据面 = 2 层"的判据，在数据面真的变成 3 层时零信号）。
  // 现判据 = **三个派生集合求差**，不含任何平面常量名、也不写死层数：
  //   ① 定义面：core/paths.js 里 PLANE 字面量的顶层键（怎么增删都跟着动）
  //   ② 消费面：core/ 与 host/ 全部源码里出现的 `PLANE.<键>`（文件清单也是扫出来的，不写死）
  //   ③ 契约面：ARCHITECTURE §3 表格里列出的层路径（去尾斜杠后比）
  // 三个必须同时逐键相等：多一个 = 留了份永不再写的承诺；少一个 = 悬空引用；
  // 与契约对不上 = 层数被悄悄改了而契约没跟着改（换代时改契约，判据自己跟着动）。
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const pathsSrc = strip(readFileSync(join(pkgRoot, 'core', 'paths.js'), 'utf-8'))
  const planeBlock = pathsSrc.match(/export const PLANE\s*=\s*\{([\s\S]*?)\n\}/)
  assert.ok(planeBlock, 'core/paths.js 必须有 PLANE 字面量定义 —— 解析不到即判据无从派生，不许静默通过')
  const defPairs = [...planeBlock[1].matchAll(/^\s*([A-Za-z_]\w*)\s*:\s*'([^']*)'/gm)]
  const defKeys = defPairs.map((m) => m[1]).sort()
  const defVals = [...new Set(defPairs.map((m) => m[2].replace(/\/+$/, '')))].sort()
  assert.ok(defKeys.length > 0, 'PLANE 至少得有一个平面常量（解析出空集 = 判据恒绿，正是本项要修的病）')
  assert.deepEqual(defKeys, Object.keys(PLANE).sort(),
    'PLANE 的字面量定义面必须与运行时导出对象逐键一致（解析器自证 —— 用计算键/展开写法会被这里抓住）')

  const srcFiles = readdirSync(join(pkgRoot, 'core')).filter((f) => f.endsWith('.js')).map((f) => join(pkgRoot, 'core', f))
  srcFiles.push(join(pkgRoot, 'host', 'index.js'))
  const consumed = new Set()
  for (const f of srcFiles) {
    for (const m of strip(readFileSync(f, 'utf-8')).matchAll(/PLANE\.([A-Za-z_]\w*)/g)) consumed.add(m[1])
  }
  assert.deepEqual(defKeys, [...consumed].sort(),
    `平面常量的定义面与消费面必须逐键相等（数据面应恰为 ${defKeys.length} 层）；定义了却零消费 = 留了永不再写的承诺，被引用却未定义 = 悬空`)

  // 契约面：层数不写在这里，从 ARCHITECTURE §3 的表格行**派生**（换代时改契约，判据自己跟着动）
  const arch = readFileSync(join(pkgRoot, 'ARCHITECTURE.md'), 'utf-8')
  const sec3 = arch.split(/\n(?=## )/).find((s) => /^## 3\./.test(s))
  assert.ok(sec3, 'ARCHITECTURE 必须有 §3（两层数据面）—— 找不到就是契约被搬走了')
  const contractVals = [...sec3.matchAll(/^\|\s*\*\*[^|]+\*\*\s*\|\s*`([^`]+)`/gm)]
    .map((m) => m[1].replace(/\/+$/, '')).sort()
  assert.ok(contractVals.length > 0, '§3 表格里必须解析出层路径（解析出空集 = 判据恒绿）')
  assert.deepEqual(defVals, contractVals,
    `PLANE 的取值面必须与 ARCHITECTURE §3 列出的层逐条一致（契约与源码必须给出同一个层数 ${contractVals.length}）`)
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

// ============ A5 缓存语义（0.12.0 · useCache 默认翻为 true 之后的覆盖缺口）============
//
// 病根（2026-09-25 施工席自述 + 复核席确认）：`loadModel` 的默认已翻成 `useCache: true`
// —— 生产路径**从此读缓存**，而缓存路径此前只被「edges 冷热一致」覆盖过：
// 而 edges 在**两条路径上都当场重算**（见 buildModelFromPlain 注释）⇒ 零分辨力，
// 缓存载荷有没有被真的消费、被消费得对不对，一个字都没测。
//
// 下面两条补的是「**缓存载荷真的被消费**」：
//   ① 逐项比对缓存**供应**的那些字段（vector / decisions / nodes / stale / unregistered / commits）；
//   ② 篡改缓存载荷 ⇒ 第二关（contentDigest）必须作废整份缓存 —— 这一条是投毒方向的守卫。

test('A5 冷热一致不止 edges：缓存供应的每个字段都必须逐项等价（缓存载荷真被消费）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)
  put(root, 'src/b.js', "import './a.js'\n")
  await appendEvents(root, [{ kind: 'decide', anchor: 'PN-F01', reason: 'r', decision: 'd' }])

  const cold = loadModel(root, { useCache: false })   // 重算 + 落缓存
  const supplyOf = (m) => ({                          // ← 缓存**供应**的那一半（事件流派生）
    vector: m.vector,
    decisions: m.decisions,
    nodes: [...m.nodes.values()].map((n) => [n.id, n.status, n.name, n.files, n.module]),
    commits: m.commits.map((c) => [c.id, c.phase, c.anchor])
  })
  assert.ok(cold.vector.doing && cold.nodes.size > 0, '前置事实：缓存供应的载荷非空（否则下面的比对是空集比空集）')

  // ⚠ 判别力来源：**落缓存之后**再改磁盘（事件流一个字没动 ⇒ 戳仍然一致 ⇒ warm 必然走缓存路径）。
  // 登记的落点被删 → STALE；新增未登记文件 → unregistered。这两个是**纯磁盘派生**，
  // 而 buildModelFromPlain 的既定契约是"命中缓存也当场重算"（事件流的戳证明不了磁盘）。
  rmSync(join(root, 'src', 'a.js'), { force: true })
  put(root, 'src/z-extra.js', '// unregistered')


  const warm = loadModel(root, { useCache: true })
  const fresh = buildModel(root)                      // 无缓存重算 = 参考真相
  assert.deepEqual(supplyOf(warm), supplyOf(cold),
    '命中缓存的那条路径必须与"写缓存时的真相"逐字段等价 —— 缓存载荷是"被消费"的，不是被忽略的')
  // 磁盘派生态：不得采信缓存里那份（旧判据只比 edges ⇒ 换个字段就完全看不见）
  assert.ok(warm.stale.length > 0, '前置事实：STALE 必须非空 —— 否则"重算 vs 采信缓存"在这一项上不可分辨')
  assert.ok(warm.unregistered.includes('src/z-extra.js'), '前置事实：未登记清单必须非空（同上）')
  assert.deepEqual(warm.stale, fresh.stale, '命中缓存时 STALE 必须当场重算，不得从缓存载荷里取（I1：戳证明不了磁盘）')
  assert.deepEqual(warm.unregistered, fresh.unregistered, '未登记清单同理（stale/unregistered 与 edges 同一理由）')

  // 冷热两条路径的 dependents（节点级投影）也不许分叉
  const deps = (m) => [...m.edges.dependents].map(([k, v]) => [k, [...v].sort()]).sort()
  assert.deepEqual(deps(warm), deps(cold))
})

test('A5 篡改缓存载荷 ⇒ warm 不得采信（contentDigest 第二关；投毒方向的守卫）', async (t) => {
  // 为什么必须单独测投毒：第一关（事件流戳）只管"源没变"，
  // 手工改一处缓存字段**根本不改变事件流的戳** ⇒ 光有第一关时"源没变"为真、缓存却已不是源的投影。
  // 这正是 useCache 翻成默认 true 之后必须堵的口子（读缓存成为默认路径）。
  const root = tmpRoot(t)
  await seed(root)
  await appendEvents(root, [{ kind: 'decide', anchor: 'PN-F01', reason: 'r', decision: 'd' }])
  loadModel(root, { useCache: false })        // 先写出一份**合法**缓存
  const modelFile = paths.model(root)

  // 篡改前后必须是两份不同字节（下面"不得采信"的判据才有标的）
  const beforeBytes = readFileSync(modelFile, 'utf-8')
  const tampered = JSON.parse(beforeBytes)
  tampered.vector = { ...tampered.vector, doing: 'POISONED-VECTOR' }
  // 两处一起投毒：
  //   · vector —— 与既有 I1 用例的靶同一面（那一条已覆盖它，这里作回归）；
  //   · node.name —— **此前无任何判据覆盖的面**（旧冷热用例只比 edges ⇒ 对它零分辨力）。
  tampered.nodes = tampered.nodes.map((n) => n.id === 'feature:pn-f01' ? { ...n, name: 'POISONED-NAME' } : n)
  writeFileSync(modelFile, JSON.stringify(tampered, null, 2), 'utf-8')
  assert.notEqual(readFileSync(modelFile, 'utf-8'), beforeBytes, '前置事实：篡改必须真的改变了缓存字节')

  const warm = loadModel(root, { useCache: true })
  assert.notEqual(warm.vector.doing, 'POISONED-VECTOR', '篡改缓存载荷后 warm 不得采信（contentDigest 第二关必须作废整份缓存）')
  assert.equal(warm.vector.doing, 'core', 'warm 必须回落事件流里的真相')
  assert.equal(warm.nodes.get('feature:pn-f01').name, 'PN-F01',
    '缓存里的节点名被篡改也不得采信 —— 这是旧冷热用例（只比 edges）零分辨力的那一面')

  // 反向配对：**只**动 vector 时，戳（事件流未变）确实一致 —— 证明这道关卡的靶是第一关盖不住的那一面
  assert.equal(loadModel(root, { useCache: false }).vector.doing, 'core')

  // 且缓存必须被重建（不得把毒留在盘上等着下一次读）
  const afterBytes = readFileSync(modelFile, 'utf-8')
  assert.equal(JSON.parse(afterBytes).vector.doing, 'core', '缓存必须被重建回真相，而不是带着被篡改的载荷继续结账')
  // 重建后的缓存必须重新可被采信（否则"防投毒"可以退化成"永远重算"）
  const warm2 = loadModel(root, { useCache: true })
  assert.equal(warm2.vector.doing, 'core')
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

// ============ 主线向量的缺席可观测（隐性字段陷阱）============
//
// 病根（2026-09-23 实测）：主线向量四字段曾在**四个渲染站点各自手写**，且对"未填"给出四种语义
// —— nav_set 回执四字段全显式 `(unset)`；health/presence 只显式 doing/next，另两个**整行消失**；
// tree 干脆不渲染 exitCondition。后果不是"少显示一行"，而是**失败不可观测**：
// 新增字段时漏改一处、或某字段从未被渲染，都不会有任何信号。
// 这正是本仓最忌的一类缺陷（同族：ACT-341「空扫不得判绿」）。
//
// 判据刻意**从模型派生**（不是硬编码四个名字）：`vector` 长出新字段而没人渲染 ⇒ 本用例自动失败。
// 这样它不需要人维护 —— 与该文件其余判据同源。

test('主线向量：每个字段在三个渲染面上都必须显式可辨（派生自模型，非硬编码）', async (t) => {
  const root = tmpRoot(t)
  await seed(root)   // seed 四字段全有值
  // 造"未填"态：这才是原病根分支 —— 真仓/夹具四字段全满时它测不出来（假绿）
  await appendEvents(root, [{ kind: 'set', vector: { doing: 'ONLY-DOING', next: '', notDoing: '   ', exitCondition: null } }])

  const m = buildModel(root)
  const folded = foldOnly(root)

  // 权威字段集从模型派生（排除 updatedAt —— 它是元数据，不是主线语义）
  const fields = Object.keys(m.vector).filter((k) => k !== 'updatedAt')
  assert.ok(fields.length >= 4, `向量字段数异常：${fields.join(', ')}`)

  const surfaces = {
    'renderTreeText': renderTreeText(m),
    'renderHealth': renderHealth(m, { rootPath: root, opens: [], locks: [], inflight: [], logCheck: null }),
    'renderPresence': renderPresence(folded)
  }
  for (const [name, text] of Object.entries(surfaces)) {
    for (const f of fields) {
      // 每个字段必须在场：要么带真实值，要么带显式 (unset) —— 不许整行消失
      assert.ok(text.includes(f), `${name} 未渲染向量字段 "${f}"（缺席即不可观测）`)
    }
    assert.ok(text.includes('(unset)'), `${name} 必须把未填字段显式标成 (unset)，而不是让整行消失`)
    assert.ok(text.includes('ONLY-DOING'), `${name} 必须给出已填字段的真实值`)
  }

  // 反向：`(unset)` 不得泄漏到**数据面**（JSON 快照的缺席仍是空串，不是显示串）
  const { mountHost } = await import('./host-harness.mjs')
  const h = await mountHost(root, { config: {} })
  t.after(() => h.dispose())
  const snap = JSON.parse(await h.call('nav_graph', { mode: 'health', format: 'json' }))
  assert.equal(snap.vector.next, '', 'JSON 数据面缺席必须是空串（(unset) 只是显示态，不得污染数据）')
  assert.equal(snap.vector.doing, 'ONLY-DOING')
})
