/**
 * 便携壳自更新：清单 + 下载 + 校验 + 落 staging。
 *
 * 分工：本脚本**只**把远端壳文件取下来、按字节校验、落到 staging 目录；
 * 换装（备份 → 覆盖 → 回滚）由 dsh-portable.ps1 的 shell-update 动作负责，这里绝不直接改仓库里的文件。
 *
 * 壳 = 根脚本 + tools\ + runtime\vcredist + home\profiles 清单/锁文件 + README/LICENSE。
 * 官方层（app\ desktop\ runtime\node|pnpm）与运行时数据永不在更新范围内，见下面的白名单。
 *
 *   node tools\shell-update.mjs check [--manifest <url|本地路径>] [--base <url|目录>] [--json]
 *   node tools\shell-update.mjs stage [--manifest <url|本地路径>] [--stage <目录>] [--base <url|目录>] [--force] [--json]
 *
 * 退出码：check → 0 有更新 / 4 已最新（或远端更旧）/ 1 取不到清单；
 *         stage → 0 成功（没有要下的文件也算成功）/ 1 失败。
 *
 * 三条铁律（按字节判定，绝不重新编码后落盘：下载即写字节）：
 *   *.cmd                 纯 ASCII 且 CRLF（LF-only 会让 cmd.exe 报 cannot find the batch label）
 *   *.ps1                 必须以 EF BB BF 开头，且不能有两个连续 BOM
 *   *.md/.json/.mjs/.yml  不得以 BOM 开头
 * 任何一条不过 → 整次 stage 失败并点名文件，一个字节都不落盘（先全部下到内存，校验过了才写）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/** 壳版本清单（仓库根）：既是"当前版本号"也是"当前文件 sha256 表"，由 clean-ship refresh 生成 */
export const SHELL_MANIFEST = 'shell-version.json'
const DEFAULT_BASE = 'https://raw.githubusercontent.com/Blue-Seventeen/hack3rx-harness/master'
const DEFAULT_MANIFEST = DEFAULT_BASE + '/' + SHELL_MANIFEST
const FETCH_TIMEOUT_MS = 8000
const RETRIES = 1
const CONCURRENCY = 4

const USAGE = [
  '用法：',
  '  node tools\\shell-update.mjs check [--manifest <url|本地路径>] [--base <url|目录>] [--json]',
  '  node tools\\shell-update.mjs stage [--manifest <url|本地路径>] [--stage <目录>] [--base <url|目录>] [--force] [--json]',
  '',
  '  --manifest  远端清单（默认 ' + DEFAULT_MANIFEST + '）；也可给本地文件路径（测试接缝）',
  '  --base      文件基址（默认取清单所在目录）；远端默认 ' + DEFAULT_BASE + '/<path>',
  '  --stage     staging 目录（默认 %LOCALAPPDATA%\\Hack3rX-Harness\\build\\shell-<version>）',
  '  --force     stage 时忽略 sha 相同，全部重下（也用于允许降级）',
  '  --json      只输出一行机器可读 JSON（纯 ASCII，供 PowerShell ConvertFrom-Json）',
  '',
  '退出码：check 0=有更新 / 4=已最新 / 1=失败；stage 0=成功 / 1=失败',
].join('\n')

// ---- 壳文件白名单（唯一权威；tools\clean-ship.mjs 生成清单时复用同一份） ------
/** 根目录随壳更新的脚本：清单里点名的 10 个 */
export const ROOT_SHELL_FILES = [
  'dsh-portable.ps1', 'preflight.cmd', 'start-web.cmd', 'start-desktop.cmd', 'dsh-portable.cmd',
  'dsh.cmd', 'dsh-plugin.cmd', 'dsh-plugin-shared.cmd', 'check-update.cmd', 'env.cmd',
]
/** 整条路径点名（不支持通配）：README/LICENSE + home\profiles 的清单与锁文件 */
const SHELL_EXACT = [
  ...ROOT_SHELL_FILES,
  'README.md',
  'LICENSE',
  SHELL_MANIFEST,
  'home/cordis.patch.yml',
  'home/profiles/package.json',
  'home/profiles/pnpm-workspace.yaml',
  'home/profiles/pnpm-lock.yaml',
  'home/profiles/web/package.json',
  'home/profiles/web/pnpm-workspace.yaml',
  'home/profiles/web/pnpm-lock.yaml',
  'home/profiles/web/cordis.yml',
  'home/profiles/web/cordis.patch.yml',
  'home/profiles/desktop/package.json',
  'home/profiles/desktop/pnpm-workspace.yaml',
  'home/profiles/desktop/pnpm-lock.yaml',
  'home/profiles/desktop/cordis.yml',
]
/** 这俩目录下任意文件（tools\7z 的二进制也随壳走） */
const SHELL_PREFIXES = ['tools/', 'runtime/vcredist/']
/**
 * 显式禁止，优先级最高：
 *   home/profiles/desktop/cordis.patch.yml 是用户私有网关配置（一回滚就把人家的中转打没了）
 *   version.json 是官方层出厂快照、.gitattributes/.gitignore 是仓库元数据，都不属于"壳"
 */
