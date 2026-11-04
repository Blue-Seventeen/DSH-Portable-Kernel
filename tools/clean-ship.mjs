/**
 * 交付前清理 / 断言（干净包）。
 *
 * 目的：便携版是把"源机器上正在用的 dsh 目录"整体拷出来的，所以包里有作者本人的凭证、
 * 会话历史、Cookies、登录态备份、崩溃日志，以及写死旧盘符的遗留脚本。这些既不该随包分发，
 * 也会让"换机自愈"的判断变脏。这里把交付前该做的事做成一条命令：
 *
 *   dsh-portable.cmd clean-ship            # dry-run：只列清单，不删任何东西
 *   dsh-portable.cmd clean-ship --apply    # 真删，并把 version.json 刷成出厂快照
 *   dsh-portable.cmd clean-ship verify     # 只断言：还没干净就 exit 1（打包门禁）
 *   dsh-portable.cmd clean-ship refresh    # 只刷 version.json 计数 + 重新生成 shell-version.json（清单 schemaVersion 2），不删任何文件
 *
 * 提示：桌面程序运行中，tmp\dsh-* 属正常运行时目录，verify 会把该项降级为信息项。
 *
 * 只删白名单里的路径；删不掉（被占用）会记下来但继续，最后汇总。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// 壳自更新清单的口径只有一份（白名单 + sha256 + 清单 schema 版本），这里直接复用，免得两边各写一套后漂移
import {
  MANIFEST_SCHEMA, REPO, SHELL_MANIFEST, UPDATER_MIN, USER_OWNED,
  listLocalShellFiles, readLocalManifest, sha256File,
} from './shell-update.mjs'
import { SHELL_MIGRATIONS } from './shell-migrations.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// 参数既接受 --apply/--verify，也接受裸词 apply/verify：
// dsh-portable.cmd 走的是 powershell -File，--xxx 会被 PowerShell 当成参数名而报错。
const argv = process.argv.slice(2)
const apply = argv.includes('--apply') || argv.includes('apply')
const verify = argv.includes('--verify') || argv.includes('verify')
// keep-creds：保留两个 .credentials.yaml（作者选择暂不删），其余清理项照做
const keepCreds = argv.includes('--keep-creds') || argv.includes('keep-creds')
// refresh：只把 version.json 的计数/时间戳刷成当前实物，不删任何东西（替代"为了对齐计数就得删会话"）
const refreshOnly = argv.includes('--refresh') || argv.includes('refresh')

const report = []
const say = (m) => { console.log(m); report.push(m) }

const rmPath = (p) => {
  if (!existsSync(p)) return 0
  const n = countFiles(p)
  try { rmSync(p, { recursive: true, force: true }) } catch (e) { return -1 }
  return n
}
const countFiles = (p) => {
  try {
    const st = statSync(p)
    if (st.isFile()) return 1
    let n = 0
    for (const d of readdirSync(p, { withFileTypes: true })) {
      const c = join(p, d.name)
      if (d.isDirectory()) n += countFiles(c)
      else if (d.isFile()) n += 1
    }
    return n
  } catch { return 0 }
}
const sizeMB = (p) => { try { return Math.round(countBytes(p) / 1048576 * 10) / 10 } catch { return 0 } }
const countBytes = (p) => {
  try {
    const st = statSync(p)
    if (st.isFile()) return st.size
    let n = 0
    for (const d of readdirSync(p, { withFileTypes: true })) n += countBytes(join(p, d.name))
    return n
  } catch { return 0 }
}
const listDirs = (dir, pred) => { try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && pred(d.name)).map((d) => join(dir, d.name)) } catch { return [] } }
const listFiles = (dir, pred) => { try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && pred(d.name)).map((d) => join(dir, d.name)) } catch { return [] } }
const findDeep = (dir, name, skip) => {
  const out = []
  const walk = (d) => {
    let ents = []
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(d, e.name)
      if (e.isDirectory()) { if (!skip.includes(e.name)) walk(p) }
      else if (e.name === name) out.push(p)
    }
  }
  walk(dir)
  return out
}

// ---- 清理项白名单 -----------------------------------------------------------
const items = []

// 1) 明文凭证（作者本人的 API Key）
const creds = [
  ...findDeep(join(ROOT, 'home'), '.credentials.yaml', ['node_modules']),
  ...findDeep(join(ROOT, 'shell-profile'), '.credentials.yaml', []),
]
if (keepCreds) say('按 --keep-creds 保留凭证文件：' + creds.length + ' 个（交付给别人前记得删）')
else items.push({ name: '凭证文件 .credentials.yaml', paths: creds.filter((v, i, a) => a.indexOf(v) === i) })

// 2) 会话历史与投影缓存
items.push({ name: '会话历史 home\\sessions', paths: [join(ROOT, 'home', 'sessions')] })
items.push({ name: '会话投影缓存 home\\storages\\session_projcache', paths: [join(ROOT, 'home', 'storages', 'session_projcache')] })

// 3) 登录态（DPAPI 绑定本机，拷走必然解不开，且含 Cookies）
const sp = join(ROOT, 'shell-profile')
items.push({
  name: '登录态（Cookies / Local State / Trust Tokens）',
  paths: [join(sp, 'Network'), join(sp, 'Local State'), ...listFiles(sp, (n) => n.startsWith('Trust Tokens'))],
})

// 4) 登录态备份（壳自己生成的 cache\shell-login-bak-*）
items.push({ name: '登录态备份 cache\\shell-login-bak-*', paths: listDirs(join(ROOT, 'cache'), (n) => n.startsWith('shell-login-bak-')) })

// 5) 崩溃日志
items.push({ name: '崩溃日志 shell-profile\\logs\\crash-*.log', paths: listFiles(join(sp, 'logs'), (n) => n.startsWith('crash-') && n.endsWith('.log')) })

// 6) 官方安装器遗留脚本（写死源机器盘符，且 asar 里没有引用）
items.push({ name: '遗留脚本 home\\preset-runtime', paths: [join(ROOT, 'home', 'preset-runtime')] })

// 7) 旧机器路径痕迹
items.push({ name: '迁移残迹 cache\\migrate-*', paths: listDirs(join(ROOT, 'cache'), (n) => n.startsWith('migrate-')) })
items.push({ name: '插件管理日志 home\\.plugin-manager\\logs', paths: [join(ROOT, 'home', '.plugin-manager', 'logs')] })

// 8) 自检/运行期临时目录（不在 Clean-TempJunk 覆盖范围里的那几种前缀）
const tmp = join(ROOT, 'tmp')
items.push({
  name: '临时目录 tmp\\dsh-* 与 *.tmp',
  paths: [
    ...listDirs(tmp, (n) => /^dsh-(subprocess|workspace-changes|acl-skill|spill)/.test(n)),
    ...listFiles(tmp, (n) => n.endsWith('.tmp')),
  ],
})

// 8.5) 旧的 legacy-deepseek 目录：源机器上的历史对话 + 快照，既不该随包分发也不在 readme 的"仅备查"范围内
items.push({ name: '旧对话残留 legacy-deepseek', paths: [join(ROOT, 'legacy-deepseek')] })

// 9) 桌面控制台日志（含端口/会话线索，且运行时会被重建）
items.push({ name: '桌面控制台日志 logs\\desktop-console.log*', paths: listFiles(join(ROOT, 'logs'), (n) => n.startsWith('desktop-console.log')) })

// 10) 老系统 Office 补丁贴进去的 7 个 DLL（新系统上不该有；老系统首启 auto-prepare 会重贴）
const officeDirs = [
  join(ROOT, 'app', 'node_modules', '@deepseek-ai', 'libreoffice-kit-win32-x64', 'bin'),
  join(ROOT, 'desktop', 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit-win32-x64', 'bin'),
]
const officeDlls = officeDirs.flatMap((d) => listFiles(d, (n) => /^(msvcp140|vcruntime140|concrt140)/i.test(n)))

/** 桌面程序是否在运行：在跑时 tmp\dsh-* 是正常运行时目录，不该让门禁一直红（审计 E.3/F.4） */
const desktopRunning = (() => {
  // 必须按"可执行文件在本目录下"判断：官方安装版也在跑（同一个进程名），只看进程名会把临时目录误判成"正常运行时"
  try {
    // 注意：PowerShell 5.1 里没有 \" 这种转义（那是 C 系语言的写法），必须用单引号把进程名括起来，
    // 否则整条命令 ParserError，桌面运行状态永远误判成 false。
    const ps = `powershell -NoLogo -NoProfile -Command "Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }"`
    const out = execFileSync('cmd', ['/c', ps], { encoding: 'utf8', timeout: 20000 })
    const prefix = join(ROOT, 'desktop').toLowerCase()
    return out.split(/\r?\n/).some((p) => p.trim() && p.trim().toLowerCase().startsWith(prefix))
  } catch { return false }
})()

