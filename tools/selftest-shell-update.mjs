/**
 * 壳换装引擎自测（A–I 九用例）。
 *
 *   node tools\selftest-shell-update.mjs [--keep]
 *
 * 做的事：在 tmp\selftest\<case>\ 下造一个"迷你壳"（tools\*.mjs 从真仓库复制过去），
 * 直接 import tools\shell-apply.mjs 的导出函数跑 apply / rollback / recover，
 * 逐条断言，最后打印 PASS/FAIL 表，退出码 0/1，并删掉 tmp\selftest。
 *
 * 只写 tmp\selftest\ 下的东西（每个用例独立 root / stage / backupRoot）；
 * --keep 是给调试用的：保留夹具不删。
 *
 * 用例：
 *   A add / update / skip 判定正确 + 导出契约；随后 rollbackUpdate 整体还原
 *   B userOwned：被用户改过 → preserved 且字节不变；没改过 → update
 *   C 官方层与用户数据隔离（app\ desktop\ runtime\node home\sessions 凭证）+ 越界路径全拒
 *   D 删除只动"自己装过"的文件；用户手放的不删；回滚能把删掉的还回来
 *   E verify 不通过 → 整体回滚（字节与备份一致、journal 清掉、无 .new 残留）
 *   F 残留 journal → recoverUpdate 按备份还原（含损坏 journal 与搬家兜底）
 *   G dryRun 零写盘（不建目录、不写 journal、不跑 verify 与迁移）
 *   H staging 坏文件（sha 不符）→ 整体失败且零写盘
 *   I 迁移脚本真的被执行并记录（不在清单里的、非 tools\ 的一律拒绝）
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { APPLY_JOURNAL, applyUpdate, listBackups, recoverUpdate, rollbackUpdate } from './shell-apply.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BASE = join(ROOT, 'tmp', 'selftest')
const KEEP = process.argv.includes('--keep')
const TOOLS = join(ROOT, 'tools')

// ---- 夹具目录的安全闸：只许在 <repo>\tmp\selftest 下造/删东西 ----------------------
if (!BASE.toLowerCase().startsWith(ROOT.toLowerCase() + '\\') && !BASE.toLowerCase().startsWith(ROOT.toLowerCase() + '/')) {
  console.error('selftest：夹具目录不在仓库里，拒绝运行：' + BASE)
  process.exit(2)
}
if (dirname(BASE).toLowerCase() !== join(ROOT, 'tmp').toLowerCase() || !BASE.toLowerCase().endsWith('selftest')) {
  console.error('selftest：夹具目录形状不对（必须是 <repo>\\tmp\\selftest），拒绝运行：' + BASE)
  process.exit(2)
}
if (!existsSync(TOOLS)) {
  console.error('selftest：找不到 tools 目录：' + TOOLS)
  process.exit(2)
}
const TOOL_MJS = readdirSync(TOOLS).filter((n) => n.toLowerCase().endsWith('.mjs')).sort()
if (!TOOL_MJS.length) {
  console.error('selftest：tools 下没有 .mjs 可复制进夹具')
  process.exit(2)
}

// ---- 现场小工具 -------------------------------------------------------------
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const shaText = (t) => sha(Buffer.from(String(t), 'utf8'))
const shaFile = (abs) => sha(readFileSync(abs))
const absIn = (base, rel) => join(base, ...rel.split('/'))
const put = (base, rel, text) => {
  const abs = absIn(base, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text)
  return abs
}
const read = (base, rel) => {
  try { return readFileSync(absIn(base, rel), 'utf8') } catch { return null }
}
const same = (a, b) => {
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return a === b }
}
const fmt = (v) => {
  if (v === undefined) return 'undefined'
  try {
    const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)
    return s === undefined ? String(v) : (s.length > 300 ? s.slice(0, 300) + '…' : s)
  } catch { return String(v) }
}

/** 目录下所有文件的 rel → sha256（用来断言"一个字节都没动"） */
const snapshot = (dir) => {
  const out = {}
  const walk = (d, prefix) => {
    let ents = []
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const rel = prefix ? prefix + '/' + e.name : e.name
      if (e.isDirectory()) walk(join(d, e.name), rel)
      else if (e.isFile()) {
        try { out[rel] = shaFile(join(d, e.name)) } catch { out[rel] = 'unreadable' }
      }
    }
  }
  walk(dir, '')
  return out
}
const diffSnap = (a, b) => {
  const keys = new Set(Object.keys(a).concat(Object.keys(b)))
  const out = []
  for (const k of keys) {
    if (a[k] === b[k]) continue
    out.push(k + '（' + (a[k] ? a[k].slice(0, 8) : '缺失') + ' -> ' + (b[k] ? b[k].slice(0, 8) : '缺失') + '）')
  }
  return out.sort()
}
/** 全盘找 .new 影子文件（换装后不该残留） */
const findNew = (dir) => {
  const out = []
  const walk = (d) => {
    let ents = []
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.toLowerCase().endsWith('.new')) out.push(p)
    }
  }
  walk(dir)
  return out
}