const SHELL_DENY = ['home/profiles/desktop/cordis.patch.yml', 'version.json', '.gitattributes', '.gitignore']

const SHELL_EXACT_SET = new Set(SHELL_EXACT.map((s) => s.toLowerCase()))
const SHELL_DENY_SET = new Set(SHELL_DENY.map((s) => s.toLowerCase()))

const toPosix = (p) => String(p).replace(/\\/g, '/')

/** 清单里的相对路径 → 规范化正斜杠路径；含 .. / 绝对路径 / 盘符 / NUL 一律返回 null */
const normalizeRel = (p) => {
  if (typeof p !== 'string' || !p.trim()) return null
  const rel = toPosix(p.trim()).replace(/\/{2,}/g, '/')
  if (rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.includes('\0')) return null
  const segs = rel.split('/')
  if (segs.some((s) => !s || s === '.' || s === '..')) return null
  return rel
}

/**
 * 路径是否允许写。Windows 文件系统大小写不敏感（"TOOLS/x.mjs" 会落到 tools\x.mjs），
 * 所以白名单一律按小写判；返回给调用方的路径保留清单原样。
 */
export const isAllowedShellPath = (p) => {
  const rel = normalizeRel(p)
  if (!rel) return false
  const low = rel.toLowerCase()
  if (SHELL_DENY_SET.has(low)) return false
  if (SHELL_EXACT_SET.has(low)) return true
  return SHELL_PREFIXES.some((pre) => low.startsWith(pre) && low.length > pre.length)
}

const walkFiles = (absDir, relPrefix, out) => {
  let ents = []
  try { ents = readdirSync(absDir, { withFileTypes: true }) } catch { return }
  for (const d of ents) {
    const rel = relPrefix + d.name
    if (d.isDirectory()) walkFiles(join(absDir, d.name), rel + '/', out)
    else if (d.isFile() && isAllowedShellPath(rel) && rel.toLowerCase() !== SHELL_MANIFEST) out.push(rel)
  }
}