/** 把 version.json 刷成当前实物快照（计数/asar 字节/shipTime，源路径脱敏） */
const refreshVersion = () => {
  try {
    const vf = join(ROOT, 'version.json')
    const v = existsSync(vf) ? JSON.parse(readFileSync(vf, 'utf8')) : {}
    const appDir = join(ROOT, 'app'), deskDir = join(ROOT, 'desktop'), homeDir = join(ROOT, 'home')
    v.appFiles = countFiles(appDir)
    v.desktopFiles = countFiles(deskDir)
    v.homeFiles = countFiles(homeDir)
    v.desktopAsarBytes = existsSync(join(deskDir, 'resources', 'app.asar')) ? statSync(join(deskDir, 'resources', 'app.asar')).size : 0
    // 体积字段也一起重算：以前只刷文件数，结果 homeSizeMB 一直停在旧值（审计提出过）
    v.appSizeMB = sizeMB(appDir)
    v.desktopSizeMB = sizeMB(deskDir)
    v.homeSizeMB = sizeMB(homeDir)
    v.desktopAsarSizeMB = Math.round((v.desktopAsarBytes / 1048576) * 10) / 10
    v.sourceInstall = '(redacted)'
    v.sourceProfile = '(redacted)'
    // 内容没变就不要刷新时间戳：否则每次 refresh 都把工作区弄脏（无法判断"这次到底变没变"）
    const prevText = existsSync(vf) ? readFileSync(vf, 'utf8') : ''
    let prev = null
    try { prev = JSON.parse(prevText) } catch { prev = null }
    v.shipTime = new Date().toISOString()
    if (prev && typeof prev === 'object') {
      const strip = (o) => { const c = Object.assign({}, o); delete c.shipTime; return JSON.stringify(c) }
      if (prev.shipTime && strip(prev) === strip(v)) v.shipTime = prev.shipTime
    }
    const text = JSON.stringify(v, null, 2) + '\n'
    // 明确按 UTF-8 写、无 BOM：审计机副本的 shipNote 曾出现 GBK 误读的乱码
    writeFileSync(vf, Buffer.from(text, 'utf8'))
    const back = readFileSync(vf, 'utf8')
    if (back !== text) say('⚠ version.json 写入后读回不一致（编码问题）')
    say('version.json 已刷成出厂快照（文件数 / 体积 / asar 字节 / shipTime）')
    return true
  } catch (e) { say('version.json 更新失败：' + e.message); return false }
}