// ---- 白名单谓词（由"调用方"注入的那一个；夹具里自己实现一份，不依赖真仓库的） ------
const ALLOW_EXACT = new Set(['readme.md', 'license', 'shell-version.json', 'dsh-portable.ps1', 'env.cmd', 'preflight.cmd'])
const ALLOW_PREFIX = ['tools/', 'runtime/vcredist/', 'home/profiles/']
const relOf = (p) => {
  if (typeof p !== 'string') return null
  const raw = p.trim()
  if (!raw || raw.indexOf('\0') !== -1) return null
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) return null
  const posix = raw.replace(/\\/g, '/')
  const segs = posix.split('/')
  for (const s of segs) if (!s || s === '.' || s === '..') return null
  return posix
}
const isAllowed = (p) => {
  const rel = relOf(p)
  if (!rel) return false
  const low = rel.toLowerCase()
  if (ALLOW_EXACT.has(low)) return true
  return ALLOW_PREFIX.some((pre) => low.startsWith(pre) && low.length > pre.length)
}

// ---- 远端清单 / 已装清单构造 ---------------------------------------------------
/** 把远端文件写进 stage，并按真实字节算 sha256，返回契约里的 manifest 对象 */
const buildRemote = (stage, files, userOwned, remove) => {
  const map = {}
  for (const rel of Object.keys(files)) {
    put(stage, rel, files[rel])
    map[rel] = shaFile(absIn(stage, rel))
  }
  const json = { schemaVersion: 2, shellVersion: '0.1.0', files: map, userOwned: userOwned || [] }
  if (remove && remove.length) json.remove = remove
  return {
    raw: Buffer.from(JSON.stringify(json, null, 2) + '\n', 'utf8'),
    files: map,
    userOwned: userOwned || [],
    remove: remove || [],
  }
}
const installedFrom = (files, shellVersion) => ({
  present: true,
  shellVersion: shellVersion || '0.0.9',
  files: files || {},
})
/** 只有路径、sha 随便的清单（用来测"整份拒绝"） */
const rawManifest = (paths) => {
  const files = {}
  for (const p of paths) files[p] = shaText('x')
  return { raw: Buffer.from('{"files":{}}\n', 'utf8'), files, userOwned: [] }
}
const baseOpts = (c, extra) => Object.assign({
  root: c.root,
  stage: c.stage,
  backupRoot: c.backupRoot,
  journalPath: c.journal,
  manifest: null,
  installed: installedFrom({}),
  isAllowed,
  verify: { cmd: null, enabled: false },
  migrations: [],
  dryRun: false,
  logger: () => {},
}, extra || {})
/** 最新一份备份的 meta + 目录 */
const newestBackup = (backupRoot) => {
  const list = listBackups(backupRoot)
  if (!list.length) return { meta: null, dir: '', name: '' }
  let meta = null
  try { meta = JSON.parse(readFileSync(join(list[0].dir, 'meta.json'), 'utf8')) } catch {}
  return { meta, dir: list[0].dir, name: list[0].name }
}

// ---- 用例执行器 --------------------------------------------------------------
const results = []
const runCase = async (id, title, fn) => {
  const root = join(BASE, id)
  const stage = join(BASE, '_stage', id)
  const backupRoot = join(BASE, '_backup', id)
  const journal = join(root, APPLY_JOURNAL)
  rmSync(root, { recursive: true, force: true })
  rmSync(stage, { recursive: true, force: true })
  rmSync(backupRoot, { recursive: true, force: true })
  mkdirSync(join(root, 'tools'), { recursive: true })
  for (const f of TOOL_MJS) copyFileSync(join(TOOLS, f), join(root, 'tools', f))

  const rec = { id, title, asserts: [], error: '', ms: 0 }
  const c = {
    id, root, stage, backupRoot, journal,
    eq: (name, actual, expected) => rec.asserts.push({ name, ok: same(actual, expected), expected, actual }),
    ok: (name, actual) => rec.asserts.push({ name, ok: !!actual, expected: true, actual }),
    no: (name, actual) => rec.asserts.push({ name, ok: !actual, expected: false, actual }),
  }
  const t0 = Date.now()
  try { await fn(c) } catch (e) { rec.error = String((e && e.stack) || e) }
  rec.ms = Date.now() - t0
  rec.pass = !rec.error && rec.asserts.length > 0 && rec.asserts.every((a) => a.ok)
  results.push(rec)

  process.stdout.write('\n[' + id + '] ' + title + '   (' + rec.ms + 'ms)\n')
  if (rec.error) process.stdout.write('    ERROR  ' + rec.error.replace(/\n/g, '\n           ') + '\n')
  for (const a of rec.asserts) {
    if (a.ok) {
      const tail = typeof a.actual === 'boolean' ? '' : ' = ' + fmt(a.actual)
      process.stdout.write('    ok     ' + a.name + tail + '\n')
    } else {
      process.stdout.write('    FAIL   ' + a.name + '\n')
      process.stdout.write('           期望：' + fmt(a.expected) + '\n')
      process.stdout.write('           实际：' + fmt(a.actual) + '\n')
    }
  }
}

