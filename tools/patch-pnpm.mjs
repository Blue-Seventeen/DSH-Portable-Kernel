/**
 * pnpm 在 exFAT 上的补丁（项目注册失败不阻断安装）—— 多副本 + 语义锚点版。
 *
 * 背景：pnpm 11 每次**写操作**（install / add / remove）前会跑
 *   prepareStoreDir() → registerProject() → symlinkDir()
 * 在 `<storeDir>/projects/<hash>` 建一个指回项目目录的符号链接（prune 用的簿记）。
 * exFAT 不支持符号链接，它的兜底链（EEXIST → 改名 → 重试 → unlink）还会再抛 ENOENT，
 * 于是**任何安装都会失败**（2026-11-04 实测：桌面里从商城装插件报 EISDIR，栈顶就是
 * `prepareStoreDir` 里的 `await registerProject(storeDir, lockfileDir);`）。
 *
 * 修法：只给这一行加 try/catch。registerProject 的返回值没人用，唯一的消费者是
 * pruneGlobalVirtualStore（我们用 hoisted linker，不走全局虚拟 store），吞掉是安全的。
 *
 * 为什么不再"整段替换 registerProject 函数"：那是逐字锚点，官方 pnpm 一改格式/重构就失配。
 * 现在按**语义**定位（prepareStoreDir 函数体里的这一次调用），并保留一个兜底锚点
 * （registerProject 内部的 symlinkDir 调用），两处都找不到才算 needs-adapt。
 *
 * 为什么多副本：便携壳里不止一份 pnpm——
 *   1) `runtime\pnpm`                          —— 壳自己的（CLI 装插件走这份）
 *   2) `desktop\resources\runtime\<...>\dependencies\pnpm` —— 桌面窗口内置的（**商城装/卸走这份**）
 * 只补一份，另一条路径仍会失败；而且官方 `update-app` / `update-desktop` 会整份替换它们。
 *
 * 用法：
 *   node tools\patch-pnpm.mjs --check    # 0=全部已打 / 4=有没打的 / 2=有锚点失配（needs-adapt）
 *   node tools\patch-pnpm.mjs --apply    # 幂等；--strict-version 时版本不在已验证清单就拒绝
 *   node tools\patch-pnpm.mjs --revert   # 用 cache\pnpm-pristine-<ver>\ 下的备份还原
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BACKUP_ROOT = join(ROOT, 'cache')

/** 只作展示与 `--strict-version` 判断：不在清单里的版本照样**尝试**打补丁（失败会明确报 needs-adapt） */
const VERIFIED = new Set(['11.28.5'])
const MARK = '/* [portable-pnpm] exFAT 无符号链接：项目注册簿记失败不影响安装 */'
/** v1 补丁留下的注释，用来把"老补丁"也认成已打（它功能上等价，不必重写） */
const LEGACY_MARK = '// [hack3rx] pnpm exFAT: 无符号链接的文件系统跳过项目注册'

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_ADAPT = 2
const EXIT_NOT_APPLIED = 4

const QUIET = process.argv.includes('--quiet')
const say = (m) => { if (!QUIET) console.log(m) }

/* ------------------------------------------------------------------ 发现副本 */

/** 找所有"带项目注册逻辑的 pnpm 主文件"（dist/pnpm.mjs，个别版本直接放 bin/） */
const candidates = () => {
  const out = new Set()
  const probe = (dir) => {
    for (const rel of ['dist/pnpm.mjs', 'bin/pnpm.mjs']) {
      const f = join(dir, rel)
      if (!existsSync(f)) continue
      try {
        const text = readFileSync(f, 'utf8')
        if (text.includes('registerProject') || text.includes('prepareStoreDir')) out.add(f)
      } catch { /* 读不动就跳过 */ }
    }
  }
  probe(join(ROOT, 'runtime', 'pnpm'))
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

const slug = (file) => file.slice(ROOT.length + 1).replace(/[\\/]+/g, '__').replace(/[^A-Za-z0-9_.-]/g, '_')
const backupPath = (version, file) => join(BACKUP_ROOT, 'pnpm-pristine-' + version, slug(file) + '.bak')

/* ------------------------------------------------------------------ 语义定位 */

// 按**调用形态**匹配，不绑参数名：官方 rename 参数不会让锚点失效
const CALL_RE = /await\s+registerProject\s*\([^)]*\)\s*;/
const SYMLINK_RE = /await\s+symlinkDir\s*\([^)]*\)\s*;/
const ENTRY = 'async function prepareStoreDir('
const FALLBACK_BLOCK = 'async function registerProject('