/** 本地"当前存在"的壳文件（正斜杠相对路径，字典序）。shell-version.json 自己不进 files 列表。 */
export const listLocalShellFiles = () => {
  const out = []
  for (const rel of SHELL_EXACT) {
    if (rel.toLowerCase() === SHELL_MANIFEST) continue
    try { if (statSync(join(ROOT, rel)).isFile() && isAllowedShellPath(rel)) out.push(rel) } catch {}
  }
  for (const pre of SHELL_PREFIXES) walkFiles(join(ROOT, pre), pre, out)
  return out.filter((v, i, a) => a.indexOf(v) === i).sort()
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
export const sha256File = (abs) => sha256(readFileSync(abs))
// ---- 编码校验（仓库铁律，按字节判定） ---------------------------------------
const startsWithBom = (b) => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
const NO_BOM_EXT = ['md', 'json', 'mjs', 'yml', 'yaml']
const hex = (x) => '0x' + x.toString(16).padStart(2, '0')

/**
 * 校验一份即将落盘的壳文件字节。
 * @returns {{ok: boolean, error?: string, warnings?: string[]}}
 * 注意：只拒绝、不改写。哪怕行尾不合约定也只警告，落盘仍是远端原字节（改了就等于偷偷重编码）。
 */
export const validateShellBytes = (relPath, buf) => {
  const rel = normalizeRel(relPath) || toPosix(String(relPath))
  const low = rel.toLowerCase()
  const name = rel.replace(/\//g, '\\')
  const warnings = []
  if (low.endsWith('.cmd')) {
    const bad = buf.findIndex((x) => x > 0x7f)
    if (bad !== -1) {
      return { ok: false, error: name + ' 不是纯 ASCII（偏移 ' + bad + ' 处是 ' + hex(buf[bad]) + '）；.cmd 必须纯 ASCII + CRLF' }
    }
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) {
        return { ok: false, error: name + ' 有 LF-only 行尾（偏移 ' + i + '）；.cmd 必须 CRLF，否则 cmd.exe 报 cannot find the batch label' }
      }
    }
    return { ok: true, warnings }
  }
  if (low.endsWith('.ps1')) {
    if (!startsWithBom(buf)) {
      return { ok: false, error: name + ' 缺少 UTF-8 BOM；PowerShell 5.1 会按 ANSI 读，中文全废' }
    }
    if (buf.length >= 6 && buf[3] === 0xef && buf[4] === 0xbb && buf[5] === 0xbf) {
      return { ok: false, error: name + ' 有两个连续 BOM（EF BB BF EF BB BF）；PowerShell 直接语法错' }
    }
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) warnings.push(name + ' 含 LF-only 行尾（偏移 ' + i + '）')
    }
    return { ok: true, warnings }
  }
  const dot = low.lastIndexOf('.')
  const ext = dot === -1 ? '' : low.slice(dot + 1)
  if (NO_BOM_EXT.includes(ext) && startsWithBom(buf)) {
    return { ok: false, error: name + ' 以 UTF-8 BOM 开头；' + ext + ' 必须无 BOM' }
  }
  if (NO_BOM_EXT.includes(ext) && buf.includes(0x0d)) warnings.push(name + ' 含 CR（仓库约定 LF）；按原字节落盘')
  return { ok: true, warnings }
}

// ---- 版本比较（与 tools\update-check.mjs 同一套语义：只在"远端更新"时才算更新） -----
const parseVer = (v) => {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '')
  const dash = s.indexOf('-')
  const core = dash === -1 ? s : s.slice(0, dash)
  const pre = dash === -1 ? '' : s.slice(dash + 1)
  return { nums: core.split('.').map((x) => parseInt(x, 10) || 0), pre: pre ? pre.split('.') : [] }
}
const cmpPre = (a, b) => {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x) ? Number(x) : null
    const ny = /^\d+$/.test(y) ? Number(y) : null
    if (nx !== null && ny !== null) { if (nx !== ny) return nx - ny }
    else { const c = String(x).localeCompare(String(y)); if (c) return c }
  }
  return 0
}
export const isNewer = (latest, cur) => {
  const a = parseVer(latest), b = parseVer(cur)
  const n = Math.max(a.nums.length, b.nums.length, 3)
  for (let i = 0; i < n; i++) {
    const x = a.nums[i] || 0, y = b.nums[i] || 0
    if (x !== y) return x > y
  }
  if (!a.pre.length && b.pre.length) return true
  if (a.pre.length && !b.pre.length) return false
  return cmpPre(a.pre, b.pre) > 0
}

// ---- IO ---------------------------------------------------------------------
const isUrl = (s) => /^https?:\/\//i.test(String(s == null ? '' : s))
const trimUrl = (s) => String(s).replace(/\/+$/, '')
const joinUrl = (base, rel) => trimUrl(base) + '/' + rel.split('/').map(encodeURIComponent).join('/')

/** 定时器必须 unref：否则 fetch 早结束也得等满 8 秒才退 */
const withTimeout = (ms) => {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  if (t.unref) t.unref()
  return c.signal
}

/** 取一段字节：8 秒超时、失败重试 1 次（4xx 不重试） */
const fetchBytes = async (url) => {
  let last = ''
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const r = await fetch(url, { signal: withTimeout(FETCH_TIMEOUT_MS), cache: 'no-store' })
      if (!r.ok) {
        last = 'HTTP ' + r.status + (r.statusText ? ' ' + r.statusText : '')
        if (r.status >= 400 && r.status < 500) break
        continue
      }
      return { ok: true, buf: Buffer.from(await r.arrayBuffer()) }
    } catch (e) {
      last = e && e.name === 'AbortError' ? '超时（' + FETCH_TIMEOUT_MS + 'ms）' : String((e && e.message) || e)
    }
  }
  return { ok: false, error: last }
}