// ---- A ---------------------------------------------------------------------
const caseA = () => runCase('A', 'add / update / skip 判定 + rollback 还原', async (c) => {
  c.eq('导出 APPLY_JOURNAL', APPLY_JOURNAL, 'tmp/shell-update-journal.json')
  c.eq('导出函数齐全', [typeof listBackups, typeof applyUpdate, typeof rollbackUpdate, typeof recoverUpdate],
    ['function', 'function', 'function', 'function'])

  const A_OLD = 'export const a = 1\n'
  const A_NEW = 'export const a = 2\n'
  const B_SAME = 'export const b = 1\n'
  const C_NEW = 'export const c = 1\n'
  const MANIFEST_JSON = '{"shellVersion":"0.1.0"}\n'
  put(c.root, 'tools/a.mjs', A_OLD)
  put(c.root, 'tools/b.mjs', B_SAME)
  const remote = buildRemote(c.stage, {
    'shell-version.json': MANIFEST_JSON,
    'tools/a.mjs': A_NEW,
    'tools/b.mjs': B_SAME,
    'tools/c.mjs': C_NEW,
  })
  const installed = installedFrom({ 'tools/a.mjs': shaText(A_OLD), 'tools/b.mjs': shaText(B_SAME) })
  const r = await applyUpdate(baseOpts(c, { manifest: remote, installed }))

  c.eq('ok', r.ok, true)
  c.eq('action', r.action, 'apply')
  c.eq('from', r.from, '0.0.9')
  c.eq('to', r.to, '0.1.0')
  c.eq('applied（只 add/update）', r.applied,
    [{ path: 'shell-version.json', action: 'add' }, { path: 'tools/a.mjs', action: 'update' }, { path: 'tools/c.mjs', action: 'add' }])
  c.eq('skipped（sha 一样）', r.skipped, ['tools/b.mjs'])
  c.eq('deleted', r.deleted, [])
  c.eq('清单自身也能随壳落盘（版本号才会前进）', read(c.root, 'shell-version.json'), MANIFEST_JSON)
  c.eq('a.mjs 已更新', read(c.root, 'tools/a.mjs'), A_NEW)
  c.eq('c.mjs 已新增', read(c.root, 'tools/c.mjs'), C_NEW)
  c.eq('b.mjs 未变', read(c.root, 'tools/b.mjs'), B_SAME)
  c.no('journal 已清', existsSync(c.journal))
  const baks = listBackups(c.backupRoot)
  c.eq('备份 1 份', baks.map((b) => b.name).length, 1)
  c.eq('备份 meta 存在', existsSync(join(baks[0] ? baks[0].dir : '', 'meta.json')), true)
  c.eq('备份里存了换装前字节', shaFile(join(baks[0] ? baks[0].dir : '', 'files', 'tools', 'a.mjs')), shaText(A_OLD))
  c.eq('无 .new 残留', findNew(c.root), [])

  // 顺带验语义 9：用最新备份整体还原
  const rb = await rollbackUpdate({
    root: c.root, backupRoot: c.backupRoot, journalPath: c.journal,
    installed: installedFrom({ 'tools/a.mjs': remote.files['tools/a.mjs'] }, '0.1.0'),
    verify: { cmd: null, enabled: false }, logger: () => {},
  })
  c.eq('rollback ok', rb.ok, true)
  c.eq('rollback action', rb.action, 'rollback')
  c.eq('rollback to（回到 0.0.9）', rb.to, '0.0.9')
  c.eq('rollback 后 a.mjs 还原', read(c.root, 'tools/a.mjs'), A_OLD)
  c.no('rollback 后 c.mjs 被删掉', existsSync(absIn(c.root, 'tools/c.mjs')))
  c.no('rollback 后 shell-version.json 也撤掉（版本号跟着回去）', existsSync(absIn(c.root, 'shell-version.json')))
  c.eq('rollback 后 b.mjs 未变', read(c.root, 'tools/b.mjs'), B_SAME)
  c.eq('备份 meta 标了 rolled-back', (newestBackup(c.backupRoot).meta || {}).phase, 'rolled-back')
})

