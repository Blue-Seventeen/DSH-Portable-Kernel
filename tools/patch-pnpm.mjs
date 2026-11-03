/**
 * pnpm store 在 exFAT 上的补丁（项目注册整段容错）。
 *
 * 背景：pnpm 11 在每次**写操作**（install / add / remove）前会跑 prepareStoreDir → registerProject，
 * 它在 `<storeDir>/projects/<hash>` 建一个符号链接指回项目目录（prune 用的项目簿记）。
 * exFAT / FAT32 / 部分网络盘不支持符号链接，而且 pnpm 的兜底链在"EEXIST → 改名 → 重试 → unlink"
 * 里会抛 ENOENT（那个路径根本没被创建），于是 store 搬进便携盘后，商城就会"装不上也卸不掉"。
 *
 * 修法：把 registerProject 里的 `await symlinkDir(...)` 整段包进 try/catch **吞掉所有错误**。
 * 理由：项目注册只是 prune 的簿记，失败不影响安装 / 解析 / 内容寻址；而按错误码列白名单
 * 挡不住 pnpm 兜底链里冒出来的 ENOENT（v0.1.0 实测）。
 *
 *   node tools\patch-pnpm.mjs --check     # 0=已打 4=未打 2=版本或锚点不匹配 1=失败
 *   node tools\patch-pnpm.mjs --apply     # 幂等
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
  '    // 整段吞掉：项目注册只是 prune 的簿记，失败不影响安装；',
  '    // 在 exFAT 上 pnpm 会在"EEXIST→改名→重试→unlink"的兜底链里抛 ENOENT（路径根本没被创建），',
  '    // 按错误码列白名单挡不住它。',
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
    if (applied) { say('pnpm ' + version + '：已打（registerProject 已整段容错）'); return EXIT_OK }
    say('pnpm ' + version + '：未打（store 在 exFAT 上会装不上：EISDIR / ENOENT symlink）')
    return EXIT_NOT_APPLIED
  }

  if (REVERT) {
    const bak = backupPath(version)
    if (!existsSync(bak)) { say('没有备份可回退：' + bak); return EXIT_FAIL }
    writeFileSync(PNPM_DIST, readFileSync(bak))
    say('已回退 pnpm ' + version + ' 的 registerProject 补丁')
    return EXIT_OK
  }

  if (applied) {
    // 旧版补丁只吞了部分错误码：提示先 revert 再 apply 升级（不自动改写，避免半新半旧）
    if (/includes\(err && err\.code\)/.test(text)) {
      say('检测到旧版补丁（只吞部分错误码），先 --revert 再 --apply 升级')
      return EXIT_FAIL
    }
    say('pnpm ' + version + '：已经是打过补丁的状态，无需重复')
    return EXIT_OK
  }

  const blockAt = text.indexOf(BLOCK_START)
  const at = blockAt < 0 ? -1 : text.indexOf(ANCHOR, blockAt)
  if (blockAt < 0 || at < 0) {
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