const readLocalBytes = (baseDir, rel) => {
  const abs = join(baseDir, rel)
  try { return { ok: true, buf: readFileSync(abs) } } catch (e) { return { ok: false, error: abs + ' 读取失败：' + e.message } }
}

const getBytes = async (base, rel) => (isUrl(base) ? fetchBytes(joinUrl(base, rel)) : readLocalBytes(base, rel))

/** 读本地清单（只用来取版本号与"上一版装过哪些文件"） */
export const readLocalManifest = () => {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, SHELL_MANIFEST), 'utf8'))
    const files = j && j.files && typeof j.files === 'object' && !Array.isArray(j.files) ? Object.keys(j.files) : []
    return { present: true, shellVersion: String((j && j.shellVersion) || '').trim(), files }
  } catch { return { present: false, shellVersion: '', files: [] } }
}

/** 本地壳版本号（clean-ship / PS 侧都可以直接用，不必自己再解析 JSON） */
export const readShellVersion = () => readLocalManifest().shellVersion

/**
 * 拉远端清单并逐条校验（路径白名单 / sha256 格式 / 大小写重名 / 清单编码）。
 * 清单本身也是 .json：无 BOM 才收。
 */
const loadManifest = async (manifestArg, baseArg) => {
  const source = manifestArg || DEFAULT_MANIFEST
  let buf = null
  let kind = 'url'
  let localPath = null
  if (isUrl(source)) {
    const r = await fetchBytes(source)
    if (!r.ok) return { ok: false, errorCode: 'manifest-unreachable', error: '取不到清单 ' + source + '：' + r.error }
    buf = r.buf
  } else {
    kind = 'file'
    localPath = resolve(process.cwd(), source)
    try { buf = readFileSync(localPath) } catch (e) { return { ok: false, errorCode: 'manifest-unreachable', error: '读不到清单 ' + localPath + '：' + e.message } }
  }
  const enc = validateShellBytes(SHELL_MANIFEST, buf)
  if (!enc.ok) return { ok: false, errorCode: 'manifest-invalid', error: '清单本身编码不合规：' + enc.error }

  let json = null
  try { json = JSON.parse(buf.toString('utf8')) } catch (e) { return { ok: false, errorCode: 'manifest-invalid', error: '清单不是合法 JSON：' + e.message } }
  if (!json || typeof json !== 'object') return { ok: false, errorCode: 'manifest-invalid', error: '清单不是 JSON 对象' }
  const shellVersion = typeof json.shellVersion === 'string' ? json.shellVersion.trim() : ''
  if (!shellVersion) return { ok: false, errorCode: 'manifest-invalid', error: '清单缺少 shellVersion' }
  if (!json.files || typeof json.files !== 'object' || Array.isArray(json.files)) {
    return { ok: false, errorCode: 'manifest-invalid', error: '清单缺少 files 对象' }
  }

  const files = {}
  const bad = []
  const seen = new Map()
  for (const [rawPath, rawSha] of Object.entries(json.files)) {
    const rel = normalizeRel(rawPath)
    const sha = typeof rawSha === 'string' ? rawSha.trim().toLowerCase() : ''
    if (!rel) { bad.push(String(rawPath) + '（路径非法）'); continue }
    if (!/^[0-9a-f]{64}$/.test(sha)) { bad.push(String(rawPath) + '（sha256 不是 64 位 hex）'); continue }
    if (!isAllowedShellPath(rel)) { bad.push(String(rawPath) + '（不在白名单）'); continue }
    if (rel.toLowerCase() === SHELL_MANIFEST) { bad.push(String(rawPath) + '（清单不能更新自己）'); continue }
    const low = rel.toLowerCase()
    if (seen.has(low)) { bad.push(seen.get(low) + ' / ' + rel + '（大小写重名）'); continue }
    seen.set(low, rel)
    files[rel] = sha
  }
  if (bad.length) {
    return { ok: false, errorCode: 'whitelist-violation', error: '清单有 ' + bad.length + ' 条不可用，拒绝整份清单：' + bad.slice(0, 6).join('；') + (bad.length > 6 ? ' …' : '') }
  }
  if (Object.keys(files).length === 0) {
    return { ok: false, errorCode: 'manifest-invalid', error: '清单 files 为空（等于让壳变空目录），拒绝' }
  }

  // 基址：--base 优先；否则取清单所在目录（URL 或本地目录），远端默认就是仓库 master
  const base = baseArg ? String(baseArg) : (kind === 'url' ? trimUrl(source).replace(/\/[^/]*$/, '') : dirname(localPath))
  return {
    ok: true,
    source,
    kind,
    localPath,
    base,
    raw: buf,
    shellVersion,
    generatedAt: typeof json.generatedAt === 'string' ? json.generatedAt : '',
    files,
  }
}

