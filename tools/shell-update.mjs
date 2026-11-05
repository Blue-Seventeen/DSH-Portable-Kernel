/**
 * 便携壳自更新 v2 —— 版本线（GitHub Release）清单 + 校验 + staging + 换装编排。
 *
 * 分工：本脚本负责"取清单 / 算计划 / 下载校验 / 落 staging / 调换装引擎"；
 * 真正改文件（备份 → 原子替换 → verify → 回滚 → 恢复）在 tools\shell-apply.mjs，PS 侧只做前置检查与提示。
 *
 * 版本线（永不从 master 拉）：
 *   发现最新稳定版  https://github.com/<repo>/releases/latest/download/shell-version.json
 *   取该版文件      https://raw.githubusercontent.com/<repo>/refs/tags/v<版本>/<path>
 *   锁定/降级       https://raw.githubusercontent.com/<repo>/refs/tags/v<版本>/shell-version.json
 *
 *   node tools\shell-update.mjs check    [--cached <分钟>] [--prompt] [--json] [--to <版本>] [--manifest <路径|URL>] [--base <路径|URL>]
 *   node tools\shell-update.mjs stage    [--to <版本>] [--full] [--stage <目录>] [--json]
 *   node tools\shell-update.mjs apply    [--force] [--dry-run] [--to <版本>] [--full] [--no-verify] [--json]
 *   node tools\shell-update.mjs rollback [--json]
 *   node tools\shell-update.mjs recover  [--json]
 *   node tools\shell-update.mjs notes    [--to <版本>] [--json]
 *   node tools\shell-update.mjs defaults [--json]
 *
 * 退出码：0 有更新/成功 · 4 已最新 · 3 被兼容性挡下 · 1 失败 · 2 用法错误
 *
 * 三条铁律（按字节判定，绝不重新编码后落盘）：
 *   *.cmd                 纯 ASCII 且 CRLF
 *   *.ps1                 必须以 EF BB BF 开头，且不能有两个连续 BOM
 *   *.md/.json/.mjs/.yml  不得以 BOM 开头
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPLY_JOURNAL, applyUpdate, listBackups, recoverUpdate, rollbackUpdate } from './shell-apply.mjs'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const SHELL_MANIFEST = 'shell-version.json'
/** 清单/换装语义版本（读得懂的最高版本） */
export const MANIFEST_SCHEMA = 2
/** 本更新器自身的能力级别（写进清单的 updaterMin 不能高于它） */
export const UPDATER_MIN = 2
export const REPO = 'Blue-Seventeen/DSH-Portable-Kernel'
export const RELEASES = 'https://github.com/' + REPO + '/releases'
export const DEFAULT_MANIFEST = RELEASES + '/latest/download/' + SHELL_MANIFEST
export const RAW_BASE = 'https://raw.githubusercontent.com/' + REPO
export const ALLOWED_HOSTS = ['github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'codeload.github.com']
export const TAG_PREFIX = 'v'
export const EXIT_OK = 0
export const EXIT_FAIL = 1
export const EXIT_USAGE = 2
export const EXIT_BLOCKED = 3
export const EXIT_UP_TO_DATE = 4
let FETCH_TIMEOUT_MS = 8000
let RETRIES = 3
const CONCURRENCY = 2
const CACHE_FILE = 'tmp/shell-check.json'
const SNOOZE_FILE = 'tmp/shell-snooze.json'

const USAGE = [
  '用法：',
  '  node tools\\shell-update.mjs check    [--cached <分钟>] [--prompt] [--json] [--to <版本>] [--manifest <路径|URL>] [--base <路径|URL>]',
  '  node tools\\shell-update.mjs stage    [--to <版本>] [--full] [--stage <目录>] [--json]',
  '  node tools\\shell-update.mjs apply    [--force] [--dry-run] [--to <版本>] [--full] [--no-verify] [--json]',
  '  node tools\\shell-update.mjs rollback [--json]',
  '  node tools\\shell-update.mjs recover  [--json]',
  '  node tools\\shell-update.mjs snooze   [--json] [--clear]   （--clear 撤销"这次不更新"）',
  '  node tools\\shell-update.mjs notes    [--to <版本>] [--json]',
  '  node tools\\shell-update.mjs defaults [--json]',
  '',
  '  --manifest   清单来源（默认 ' + DEFAULT_MANIFEST + '）；本地文件路径 = 自测/离线接缝',
  '  --base       文件基址（默认由清单来源推导：远端 → refs/tags/v<版本>/）',
  '  --to <版本>  锁定到某个已发布版本（取 refs/tags/v<版本>/shell-version.json）',
  '  --cached <分钟>  check 用缓存（0=强制刷新）',
  '  --prompt     只打印一段紧凑提示（给 preflight 用）',
  '  --full       整包 zip 换装（跨版本/壳被改花时用）',
  '  --force      apply 真的换（不加只预演）；也用于允许降级',
  '  --json       只输出一行机器可读 JSON（纯 ASCII，\\u 转义中文，供 PowerShell ConvertFrom-Json）',
  '',
  '退出码：0 有更新/成功 · 4 已最新 · 3 被兼容性挡下 · 1 失败 · 2 用法错误',
].join('\n')

// ---- 壳文件白名单（唯一权威；tools\clean-ship.mjs 生成清单时复用同一份） ------
/** 根目录随壳更新的脚本：清单里点名的 10 个 */
export const ROOT_SHELL_FILES = [
  'dsh-portable.ps1', 'preflight.cmd', 'start-web.cmd', 'start-desktop.cmd', 'dsh-portable.cmd',
  'dsh.cmd', 'dsh-plugin.cmd', 'dsh-plugin-shared.cmd', 'check-update.cmd', 'env.cmd',
]
/**
 * 用户可变文件：正常使用中会被插件市场 / fix-pnpm-state / 用户自己改写。
 * 换装时"改过就保留"：只有与已安装清单哈希一致（= 用户没动过）时才覆盖。
 */
export const USER_OWNED = [
  'home/cordis.patch.yml',
  'home/profiles/package.json',
  'home/profiles/pnpm-lock.yaml',
  'home/profiles/web/package.json',
  'home/profiles/web/pnpm-lock.yaml',
  'home/profiles/web/cordis.patch.yml',
  'home/profiles/desktop/package.json',
  'home/profiles/desktop/pnpm-lock.yaml',
]
/** 整条路径点名（不支持通配）：README/LICENSE/发布说明 + home\profiles 的固定根 */
const SHELL_EXACT = [
  ...ROOT_SHELL_FILES,
  'README.md',
  'LICENSE',
  'RELEASE-NOTES.md',
  SHELL_MANIFEST,
  'home/cordis.patch.yml',
  'home/profiles/package.json',
  // 注意：三份 pnpm-workspace.yaml **不随壳发布**（见 SHELL_DENY）：里面是 storeDir 等机器配置，
  // 由 tools\fix-pnpm-state.mjs 每次启动时生成/对齐；发布它们会让升级把用户的 store 配置冲掉。
  'home/profiles/pnpm-lock.yaml',
  'home/profiles/web/package.json',
  'home/profiles/web/pnpm-lock.yaml',
  'home/profiles/web/cordis.yml',
  'home/profiles/web/cordis.patch.yml',
  'home/profiles/desktop/package.json',
  'home/profiles/desktop/pnpm-lock.yaml',
  'home/profiles/desktop/cordis.yml',
]
/** 这俩目录下任意文件（tools\7z 的二进制、vcredist 也随壳走） */
const SHELL_PREFIXES = ['tools/', 'runtime/vcredist/']
/**
 * 显式禁止，优先级最高：
 *   home/profiles/desktop/cordis.patch.yml 是用户私有网关配置（一覆盖就把人家的中转打没了）
 *   home/profiles/web/cordis.patch.yml    反过来：它是用户网页模式的网关配置，属"用户可变"，不禁止但要保留改动
 *   version.json 是官方层出厂快照、.gitattributes/.gitignore 是仓库元数据，都不属于"壳"
 */
const SHELL_DENY = [ 'home/profiles/desktop/cordis.patch.yml', // 用户私有网关配置，覆盖会打掉中转
  // 机器配置（storeDir / packageImportMethod / modulesDir）由 fix-pnpm-state 在每次启动时写入，
  // 绝不能随壳发布：一旦被 tag 里的干净版覆盖，pnpm 的 store 解析就会漂到 $PNPM_HOME/store，
  // 与 node_modules\.modules.yaml 记录不一致 → 该 profile 的装/卸全部被 pnpm 拒绝（2026-11-04 事故）。
  'home/profiles/pnpm-workspace.yaml',
  'home/profiles/web/pnpm-workspace.yaml',
  'home/profiles/desktop/pnpm-workspace.yaml',
  'version.json', '.gitattributes', '.gitignore']

const SHELL_EXACT_SET = new Set(SHELL_EXACT.map((s) => s.toLowerCase()))
const SHELL_DENY_SET = new Set(SHELL_DENY.map((s) => s.toLowerCase()))
const USER_OWNED_SET = new Set(USER_OWNED.map((s) => s.toLowerCase()))

const toPosix = (p) => String(p).replace(/\\/g, '/')
const hex8 = (x) => '0x' + x.toString(16).padStart(2, '0')
const lower = (p) => String(p).toLowerCase()

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
  const low = lower(rel)
  if (SHELL_DENY_SET.has(low)) return false
  if (SHELL_EXACT_SET.has(low)) return true
  return SHELL_PREFIXES.some((pre) => low.startsWith(pre) && low.length > pre.length)
}