/**
 * 生成/更新仓库根的 shell-version.json（壳自更新清单，schemaVersion 2）。
 * 内容 = 白名单里"当前存在"的文件 + 各自 sha256；shell-version.json 自己不进 files 列表。
 * v2 元数据（channel / tag / releasedAt / minShellVersion / requires / notes / notesUrl / zip）一律从旧清单继承：
 * 那些字段由 tools/shell-release.mjs prepare 写入、由人决定，refresh 只重算 files 与 userOwned。
 * shellVersion 同样继承、由人手动 bump（脚本绝不自己加版本号）；没有旧文件才写 0.1.0 并提示。
 */
const refreshShellManifest = () => {
  try {
    const f = join(ROOT, SHELL_MANIFEST)
    const prev = readLocalManifest()
    const old = (prev.present && prev.json && typeof prev.json === 'object' && !Array.isArray(prev.json)) ? prev.json : {}
    let shellVersion = String(old.shellVersion || '').trim()
    if (!shellVersion) {
      shellVersion = '0.1.0'
      say('提示：' + SHELL_MANIFEST + (prev.present ? ' 里的 shellVersion 读不动，' : ' 不存在，') + '先写 ' + shellVersion + '；发包前请手动改成正式版本号（脚本不会自动 bump）')
    }
    const files = {}
    for (const rel of listLocalShellFiles()) files[rel] = sha256File(join(ROOT, rel))
    const sorted = {}
    for (const k of Object.keys(files).sort()) sorted[k] = files[k]
    // userOwned 只收"清单里真的存在"的那些，顺序沿用 shell-update 的 USER_OWNED（人读得懂、diff 稳定）
    const userOwned = USER_OWNED.filter((rel) => Object.prototype.hasOwnProperty.call(sorted, rel))
    // notes：旧值优先；旧清单里没有就写六个空数组（verify 的「清单 v2 合法」要求六个键都是数组，缺键要报出来）
    const oldNotes = (old.notes && typeof old.notes === 'object' && !Array.isArray(old.notes)) ? old.notes : {}
    const notes = {}
    for (const k of ['added', 'fixed', 'optimized', 'breaking', 'upgrade', 'rollback']) notes[k] = Array.isArray(oldNotes[k]) ? oldNotes[k] : []
    for (const k of Object.keys(oldNotes)) if (!(k in notes)) notes[k] = oldNotes[k]
    const channel = String(old.channel || '').trim() || 'stable'
    const tag = String(old.tag || '').trim() || 'v' + shellVersion
    const out = {
      schemaVersion: MANIFEST_SCHEMA,
      updaterMin: UPDATER_MIN,
      channel,
      shellVersion,
      tag,
      releasedAt: String(old.releasedAt || '').trim() || new Date().toISOString(),
      minShellVersion: String(old.minShellVersion || '').trim() || shellVersion,
      generatedAt: new Date().toISOString(),
      requires: (old.requires && typeof old.requires === 'object' && !Array.isArray(old.requires)) ? old.requires : { dsh: '>=0.2.1-rc.5', node: '>=24.0.0' },
      files: sorted,
      userOwned,
      notes,
      notesUrl: String(old.notesUrl || '').trim() || ('https://github.com/' + REPO + '/releases/tag/v' + shellVersion),
    }
    // 换装后要跑的迁移（幂等、失败不阻断）：机器配置由 fix-pnpm-state 重新对齐，见 shell-migrations.mjs
    out.migrations = SHELL_MIGRATIONS
    // zip 资产由 shell-release 打包后写回；refresh 不生成 zip，但已经存在就原样保住（否则发布后置校验必红）
    if (old.zip && typeof old.zip === 'object' && !Array.isArray(old.zip)) out.zip = old.zip
    // 内容没变就保留旧 generatedAt，避免 refresh 每次改写时间戳
    if (typeof old === 'object' && old && old.generatedAt) {
      const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.generatedAt; return JSON.stringify(c) }
      if (strip(old) === strip(out)) out.generatedAt = old.generatedAt
    }
    const text = JSON.stringify(out, null, 2) + '\n'
    // 明确按 UTF-8 写、无 BOM：tools/shell-update.mjs 会拒绝带 BOM 的清单
    writeFileSync(f, Buffer.from(text, 'utf8'))
    const back = readFileSync(f, 'utf8')
    if (back !== text) { say('⚠ ' + SHELL_MANIFEST + ' 写入后读回不一致（编码问题）'); return false }
    say(SHELL_MANIFEST + ' 已刷新：schemaVersion ' + out.schemaVersion + ' / updaterMin ' + out.updaterMin + ' / 文件 ' + Object.keys(sorted).length + ' 个 / userOwned ' + userOwned.length + ' 个 / channel ' + channel + ' / tag ' + tag + (out.zip ? ' / zip 已保留' : ''))
    return true
  } catch (e) { say(SHELL_MANIFEST + ' 生成失败：' + e.message); return false }
}