/** 远端清单 vs 本地实物：逐文件 add/update/skip */
const computePlan = (files) => {
  const rows = []
  for (const rel of Object.keys(files).sort()) {
    const abs = join(ROOT, rel)
    let have = null
    let size = 0
    try {
      const st = statSync(abs)
      if (st.isFile()) { have = sha256File(abs); size = st.size }
    } catch {}
    const action = have === null ? 'add' : (have === files[rel] ? 'skip' : 'update')
    rows.push({ path: rel, action, localSha: have, remoteSha: files[rel], bytes: size })
  }
  return rows
}

/**
 * removed = 本地上一版清单里有、远端这版没有的文件。
 * 只认"自己装过"的那些：绝不把用户在 tools\ 下手放的东西算成待删。
 */
const computeRemoved = (files) => {
  const local = readLocalManifest()
  if (!local.present || !local.files.length) return []
  const remote = new Set(Object.keys(files).map((p) => p.toLowerCase()))
  const out = []
  for (const raw of local.files) {
    const rel = normalizeRel(raw)
    if (!rel) continue
    if (rel.toLowerCase() === SHELL_MANIFEST) continue
    if (!isAllowedShellPath(rel)) continue
    if (!remote.has(rel.toLowerCase())) out.push(rel)
  }
  return out.sort()
}

const fmtSize = (n) => (n >= 1048576 ? (Math.round((n / 1048576) * 10) / 10) + ' MB' : n >= 1024 ? (Math.round((n / 1024) * 10) / 10) + ' KB' : n + ' B')
// ---- CLI --------------------------------------------------------------------
const VALUE_FLAGS = { '--manifest': 'manifest', '--base': 'base', '--stage': 'stage' }
const parseArgs = (argv) => {
  const a = { cmd: '', manifest: '', base: '', stage: '', json: false, force: false, help: false, bad: '' }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '-h' || t === '--help') { a.help = true; continue }
    if (t === '--json') { a.json = true; continue }
    if (t === '--force') { a.force = true; continue }
    const eq = t.indexOf('=')
    if (t.startsWith('--') && eq > 2 && VALUE_FLAGS[t.slice(0, eq)]) { a[VALUE_FLAGS[t.slice(0, eq)]] = t.slice(eq + 1); continue }
    if (VALUE_FLAGS[t]) {
      const v = argv[i + 1]
      if (v === undefined || (v.startsWith('--') && !VALUE_FLAGS[v])) { a.bad = t + ' 缺少取值'; return a }
      a[VALUE_FLAGS[t]] = v
      i += 1
      continue
    }
    if (t.startsWith('-')) { a.bad = '未知参数 ' + t; return a }
    if (!a.cmd) { a.cmd = t; continue }
    a.bad = '多余的参数 ' + t
    return a
  }
  return a
}

/** 直接 process.exit 在管道里可能截断 stdout（PS 侧就是重定向抓取），先等 stdout 排空 */
const finish = (code) => {
  try { process.stdout.write('', () => process.exit(code)) } catch { process.exit(code) }
  const t = setTimeout(() => process.exit(code), 2000)
  if (t.unref) t.unref()
}

const emitJson = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

const fail = (jsonMode, action, errorCode, error, extra) => {
  if (jsonMode) emitJson(Object.assign({ ok: false, action, errorCode, error, exitCode: 1 }, extra || {}))
  else process.stderr.write('shell-update: ' + error + '\n')
  finish(1)
}