// ---- B ---------------------------------------------------------------------
const caseB = () => runCase('B', 'userOwned：改过的保留 / 没改过的更新', async (c) => {
  const EDITED = '{"user":"edited"}\n'
  const OFF1 = '{"official":1}\n'
  const OFF2 = '{"official":2}\n'
  put(c.root, 'home/profiles/package.json', EDITED)
  put(c.root, 'home/profiles/web/package.json', OFF1)
  const remote = buildRemote(c.stage, {
    'home/profiles/package.json': OFF2,
    'home/profiles/web/package.json': OFF2,
  }, ['home/profiles/package.json', 'home/profiles/web/package.json'])
  const installed = installedFrom({
    'home/profiles/package.json': shaText(OFF1),
    'home/profiles/web/package.json': shaText(OFF1),
  })
  const r = await applyUpdate(baseOpts(c, { manifest: remote, installed }))

  c.eq('ok', r.ok, true)
  c.eq('preserved（用户改过的那个）', r.preserved, ['home/profiles/package.json'])
  c.eq('applied（没改过的那个）', r.applied, [{ path: 'home/profiles/web/package.json', action: 'update' }])
  c.eq('用户改动字节不变', read(c.root, 'home/profiles/package.json'), EDITED)
  c.no('preserved 不进备份（没动它，不占地方）', 'home/profiles/package.json' in ((newestBackup(c.backupRoot).meta || {}).files || {}))
  c.eq('没改过的被更新成新版', read(c.root, 'home/profiles/web/package.json'), OFF2)
  c.eq('更新过的进备份（老字节在）',
    shaFile(join(newestBackup(c.backupRoot).dir, 'files', 'home', 'profiles', 'web', 'package.json')), shaText(OFF1))

  // 集成护栏：installed.files 必须是 { rel: sha256 } 映射；写成数组（旧 readLocalManifest 的形状）
  // 会被忽略并告警 —— 那种情况下 userOwned 一律按"用户改过"保留，绝不敢覆盖。
  const legacy = await applyUpdate(baseOpts(c, {
    manifest: remote,
    installed: { present: true, shellVersion: '0.0.9', files: ['home/profiles/package.json'] },
  }))
  c.ok('installed.files 形状不对会告警', legacy.warnings.some((w) => /sha256 不合法/.test(w)))
  c.eq('形状不对时 userOwned 一律按"改过"保留', legacy.preserved, ['home/profiles/package.json'])
  c.eq('形状不对时这不影响 ok（只是保守）', legacy.ok, true)
})

// ---- C ---------------------------------------------------------------------
const caseC = () => runCase('C', '官方层/用户数据隔离 + 越界路径全拒', async (c) => {
  const official = {
    'app/x.txt': 'official app\n',
    'desktop/y.txt': 'official desktop\n',
    'runtime/node/z.txt': 'official node\n',
    'home/sessions/s.jsonl': '{"session":1}\n',
    'home/.credentials.yaml': 'token: secret\n',
  }
  for (const rel of Object.keys(official)) put(c.root, rel, official[rel])
  const before = {}
  for (const rel of Object.keys(official)) before[rel] = shaFile(absIn(c.root, rel))

  put(c.root, 'tools/a.mjs', 'export const a = 1\n')
  const remote = buildRemote(c.stage, { 'tools/a.mjs': 'export const a = 2\n' })
  const r = await applyUpdate(baseOpts(c, {
    manifest: remote,
    installed: installedFrom({ 'tools/a.mjs': shaText('export const a = 1\n') }),
  }))
  c.eq('正常换装 ok', r.ok, true)
  const after = {}
  for (const rel of Object.keys(official)) after[rel] = shaFile(absIn(c.root, rel))
  c.eq('官方层 + 会话 + 凭证 哈希前后一致', diffSnap(before, after), [])

  // C1：清单里混进官方层路径 → 整份拒绝、零写入
  const r2 = await applyUpdate(baseOpts(c, { manifest: rawManifest(['app/x.txt']), installed: installedFrom({}) }))
  c.eq('清单含 app/x.txt 被整份拒绝', r2.ok, false)
  c.ok('拒绝原因点名白名单', r2.errors.some((e) => /白名单|isAllowed/.test(e)))
  c.eq('app/x.txt 未被改', shaFile(absIn(c.root, 'app/x.txt')), before['app/x.txt'])

  // C2：就算 isAllowed 全放行，路径规范化闸也要挡住 .. / 盘符 / 绝对路径 / NUL
  const allowAll = () => true
  const evilPaths = ['../evil.txt', 'tools/../../evil.txt', 'C:/evil.txt', '/evil.txt', 'tools/a\0.mjs', '..\\evil.txt']
  const outcomes = []
  for (const bad of evilPaths) {
    const rr = await applyUpdate(baseOpts(c, { manifest: rawManifest([bad]), installed: installedFrom({}), isAllowed: allowAll }))
    outcomes.push(rr.ok === false && rr.errors.length > 0)
  }
  c.eq('6 条越界路径全部被拒', outcomes, evilPaths.map(() => true))
  c.no('仓库外没有被写文件', existsSync(join(BASE, 'evil.txt')))
  c.eq('tools/a.mjs 仍是换装后的新版', read(c.root, 'tools/a.mjs'), 'export const a = 2\n')
})

