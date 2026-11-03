/**
 * pnpm store 在 exFAT 上的补丁（项目注册改成"不支持符号链接就跳过"）。
 *
 * 背景：pnpm 11 在每次**写操作**（install / add / remove）前会跑 prepareStoreDir → registerProject，
 * 它在 `<storeDir>/projects/<hash>` 建一个**符号链接**指回项目目录（prune 用的项目簿记）。
 * exFAT / FAT32 / 部分网络盘不支持符号链接，于是任何安装都会以
 *   EISDIR: illegal operation on a directory, symlink '..\..\proj' -> '<store>\projects\<hash>'
 * 失败——store 搬进便携盘（migrate-store）之后，商城就会"装不上也卸不掉"。
 *
 * 修法：把 registerProject 里那一行 `await symlinkDir(...)` 包进 try/catch，
 * 只吞掉"文件系统不支持符号链接"类的错误码；其它错误照旧抛出。
 * 影响面：仅"prune 的项目簿记"缺失，不影响安装 / 解析 / 内容寻址。
 *
 *   node tools\patch-pnpm.mjs --check     # 0=已打 4=未打 2=版本或锚点不匹配 1=失败
 *   node tools\patch-pnpm.mjs --apply     # 幂等（已打过就直接返回）
 *   node tools\patch-pnpm.mjs --revert    # 用 cache\pnpm-pristine-<ver>\pnpm.mjs 还原
 *
 * 为什么要单独一个工具：`runtime\` 是官方层、不进 git，`update-app` / `bootstrap` 换 pnpm 会把它冲掉，
 * 所以 `repair` 每次都要能重新打上。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PNPM_DIR = join(ROOT, 'runtime', 'pnpm')
const PNPM_DIST = join(PNPM_DIR, 'dist', 'pnpm.mjs')
const PNPM_PKG = join(PNPM_DIR, 'package.json')
const BACKUP_ROOT = join(ROOT, 'cache')

/** 只对验证过的 pnpm 版本动手：其它版本锚点可能不同，宁可不打也不能打坏 */
const SUPPORTED = new Set(['11.28.5'])
/** 幂等标记（只看这一行就够） */
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
  '    // 不吞掉这个错误的话，store 在 exFAT 上会让任何 install/add/remove 都 EISDIR',
  '    if (!["EISDIR", "EPERM", "ENOSYS", "EINVAL", "ENOTSUP"].includes(err && err.code)) throw err;',
  '  }',
  '',
].join('\n')

const readVersion = () => {
  try { return String(JSON.parse(readFileSync(PNPM_PKG, 'utf8')).version || '').trim() } catch { return '' }
}
const backupPath = (version) => join(BACKUP_ROOT, 'pnpm-pristine-' + version, 'pnpm.mjs')

const main = () => {
  const version = readVersion()
  if (!existsSync(PNPM_DIST)) { say('没有 runtime\\pnpm\\dist\\pnpm.mjs（还没 bootstrap？）'); return EXIT_VERSION }
  if (!SUPPORTED.has(version)) {
    say('pnpm 版本 ' + (version || '(读不到)') + ' 不在已验证清单里（' + [...SUPPORTED].join(', ') + '）：不改动')
    return EXIT_VERSION
  }
  const text = readFileSync(PNPM_DIST, 'utf8')
  const applied = text.includes(MARK)

  if (CHECK) {
    if (applied) { say('pnpm ' + version + '：已打（registerProject 已容错）'); return EXIT_OK }
    say('pnpm ' + version + '：未打（store 在 exFAT 上会装不上：EISDIR symlink）')
    return EXIT_NOT_APPLIED
  }

  if (REVERT) {
    const bak = backupPath(version)
    if (!existsSync(bak)) { say('没有备份可回退：' + bak); return EXIT_FAIL }
    writeFileSync(PNPM_DIST, readFileSync(bak))
    say(text.includes(MARK) ? '已回退 pnpm ' + version + ' 的 registerProject 补丁' : '当前没有补丁，已用备份覆盖回去（幂等）')
    return EXIT_OK
  }

  if (applied) { say('pnpm ' + version + '：已经是打过补丁的状态，无需重复'); return EXIT_OK }

  const at = text.indexOf(ANCHOR, text.indexOf(BLOCK_START))
  if (text.indexOf(BLOCK_START) < 0 || at < 0) {
    say('找不到 registerProject 锚点（pnpm ' + version + ' 的结构变了）：不改动')
    return EXIT_VERSION
  }
  const bak = backupPath(version)
  if (!existsSync(bak)) {
    mkdirSync(dirname(bak), { recursive: true })
    copyFileSync(PNPM_DIST, bak)
    say('原件已备份：' + bak)
  }
  const out = text.slice(0, at) + PATCHED + text.slice(at + ANCHOR.length)
  writeFileSync(PNPM_DIST, out)
  const back = readFileSync(PNPM_DIST, 'utf8')
  if (!back.includes(MARK) || back.length <= text.length) { say('写盘校验失败：' + PNPM_DIST); return EXIT_FAIL }
  say('已给 pnpm ' + version + ' 打上 registerProject 容错补丁（' + statSync(PNPM_DIST).size + ' B）')
  return EXIT_OK
}

process.exit(main())