// ---- check ------------------------------------------------------------------
const runCheck = async (opts) => {
  const m = await loadManifest(opts.manifest, opts.base)
  if (!m.ok) return fail(opts.json, 'check', m.errorCode, m.error)
  const local = readLocalManifest()
  const rows = computePlan(m.files)
  const changedRows = rows.filter((r) => r.action !== 'skip')
  const added = changedRows.filter((r) => r.action === 'add').length
  const updated = changedRows.filter((r) => r.action === 'update').length
  const changed = changedRows.length
  const removed = computeRemoved(m.files)
  const localVer = local.shellVersion
  const remoteVer = m.shellVersion
  let status = 'up-to-date'
  let code = 4
  if (!local.present) { status = 'update-available'; code = 0 }
  else if (localVer && isNewer(localVer, remoteVer) && !opts.force) { status = 'local-newer'; code = 4 }
  else if (isNewer(remoteVer, localVer) || changed > 0) { status = 'update-available'; code = 0 }
  const summary = {
    ok: true,
    action: 'check',
    local: localVer,
    remote: remoteVer,
    changed,
    upToDate: code === 4,
    files: changedRows.map((r) => r.path),
    added,
    updated,
    skipped: rows.length - changed,
    status,
    removed,
    changes: changedRows.map((r) => ({ path: r.path, action: r.action, localSha: r.localSha, remoteSha: r.remoteSha })),
    localManifest: { present: local.present, fileCount: local.files.length },
    manifest: { source: m.source, kind: m.kind, base: m.base, generatedAt: m.generatedAt, fileCount: Object.keys(m.files).length },
    exitCode: code,
  }
  if (opts.json) { emitJson(summary); return finish(code) }

  if (status === 'up-to-date') {
    process.stdout.write('SHELL 已是最新 (' + (localVer || remoteVer) + ')\n')
    process.stdout.write('  变更文件：0 个（清单 ' + Object.keys(m.files).length + ' 个文件全部一致）\n')
  } else if (status === 'local-newer') {
    process.stdout.write('SHELL ' + localVer + ' -> ' + remoteVer + '（远端更旧，不降级；确需回退用 stage --force）\n')
    process.stdout.write('  变更文件：' + changed + ' 个\n')
  } else {
    process.stdout.write('SHELL ' + localVer + ' -> ' + remoteVer + '（' + changed + ' 个文件变更）\n')
    process.stdout.write('  变更文件：' + changed + ' 个（新增 ' + added + ' / 更新 ' + updated + '）' + (removed.length ? '；清单已删 ' + removed.length + ' 个' : '') + '\n')
  }
  process.stdout.write('  清单：' + (m.kind === 'url' ? m.source : m.localPath) + (m.generatedAt ? '（generatedAt ' + m.generatedAt + '）' : '') + '\n')
  finish(code)
}

// ---- stage ------------------------------------------------------------------
/** staging 目录防手滑：不能是仓库根 / 仓库根上级 / 盘根 / 用户目录 */
const guardStageDir = (dir) => {
  const abs = resolve(dir)
  const norm = (s) => String(s).replace(/[\\/]+$/, '').toLowerCase()
  const a = norm(abs)
  const root = norm(ROOT)
  if (!a) throw new Error('staging 路径为空')
  if (a === root) throw new Error('staging 不能是仓库根：' + abs)
  if (root.startsWith(a + '\\')) throw new Error('staging 不能是仓库根的上级：' + abs)
  if (/^[a-z]:$/.test(a) || /^[a-z]:\\$/.test(a)) throw new Error('staging 不能是盘根：' + abs)
  for (const k of ['USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SYSTEMROOT']) {
    if (process.env[k] && norm(process.env[k]) === a) throw new Error('staging 不能直接用 ' + k + ' 目录：' + abs)
  }
  if (a.split('\\').filter(Boolean).length < 2) throw new Error('staging 路径太浅，拒绝：' + abs)
  return abs
}

const defaultStageDir = (version) => {
  const safe = String(version).replace(/[^\w.+-]/g, '_')
  const base = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Hack3rX-Harness', 'build') : join(ROOT, 'tmp')
  return join(base, 'shell-' + safe)
}

