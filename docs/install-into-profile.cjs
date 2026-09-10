// install-into-profile.cjs — 把本插件的一个 tgz 版本外科对齐安装进 profile。
//
// 为什么不直接用 `dsh plugin --profile web add`：那可能触发 daemon 自我重载，把正在跑的
// 会话打断（HANDOFF §38.7）。本脚本做的是同一件事——改 profile 依赖 + 锁文件（路径与
// integrity）+ 覆盖安装副本——只是完全不碰运行中的进程。重启由用户手动完成。
//
// 用法：node docs/install-into-profile.cjs <oldVersion> <newVersion> [profileDir]
//   例：node docs/install-into-profile.cjs 0.8.3 0.8.4
//
// 前置：先在插件目录 `pnpm pack` 出 <newVersion> 的 tgz；profile 三件先备份。
const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')

const oldV = process.argv[2]
const newV = process.argv[3]
const PROF = process.argv[4] || path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'web')
if (!oldV || !newV) { console.error('usage: node install-into-profile.cjs <oldV> <newV> [profileDir]'); process.exit(1) }

const pkgRoot = path.resolve(__dirname, '..')
// pnpm writes these file: specifiers with FORWARD slashes; path.resolve yields backslashes on
// Windows, so normalise or the lockfile anchors silently miss (a real bug this script had).
const fwd = (p) => p.replace(/\\/g, '/')
const oldTgz = `${fwd(pkgRoot)}/dsh-external-project-nav-${oldV}.tgz`
const newTgz = `${fwd(pkgRoot)}/dsh-external-project-nav-${newV}.tgz`
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1) }
if (!fs.existsSync(newTgz)) fail('new tgz missing (run `pnpm pack` first): ' + newTgz)

const newIntegrity = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(newTgz)).digest('base64')

// ---- pnpm-lock.yaml: importer specifier/version, packages block (+integrity), snapshots key ----
const lkPath = path.join(PROF, 'pnpm-lock.yaml')
let lk = fs.readFileSync(lkPath, 'utf8')
const anchor = `tarball: file:${oldTgz}}\n    version: ${oldV}`
if (!lk.includes(anchor)) fail('lockfile packages anchor not found for ' + oldV)
const m = lk.match(new RegExp('integrity: (sha512-[A-Za-z0-9+/=]+), tarball: file:' + oldTgz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
if (!m) fail('old integrity not found for ' + oldV)
lk = lk.split(m[1]).join(newIntegrity)
lk = lk.split(anchor).join(`tarball: file:${newTgz}}\n    version: ${newV}`)
const refs = lk.split(oldTgz).length - 1
lk = lk.split(oldTgz).join(newTgz)
if (lk.includes(oldTgz)) fail('lockfile still references ' + oldTgz)
fs.writeFileSync(lkPath, lk)
console.log(`lockfile: ${refs + 1} path refs updated, packages block -> ${newV}, integrity rotated`)

// ---- profile package.json: dependency specifier only (never reformat, never add a BOM) ----
const pjPath = path.join(PROF, 'package.json')
let pj = fs.readFileSync(pjPath, 'utf8')
if (!pj.includes(oldTgz)) fail('profile dependency does not reference ' + oldTgz)
pj = pj.split(oldTgz).join(newTgz)
if (pj.charCodeAt(0) === 0xFEFF) fail('refusing to write a BOM into profile package.json')
fs.writeFileSync(pjPath, pj)
console.log(`profile package.json: dependency -> ${newV}`)

// ---- installed copy: extract the tgz over it (what pnpm would have unpacked) ----
const dest = path.join(PROF, 'node_modules', '@dsh-external', 'project-nav')
if (!fs.existsSync(dest)) fail('installed copy missing: ' + dest)
console.log('now extract over: ' + dest)
console.log(`  tar -xzf "${newTgz}" -C "${dest}" --strip-components=1`)