if (refreshOnly) {
  say('=== clean-ship refresh（只刷 version.json + shell-version.json，不删任何文件）===')
  const versionOk = refreshVersion()
  const shellOk = refreshShellManifest()
  process.exit(versionOk && shellOk ? 0 : 1)
}

// ---- 执行 -------------------------------------------------------------------
let totalFiles = 0
let totalMB = 0
let failed = 0
const cleanupRows = []

for (const it of items) {
  const existing = it.paths.filter((p) => existsSync(p))
  const files = existing.reduce((a, p) => a + countFiles(p), 0)
  const mb = existing.reduce((a, p) => a + countBytes(p), 0) / 1048576
  cleanupRows.push({ name: it.name, files, mb: Math.round(mb * 10) / 10 })
  totalFiles += files
  totalMB += mb
  if (!apply) continue
  for (const p of existing) if (rmPath(p) === -1) failed += 1
}

if (apply) {
  // Office DLL 只在老系统需要；新系统留着等于白白偏离官方清单
  for (const f of officeDlls) { if (rmPath(f) === -1) failed += 1 }
  // version.json 刷成出厂快照（计数一类的判据都从这里读）
  refreshVersion()
}

// ---- 输出 -------------------------------------------------------------------
say('')
say((apply ? '=== clean-ship --apply ===' : verify ? '=== clean-ship --verify ===' : '=== clean-ship（dry-run，加 apply 才真删）===') + (keepCreds ? '（凭证保留）' : ''))
say('清理项                          文件数      体积')
for (const r of cleanupRows) say(('  ' + r.name).padEnd(34, ' ') + String(r.files).padStart(6) + '  ' + String(r.mb).padStart(8) + ' MB')
say(('  合计').padEnd(34, ' ') + String(totalFiles).padStart(6) + '  ' + String(Math.round(totalMB * 10) / 10).padStart(8) + ' MB')
if (apply) say('删除失败（被占用）：' + failed + (officeDlls.length ? '；office DLL 已从引擎目录移除 ' + officeDlls.length + ' 个' : ''))