/** 小并发拉取（CONCURRENCY 路），结果按清单顺序落回数组，输出仍然确定 */
const downloadAll = async (targets, base) => {
  const out = new Array(targets.length)
  let idx = 0
  const worker = async () => {
    while (true) {
      const i = idx++
      if (i >= targets.length) return
      const t = targets[i]
      const got = await getBytes(base, t.path)
      out[i] = Object.assign({}, t, got)
    }
  }
  const n = Math.min(CONCURRENCY, targets.length)
  await Promise.all(Array.from({ length: n }, worker))
  return out
}

const runStage = async (opts) => {
  const m = await loadManifest(opts.manifest, opts.base)
  if (!m.ok) return fail(opts.json, 'stage', m.errorCode, m.error)
  const local = readLocalManifest()

  // 降级保护：远端比本地旧说明拿错了源（分支/镜像），默认不做
  if (local.present && local.shellVersion && !opts.force && isNewer(local.shellVersion, m.shellVersion)) {
    return fail(opts.json, 'stage', 'downgrade-refused', '远端 ' + m.shellVersion + ' 比本地 ' + local.shellVersion + ' 旧，拒绝降级（确需回退加 --force）')
  }

  let stageDir = ''
  try { stageDir = guardStageDir(opts.stage || defaultStageDir(m.shellVersion)) }
  catch (e) { return fail(opts.json, 'stage', 'stage-dir-invalid', e.message) }

  const rows = computePlan(m.files)
  const targets = opts.force ? rows.slice() : rows.filter((r) => r.action !== 'skip')
  const removed = computeRemoved(m.files)
  // 版本号对不上也要落 staging：只有 shell-version.json 需要同步时没有文件要下
  const versionSync = !local.present || local.shellVersion !== m.shellVersion
  const willWrite = targets.length > 0 || versionSync
  const warnings = []

  if (!willWrite) {
    const idle = { ok: true, action: 'stage', shellVersion: m.shellVersion, stage: stageDir, stageCreated: false, files: [], skipped: rows.length, downloaded: 0, added: 0, updated: 0, bytes: 0, removed, manifestFile: null, warnings, exitCode: 0 }
    if (opts.json) { emitJson(idle); return finish(0) }
    process.stdout.write('SHELL 已是最新 (' + m.shellVersion + ')，staging 未创建（0 个文件）\n')
    process.stdout.write('  跳过 ' + rows.length + ' 个文件（sha256 与清单一致）\n')
    return finish(0)
  }

  // 1) 全部下到内存：一个失败就整次失败，staging 一个字节都不写
  const got = await downloadAll(targets, m.base)
  const dlFailed = got.filter((g) => !g.ok)
  if (dlFailed.length) {
    const detail = dlFailed.slice(0, 5).map((g) => g.path + '：' + g.error).join('；') + (dlFailed.length > 5 ? ' …' : '')
    return fail(opts.json, 'stage', 'download-failed', dlFailed.length + ' 个文件下载失败 —— ' + detail, { shellVersion: m.shellVersion, stage: stageDir })
  }

  // 2) 编码校验（按字节）：任何一条不过就整次失败，且一个字节都不落盘
  const encBad = []
  for (const g of got) {
    const v = validateShellBytes(g.path, g.buf)
    if (!v.ok) encBad.push(v.error)
    else if (v.warnings) warnings.push.apply(warnings, v.warnings)
  }
  if (encBad.length) {
    return fail(opts.json, 'stage', 'encoding-violation', encBad.length + ' 个文件编码不合规，已中止（staging 未写） —— ' + encBad.slice(0, 5).join('；'), { shellVersion: m.shellVersion, stage: stageDir, violations: encBad })
  }

  // 3) 先对 sha256，再落盘（下载即写字节，绝不重新编码）
  const shaBad = got.filter((g) => sha256(g.buf) !== g.remoteSha)
  if (shaBad.length) {
    return fail(opts.json, 'stage', 'sha-mismatch', '下载内容与清单 sha256 不符：' + shaBad.slice(0, 5).map((g) => g.path).join('；'), { shellVersion: m.shellVersion, stage: stageDir })
  }

  // 4) staging 清空重建（guardStageDir 已挡住危险路径）
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })

  // 5) 写文件 + 立刻读回校验 sha256（防磁盘层出问题）
  let totalBytes = 0
  for (const g of got) {
    const abs = join(stageDir, g.path)
    if (!resolve(abs).toLowerCase().startsWith(stageDir.toLowerCase() + '\\')) {
      return fail(opts.json, 'stage', 'whitelist-violation', '落盘路径逃出 staging：' + g.path)
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, g.buf)
    const back = sha256File(abs)
    if (back !== g.remoteSha) return fail(opts.json, 'stage', 'sha-mismatch', '落盘后校验不一致：' + g.path, { shellVersion: m.shellVersion, stage: stageDir })
    g.bytes = g.buf.length
    totalBytes += g.bytes
  }

  // 6) 清单本身也进 staging（原字节）：换装时一并覆盖，版本号才会同步，否则下次 check 还报有更新
  const manifestAbs = join(stageDir, SHELL_MANIFEST)
  writeFileSync(manifestAbs, m.raw)
  const manifestFile = { path: SHELL_MANIFEST, bytes: m.raw.length, sha256: sha256File(manifestAbs) }

  const out = {
    ok: true,
    action: 'stage',
    shellVersion: m.shellVersion,
    stage: stageDir,
    stageCreated: true,
    files: got.map((g) => ({ path: g.path, action: g.action, bytes: g.bytes })),
    skipped: rows.length - got.length,
    downloaded: got.length,
    added: got.filter((g) => g.action === 'add').length,
    updated: got.filter((g) => g.action === 'update').length,
    bytes: totalBytes,
    removed,
    manifestFile,
    warnings,
    exitCode: 0,
  }
  if (opts.json) { emitJson(out); return finish(0) }

  process.stdout.write('SHELL ' + (local.shellVersion || '(无本地清单)') + ' -> ' + m.shellVersion + '\n')
  process.stdout.write('  清单：' + (m.kind === 'url' ? m.source : m.localPath) + '（' + Object.keys(m.files).length + ' 个文件）\n')
  process.stdout.write('  staging：' + stageDir + '\n')
  process.stdout.write('  下载 ' + got.length + ' 个（新增 ' + out.added + ' / 更新 ' + out.updated + '），跳过 ' + out.skipped + ' 个，共 ' + fmtSize(totalBytes) + '\n')
  for (const g of got) process.stdout.write('    ' + (g.action === 'add' ? '+ ' : '~ ') + g.path + '  ' + fmtSize(g.bytes) + '\n')
  if (removed.length) {
    process.stdout.write('  清单已删 ' + removed.length + ' 个（本脚本不删，交 PS 侧决定）：\n')
    for (const r of removed) process.stdout.write('    - ' + r + '\n')
  }
  if (warnings.length) process.stdout.write('  警告：' + warnings.slice(0, 5).join('；') + (warnings.length > 5 ? ' …' : '') + '\n')
  process.stdout.write('  staging 内另附 shell-version.json（换装时请一并覆盖，版本号才会同步）\n')
  finish(0)
}