const indentOf = (text, at) => {
  const lineStart = text.lastIndexOf('\n', at) + 1
  const m = /^[ \t]*/.exec(text.slice(lineStart, at))
  return m ? m[0] : ''
}

/** 把 `statement`（含行首缩进）包成 try/catch，注释说明为什么可以吞 */
const wrap = (statement, indent) => [
  indent + 'try {',
  indent + '    ' + statement,
  indent + '} catch {',
  indent + '    ' + MARK,
  indent + '}',
].join('\n')

/** 返回 { at, kind }：优先语义锚点（prepareStoreDir 里的调用），退回 symlinkDir 那一行 */
const locate = (text) => {
  /** 在 [from, from+window) 里找第一个匹配，返回绝对位置与长度 */
  const find = (re, from, window) => {
    const seg = text.slice(from, from + window)
    const m = re.exec(seg)
    return m ? { at: from + m.index, len: m[0].length, text: m[0] } : null
  }
  const entryAt = text.indexOf(ENTRY)
  if (entryAt >= 0) {
    const hit = find(CALL_RE, entryAt, 4000)
    if (hit) return { ...hit, kind: 'prepareStoreDir' }
  }
  const blockAt = text.indexOf(FALLBACK_BLOCK)
  if (blockAt >= 0) {
    const hit = find(SYMLINK_RE, blockAt, 2000)
    if (hit) return { ...hit, kind: 'symlinkDir' }
  }
  const bare = find(CALL_RE, 0, text.length)
  if (bare) return { ...bare, kind: 'registerProject-call' }
  return null
}

const patchedState = (text) => {
  if (text.includes(MARK)) return 'applied'
  if (text.includes(LEGACY_MARK)) return 'applied-legacy'
  return 'not-applied'
}

/* --------------------------------------------------------------------- 动作 */

/** 只读：每个副本的状态（给 patch-all / doctor / verify 用） */
export const status = () => candidates().map((file) => {
  const text = readFileSync(file, 'utf8')
  const state = patchedState(text)
  const loc = state === 'not-applied' ? locate(text) : null
  return {
    file,
    rel: file.slice(ROOT.length + 1),
    version: versionOf(file),
    verified: VERIFIED.has(versionOf(file)),
    state: state === 'applied' ? 'applied' : state === 'applied-legacy' ? 'applied (v1)' : (loc ? 'not-applied' : 'needs-adapt'),
    anchor: loc ? loc.kind : null,
  }
})

/** 打补丁（幂等）。checkOnly 时只算状态不写盘 */
export const apply = ({ checkOnly = false, strictVersion = false } = {}) => {
  const rows = []
  for (const file of candidates()) {
    const rel = file.slice(ROOT.length + 1)
    const version = versionOf(file)
    const text = readFileSync(file, 'utf8')
    const state = patchedState(text)

    if (state === 'applied' || state === 'applied-legacy') {
      rows.push({ rel, version, state: 'applied', changed: false })
      continue
    }
    if (strictVersion && !VERIFIED.has(version)) {
      rows.push({ rel, version, state: 'needs-adapt', reason: 'version ' + (version || '?') + ' 不在已验证清单' })
      continue
    }
    const loc = locate(text)
    if (!loc) {
      rows.push({ rel, version, state: 'needs-adapt', reason: '找不到 prepareStoreDir / symlinkDir 锚点' })
      continue
    }
    if (checkOnly) {
      rows.push({ rel, version, state: 'not-applied', anchor: loc.kind, changed: false })
      continue
    }
    const bak = backupPath(version, file)
    if (!existsSync(bak)) {
      mkdirSync(dirname(bak), { recursive: true })
      copyFileSync(file, bak)
    }
    const statement = loc.text
    const indent = indentOf(text, loc.at)
    const out = text.slice(0, loc.at) + wrap(statement, indent) + text.slice(loc.at + statement.length)
    writeFileSync(file, out)
    const back = readFileSync(file, 'utf8')
    if (!back.includes(MARK)) {
      rows.push({ rel, version, state: 'failed', reason: '写盘校验失败' })
      continue
    }
    rows.push({ rel, version, state: 'applied', anchor: loc.kind, changed: true, bytes: statSync(file).size })
  }
  return rows
}

export const revert = () => {
  const rows = []
  for (const file of candidates()) {
    const version = versionOf(file)
    const bak = backupPath(version, file)
    if (!existsSync(bak)) { rows.push({ rel: file.slice(ROOT.length + 1), state: 'no-backup' }); continue }
    writeFileSync(file, readFileSync(bak))
    rows.push({ rel: file.slice(ROOT.length + 1), state: 'reverted' })
  }
  return rows
}

