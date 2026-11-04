/**
 * pnpm store 在 exFAT 上的补丁（项目注册整段容错）—— 多副本版。
 *
 * 背景：pnpm 11 在每次**写操作**（install / add / remove）前会跑 prepareStoreDir → registerProject，
 * 它在 `<storeDir>/projects/<hash>` 建符号链接指回项目目录（prune 用的簿记）。exFAT 不支持符号链接，
 * 而且它的兜底链（EEXIST → 改名 → 重试 → unlink）会再抛 ENOENT，于是任何安装都会失败。
 *
 * **为什么要多副本**：便携壳里不止一份 pnpm——
 *   1) `runtime\pnpm`                —— 壳自己的（插件 CLI 走这份）
 *   2) `desktop\resources\runtime\<...>\dependencies\pnpm` —— 桌面窗口内置的（**商城装/卸走这份**）
 * 只补一份的话，另一条路径仍会在 exFAT 上失败（v0.1.3 实测：重启后从桌面商城装插件报 EISDIR）。
 *
 *   node tools\patch-pnpm.mjs --check     # 0=全部已打 4=有没打的 2=有版本/锚点不匹配被跳过
 *   node tools\patch-pnpm.mjs --apply     # 幂等
 *   node tools\patch-pnpm.mjs --revert    # 用 cache\pnpm-pristine-<ver>\ 下的备份还原
 *
 * 为什么要工具化：`runtime\` / `desktop\` 都是官方层、不进 git，`update-app` / `bootstrap` 换 pnpm 会冲掉，
 * 所以 `repair` 每次都要能重新打上。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BACKUP_ROOT = join(ROOT, 'cache')

/** 只对验证过的 pnpm 版本动手：其它版本锚点可能不同，宁可不打也不能打坏 */
const SUPPORTED = new Set(['11.28.5'])
const MARK = '// [hack3rx] pnpm exFAT: 无符号链接的文件系统跳过项目注册'

const APPLY = process.argv.includes('--apply')
const REVERT = process.argv.includes('--revert')
const CHECK = process.argv.includes('--check') || (!APPLY && !REVERT)
const QUIET = process.argv.includes('--quiet')

const say = (m) => { if (!QUIET) console.log(m) }
const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_VERSION = 2
const EXIT_NOT_APPLIED = 4

const BLOCK_START = 'async function registerProject(storeDir, projectDir) {'
const ANCHOR = '  await symlinkDir(projectDir, linkPath);\n'
const PATCHED = [
  '  try {',
  '    await symlinkDir(projectDir, linkPath);',
  '  } catch (err) {',
  '    ' + MARK,
  '    // 整段吞掉：项目注册只是 prune 的簿记；exFAT 上 pnpm 会在"EEXIST→改名→重试→unlink"里抛 ENOENT。',
  '  }',
  '',
].join('\n')

/** 找所有"带 registerProject 的 pnpm 主文件"（dist/pnpm.mjs，以及个别版本直接放 bin/ 的情况） */
const candidates = () => {
  const out = new Set()
  const probe = (dir) => {
    for (const rel of ['dist/pnpm.mjs', 'bin/pnpm.mjs']) {
      const f = join(dir, rel)
      if (!existsSync(f)) continue
      try { if (readFileSync(f, 'utf8').includes(BLOCK_START)) out.add(f) } catch { }
    }
  }
  // 1) 壳自己的
  probe(join(ROOT, 'runtime', 'pnpm'))
  // 2) 桌面内置的：布局不固定（resources\runtime\<x>\dependencies\pnpm 等），有限深度递归找名字叫 pnpm 的目录
  const walk = (dir, depth) => {
    if (depth <= 0) return
    for (const name of safeList(dir)) {
      const sub = join(dir, name)
      if (name === 'pnpm') { probe(sub); continue }
      if (name === 'node_modules' && depth > 2) continue
      walk(sub, depth - 1)
    }
  }
  for (const base of [join(ROOT, 'desktop', 'resources'), join(ROOT, 'app', 'node_modules')]) {
    if (existsSync(base)) walk(base, base.includes('app') ? 2 : 6)
  }
  return [...out]
}
function safeList(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
}

const versionOf = (file) => {
  try {
    const pkg = join(dirname(dirname(file)), 'package.json')
    return String(JSON.parse(readFileSync(pkg, 'utf8')).version || '').trim()
  } catch {
    try {
      const m = readFileSync(file, 'utf8').match(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/)
      return m ? m[1] : ''
    } catch { return '' }
  }
}

const slug = (file) => {
  const rel = file.slice(ROOT.length + 1).replace(/[\\/]+/g, '__').replace(/[^A-Za-z0-9_.-]/g, '_')
  return rel
}
const backupPath = (version, file) => join(BACKUP_ROOT, 'pnpm-pristine-' + version, slug(file) + '.bak')

const main = () => {
  const files = candidates()
  if (!files.length) { say('没有找到任何 pnpm（runtime\\pnpm 与 desktop\\resources 下都没有）'); return EXIT_VERSION }
  let worst = EXIT_OK
  for (const file of files) {
    const rel = file.slice(ROOT.length + 1)
    const version = versionOf(file)
    if (!SUPPORTED.has(version)) {
      say('  ' + rel + '：pnpm ' + (version || '(读不到)') + ' 不在已验证清单（' + [...SUPPORTED].join(', ') + '），跳过')
      worst = Math.max(worst, EXIT_VERSION)
      continue
    }
    const text = readFileSync(file, 'utf8')
    const applied = text.includes(MARK)
    if (CHECK) {
      if (applied) say('  ' + rel + '：已打')
      else { say('  ' + rel + '：未打（exFAT 上装/卸插件会失败）'); worst = Math.max(worst, EXIT_NOT_APPLIED) }
      continue
    }
    if (REVERT) {
      const bak = backupPath(version, file)
      if (!existsSync(bak)) { say('  ' + rel + '：没有备份可回退（' + bak + '）'); worst = Math.max(worst, EXIT_FAIL); continue }
      writeFileSync(file, readFileSync(bak))
      say('  ' + rel + '：已回退')
      continue
    }
    if (applied) { say('  ' + rel + '：已经是打过补丁的状态'); continue }
    if (/includes\(err && err\.code\)/.test(text)) { say('  ' + rel + '：是旧版补丁（只吞部分错误码），先 --revert 再 --apply'); worst = Math.max(worst, EXIT_FAIL); continue }
    const blockAt = text.indexOf(BLOCK_START)
    const at = blockAt < 0 ? -1 : text.indexOf(ANCHOR, blockAt)
    if (at < 0) { say('  ' + rel + '：找不到 registerProject 锚点，跳过'); worst = Math.max(worst, EXIT_VERSION); continue }
    const bak = backupPath(version, file)
    if (!existsSync(bak)) {
      mkdirSync(dirname(bak), { recursive: true })
      copyFileSync(file, bak)
    }
    const out = text.slice(0, at) + PATCHED + text.slice(at + ANCHOR.length)
    writeFileSync(file, out)
    const back = readFileSync(file, 'utf8')
    if (!back.includes(MARK)) { say('  ' + rel + '：写盘校验失败'); worst = Math.max(worst, EXIT_FAIL); continue }
    say('  ' + rel + '：已打（' + statSync(file).size + ' B）')
  }
  return worst
}

process.exit(main())