// ---- 断言 -------------------------------------------------------------------
const checks = []
const assertEmpty = (label, paths) => {
  const left = paths.filter((p) => existsSync(p) && countFiles(p) > 0)
  checks.push({ label, ok: left.length === 0, detail: left.length ? left.map((p) => p.slice(ROOT.length + 1)).join(', ') : '' })
}
if (keepCreds) checks.push({ label: '凭证文件（按 --keep-creds 保留）', ok: true, detail: 'skipped' })
else assertEmpty('无凭证文件', [...findDeep(join(ROOT, 'home'), '.credentials.yaml', ['node_modules']), ...findDeep(join(ROOT, 'shell-profile'), '.credentials.yaml', [])])
assertEmpty('无会话历史', [join(ROOT, 'home', 'sessions')])
assertEmpty('无投影缓存', [join(ROOT, 'home', 'storages', 'session_projcache')])
assertEmpty('无 Cookies', [join(sp, 'Network', 'Cookies')])
assertEmpty('无 Local State', [join(sp, 'Local State')])
assertEmpty('无登录态备份', listDirs(join(ROOT, 'cache'), (n) => n.startsWith('shell-login-bak-')))
assertEmpty('无崩溃日志', listFiles(join(sp, 'logs'), (n) => n.startsWith('crash-') && n.endsWith('.log')))
assertEmpty('无 preset-runtime', [join(ROOT, 'home', 'preset-runtime')])
assertEmpty('无迁移残迹', listDirs(join(ROOT, 'cache'), (n) => n.startsWith('migrate-')))
const tmpDsh = listDirs(tmp, (n) => /^dsh-/.test(n))
if (desktopRunning) checks.push({ label: '无 dsh-* 临时目录（桌面在运行，降级为信息项）', ok: true, detail: 'skipped，现存 ' + tmpDsh.length + ' 个' })
else assertEmpty('无 dsh-* 临时目录', tmpDsh)
assertEmpty('无旧对话残留 legacy-deepseek', [join(ROOT, 'legacy-deepseek')])

if (verify) {
  say('')
  let bad = 0
  for (const c of checks) {
    if (!c.ok) bad += 1
    say('  ' + (c.ok ? 'PASS' : 'FAIL') + '  ' + c.label + (c.detail ? '  ← ' + c.detail : ''))
  }
  say('')
  if (bad === 0 && apply && failed > 0) {
    say('结论：还有 ' + failed + ' 个文件删除失败（被占用），不算干净')
    process.exit(1)
  }
  if (bad === 0) { say('结论：交付快照干净（' + checks.length + ' 项全过）'); process.exit(0) }
  say('结论：还有 ' + bad + ' 项不干净 —— 先跑 dsh-portable.cmd clean-ship apply')
  process.exit(1)
}
process.exit(0)