// ---- 入口 -------------------------------------------------------------------
const main = async () => {
  const a = parseArgs(process.argv.slice(2))
  if (a.help) { process.stdout.write(USAGE + '\n'); return finish(0) }
  if (a.bad) { process.stderr.write('shell-update: ' + a.bad + '\n\n' + USAGE + '\n'); return finish(2) }
  if (!a.cmd) { process.stderr.write('shell-update: 缺少子命令\n\n' + USAGE + '\n'); return finish(2) }
  if (a.cmd === 'check') return runCheck(a)
  if (a.cmd === 'stage') return runStage(a)
  process.stderr.write('shell-update: 未知子命令 ' + a.cmd + '\n\n' + USAGE + '\n')
  return finish(2)
}

/** 只有被当脚本直接跑才执行；clean-ship.mjs 会 import 这里的白名单 / sha / 版本读取 */
const invokedDirectly = (() => {
  try { return resolve(process.argv[1] || '').toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase() } catch { return false }
})()
if (invokedDirectly) {
  main().catch((e) => {
    if (process.argv.includes('--json')) emitJson({ ok: false, action: 'unknown', errorCode: 'internal', error: String((e && e.message) || e), exitCode: 1 })
    else process.stderr.write('shell-update: 未捕获异常 ' + String((e && e.stack) || e) + '\n')
    finish(1)
  })
}