/** 该路径是否属于"用户可变"（改过就保留） */
export const isUserOwnedPath = (p) => {
  const rel = normalizeRel(p)
  return !!rel && USER_OWNED_SET.has(lower(rel))
}

const walkFiles = (absDir, relPrefix, out) => {
  let ents = []
  try { ents = readdirSync(absDir, { withFileTypes: true }) } catch { return }
  for (const d of ents) {
    const rel = relPrefix + d.name
    if (d.isDirectory()) walkFiles(join(absDir, d.name), rel + '/', out)
    else if (d.isFile() && isAllowedShellPath(rel) && lower(rel) !== lower(SHELL_MANIFEST)) out.push(rel)
  }
}

/** 本地"当前存在"的壳文件（正斜杠相对路径，字典序）。shell-version.json 自己不进 files 列表。 */
export const listLocalShellFiles = () => {
  const out = []
  for (const rel of SHELL_EXACT) {
    if (lower(rel) === lower(SHELL_MANIFEST)) continue
    try { if (statSync(join(ROOT, rel)).isFile() && isAllowedShellPath(rel)) out.push(rel) } catch { }
  }
  for (const pre of SHELL_PREFIXES) walkFiles(join(ROOT, pre), pre, out)
  return out.filter((v, i, a) => a.indexOf(v) === i).sort()
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
export const sha256File = (abs) => sha256(readFileSync(abs))

// ---- 编码校验（仓库铁律，按字节判定） ---------------------------------------
const startsWithBom = (b) => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
const NO_BOM_EXT = ['md', 'json', 'mjs', 'yml', 'yaml']

/**
 * 校验一份即将落盘的壳文件字节。只拒绝、不改写（改了就等于偷偷重编码）。
 * @returns {{ok: boolean, error?: string, warnings?: string[]}}
 */
export const validateShellBytes = (relPath, buf) => {
  const rel = normalizeRel(relPath) || toPosix(String(relPath))
  const low = lower(rel)
  const name = rel.replace(/\//g, '\\')
  const warnings = []
  if (low.endsWith('.cmd')) {
    const bad = buf.findIndex((x) => x > 0x7f)
    if (bad !== -1) {
      return { ok: false, error: name + ' 不是纯 ASCII（偏移 ' + bad + ' 处是 ' + hex8(buf[bad]) + '）；.cmd 必须纯 ASCII + CRLF' }
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
export const parseVer = (v) => {
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

/** 极简范围判定：支持 ">=x" ">x" "<=x" "<x" "=x" 与逗号组合；解析不了返回 null（= 不判） */
export const satisfiesRange = (ver, range) => {
  const cur = String(ver || '').trim()
  if (!cur || !range) return null
  const conds = String(range).split(',').map((s) => s.trim()).filter(Boolean)
  for (const c of conds) {
    const m = /^(>=|<=|>|<|=)?\s*v?(.+)$/.exec(c)
    if (!m) return null
    const op = m[1] || '='
    const target = m[2].trim()
    if (op === '>=') { if (isNewer(target, cur) && !equalVer(target, cur)) return false }
    else if (op === '>') { if (!isNewer(cur, target)) return false }
    else if (op === '<=') { if (isNewer(cur, target)) return false }
    else if (op === '<') { if (!isNewer(target, cur)) return false }
    else if (!equalVer(cur, target)) return false
  }
  return true
}
const equalVer = (a, b) => {
  const x = parseVer(a), y = parseVer(b)
  const n = Math.max(x.nums.length, y.nums.length, 3)
  for (let i = 0; i < n; i++) if ((x.nums[i] || 0) !== (y.nums[i] || 0)) return false
  if (x.pre.length !== y.pre.length) return false
  return cmpPre(x.pre, y.pre) === 0
}

// ---- IO ---------------------------------------------------------------------
const isUrl = (s) => /^https?:\/\//i.test(String(s == null ? '' : s))
const trimUrl = (s) => String(s).replace(/\/+$/, '')
const joinUrl = (base, rel) => trimUrl(base) + '/' + rel.split('/').map(encodeURIComponent).join('/')
const tagFor = (ver) => TAG_PREFIX + String(ver == null ? '' : ver).replace(/^v/i, '')
const hostOf = (u) => { try { return new URL(u).host.toLowerCase() } catch { return '' } }

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
      const r = await fetch(url, { signal: withTimeout(FETCH_TIMEOUT_MS), cache: 'no-store', redirect: 'follow' })
      if (!r.ok) {
        last = 'HTTP ' + r.status + (r.statusText ? ' ' + r.statusText : '')
        if (r.status >= 400 && r.status < 500) break
        continue
      }
      return { ok: true, buf: Buffer.from(await r.arrayBuffer()), finalUrl: r.url || url }
    } catch (e) {
      last = e && e.name === 'AbortError' ? '超时（' + FETCH_TIMEOUT_MS + 'ms）' : String((e && e.message) || e)
    }
    if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
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
    const raw = readFileSync(join(ROOT, SHELL_MANIFEST))
    const j = JSON.parse(raw.toString('utf8'))
    const files = j && j.files && typeof j.files === 'object' && !Array.isArray(j.files) ? j.files : {}
    return { present: true, raw, json: j, shellVersion: String((j && j.shellVersion) || '').trim(), files: normalizeShaMap(files) }
  } catch { return { present: false, raw: null, json: null, shellVersion: '', files: {} } }
}
const normalizeShaMap = (obj) => {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    const rel = normalizeRel(k)
    const sha = String(v || '').trim().toLowerCase()
    if (rel && /^[0-9a-f]{64}$/.test(sha)) out[rel] = sha
  }
  return out
}

/** 本地壳版本号（clean-ship / PS 侧都可以直接用，不必自己再解析 JSON） */
export const readShellVersion = () => readLocalManifest().shellVersion

const NOTES_SECTIONS = [
  ['added', '新增'],
  ['fixed', '修复'],
  ['optimized', '优化'],
  ['breaking', '破坏性变更'],
  ['upgrade', '升级会做什么'],
  ['rollback', '如何回退'],
]
export { NOTES_SECTIONS }

/** 默认文件基址：远端清单 → refs/tags/v<版本>/；本地清单 → 所在目录 */
export const deriveBase = (source, tag) => {
  if (!isUrl(source)) return dirname(resolve(process.cwd(), source))
  if (/\/releases\/(?:latest|download)\//i.test(source)) return RAW_BASE + '/refs/tags/' + tag
  return trimUrl(source).replace(/\/[^/]*$/, '')
}

/**
 * 拉远端清单并逐条校验（schema / 路径白名单 / sha256 / 大小写重名 / 编码）。
 * @returns {{ok: boolean, errorCode?: string, error?: string, blockers?: array, ...}}
 */
const loadManifest = async (opts) => {
  const tagHint = opts.to ? tagFor(opts.to) : ''
  const source = opts.manifest || (tagHint ? RAW_BASE + '/refs/tags/' + tagHint + '/' + SHELL_MANIFEST : DEFAULT_MANIFEST)
  if (isUrl(source) && !opts.allowUntrusted && !ALLOWED_HOSTS.includes(hostOf(source))) {
    return { ok: false, errorCode: 'untrusted-host', error: '清单来源不是可信主机：' + source + '（确需使用请加 --allow-untrusted）' }
  }
  let buf = null
  let kind = 'url'
  let localPath = null
  let finalUrl = source
  if (isUrl(source)) {
    const r = await fetchBytes(source)
    if (!r.ok) return { ok: false, errorCode: 'manifest-unreachable', error: '取不到清单 ' + source + '：' + r.error }
    buf = r.buf
    finalUrl = r.finalUrl || source
  } else {
    kind = 'file'
    localPath = resolve(process.cwd(), source)
    try { buf = readFileSync(localPath) } catch (e) { return { ok: false, errorCode: 'manifest-unreachable', error: '读不到清单 ' + localPath + '：' + e.message } }
  }
  const enc = validateShellBytes(SHELL_MANIFEST, buf)
  if (!enc.ok) return { ok: false, errorCode: 'manifest-invalid', error: '清单本身编码不合规：' + enc.error }

  let json = null
  try { json = JSON.parse(buf.toString('utf8')) } catch (e) { return { ok: false, errorCode: 'manifest-invalid', error: '清单不是合法 JSON：' + e.message } }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, errorCode: 'manifest-invalid', error: '清单不是 JSON 对象' }

  const shellVersion = typeof json.shellVersion === 'string' ? json.shellVersion.trim() : ''
  if (!shellVersion) return { ok: false, errorCode: 'manifest-invalid', error: '清单缺少 shellVersion' }
  const schemaVersion = Number.isInteger(json.schemaVersion) ? json.schemaVersion : 1
  const updaterMin = Number.isInteger(json.updaterMin) ? json.updaterMin : 1
  const tag = typeof json.tag === 'string' && json.tag.trim() ? json.tag.trim() : tagFor(shellVersion)
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
    if (lower(rel) === lower(SHELL_MANIFEST)) { bad.push(String(rawPath) + '（清单不能更新自己）'); continue }
    const low = lower(rel)
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

  // userOwned：清单可以显式给，但必须是 files 的子集；缺省用代码里的名单
  const userOwned = []
  if (Array.isArray(json.userOwned)) {
    for (const p of json.userOwned) {
      const rel = normalizeRel(p)
      if (!rel) return { ok: false, errorCode: 'manifest-invalid', error: 'userOwned 里有非法路径：' + String(p) }
      if (!isUserOwnedPath(rel)) return { ok: false, errorCode: 'manifest-invalid', error: 'userOwned 里有非"用户可变"路径：' + rel }
      if (!Object.prototype.hasOwnProperty.call(files, rel)) return { ok: false, errorCode: 'manifest-invalid', error: 'userOwned 里有 files 中不存在的路径：' + rel }
      userOwned.push(rel)
    }
  } else {
    for (const rel of Object.keys(files)) if (isUserOwnedPath(rel)) userOwned.push(rel)
  }

  const migrations = Array.isArray(json.migrations) ? json.migrations.filter((m) => m && typeof m.id === 'string' && typeof m.script === 'string' && /^tools\/[A-Za-z0-9._-]+\.mjs$/.test(m.script) && Object.prototype.hasOwnProperty.call(files, m.script)) : []
  const zip = json.zip && typeof json.zip === 'object' && typeof json.zip.name === 'string' && /^[A-Za-z0-9._-]+\.zip$/.test(json.zip.name)
    ? { name: json.zip.name, sha256: String(json.zip.sha256 || '').toLowerCase(), bytes: Number(json.zip.bytes) || 0 }
    : null

  const base = opts.base ? String(opts.base) : (typeof json.base === 'string' && json.base.trim() ? json.base.trim() : deriveBase(kind === 'url' ? source : localPath, tag))

  return {
    ok: true,
    source,
    finalUrl,
    kind,
    localPath,
    base,
    raw: buf,
    json,
    schemaVersion,
    updaterMin,
    shellVersion,
    tag,
    channel: typeof json.channel === 'string' ? json.channel.trim() : 'stable',
    minShellVersion: typeof json.minShellVersion === 'string' ? json.minShellVersion.trim() : '',
    requires: json.requires && typeof json.requires === 'object' ? json.requires : {},
    notes: json.notes && typeof json.notes === 'object' ? json.notes : {},
    notesUrl: typeof json.notesUrl === 'string' ? json.notesUrl : '',
    migrations,
    zip,
    files,
    userOwned,
    generatedAt: typeof json.generatedAt === 'string' ? json.generatedAt : '',
  }
}

/** 本地官方层版本（用于 requires.dsh） */
const localDshVersion = () => {
  const paths = ['app/node_modules/@deepseek-ai/dsh/package.json', 'app/package.json']
  for (const rel of paths) {
    try {
      const j = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
      if (j && j.version) return String(j.version)
    } catch { }
  }
  return ''
}

/** 兼容性闸门：schema / updater / minShellVersion / requires */
const compatBlockers = (m, installed, opts) => {
  const blockers = []
  if (m.schemaVersion > MANIFEST_SCHEMA) {
    blockers.push({ code: 'schema-too-new', message: '这份清单是 schema v' + m.schemaVersion + '，本壳只读得懂 v' + MANIFEST_SCHEMA, fix: '从 Release 页下载 harness-shell-' + m.shellVersion + '.zip 手工覆盖壳文件后再升级' })
  }
  if (m.updaterMin > UPDATER_MIN) {
    blockers.push({ code: 'updater-too-old', message: '这份清单要求更新器至少 v' + m.updaterMin + '（本壳是 v' + UPDATER_MIN + '）', fix: '先升到中间版本，或从 Release 页下载 zip 手工覆盖壳文件' })
  }
  if (m.minShellVersion && installed.present && isNewer(m.minShellVersion, installed.shellVersion)) {
    blockers.push({ code: 'need-full', message: '跨版本太大：要升到 ' + m.shellVersion + ' 至少得先有 ' + m.minShellVersion + '（本壳是 ' + installed.shellVersion + '）', fix: '改跑 apply --full（整包 zip 换装）' })
  }
  const wantDsh = m.requires && typeof m.requires.dsh === 'string' ? m.requires.dsh : ''
  if (wantDsh) {
    const have = localDshVersion()
    if (have) {
      const ok = satisfiesRange(have, wantDsh)
      if (ok === false) blockers.push({ code: 'requires-dsh', message: '这份壳要求官方层 dsh ' + wantDsh + '，本机是 ' + have, fix: '先 dsh-portable.cmd update-app -Force / update-desktop -Force' })
    }
  }
  const wantNode = m.requires && typeof m.requires.node === 'string' ? m.requires.node : ''
  if (wantNode) {
    const have = process.versions.node
    const ok = satisfiesRange(have, wantNode)
    if (ok === false) blockers.push({ code: 'requires-node', message: '这份壳要求 node ' + wantNode + '，本机是 ' + have, fix: '先 dsh-portable.cmd bootstrap 更新运行时' })
  }
  if (!(opts && opts.force)) return blockers
  // --force 只越过"官方层/运行时版本"这类软要求；schema 太新、更新器太旧、跨版本太大永远硬挡
  return blockers.map((b) => (/^requires-/.test(b.code) ? Object.assign({}, b, { ignoredByForce: true }) : b))
}

/** 远端清单 vs 本地实物：code/update、user-owned 保留、add、skip。userOwned 以清单为准（缺省回退到代码常量） */
export const computePlan = (m, installed) => {
  const rows = []
  const ownedSet = new Set((Array.isArray(m.userOwned) ? m.userOwned : USER_OWNED).map(lower))
  for (const rel of Object.keys(m.files).sort()) {
    const abs = join(ROOT, rel)
    let have = null
    let size = 0
    try {
      const st = statSync(abs)
      if (st.isFile()) { have = sha256File(abs); size = st.size }
    } catch { }
    const remoteSha = m.files[rel]
    const owned = ownedSet.has(lower(rel))
    let action = 'skip'
    // userOwned 被用户删掉：尊重删除意图，不自动装回来（首次安装由 bootstrap 负责）
    if (have === null && owned) action = 'skip'
    else if (have === null) action = 'add'
    else if (have === remoteSha) action = 'skip'
    else if (owned && (installed.files[rel] ? installed.files[rel] !== have : true)) action = 'preserved'
    // tools\ 是整目录白名单：本地已有、但"上一版清单没装过"的文件，是用户自己放的脚本，永不覆盖
    else if (!owned && installed.files[rel] === undefined && lower(rel).startsWith('tools/')) action = 'preserved'
    else action = 'update'
    rows.push({ path: rel, action, class: owned ? 'user-owned' : 'code', localSha: have, remoteSha, bytes: size })
  }
  return rows
}

/** removed = 本地上一版清单里有、远端这版没有的文件（只认自己装过的，且不动用户可变/用户自建） */
/**
 * 机器配置：由 fix-pnpm-state 生成，绝不随壳发布，也绝不能被"清单里删掉了"当成待删文件删除。
 * 2026-11-04 事故：0.3.0 把三份 pnpm-workspace.yaml 移出清单后，升级把它们当成"清单已删文件"删掉，
 * pnpm 随即漂到 $PNPM_HOME/store，与 node_modules 记录不一致 → 装不上插件。
 */
export const isMachineConfigPath = (rel) => {
  const low = lower(rel)
  return low === 'home/profiles/pnpm-workspace.yaml'
    || /^home\/profiles\/[^/]+\/pnpm-workspace\.yaml$/.test(low)
}

export const computeRemoved = (m, installed) => {
  if (!installed.present) return []
  // 保护集：新清单的 userOwned + **已安装清单的 userOwned**（从清单里移除的旧用户文件也不删）
  const ownedSet = new Set([
    ...(Array.isArray(m.userOwned) ? m.userOwned : USER_OWNED),
    ...(Array.isArray(installed.userOwned) ? installed.userOwned : []),
  ].map(lower))
  const remote = new Set(Object.keys(m.files).map(lower))
  const out = []
  for (const rel of Object.keys(installed.files)) {
    if (lower(rel) === lower(SHELL_MANIFEST)) continue
    if (!isAllowedShellPath(rel)) continue
    if (isMachineConfigPath(rel)) continue          // 机器配置永不删
    if (ownedSet.has(lower(rel))) continue
    if (!remote.has(lower(rel))) out.push(rel)
  }
  return out.sort()
}

// ---- 缓存 / 贪睡 ---------------------------------------------------------------
const readJsonFile = (rel) => { try { return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) } catch { return null } }
const writeJsonFile = (rel, obj) => {
  try {
    const abs = join(ROOT, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, JSON.stringify(obj, null, 2) + '\n')
  } catch { }
}
const readCache = () => readJsonFile(CACHE_FILE)
const readSnooze = () => readJsonFile(SNOOZE_FILE)
const snoozedFor = (version) => {
  const s = readSnooze()
  if (!s || !s.version || !s.at) return false
  if (String(s.version) !== String(version)) return false
  return Date.now() - Number(s.at) < 7 * 24 * 3600 * 1000
}

// ---- 打印 --------------------------------------------------------------------
const fmtSize = (n) => (n >= 1048576 ? (Math.round((n / 1048576) * 10) / 10) + ' MB' : n >= 1024 ? (Math.round((n / 1024) * 10) / 10) + ' KB' : n + ' B')
const write = (s) => process.stdout.write(s)
const line = (s) => process.stdout.write((s == null ? '' : s) + '\n')

const printNotes = (m, compact) => {
  const n = m.notes || {}
  const rows = []
  for (const [key, label] of NOTES_SECTIONS) {
    const arr = Array.isArray(n[key]) ? n[key].filter((x) => String(x).trim()) : []
    // 六小节固定：没有内容的也打印"无"，别让用户以为漏了一节（尤其"破坏性变更"）
    rows.push([label, arr.length ? arr : ['无']])
  }
  if (!rows.length) { line('  更新细则：这一版没有提供（见 ' + (m.notesUrl || 'Release 页面') + '）'); return }
  for (const [label, arr] of rows) {
    if (label === '破坏性变更') line('  ⚠ 破坏性变更：')
    else line('  ' + label + '：')
    const show = compact ? arr.slice(0, 2) : arr
    for (const x of show) line('    - ' + String(x).trim())
    if (show.length < arr.length) line('    … 还有 ' + (arr.length - show.length) + ' 条')
  }
  if (m.notesUrl) line('  详情：' + m.notesUrl)
}

const printBlockers = (blockers) => {
  if (!blockers.length) return
  line('  被兼容性挡下：')
  for (const b of blockers) {
    line('    ✗ ' + b.message + (b.ignoredByForce ? '（已用 --force 忽略）' : ''))
    if (b.fix && !b.ignoredByForce) line('      → ' + b.fix)
  }
}

const printPlan = (m, rows, removed, installed) => {
  const add = rows.filter((r) => r.action === 'add')
  const upd = rows.filter((r) => r.action === 'update')
  const keep = rows.filter((r) => r.action === 'preserved')
  line('  变更文件：' + (add.length + upd.length) + ' 个（新增 ' + add.length + ' / 更新 ' + upd.length + '）' + (removed.length ? '；清单已删 ' + removed.length + ' 个' : ''))
  for (const r of upd.slice(0, 12)) line('    更新  ' + r.path + '  ' + fmtSize(r.bytes))
  if (upd.length > 12) line('    … 还有 ' + (upd.length - 12) + ' 个更新')
  for (const r of add.slice(0, 12)) line('    新增  ' + r.path)
  if (add.length > 12) line('    … 还有 ' + (add.length - 12) + ' 个新增')
  if (keep.length) {
    line('  保留你的改动（不覆盖）：' + keep.length + ' 个')
    for (const r of keep) line('    保留  ' + r.path)
  }
  if (removed.length) for (const p of removed.slice(0, 12)) line('    删除  ' + p)
  line('  清单：' + (m.kind === 'url' ? m.finalUrl : m.localPath) + (m.generatedAt ? '（generatedAt ' + m.generatedAt + '）' : ''))
}

// ---- 结果与 JSON ----------------------------------------------------------------
/** 单行 + 纯 ASCII（中文转成 \\uXXXX，PS 的 ConvertFrom-Json 会正确解码） */
const asciiJson = (obj) => JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
const emitJson = (obj) => process.stdout.write(asciiJson(obj) + '\n')

/** 直接 process.exit 在管道里可能截断 stdout（PS 侧就是重定向抓取），先等 stdout 排空 */
const finish = (code) => {
  try { process.stdout.write('', () => process.exit(code)) } catch { process.exit(code) }
  const t = setTimeout(() => process.exit(code), 2000)
  if (t.unref) t.unref()
}

let QUIET_FAIL = false
// 启动路径（preflight）失败时不刷屏：把错误记一笔，由 preflight 的 [11] 显示"检查失败：…"
const CHECK_ERR = 'tmp/shell-check.err.json'
const recordCheckError = (error) => {
  try { writeJsonFile(CHECK_ERR, { at: Date.now(), error: String(error || '').slice(0, 300) }) } catch { }
}
const fail = (jsonMode, action, errorCode, error, extra) => {
  const code = extra && Number.isInteger(extra.exitCode) ? extra.exitCode : (errorCode === 'blocked' ? EXIT_BLOCKED : EXIT_FAIL)
  if (action === 'check') recordCheckError(error)
  if (jsonMode) emitJson(Object.assign({ ok: false, action, errorCode, error, exitCode: code }, extra || {}))
  else if (!(QUIET_FAIL && action === 'check')) process.stderr.write('shell-update: ' + error + '\n')
  finish(code)
}

// ---- check ------------------------------------------------------------------
const buildSummary = (m, installed, rows, removed, blockers, opts) => {
  const add = rows.filter((r) => r.action === 'add')
  const upd = rows.filter((r) => r.action === 'update')
  const keep = rows.filter((r) => r.action === 'preserved')
  const localVer = installed.shellVersion
  const remoteVer = m.shellVersion
  let status = 'up-to-date'
  let code = EXIT_UP_TO_DATE
  // 只有"远端确实更新"时，minShellVersion / requires 才值得拦人；
  // 同版本或远端更旧时把它们当噪音（否则 v0.1.0 首发那种 minShellVersion 写高了会永远误报）。
  const hardBlockers = blockers.filter((b) => !b.ignoredByForce)
  const remoteIsNewer = !installed.present || isNewer(remoteVer, localVer)
  const relevantBlockers = hardBlockers.filter((b) => b.code === 'schema-too-new' || b.code === 'updater-too-old' || remoteIsNewer)
  if (relevantBlockers.length) { status = 'blocked'; code = EXIT_BLOCKED }
  else if (!installed.present) { status = 'update-available'; code = EXIT_OK }
  else if (localVer && isNewer(localVer, remoteVer) && !opts.force) { status = 'local-newer'; code = EXIT_UP_TO_DATE }
  else if (isNewer(remoteVer, localVer) || add.length + upd.length > 0) { status = 'update-available'; code = EXIT_OK }
  return {
    ok: true,
    action: 'check',
    schema: m.schemaVersion,
    local: localVer,
    remote: remoteVer,
    channel: m.channel,
    status,
    changed: add.length + upd.length,
    added: add.length,
    updated: upd.length,
    removed: removed.length,
    skipped: rows.filter((r) => r.action === 'skip').length,
    skippedLocalChanges: keep.map((r) => r.path),
    files: rows.filter((r) => r.action !== 'skip' && r.action !== 'preserved').map((r) => r.path),
    changes: rows.filter((r) => r.action !== 'skip' && r.action !== 'preserved').map((r) => ({ path: r.path, action: r.action, class: r.class, localSha: r.localSha, remoteSha: r.remoteSha })),
    preserved: keep.map((r) => ({ path: r.path, action: 'preserved', class: r.class })),
    blockedFiles: removed,
    blockers,
    notes: m.notes,
    notesUrl: m.notesUrl,
    manifest: { source: m.source, kind: m.kind, base: m.base, tag: m.tag, generatedAt: m.generatedAt, fileCount: Object.keys(m.files).length },
    localManifest: { present: installed.present, fileCount: Object.keys(installed.files).length },
    exitCode: code,
    _rows: rows,
    _removed: removed,
  }
}

const runCheck = async (opts) => {
  // 缓存：只有"取不到远端"或显式 --cached 时才用；有缓存且未过期就直接回放
  const sourceKey = opts.manifest || (opts.to ? RAW_BASE + '/refs/tags/' + tagFor(opts.to) + '/' + SHELL_MANIFEST : DEFAULT_MANIFEST)
  const cache = opts.cached > 0 ? readCache() : null
  // 缓存必须绑定"同一份清单来源"，否则 --manifest 切换后会回放别的清单的结论（preflight 也会被污染）；
  // 还必须绑定"本地版本"：升级完成后本地版本变了，旧缓存的 "0.2.0 -> 0.2.1" 就不能再回放
  //（2026-11-04 实测：升级到 0.2.1 后 preflight 仍提示 0.2.0 -> 0.2.1）。
  const installedNow = readLocalManifest()
  const cacheLocalOk = !!cache && !!cache.summary
    && String(cache.summary.local || '') === String(installedNow.shellVersion || '')
  if (cache && cacheLocalOk && cache.at && cache.source === sourceKey && Date.now() - Number(cache.at) < opts.cached * 60000 && cache.summary) {
    const s = cache.summary
    if (opts.prompt && snoozedFor(s.remote)) return finish(EXIT_UP_TO_DATE)
    if (opts.json) { emitJson(Object.assign({}, s, { cached: true, exitCode: s.exitCode, _rows: undefined, _removed: undefined })); return finish(s.exitCode) }
    if (opts.prompt) { printPrompt(s); return finish(s.exitCode) }
    line('SHELL ' + (s.local || '(未知)') + ' -> ' + s.remote + '（缓存 ' + Math.round((Date.now() - Number(cache.at)) / 60000) + ' 分钟前）')
    printBlockers(s.blockers || [])
    printNotes({ notes: s.notes, notesUrl: s.notesUrl }, false)
    return finish(s.exitCode)
  }

  const m = await loadManifest(opts)
  if (!m.ok) return fail(opts.json, 'check', m.errorCode, m.error)
  const installed = readLocalManifest()
  const rows = computePlan(m, installed)
  const removed = computeRemoved(m, installed)
  const blockers = compatBlockers(m, installed, opts)
  const summary = buildSummary(m, installed, rows, removed, blockers, opts)
  // 只有"从网络真查到"的结果才写缓存（本地清单测试不落盘）；这样 doctor/preflight 读到的永远是最近一次真实结论
  if (m.kind === 'url') {
    writeJsonFile(CACHE_FILE, { at: Date.now(), source: sourceKey, version: m.shellVersion, summary: Object.assign({}, summary, { _rows: undefined, _removed: undefined }) })
    // 这次真查成功了：清掉上一次的失败记录
    try { unlinkSync(join(ROOT, CHECK_ERR)) } catch { }
  }
  const { _rows, _removed, ...clean } = summary

  if (opts.json) {
    if (opts.prompt && snoozedFor(m.shellVersion)) return finish(EXIT_UP_TO_DATE)
    emitJson(clean)
    return finish(clean.exitCode)
  }
  if (opts.prompt) {
    // "这次不更新"：7 天内不再提醒（preflight 会调 snooze 写入），静默退出 4
    if (snoozedFor(m.shellVersion)) return finish(EXIT_UP_TO_DATE)
    printPrompt(clean)
    return finish(clean.exitCode)
  }
  if (snoozedFor(m.shellVersion) && clean.status === 'update-available') {
    line('SHELL ' + (clean.local || '(未知)') + ' -> ' + clean.remote + '（你已选择暂不更新，7 天内不再提醒；要更新请运行 dsh-portable.cmd shell-update apply -Force（或 node tools\\shell-update.mjs apply --force））')
    return finish(clean.exitCode)
  }
  if (clean.status === 'up-to-date') {
    line('SHELL 已是最新 (' + (clean.local || clean.remote) + ')')
    line('  变更文件：0 个（清单 ' + clean.manifest.fileCount + ' 个文件全部一致）')
  } else if (clean.status === 'local-newer') {
    line('SHELL ' + clean.local + ' -> ' + clean.remote + '（远端更旧，不降级；确需回退用 apply --to ' + clean.remote + ' --force）')
  } else if (clean.status === 'blocked') {
    line('SHELL ' + (clean.local || '(未知)') + ' -> ' + clean.remote + '：这次不能自动升级')
    printBlockers(clean.blockers)
  } else {
    line('SHELL ' + (clean.local || '(未知)') + ' -> ' + clean.remote + '（' + clean.changed + ' 个文件变更）')
    printPlan(m, rows, removed, installed)
    printNotes(m, false)
  }
  finish(clean.exitCode)
}

const NOTE_LIMIT = 2
const printPrompt = (s) => {
  if (s.status === 'up-to-date') return
  if (s.status === 'blocked') { line('  壳更新 ' + (s.local || '?') + ' -> ' + s.remote + ' 被挡下：' + ((s.blockers || [])[0] || {}).message); return }
  // 一处一行的要点式：以前把一节里所有条目用"；"拼成一行，控制台里会变成一大坨。
  line('')
  line('  发现壳更新  ' + (s.local || '(未知)') + '  →  ' + s.remote + '     ' + s.changed + ' 个文件；保留你的改动 ' + (s.skippedLocalChanges || []).length + ' 个')
  line('  ' + '─'.repeat(54))
  const n = s.notes || {}
  const breaking = Array.isArray(n.breaking) ? n.breaking.filter((x) => String(x).trim()) : []
  if (breaking.length) {
    line('  ⚠ 破坏性变更')
    for (const x of breaking.slice(0, NOTE_LIMIT)) line('      · ' + String(x).trim())
    if (breaking.length > NOTE_LIMIT) line('      … 还有 ' + (breaking.length - NOTE_LIMIT) + ' 条')
  }
  for (const [key, label] of NOTES_SECTIONS) {
    if (key === 'breaking') continue
    const arr = Array.isArray(n[key]) ? n[key].filter((x) => String(x).trim()) : []
    if (!arr.length) continue
    line('  ' + label)
    for (const x of arr.slice(0, NOTE_LIMIT)) line('      · ' + String(x).trim())
    if (arr.length > NOTE_LIMIT) line('      … 还有 ' + (arr.length - NOTE_LIMIT) + ' 条（node tools\\shell-update.mjs notes 看全部）')
  }
  if (s.notesUrl) line('  详情：' + s.notesUrl)
  line('')
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
  const base = process.env.DSH_STAGE || join(ROOT, 'tmp', 'build')
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

const sevenZip = () => join(ROOT, 'tools', '7z', '7z.exe')

/** --full：下载整包 zip → 解到 staging → 逐文件按清单校验（多/少/不符都算失败） */
const stageFull = async (m, stageDir, log) => {
  if (!m.zip || !/^[0-9a-f]{64}$/.test(m.zip.sha256 || '')) {
    return { ok: false, errorCode: 'manifest-invalid', error: '这份清单没有可用的整包 zip 信息（--full 需要 zip{name,sha256}）' }
  }
  const url = RELEASES + '/download/' + encodeURIComponent(m.tag) + '/' + encodeURIComponent(m.zip.name)
  log('整包下载：' + url)
  const got = await fetchBytes(url)
  if (!got.ok) return { ok: false, errorCode: 'zip-unreachable', error: '取不到整包 ' + url + '：' + got.error }
  const sha = sha256(got.buf)
  if (sha !== m.zip.sha256) return { ok: false, errorCode: 'zip-sha-mismatch', error: '整包 sha256 不符（清单 ' + m.zip.sha256.slice(0, 12) + '… / 实际 ' + sha.slice(0, 12) + '…）' }
  const z7 = sevenZip()
  if (!existsSync(z7)) return { ok: false, errorCode: 'no-7z', error: '找不到 tools\\7z\\7z.exe，无法解整包' }
  mkdirSync(stageDir, { recursive: true })
  const zipPath = join(stageDir, m.zip.name)
  writeFileSync(zipPath, got.buf)
  const r = spawnSync(z7, ['x', zipPath, '-o' + stageDir, '-y'], { stdio: 'ignore' })
  rmSync(zipPath, { force: true })
  if (r.status !== 0) return { ok: false, errorCode: 'unzip-failed', error: '7z 解包失败（exit ' + r.status + '）' }
  // 多/少/不符 → 全有或全无
  const allowed = new Set(Object.keys(m.files).map(lower))
  allowed.add(lower(SHELL_MANIFEST))
  const stray = []
  const walk = (abs, prefix) => {
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      const rel = prefix + d.name
      if (d.isDirectory()) walk(join(abs, d.name), rel + '/')
      else if (!allowed.has(lower(rel))) stray.push(rel)
    }
  }
  walk(stageDir, '')
  if (stray.length) return { ok: false, errorCode: 'zip-extra-files', error: '整包里有清单外的文件：' + stray.slice(0, 5).join(', ') + (stray.length > 5 ? ' …' : '') }
  const bad = []
  for (const rel of Object.keys(m.files)) {
    const abs = join(stageDir, rel)
    let have = null
    try { have = sha256File(abs) } catch { }
    if (have === null) bad.push(rel + '（整包缺）')
    else if (have !== m.files[rel]) bad.push(rel + '（sha 不符）')
  }
  if (bad.length) return { ok: false, errorCode: 'zip-content-mismatch', error: '整包内容与清单不符：' + bad.slice(0, 5).join('；') + (bad.length > 5 ? ' …' : '') }
  writeFileSync(join(stageDir, SHELL_MANIFEST), m.raw)
  return { ok: true, full: true, files: Object.keys(m.files).map((p) => ({ path: p, action: 'update' })), bytes: got.buf.length, manifestFile: { path: SHELL_MANIFEST, bytes: m.raw.length, sha256: sha256(m.raw) } }
}

const runStage = async (opts) => {
  const m = await loadManifest(opts)
  if (!m.ok) return fail(opts.json, 'stage', m.errorCode, m.error)
  const blockers = compatBlockers(m, readLocalManifest(), opts)
  const hard = blockers.filter((b) => !b.ignoredByForce)
  if (hard.length) return fail(opts.json, 'stage', 'blocked', hard.map((b) => b.message).join('；'), { blockers: hard, exitCode: EXIT_BLOCKED })
  const installed = readLocalManifest()
  const rows = computePlan(m, installed)
  const targets = rows.filter((r) => r.action === 'add' || r.action === 'update')
  const stageDir = guardStageDir(opts.stage ? opts.stage : defaultStageDir(m.shellVersion))
  const log = (s) => line(s)

  if (opts.full) {
    const r = await stageFull(m, stageDir, log)
    if (!r.ok) return fail(opts.json, 'stage', r.errorCode, r.error)
    const summary = { ok: true, action: 'stage', full: true, shellVersion: m.shellVersion, tag: m.tag, stage: stageDir, stageCreated: true, files: r.files, skipped: rows.filter((x) => x.action === 'skip').length, downloaded: r.files.length, added: 0, updated: r.files.length, bytes: r.bytes, removed: computeRemoved(m, installed), manifestFile: r.manifestFile, warnings: [], exitCode: EXIT_OK }
    if (opts.json) { emitJson(summary); return finish(EXIT_OK) }
    line('整包已解到 ' + stageDir + '（' + r.files.length + ' 个文件全部校验通过）')
    return finish(EXIT_OK)
  }

  if (targets.length === 0) {
    // 没有要下的文件：只把清单落到 staging（换装时用于版本推进）
    mkdirSync(stageDir, { recursive: true })
    writeFileSync(join(stageDir, SHELL_MANIFEST), m.raw)
    const summary = { ok: true, action: 'stage', shellVersion: m.shellVersion, tag: m.tag, stage: stageDir, stageCreated: false, files: [], skipped: rows.length, downloaded: 0, added: 0, updated: 0, bytes: 0, removed: computeRemoved(m, installed), manifestFile: { path: SHELL_MANIFEST, bytes: m.raw.length, sha256: sha256(m.raw) }, warnings: [], exitCode: EXIT_OK }
    if (opts.json) { emitJson(summary); return finish(EXIT_OK) }
    line('没有要下载的文件（' + rows.length + ' 个已一致）')
    return finish(EXIT_OK)
  }

  const got = await downloadAll(targets, m.base)
  const bad = []
  const warnings = []
  const okFiles = []
  for (const g of got) {
    if (!g.ok) { bad.push(g.path + '（下载失败：' + g.error + '）'); continue }
    const enc = validateShellBytes(g.path, g.buf)
    if (enc.warnings && enc.warnings.length) warnings.push(...enc.warnings)
    if (!enc.ok) { bad.push(enc.error); continue }
    const sha = sha256(g.buf)
    if (sha !== m.files[g.path]) { bad.push(g.path + '（sha256 不符：清单 ' + m.files[g.path].slice(0, 12) + '… / 实际 ' + sha.slice(0, 12) + '…）'); continue }
    okFiles.push({ path: g.path, action: g.action, buf: g.buf })
  }
  if (bad.length) {
    // 与 apply 一致：逐文件下载没全过时，退一步走 Release 整包 zip（企业网关偶发挡裸文件）
    if (m.zip && /^[0-9a-f]{64}$/.test(m.zip.sha256 || '')) {
      if (!opts.json) line('逐文件下载没全过（' + bad.length + ' 个），改走整包 zip 兜底…')
      const full = await stageFull(m, stageDir, (s) => { if (!opts.json) line('  ' + s) })
      if (full.ok) {
        const summary = { ok: true, action: 'stage', full: true, shellVersion: m.shellVersion, tag: m.tag, stage: stageDir, stageCreated: true, files: full.files, skipped: rows.filter((x) => x.action === 'skip').length, downloaded: full.files.length, added: 0, updated: full.files.length, bytes: full.bytes, removed: computeRemoved(m, installed), manifestFile: full.manifestFile, warnings: [], exitCode: EXIT_OK }
        if (opts.json) { emitJson(summary); return finish(EXIT_OK) }
        line('整包已解到 ' + stageDir + '（' + full.files.length + ' 个文件全部校验通过）')
        return finish(EXIT_OK)
      }
      bad.push('整包兜底也失败：' + full.error)
    }
    return fail(opts.json, 'stage', 'verify-failed', '下载/校验没全过，一个字节都没落盘：' + bad.slice(0, 5).join('；') + (bad.length > 5 ? ' …' : ''), { failed: bad.slice(0, 50), warnings })
  }

  // 全有或全无：先清空本次 staging 里清单内的旧文件，再写
  for (const f of okFiles) {
    const abs = join(stageDir, f.path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, f.buf)
  }
  writeFileSync(join(stageDir, SHELL_MANIFEST), m.raw)

  const summary = {
    ok: true, action: 'stage', shellVersion: m.shellVersion, tag: m.tag, stage: stageDir, stageCreated: true,
    files: okFiles.map((f) => ({ path: f.path, action: f.action, bytes: f.buf.length })),
    skipped: rows.length - okFiles.length,
    downloaded: okFiles.length,
    added: okFiles.filter((f) => f.action === 'add').length,
    updated: okFiles.filter((f) => f.action === 'update').length,
    preserved: rows.filter((r) => r.action === 'preserved').map((r) => r.path),
    bytes: okFiles.reduce((a, f) => a + f.buf.length, 0),
    removed: computeRemoved(m, installed),
    manifestFile: { path: SHELL_MANIFEST, bytes: m.raw.length, sha256: sha256(m.raw) },
    warnings, exitCode: EXIT_OK,
  }
  if (opts.json) { emitJson(summary); return finish(EXIT_OK) }
  line('已下载 ' + okFiles.length + ' 个文件到 ' + stageDir + '（' + fmtSize(summary.bytes) + '）')
  for (const w of warnings.slice(0, 5)) line('  ⚠ ' + w)
  return finish(EXIT_OK)
}

// ---- apply / rollback / recover -----------------------------------------------
const verifyCmd = (opts) => {
  if (opts.noVerify) return { cmd: null, enabled: false }
  const vp = join(ROOT, 'tools', 'verify-shell.mjs')
  return { cmd: [process.execPath, vp, '--update-gate'], enabled: true, quiet: !!opts.json }
}

const runApply = async (opts) => {
  const m = await loadManifest(opts)
  if (!m.ok) return fail(opts.json, 'apply', m.errorCode, m.error)
  const installed = readLocalManifest()
  // 已经是这一版：直接说"已是最新"，不要再走 stage/换装，也不要打印
  // "清单已从 0.2.1 推进到 0.2.1"（2026-11-04 用户实测的困惑）。
  if (installed.present && String(installed.shellVersion || '') === String(m.shellVersion || '')) {
    if (opts.json) {
      emitJson({
        ok: true, action: 'apply', upToDate: true, from: installed.shellVersion, to: m.shellVersion,
        applied: [], deleted: [], preserved: [], skipped: 0,
        verify: { ok: null, code: null, failed: [], ran: false }, migrations: [],
        rolledBack: false, backup: null, journal: null, errors: [], exitCode: EXIT_OK,
      })
      return finish(EXIT_OK)
    }
    line('已是最新（' + installed.shellVersion + '），没有需要更新的文件')
    return finish(EXIT_OK)
  }
  const blockers = compatBlockers(m, installed, opts)
  const hard = blockers.filter((b) => !b.ignoredByForce)
  if (hard.length) return fail(opts.json, 'apply', 'blocked', hard.map((b) => b.message).join('；'), { blockers: hard, exitCode: EXIT_BLOCKED })
  const rows = computePlan(m, installed)
  const targets = rows.filter((r) => r.action === 'add' || r.action === 'update')

  if (!opts.force) {
    // 预演：只报告
    if (opts.json) {
      const summary = buildSummary(m, installed, rows, computeRemoved(m, installed), blockers, opts)
      const { _rows, _removed, ...clean } = summary
      emitJson(Object.assign(clean, { action: 'apply', dryRun: true, exitCode: EXIT_OK }))
      return finish(summary.status === 'blocked' ? EXIT_BLOCKED : EXIT_OK)
    }
    line('壳更新预演（只报告，不改文件）：')
    line('SHELL ' + (installed.shellVersion || '(未知)') + ' -> ' + m.shellVersion)
    printPlan(m, rows, computeRemoved(m, installed), installed)
    printNotes(m, false)
    line('')
    line('这是预演，加 --force 才真的替换（自动备份，失败自动回滚）')
    return finish(EXIT_OK)
  }

  if (targets.length === 0 && computeRemoved(m, installed).length === 0) {
    // 版本号可能前进（比如只改清单 notes），也要把清单写回
    // 没有要替换的文件，但清单本身可能变了（版本号 / notes）：把清单原子写回，让版本号前进
    const mf = join(ROOT, SHELL_MANIFEST)
    try {
      writeFileSync(mf + '.new', m.raw)
      renameSync(mf + '.new', mf)
    } catch (e) {
      return fail(opts.json, 'apply', 'manifest-write-failed', '清单写回失败：' + e.message)
    }
    const appliedRows = [{ path: SHELL_MANIFEST, action: 'update' }]
    if (opts.json) { emitJson({ ok: true, action: 'apply', dryRun: false, from: installed.shellVersion, to: m.shellVersion, applied: appliedRows, deleted: [], preserved: rows.filter((r) => r.action === 'preserved').map((r) => r.path), skipped: rows.length, verify: { ok: null, code: null, failed: [], ran: false }, migrations: [], rolledBack: false, backup: null, journal: null, errors: [], exitCode: EXIT_OK }); return finish(EXIT_OK) }
    line('没有要替换的文件；清单已从 ' + (installed.shellVersion || '?') + ' 推进到 ' + m.shellVersion)
    return finish(EXIT_OK)
  }

  const stageDir = guardStageDir(opts.stage ? opts.stage : defaultStageDir(m.shellVersion))
  // 先 stage（无 --json，避免和最终 JSON 混在一起）
  const stageOpts = Object.assign({}, opts, { json: false })
  const stageCode = await runStageInner(m, installed, stageOpts, stageDir)
  if (stageCode !== 0) return fail(opts.json, 'apply', 'stage-failed', '取文件/校验阶段失败，没有改动任何本地文件')
  if (!existsSync(join(stageDir, SHELL_MANIFEST))) return fail(opts.json, 'apply', 'stage-failed', 'staging 里没有清单文件')

  const res = await applyUpdate({
    root: ROOT,
    stage: stageDir,
    backupRoot: join(ROOT, 'cache'),
    journalPath: join(ROOT, APPLY_JOURNAL),
    // 清单自己不在 files 里（loadManifest 会拒绝"清单更新自己"），但换装时必须把它一并落盘，
    // 否则换装成功而版本号不前进 → 下次 check 又报有更新。这里在传给引擎前补上。
    manifest: { raw: m.raw, files: Object.assign({}, m.files, { [SHELL_MANIFEST]: sha256(m.raw) }), userOwned: m.userOwned, remove: computeRemoved(m, installed) },
    installed: { present: installed.present, shellVersion: installed.shellVersion, files: installed.files },
    isAllowed: isAllowedShellPath,
    verify: verifyCmd(opts),
    migrations: m.migrations,
    dryRun: false,
    logger: opts.json ? () => { } : (s) => line(s),
  })

  // 成功换装后 staging 没用了：留着只会让 tmp\build 越堆越大（失败时保留，便于排查）
  if (res.ok) { try { rmSync(stageDir, { recursive: true, force: true }) } catch { } }
  // 换装后立刻把机器配置对齐一次：storeDir / packageImportMethod / modulesDir 由 fix-pnpm-state 写进
  // 各 profile 的 pnpm-workspace.yaml。不重启也不会出现「node_modules 记录的 store ≠ pnpm 解析的 store」
  // → 商城装/卸插件不会被 pnpm 以 store 不一致拒绝（2026-11-04 事故的兜底）。
  if (res.ok) {
    try {
      const fix = join(ROOT, 'tools', 'fix-pnpm-state.mjs')
      if (existsSync(fix)) {
        const r = spawnSync(process.execPath, [fix, '--quiet'], { cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true })
        if (r.status !== 0 && !opts.json) line('  提示：换装后的 pnpm 状态对齐退出码 ' + r.status + '（不影响换装结果，下次启动会再跑一次）')
      }
    } catch { /* 对齐失败不影响换装结论 */ }
  }
  if (opts.json) {
    emitJson(Object.assign({ action: 'apply', from: installed.shellVersion, to: m.shellVersion }, res, { exitCode: res.ok ? EXIT_OK : EXIT_FAIL }))
    return finish(res.ok ? EXIT_OK : EXIT_FAIL)
  }
  if (!res.ok) {
    line('壳更新失败：' + (res.errors && res.errors.length ? res.errors.join('；') : '未知错误'))
    if (res.rolledBack) line('  已按备份整体回滚到 ' + (installed.shellVersion || '原版本') + '（备份：' + (res.backup || 'cache\\shell-backup-*') + '）')
    return finish(EXIT_FAIL)
  }
  line('壳已更新到 ' + m.shellVersion + '：' + (res.applied ? res.applied.length : 0) + ' 个文件已替换' + ((res.deleted || []).length ? '，' + res.deleted.length + ' 个旧文件已删' : '') + '，重启后生效')
  if ((res.preserved || []).length) line('  保留了你的改动：' + res.preserved.slice(0, 5).join(', ') + (res.preserved.length > 5 ? ' …' : ''))
  if ((res.migrations || []).length) for (const mg of res.migrations) line('  迁移 ' + mg.id + '：' + (mg.ok ? 'ok' : '失败（' + mg.message + '）'))
  line('  备份：' + (res.backup || 'cache\\shell-backup-*'))
  return finish(EXIT_OK)
}

/** stage 的实际执行体（供 apply 复用：返回退出码而不是直接 exit） */
const runStageInner = async (m, installed, opts, stageDir) => {
  const rows = computePlan(m, installed)
  const targets = rows.filter((r) => r.action === 'add' || r.action === 'update')
  if (opts.full) {
    const r = await stageFull(m, stageDir, (s) => line(s))
    return r.ok ? 0 : 1
  }
  mkdirSync(stageDir, { recursive: true })
  if (targets.length === 0) { writeFileSync(join(stageDir, SHELL_MANIFEST), m.raw); return 0 }
  const got = await downloadAll(targets, m.base)
  const bad = []
  for (const g of got) {
    if (!g.ok) { bad.push(g.path + '（下载失败：' + g.error + '）'); continue }
    const enc = validateShellBytes(g.path, g.buf)
    if (!enc.ok) { bad.push(enc.error); continue }
    if (sha256(g.buf) !== m.files[g.path]) { bad.push(g.path + '（sha256 不符）'); continue }
    const abs = join(stageDir, g.path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, g.buf)
  }
  if (bad.length) {
    // 企业网关/代理偶发挡裸文件（实测 618 jwt 错）时，退一步走 Release 里的整包 zip：
    // 一次请求、sha256 校验、解包后逐文件核对，语义与逐文件下载完全一致。
    if (m.zip && /^[0-9a-f]{64}$/.test(m.zip.sha256 || '')) {
      process.stderr.write('shell-update: 逐文件下载没全过（' + bad.length + ' 个），改走整包 zip 兜底…\n')
      const full = await stageFull(m, stageDir, (s) => process.stderr.write('  ' + s + '\n'))
      if (full.ok) return 0
      process.stderr.write('shell-update: 整包兜底也失败：' + full.error + '\n')
    }
    process.stderr.write('shell-update: 下载/校验没全过：' + bad.slice(0, 5).join('；') + '\n')
    return 1
  }
  writeFileSync(join(stageDir, SHELL_MANIFEST), m.raw)
  return 0
}

const runRollback = async (opts) => {
  const res = await rollbackUpdate({
    root: ROOT,
    backupRoot: join(ROOT, 'cache'),
    journalPath: join(ROOT, APPLY_JOURNAL),
    verify: verifyCmd(opts),
    isAllowed: isAllowedShellPath,
    logger: opts.json ? () => { } : (s) => line(s),
  })
  if (opts.json) { emitJson(Object.assign({ action: 'rollback' }, res, { exitCode: res.ok ? EXIT_OK : EXIT_FAIL })); return finish(res.ok ? EXIT_OK : EXIT_FAIL) }
  if (!res.ok) { line('回滚失败：' + (res.errors || []).join('；')); return finish(EXIT_FAIL) }
  if (res.noop) { line('没有可回滚的备份：' + (res.message || '')); return finish(EXIT_OK) }
  line('已回滚到 ' + (res.to || res.from || '上一版') + '（备份：' + (res.backup || '') + '）')
  finish(EXIT_OK)
}

const runRecover = async (opts) => {
  const res = await recoverUpdate({
    root: ROOT,
    backupRoot: join(ROOT, 'cache'),
    journalPath: join(ROOT, APPLY_JOURNAL),
    verify: verifyCmd(opts),
    isAllowed: isAllowedShellPath,
    logger: opts.json ? () => { } : (s) => line(s),
  })
  if (opts.json) { emitJson(Object.assign({ action: 'recover' }, res, { exitCode: res.ok ? EXIT_OK : EXIT_FAIL })); return finish(res.ok ? EXIT_OK : EXIT_FAIL) }
  if (!res.ok) { line('恢复失败：' + (res.errors || []).join('；')); return finish(EXIT_FAIL) }
  if (res.noop) { line('没有中断残留'); return finish(EXIT_OK) }
  line('上次换装中断，已恢复（备份：' + (res.backup || '') + '）')
  finish(EXIT_OK)
}

// ---- snooze -----------------------------------------------------------------
/** 「这次不更新」：记下远端版本，7 天内 preflight 不再问（菜单 U 随时可用） */
const runSnooze = async (opts) => {
  // --clear：撤销"这次不更新"，让 preflight 立刻恢复提示
  if (opts.clear) {
    try { unlinkSync(SNOOZE_FILE) } catch { /* 本来就没有 */ }
    if (opts.json) { emitJson({ ok: true, action: 'snooze', cleared: true, exitCode: EXIT_OK }); return finish(EXIT_OK) }
    line('已恢复更新提示（下次启动会重新检查）')
    return finish(EXIT_OK)
  }
  const m = await loadManifest(opts)
  const remote = m.ok ? m.shellVersion : String((readCache() || {}).version || '')
  if (!remote) return fail(opts.json, 'snooze', 'manifest-unreachable', '取不到远端版本，无法记录"这次不更新"')
  writeJsonFile(SNOOZE_FILE, { version: String(remote), at: Date.now(), until: Date.now() + 7 * 24 * 3600 * 1000 })
  if (opts.json) { emitJson({ ok: true, action: 'snooze', version: String(remote), days: 7, exitCode: EXIT_OK }); return finish(EXIT_OK) }
  line('已记下：' + remote + ' 这版先不更新（7 天内不再提示；想更新随时运行 dsh-portable.cmd shell-update apply -Force（或 node tools\\shell-update.mjs apply --force））')
  finish(EXIT_OK)
}

// ---- notes / defaults ---------------------------------------------------------
const runNotes = async (opts) => {
  const m = await loadManifest(opts)
  if (!m.ok) return fail(opts.json, 'notes', m.errorCode, m.error)
  if (opts.json) { emitJson({ ok: true, action: 'notes', version: m.shellVersion, channel: m.channel, notes: m.notes, notesUrl: m.notesUrl, exitCode: EXIT_OK }); return finish(EXIT_OK) }
  line('SHELL ' + m.shellVersion + '（' + m.channel + '，' + Object.keys(m.files).length + ' 个文件）')
  printNotes(m, false)
  finish(EXIT_OK)
}

const runDefaults = (opts) => {
  const out = {
    ok: true,
    repo: REPO,
    manifest: DEFAULT_MANIFEST,
    rawBase: RAW_BASE,
    tagTemplate: RAW_BASE + '/refs/tags/v<version>/',
    pinnedManifestTemplate: RAW_BASE + '/refs/tags/v<version>/' + SHELL_MANIFEST,
    releases: RELEASES,
    allowedHosts: ALLOWED_HOSTS,
    schemaVersion: MANIFEST_SCHEMA,
    updaterMin: UPDATER_MIN,
    userOwned: USER_OWNED,
    exitCodes: { ok: EXIT_OK, fail: EXIT_FAIL, usage: EXIT_USAGE, blocked: EXIT_BLOCKED, upToDate: EXIT_UP_TO_DATE },
  }
  if (opts.json) { emitJson(out); return finish(EXIT_OK) }
  line('repo      : ' + out.repo)
  line('manifest  : ' + out.manifest)
  line('raw base  : ' + out.rawBase + '/refs/tags/v<version>/')
  line('schema    : ' + out.schemaVersion + '（updaterMin ' + out.updaterMin + '）')
  line('userOwned : ' + out.userOwned.length + ' 个')
  finish(EXIT_OK)
}

// ---- CLI --------------------------------------------------------------------
const VALUE_FLAGS = { '--manifest': 'manifest', '--base': 'base', '--stage': 'stage', '--to': 'to', '--channel': 'channel', '--cached': 'cached' }
const BOOL_FLAGS = { '--json': 'json', '--force': 'force', '--full': 'full', '--prompt': 'prompt', '--dry-run': 'dryRun', '--no-verify': 'noVerify', '--allow-untrusted': 'allowUntrusted', '--clear': 'clear', '--brief': 'brief', '--quiet-fail': 'quietFail', '--help': 'help', '-h': 'help' }

const parseArgs = (argv) => {
  const a = { cmd: '', manifest: '', base: '', stage: '', to: '', channel: 'stable', cached: 0, json: false, force: false, full: false, prompt: false, dryRun: false, noVerify: false, allowUntrusted: false, clear: false, brief: false, quietFail: false, help: false, bad: '' }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (BOOL_FLAGS[t]) { a[BOOL_FLAGS[t]] = true; continue }
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
  a.cached = Number(a.cached) || 0
  if (a.dryRun) a.force = false
  // 启动路径（preflight）用 --brief：单次 10 秒、2 次尝试（4 秒太激进：GitHub 稍慢就误报"超时"）
  if (a.brief) { FETCH_TIMEOUT_MS = 10000; RETRIES = 2 }
  if (a.quietFail) QUIET_FAIL = true
  return a
}

const main = async () => {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { line(USAGE); return finish(EXIT_OK) }
  if (opts.bad) { process.stderr.write('shell-update: ' + opts.bad + '\n\n' + USAGE + '\n'); return finish(EXIT_USAGE) }
  try {
    switch (opts.cmd) {
      case 'check': return await runCheck(opts)
      case 'stage': return await runStage(opts)
      case 'apply': return await runApply(opts)
      case 'rollback': return await runRollback(opts)
      case 'recover': return await runRecover(opts)
      case 'snooze': return await runSnooze(opts)
      case 'notes': return await runNotes(opts)
      case 'defaults': return runDefaults(opts)
      case 'backups': {
        const list = listBackups(join(ROOT, 'cache'))
        if (opts.json) { emitJson({ ok: true, action: 'backups', backups: list, exitCode: EXIT_OK }); return finish(EXIT_OK) }
        for (const b of list) line(b.name + '  ' + (b.from || '?') + ' -> ' + (b.to || '?') + '  ' + (b.startedAt || ''))
        return finish(EXIT_OK)
      }
      default: process.stderr.write('shell-update: 未知子命令 ' + (opts.cmd || '(空)') + '\n\n' + USAGE + '\n'); return finish(EXIT_USAGE)
    }
  } catch (e) {
    return fail(opts.json, opts.cmd || 'unknown', 'exception', String((e && e.stack) || e))
  }
}

// 只有"直接跑这个文件"才执行 CLI：被 clean-ship / verify-shell 静态 import 时不能有副作用
// （否则 import 会立刻打印 usage 并 process.exit(2)）。
const isMain = (() => {
  try {
    const self = fileURLToPath(import.meta.url)
    const argv1 = process.argv[1] ? resolve(process.argv[1]) : ''
    return !!argv1 && self.toLowerCase() === argv1.toLowerCase()
  } catch { return false }
})()

if (isMain) main()