// ---- D ---------------------------------------------------------------------
const caseD = () => runCase('D', '删除只动自己装过的文件 + 回滚能还回来', async (c) => {
  const OLD = 'export const old = 1\n'
  const KEEP1 = 'export const keep = 1\n'
  const KEEP2 = 'export const keep = 2\n'
  const USER = '// 我自己放的，别动\n'
  put(c.root, 'tools/old.mjs', OLD)
  put(c.root, 'tools/keep.mjs', KEEP1)
  put(c.root, 'tools/user.mjs', USER)
  const remote = buildRemote(c.stage, { 'tools/keep.mjs': KEEP2 })
  const installed = installedFrom({ 'tools/old.mjs': shaText(OLD), 'tools/keep.mjs': shaText(KEEP1) })
  const r = await applyUpdate(baseOpts(c, { manifest: remote, installed }))

  c.eq('ok', r.ok, true)
  c.eq('deleted（只删上一版清单里的）', r.deleted, ['tools/old.mjs'])
  c.no('old.mjs 已删', existsSync(absIn(c.root, 'tools/old.mjs')))
  c.eq('用户手放 user.mjs 原样保留', read(c.root, 'tools/user.mjs'), USER)
  c.eq('keep.mjs 已更新', read(c.root, 'tools/keep.mjs'), KEEP2)
  const bm = newestBackup(c.backupRoot)
  c.eq('备份 meta 记了删除', (bm.meta || {}).deleted, ['tools/old.mjs'])
  c.eq('被删文件进了备份', shaFile(join(bm.dir, 'files', 'tools', 'old.mjs')), shaText(OLD))

  const rb = await rollbackUpdate({
    root: c.root, backupRoot: c.backupRoot, journalPath: c.journal,
    installed: installedFrom({}, '0.1.0'), verify: { cmd: null, enabled: false }, logger: () => {},
  })
  c.eq('rollback ok', rb.ok, true)
  c.eq('被删的 old.mjs 回来了', read(c.root, 'tools/old.mjs'), OLD)
  c.eq('keep.mjs 还原成老版', read(c.root, 'tools/keep.mjs'), KEEP1)
  c.eq('user.mjs 始终没被动过', read(c.root, 'tools/user.mjs'), USER)
})

