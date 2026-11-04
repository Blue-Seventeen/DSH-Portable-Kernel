/**
 * pnpm store 一致性判定（纯函数 + 只读扫描）。
 *
 * 为什么单列一个模块：`verify-shell` 用它做门禁、`selftest-store` 用它做夹具回归，
 * 两边必须用**同一份**判定，否则门禁绿了而真机坏了（2026-11-04 事故：yaml 被升级覆盖成
 * 干净版 → pnpm 漂到 `$PNPM_HOME/store` → 与 `node_modules\.modules.yaml` 记录不一致 → 装不上插件）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 从 pnpm-workspace.yaml 取顶层 storeDir（单/双引号都可）；没有返回 '' */
export const storeDirFromYaml = (text) => {
  const m = /^\s*storeDir\s*:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(String(text || ''))
  return m ? m[1].trim() : ''
}

/** 从 .modules.yaml 取 storeDir（JSON 优先；文件被写坏时退回文本匹配） */
export const recordedStoreDir = (text) => {
  try { return String(JSON.parse(text).storeDir || '').trim() } catch { /* 退回文本匹配 */ }
  const m = /"storeDir"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(text || ''))
  return m ? m[1].replace(/\\\\/g, '\\').trim() : ''
}

const norm = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').trim().toLowerCase()

/**
 * 两条 store 路径是否指同一个 store。
 * `.modules.yaml` 记的是带大版本段的（…\v11），yaml 里写的是 store 根（…\pnpm-store），
 * 所以允许"一方是另一方的前缀（按路径段）"。
 */
export const sameStore = (recorded, expected) => {
  const a = norm(recorded)
  const b = norm(expected)
  if (!a || !b) return false
  return a === b || a.startsWith(b + '\\') || b.startsWith(a + '\\')
}

/** 扫描一棵 portable 树，返回问题列表（空数组 = 一致；没有 .modules.yaml = 还没装插件，跳过） */
export const checkTree = (root) => {
  const problems = []
  const shared = join(root, 'home', 'profiles')
  const modules = join(shared, 'node_modules', '.modules.yaml')
  if (!existsSync(modules)) return problems
  const recorded = recordedStoreDir(readFileSync(modules, 'utf8'))
  for (const file of [
    join(shared, 'pnpm-workspace.yaml'),
    join(shared, 'web', 'pnpm-workspace.yaml'),
    join(shared, 'desktop', 'pnpm-workspace.yaml'),
  ]) {
    if (!existsSync(file)) continue
    const expected = storeDirFromYaml(readFileSync(file, 'utf8'))
    if (!expected) { problems.push({ file, reason: 'missing-storeDir', recorded, expected }); continue }
    if (!sameStore(recorded, expected)) problems.push({ file, reason: 'mismatch', recorded, expected })
  }
  return problems
}