/** 纯文本回归（不碰文件）：两代真实形状都要能定位到 prepareStoreDir 里的那次调用 */
export const selftest = () => {
  const cases = [
    {
      name: 'pnpm 11.28.5 prepareStoreDir(storeDir, lockfileDir, frozenStore)',
      text: ['async function prepareStoreDir(storeDir, lockfileDir, frozenStore) {',
        '  if (!frozenStore) {',
        '    await fs89.mkdir(storeDir, { recursive: true });',
        '    await registerProject(storeDir, lockfileDir);',
        '  }',
        '}'].join('\n'),
    },
    {
      name: 'pnpm 未来形状（参数改名、调用换了位置）',
      text: ['async function prepareStoreDir(store, dir, readOnly) {',
        '  if (readOnly) return;',
        '  await fs.mkdir(store, { recursive: true });',
        '  await registerProject(store, dir);',
        '}'].join('\n'),
    },
    {
      name: '只剩 registerProject 内的 symlinkDir 可定位（兜底锚点）',
      text: ['async function registerProject(storeDir, projectDir) {',
        '  const linkPath = path.join(registryDir, createShortHash(projectDir));',
        '  await symlinkDir(projectDir, linkPath);',
        '}'].join('\n'),
    },
  ]
  const results = []
  for (const c of cases) {
    const loc = locate(c.text)
    const ok = Boolean(loc)
    results.push({ name: c.name, ok, anchor: loc ? loc.kind : null })
  }
  return results
}

/* ---------------------------------------------------------------------- CLI */

const main = () => {
  const argv = process.argv.slice(2)
  const APPLY = argv.includes('--apply')
  const REVERT = argv.includes('--revert')
  const CHECK = argv.includes('--check') || (!APPLY && !REVERT)
  const STRICT = argv.includes('--strict-version')

  if (argv.includes('--selftest')) {
    const rows = selftest()
    let bad = 0
    for (const r of rows) {
      say('  ' + (r.ok ? 'OK  ' : 'FAIL') + ' ' + r.name + (r.anchor ? ' [' + r.anchor + ']' : ''))
      if (!r.ok) bad++
    }
    say(bad ? '  patch-pnpm 自测失败：' + bad : '  patch-pnpm 自测通过：' + rows.length)
    return bad ? EXIT_FAIL : EXIT_OK
  }
  if (!candidates().length) { say('没有找到任何 pnpm（runtime\\pnpm 与 desktop\\resources 下都没有）'); return EXIT_ADAPT }

  if (REVERT) {
    let worst = EXIT_OK
    for (const r of revert()) {
      if (r.state === 'reverted') say('  ' + r.rel + '：已回退')
      else { say('  ' + r.rel + '：没有备份可回退'); worst = EXIT_FAIL }
    }
    return worst
  }
  if (CHECK) {
    let worst = EXIT_OK
    for (const r of status()) {
      if (r.state.startsWith('applied')) say('  ' + r.rel + '：已打' + (r.state.includes('v1') ? '（v1）' : ''))
      else if (r.state === 'not-applied') { say('  ' + r.rel + '：未打（exFAT 上装/卸插件会失败；锚点 ' + r.anchor + '）'); worst = Math.max(worst, EXIT_NOT_APPLIED) }
      else { say('  ' + r.rel + '：锚点失配（pnpm ' + (r.version || '?') + ' 可能改版了）'); worst = Math.max(worst, EXIT_ADAPT) }
    }
    return worst
  }

  let worst = EXIT_OK
  for (const r of apply({ strictVersion: STRICT })) {
    if (r.state === 'applied') say('  ' + r.rel + '：' + (r.changed ? '已打（' + r.anchor + '，' + r.bytes + ' B）' : '已经是打过补丁的状态'))
    else if (r.state === 'not-applied') { say('  ' + r.rel + '：未打'); worst = Math.max(worst, EXIT_NOT_APPLIED) }
    else if (r.state === 'needs-adapt') { say('  ' + r.rel + '：needs-adapt（' + r.reason + '）'); worst = Math.max(worst, EXIT_ADAPT) }
    else { say('  ' + r.rel + '：失败（' + (r.reason || '') + '）'); worst = Math.max(worst, EXIT_FAIL) }
  }
  return worst
}

const invokedDirectly = (() => {
  try { return pathToFileURL(process.argv[1]).href.toLowerCase() === import.meta.url.toLowerCase() } catch { return false }
})()
if (invokedDirectly) process.exit(main())