// ---- E ---------------------------------------------------------------------
const caseE = () => runCase('E', 'verify 失败 → 整体回滚', async (c) => {
  const A1 = 'export const a = 1\n'
  const A2 = 'export const a = 2\n'
  const GONE = 'export const gone = 1\n'
  put(c.root, 'tools/a.mjs', A1)
  put(c.root, 'tools/gone.mjs', GONE)
  const remote = buildRemote(c.stage, { 'tools/a.mjs': A2, 'tools/new.mjs': 'export const n = 1\n' })
  const installed = installedFrom({ 'tools/a.mjs': shaText(A1), 'tools/gone.mjs': shaText(GONE) })
  const before = snapshot(c.root)
  const r = await applyUpdate(baseOpts(c, {
    manifest: remote,
    installed,
    verify: { cmd: [process.execPath, '-e', 'process.exit(3)'], enabled: true },
  }))

  c.eq('ok', r.ok, false)
  c.eq('rolledBack', r.rolledBack, true)
  c.eq('verify.ok', r.verify.ok, false)
  c.eq('verify.code', r.verify.code, 3)
  c.eq('verify.ran', r.verify.ran, true)
  c.ok('errors 点名自检失败', r.errors.some((e) => /自检/.test(e)))
  c.eq('整棵树字节与换装前一致', diffSnap(before, snapshot(c.root)), [])
  c.no('journal 已清', existsSync(c.journal))
  c.eq('无 .new 残留', findNew(c.root), [])
  c.no('本次新增的 new.mjs 没留下', existsSync(absIn(c.root, 'tools/new.mjs')))
  c.eq('被删的 gone.mjs 已还原', existsSync(absIn(c.root, 'tools/gone.mjs')), true)
  c.eq('a.mjs 回到老字节', read(c.root, 'tools/a.mjs'), A1)
  const bm = newestBackup(c.backupRoot)
  c.eq('备份 meta 标了 rolled-back', (bm.meta || {}).phase, 'rolled-back')
  c.eq('备份里留着换装前字节', shaFile(join(bm.dir, 'files', 'tools', 'a.mjs')), shaText(A1))
})

