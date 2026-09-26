// core/paths.js — 平面契约（ARCHITECTURE §3）
//
// 只有两个平面（0.12.0 起）。任何"我想再存一个文件"的冲动都必须先回答：它是事件，还是渲染？
// 两者都不是 → 它不该存在（I1：不存在第二个手写真相）。
//
// ⚠ 0.12.0 换代：原先的**第三个平面「落盘投影」**（PROJECT.md 标记区 / ARCH-MODEL.md / 地图）
// 已整体退场 —— 它们的唯一读者是人，而定案是「只服务 agent」。其 agent 形态的替代物是
// **在场层**（每轮注入上下文，零落盘，见 host/index.js）与 `nav_graph` 按需直出。
// 故 `PROJECT_DOC` / `MODEL_DOC` 两个常量不存在了：留着它们就是留一份永远不再被写的承诺。

import { resolve, relative, isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'

/** 两层数据面。删掉 RUNTIME 必须零损失（I3）。 */
export const PLANE = {
  /** 唯一事实源：append-only 事件流（永久 · 进版本控制） */
  EVENTS: '.internal/events.jsonl',
  /** 可丢弃缓存 / 在途 / 锁 / 诊断（短命 · 不进版本控制） */
  RUNTIME: '.internal/runtime'
}

export const RUNTIME_FILES = {
  MODEL: 'arch-model.json',
  INFLIGHT: 'inflight',
  LOCKS: 'locks',
  /** 依赖图扫描缓存（0.11.0）：纯磁盘派生的加速器，指纹 = 文件清单 + size/mtime。删了即重算。 */
  SCAN_CACHE: 'scan-cache.json'
}

export function p(root, ...parts) {
  return resolve(root, ...parts)
}

export const paths = {
  events: (root) => p(root, PLANE.EVENTS),
  runtime: (root) => p(root, PLANE.RUNTIME),
  model: (root) => p(root, PLANE.RUNTIME, RUNTIME_FILES.MODEL),
  inflightDir: (root) => p(root, PLANE.RUNTIME, RUNTIME_FILES.INFLIGHT),
  locksDir: (root) => p(root, PLANE.RUNTIME, RUNTIME_FILES.LOCKS),
  archDir: (root) => p(root, '.internal', 'arch')
}

/** 统一成 `/` 分隔、无尾斜杠。不做大小写折叠（保真），比较时再折叠。 */
export function normSlashes(s) {
  return String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 比较用键：Windows 上大小写不敏感（同一文件必须折叠成同一键）。 */
export function key(s) {
  return normSlashes(s).toLowerCase()
}

/** 被治理 root 相对的路径（绝对路径进、root 相对路径出）。 */
export function relToRoot(rootPath, absOrRel) {
  const abs = isAbsolute(absOrRel) ? resolve(absOrRel) : resolve(rootPath, absOrRel)
  return normSlashes(relative(rootPath, abs))
}

/** 该路径是否在 root 之内（用于拒绝越界登记）。 */
export function insideRoot(rootPath, absOrRel) {
  const abs = isAbsolute(absOrRel) ? resolve(absOrRel) : resolve(rootPath, absOrRel)
  const rel = normSlashes(relative(rootPath, abs))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function exists(pth) {
  try { return existsSync(pth) } catch { return false }
}

/** ISO 时间戳，唯一时间入口（可注入 now 以便测试）。 */
export function nowIso(now = Date.now()) {
  return new Date(now).toISOString()
}
