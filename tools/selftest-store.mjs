#!/usr/bin/env node
/**
 * pnpm store 一致性判定的夹具回归（纯文本 + 临时目录，不联网、不碰真树）。
 *
 * 覆盖 2026-11-04 的真实故障形态：
 *   记录 …\cache\pnpm-store\v11、yaml 缺 storeDir → 应判为问题（pnpm 会漂到 $PNPM_HOME/store）
 *   记录与 yaml 一致（含"yaml 只写 store 根、记录带 v11"）→ 应判为一致
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkTree, recordedStoreDir, sameStore, storeDirFromYaml } from './store-consistency.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const quiet = process.argv.includes('--quiet')
const say = (m) => { if (!quiet) console.log('  ' + m) }

const results = []
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); say('OK   ' + name) }
  catch (e) { results.push({ name, ok: false }); console.error('  FAIL ' + name + ' — ' + e.message) }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

check('yaml 单引号 storeDir 能读出来', () => {
  assert(storeDirFromYaml("packages:\n  - '.'\n\nstoreDir: 'G:\\X\\cache\\pnpm-store'\n") === 'G:\\X\\cache\\pnpm-store', '单引号解析失败')
})
check('yaml 双引号/无引号也能读', () => {
  assert(storeDirFromYaml('storeDir: "G:/X/cache/pnpm-store"\n') === 'G:/X/cache/pnpm-store', '双引号失败')
  assert(storeDirFromYaml('storeDir: G:/X/cache/pnpm-store\n') === 'G:/X/cache/pnpm-store', '无引号失败')
})
check('yaml 没有 storeDir 时返回空', () => {
  assert(storeDirFromYaml("packages:\n  - '.'\nnodeLinker: hoisted\n") === '', '不该解析出值')
})
check('.modules.yaml 的 storeDir 能读（JSON 与坏文件两条路）', () => {
  assert(recordedStoreDir('{"storeDir":"G:\\\\X\\\\cache\\\\pnpm-store\\\\v11"}') === 'G:\\X\\cache\\pnpm-store\\v11', 'JSON 解析失败')
  assert(recordedStoreDir('{ broken "storeDir": "G:\\\\X\\\\v11"') === 'G:\\X\\v11', '文本回退失败')
})
check('记录带 v11、yaml 写根目录 → 视为同一个 store', () => {
  assert(sameStore('G:\\X\\cache\\pnpm-store\\v11', 'G:\\X\\cache\\pnpm-store'), '应判为一致')
  assert(sameStore('G:/X/cache/pnpm-store/v11', 'g:\\x\\cache\\pnpm-store'), '大小写/斜杠应归一')
})
check('两个不同的 store 不能混为一谈', () => {
  assert(!sameStore('G:\\X\\cache\\pnpm-store\\v11', 'G:\\X\\cache\\pnpm-home\\store'), 'pnpm-store 与 pnpm-home/store 必须判为不一致')
  assert(!sameStore('', 'G:\\X'), '空记录必须判为不一致')
})

check('fixture：yaml 缺 storeDir → 报 missing-storeDir', () => {
  const root = join(process.env.TEMP || ROOT, 'store-selftest-' + Date.now() + '-a')
  try {
    const shared = join(root, 'home', 'profiles')
    mkdirSync(join(shared, 'node_modules'), { recursive: true })
    writeFileSync(join(shared, 'node_modules', '.modules.yaml'), '{"storeDir":"G:\\\\X\\\\cache\\\\pnpm-store\\\\v11"}\n', 'utf8')
    for (const p of ['', 'web', 'desktop']) {
      const dir = p ? join(shared, p) : shared
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - '.'\nnodeLinker: hoisted\n", 'utf8')
    }
    const problems = checkTree(root)
    assert(problems.length === 3, '应报 3 个文件，实际 ' + problems.length)
    assert(problems.every((x) => x.reason === 'missing-storeDir'), '原因应为 missing-storeDir')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

check('fixture：yaml 有 storeDir 且与记录一致 → 无问题', () => {
  const root = join(process.env.TEMP || ROOT, 'store-selftest-' + Date.now() + '-b')
  try {
    const shared = join(root, 'home', 'profiles')
    mkdirSync(join(shared, 'node_modules'), { recursive: true })
    writeFileSync(join(shared, 'node_modules', '.modules.yaml'), '{"storeDir":"G:\\\\X\\\\cache\\\\pnpm-store\\\\v11"}\n', 'utf8')
    for (const p of ['', 'web', 'desktop']) {
      const dir = p ? join(shared, p) : shared
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - '.'\nstoreDir: 'G:\\X\\cache\\pnpm-store'\n", 'utf8')
    }
    const problems = checkTree(root)
    assert(problems.length === 0, '不该报问题，实际 ' + JSON.stringify(problems))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

check('fixture：yaml 指向另一个 store → 报 mismatch', () => {
  const root = join(process.env.TEMP || ROOT, 'store-selftest-' + Date.now() + '-c')
  try {
    const shared = join(root, 'home', 'profiles')
    mkdirSync(join(shared, 'node_modules'), { recursive: true })
    writeFileSync(join(shared, 'node_modules', '.modules.yaml'), '{"storeDir":"G:\\\\X\\\\cache\\\\pnpm-store\\\\v11"}\n', 'utf8')
    for (const p of ['', 'web', 'desktop']) {
      const dir = p ? join(shared, p) : shared
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - '.'\nstoreDir: 'G:\\X\\cache\\pnpm-home\\store'\n", 'utf8')
    }
    const problems = checkTree(root)
    assert(problems.length === 3 && problems.every((x) => x.reason === 'mismatch'), '应为 3 个 mismatch')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

check('fixture：没有 .modules.yaml（还没装插件）→ 跳过', () => {
  const root = join(process.env.TEMP || ROOT, 'store-selftest-' + Date.now() + '-d')
  try {
    mkdirSync(join(root, 'home', 'profiles'), { recursive: true })
    assert(checkTree(root).length === 0, '没装插件时不该报问题')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

const bad = results.filter((r) => !r.ok)
if (bad.length) { console.error('  store 自测失败：' + bad.length + '/' + results.length); process.exit(1) }
say('  store 自测通过：' + results.length + '/' + results.length)
process.exit(0)