// ---- F ---------------------------------------------------------------------
const caseF = () => runCase('F', '残留 journal → recoverUpdate 还原', async (c) => {
  const A1 = 'export const a = 1\n'
  const A2 = 'export const a = 2\n'
  put(c.root, 'tools/a.mjs', A1)

  // 手工造一份"上次换装写到一半被杀"的现场：备份齐、meta 齐、journal 齐
  const backupName = 'shell-backup-20260101-000001'
  const bdir = join(c.backupRoot, backupName)
  const btools = join(bdir, 'files', 'tools')
  mkdirSync(btools, { recursive: true })
  copyFileSync(absIn(c.root, 'tools/a.mjs'), join(btools, 'a.mjs'))
  const meta = {
    schemaVersion: 1, tool: 'shell-apply', action: 'apply', from: '0.0.9', to: '0.1.0',
    root: c.root, startedAt: '2026-01-01T00:00:01.000Z', finishedAt: null, phase: 'writing',
    backupRoot: c.backupRoot, backupName,
    planned: { add: ['tools/new.mjs'], update: ['tools/a.mjs'], delete: [], preserved: [], skipped: [] },
    applied: [], deleted: [], preserved: [], skipped: [],
    verify: { ok: null, code: null }, migrations: [],
    files: {
      'tools/a.mjs': { existed: true, sha256: shaText(A1) },
      'tools/new.mjs': { existed: false, sha256: null },
    },
  }
  writeFileSync(join(bdir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  put(c.root, 'tools/a.mjs', A2) // 断电时已经写进去了
  put(c.root, 'tools/new.mjs', 'export const n = 1\n')
  mkdirSync(dirname(c.journal), { recursive: true })
  const journal = {
    version: 1, state: 'applying', action: 'apply', from: '0.0.9', to: '0.1.0', root: c.root,
    startedAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:02.000Z', phase: 'writing',
    backup: bdir, backupRel: '../_backup/F/' + backupName, backupRoot: c.backupRoot, backupName,
    plan: meta.planned, applied: [], deleted: [], verify: { ok: null, code: null },
  }
  writeFileSync(c.journal, JSON.stringify(journal, null, 2) + '\n')

  const baks = listBackups(c.backupRoot)
  c.eq('listBackups 看得见手工备份', baks.map((b) => b.name), [backupName])
  c.eq('listBackups 读出 from/to', [baks[0].from, baks[0].to], ['0.0.9', '0.1.0'])

  const r = await recoverUpdate({
    root: c.root, backupRoot: c.backupRoot, journalPath: c.journal,
    installed: installedFrom({}, '0.1.0'), verify: { cmd: null, enabled: false }, logger: () => {},
  })
  c.eq('ok', r.ok, true)
  c.eq('action', r.action, 'recover')
  c.eq('rolledBack', r.rolledBack, true)
  c.eq('noop=false（真干了活）', r.noop, false)
  c.eq('a.mjs 还原成老字节', read(c.root, 'tools/a.mjs'), A1)
  c.no('断电时新落盘的 new.mjs 被清掉', existsSync(absIn(c.root, 'tools/new.mjs')))
  c.no('journal 已清', existsSync(c.journal))

  const r2 = await recoverUpdate({ root: c.root, backupRoot: c.backupRoot, journalPath: c.journal, verify: { cmd: null, enabled: false }, logger: () => {} })
  c.eq('没有 journal 时是 noop', [r2.ok, r2.action, r2.noop], [true, 'recover', true])

  // journal 坏了：宁可报错也不乱动文件
  writeFileSync(c.journal, '{ 这不是 JSON')
  const r3 = await recoverUpdate({ root: c.root, backupRoot: c.backupRoot, journalPath: c.journal, verify: { cmd: null, enabled: false }, logger: () => {} })
  c.eq('损坏 journal → ok=false', r3.ok, false)
  c.ok('损坏 journal → 报错但不改文件', r3.errors.length > 0 && read(c.root, 'tools/a.mjs') === A1)
  c.ok('损坏 journal 会留着（可人工排查）', existsSync(c.journal))

  // 壳整个目录搬过家：journal 里的绝对路径失效，靠 backupRoot + backupName 兜底
  writeFileSync(c.journal, JSON.stringify(Object.assign({}, journal, {
    backup: join(BASE, '_nowhere', backupName),
    backupRel: '',
  }), null, 2) + '\n')
  const r4 = await recoverUpdate({ root: c.root, backupRoot: c.backupRoot, journalPath: c.journal, verify: { cmd: null, enabled: false }, logger: () => {} })
  c.eq('绝对路径失效时靠 backupName 兜底', [r4.ok, r4.rolledBack], [true, true])
  c.eq('兜底还原后字节仍是老的', read(c.root, 'tools/a.mjs'), A1)
})

// ---- G ---------------------------------------------------------------------
const caseG = () => runCase('G', 'dryRun 零写盘', async (c) => {
  const A1 = 'export const a = 1\n'
  put(c.root, 'tools/a.mjs', A1)
  const remote = buildRemote(c.stage, { 'tools/a.mjs': 'export const a = 2\n', 'tools/new.mjs': 'export const n = 1\n' })
  const before = snapshot(c.root)
  const r = await applyUpdate(baseOpts(c, {
    manifest: remote,
    installed: installedFrom({ 'tools/a.mjs': shaText(A1) }),
    dryRun: true,
    verify: { cmd: [process.execPath, '-e', 'process.exit(1)'], enabled: true },
    migrations: [{ id: 'noop', script: 'tools/nope.mjs', args: [] }],
  }))

  c.eq('ok', r.ok, true)
  c.eq('dryRun 标记', r.dryRun, true)
  c.eq('applied 里放的是计划', r.applied,
    [{ path: 'tools/a.mjs', action: 'update' }, { path: 'tools/new.mjs', action: 'add' }])
  c.eq('整棵树零写盘', diffSnap(before, snapshot(c.root)), [])
  c.no('没建备份目录', existsSync(c.backupRoot))
  c.no('没写 journal', existsSync(c.journal))
  c.eq('没跑迁移', r.migrations, [])
  c.eq('没跑 verify', r.verify.ran, false)
  c.eq('a.mjs 还是老字节', read(c.root, 'tools/a.mjs'), A1)
  c.no('new.mjs 没被创建', existsSync(absIn(c.root, 'tools/new.mjs')))
})

// ---- H ---------------------------------------------------------------------
const caseH = () => runCase('H', '坏 staged 文件 → 整体失败、零写盘', async (c) => {
  const A1 = 'export const a = 1\n'
  put(c.root, 'tools/a.mjs', A1)
  const remote = buildRemote(c.stage, { 'tools/a.mjs': 'export const a = 2\n', 'tools/b.mjs': 'export const b = 1\n' })
  writeFileSync(absIn(c.stage, 'tools/b.mjs'), 'export const b = TAMPERED\n') // 与清单 sha 不符
  const before = snapshot(c.root)
  const r = await applyUpdate(baseOpts(c, {
    manifest: remote,
    installed: installedFrom({ 'tools/a.mjs': shaText(A1) }),
    verify: { cmd: [process.execPath, '-e', 'process.exit(0)'], enabled: true },
  }))

  c.eq('ok', r.ok, false)
  c.ok('errors 点名 staging', r.errors.some((e) => /staging/.test(e)))
  c.eq('零写盘（连合法的 a.mjs 也没写）', diffSnap(before, snapshot(c.root)), [])
  c.no('没建备份目录', existsSync(c.backupRoot))
  c.no('没写 journal', existsSync(c.journal))
  c.eq('rolledBack=false（还没写过任何东西）', r.rolledBack, false)
  c.eq('verify 没跑', r.verify.ran, false)
  c.eq('没留下 .new', findNew(c.root), [])
})

// ---- I ---------------------------------------------------------------------
const caseI = () => runCase('I', '迁移脚本真的被执行并记录', async (c) => {
  const MIG = [
    "import { appendFileSync } from 'node:fs'",
    "appendFileSync('migration-ran.log', 'noop ' + JSON.stringify(process.argv.slice(2)) + '\\n')",
    '',
  ].join('\n')
  const A1 = 'export const a = 1\n'
  put(c.root, 'tools/a.mjs', A1)
  const remote = buildRemote(c.stage, { 'tools/a.mjs': 'export const a = 2\n', 'tools/mig-noop.mjs': MIG })
  const r = await applyUpdate(baseOpts(c, {
    manifest: remote,
    installed: installedFrom({ 'tools/a.mjs': shaText(A1) }),
    migrations: [
      { id: 'noop', script: 'tools/mig-noop.mjs', args: ['--from', '0.0.9'] },
      { id: 'not-in-manifest', script: 'tools/missing.mjs', args: [] },
      { id: 'not-tools', script: 'home/profiles/x.mjs', args: [] },
    ],
  }))

  c.eq('ok（迁移失败不影响换装结论）', r.ok, true)
  c.eq('迁移条数', r.migrations.length, 3)
  c.eq('noop id', r.migrations[0].id, 'noop')
  c.eq('noop 成功', r.migrations[0].ok, true)
  c.eq('noop 日志真的写了', (read(c.root, 'migration-ran.log') || '').trim(), 'noop ["--from","0.0.9"]')
  c.eq('不在清单里的脚本被拒', [r.migrations[1].ok, /不在本次清单/.test(r.migrations[1].message)], [false, true])
  c.eq('非 tools/ 的脚本被拒', r.migrations[2].ok, false)
  c.eq('迁移脚本本身也是壳文件（已落盘）', read(c.root, 'tools/mig-noop.mjs'), MIG)
  c.no('journal 已清', existsSync(c.journal))
  c.eq('备份 meta 记了迁移结果', (newestBackup(c.backupRoot).meta || {}).migrations.length, 3)
})

// ---- 跑 ----------------------------------------------------------------
const CASES = [caseA, caseB, caseC, caseD, caseE, caseF, caseG, caseH, caseI]
const startedAt = Date.now()

process.stdout.write('shell-apply selftest（壳换装引擎）\n')
process.stdout.write('  node   ' + process.version + '  ' + process.execPath + '\n')
process.stdout.write('  仓库   ' + ROOT + '\n')
process.stdout.write('  夹具   ' + BASE + '\n')
process.stdout.write('  tools  ' + TOOL_MJS.length + ' 个 .mjs 复制进每个用例\n')
process.stdout.write('  ' + '-'.repeat(88) + '\n')

try {
  for (const fn of CASES) await fn()
} finally {
  process.stdout.write('\n' + '='.repeat(88) + '\n')
  process.stdout.write('PASS/FAIL 表\n')
  process.stdout.write('  用例  说明                                              结果   断言\n')
  for (const r of results) {
    const okCount = r.asserts.filter((a) => a.ok).length
    const verdict = r.pass ? 'PASS' : 'FAIL'
    const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n)
    process.stdout.write('  ' + pad(r.id, 5) + pad(r.title, 50) + pad(verdict, 7) + okCount + '/' + r.asserts.length + '\n')
    if (r.error) process.stdout.write('        ! ' + r.error.split('\n')[0] + '\n')
  }
  const failed = results.filter((r) => !r.pass)
  const totalAssert = results.reduce((n, r) => n + r.asserts.length, 0)
  const failedAssert = results.reduce((n, r) => n + r.asserts.filter((a) => !a.ok).length, 0)
  process.stdout.write('  ' + '-'.repeat(86) + '\n')
  process.stdout.write('  合计：' + results.length + ' 用例 / ' + totalAssert + ' 断言 / 失败 '
    + failedAssert + ' 断言 / ' + (Date.now() - startedAt) + 'ms\n')
  process.stdout.write('='.repeat(88) + '\n')

  if (KEEP) {
    process.stdout.write('（--keep）保留夹具：' + BASE + '\n')
  } else {
    try {
      rmSync(BASE, { recursive: true, force: true })
      process.stdout.write('夹具已清理：' + BASE + '\n')
    } catch (e) {
      process.stdout.write('夹具清理失败（请手工删除）：' + BASE + ' —— ' + String((e && e.message) || e) + '\n')
    }
  }
  process.stdout.write(failed.length
    ? '结论：SELFTEST FAIL（' + failed.length + '/' + results.length + ' 用例失败）\n'
    : '结论：SELFTEST PASS（' + results.length + '/' + results.length + ' 用例全过）\n')
  process.exitCode = failed.length ? 1 : 0
}
