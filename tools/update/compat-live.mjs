/**
 * 兼容性「活声明」（compat.json）——壳代码之外的活数据。
 *
 * ## 为什么要有这个东西
 *
 * 以前"壳支持哪些内核版本"写在壳清单（shell-version.json）的 requires.dsh 里，
 * 而清单是版本化制品的一部分：想改一个版本号，就得打一个新壳、发一个 Release，
 * 所有用户重下一遍壳文件。可官方内核一个 rc 接一个 rc 地发，绝大多数时候根本没动
 * 我们打补丁的那几个文件（2026-11-27 实测：dsh-fs-local 与 dsh-attachment-local 的
 * lib/index.js 在 rc.2 / rc.3 / rc.4 / rc.5 上逐字节相同）。
 * 于是变成"官方发个 rc，我们陪着发个壳"——纯属浪费。
 *
 * 所以把两件事拆开：
 *   - 壳代码 = 版本化制品（升级才有新代码）
 *   - 兼容面 = 一个不进版本号的 JSON，随时改、随时推，用户联网时自动拉
 *
 * ## 安全与降级（重要）
 *
 * 1. 只放宽，不收紧：远端声明与本壳清单取"并集"（下界取更低者、上界取更高者）。
 *    这样即使远端文件被改坏，最坏结果是"多认了几个内核版本"，
 *    而不是"把用户已经能用的内核判成不支持"。补丁本来就会自己报 needs-adapt。
 * 2. 拿不到就跳过：无网、超时、JSON 坏、schema 太新、字段不合法 —— 一律退回本壳清单。
 * 3. 限制体积：最多 64 KB。
 * 4. 不进版本、不进清单：它是 tmp 下的缓存，随时可丢，换壳也不会覆盖。
 *
 * ## 谁在用
 *   - tools/update/update-check.mjs：决定"官方内核更新是否提示 UPD"（最关键：放开后用户可直接升官方内核）
 *   - tools/update/shell-update.mjs：决定"内核比壳新"那条警告要不要显示
 *   - dsh-portable.ps1（doctor）：显示生效的兼容面来自哪里
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shellRoot } from '../lib/shell-root.mjs'

const ROOT = process.env.DSH_COMPAT_ROOT || shellRoot(import.meta.url)

/** 固定地址：永远不要改（老壳只认这个）。走 master 分支裸文件，改完推上去即生效，不需要发 Release。 */
export const COMPAT_URL = 'https://raw.githubusercontent.com/Blue-Seventeen/DSH-Portable-Kernel/master/compat.json'
export const SCHEMA_VERSION = 1
const CACHE_TTL = 6 * 60 * 60 * 1000
const MAX_BYTES = 64 * 1024

export const paths = (root = ROOT) => ({
  root,
  cache: join(root, 'tmp', 'compat.json'),
  stamp: join(root, 'tmp', 'compat.meta.json'),
  manifest: join(root, 'shell-version.json'),
})

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)
const readJson = (p) => { try { return JSON.parse(stripBom(readFileSync(p, 'utf8'))) } catch { return null } }

// ---- 区间解析与合并 ----------------------------------------------------------

/** 把 >=a,<=b 这类简单区间解析成 { floor, ceil, ceilInclusive }；解析不了返回 null */
export const parseSimpleRange = (range) => {
  if (typeof range !== 'string' || !range.trim()) return null
  const out = { floor: '', floorInclusive: true, ceil: '', ceilInclusive: false }
  for (const raw of range.split(/[,\s]+/)) {
    const c = raw.trim()
    if (!c) continue
    let m = /^>=\s*v?([0-9][0-9A-Za-z.+-]*)$/.exec(c)
    if (m) { out.floor = m[1]; out.floorInclusive = true; continue }
    m = /^>\s*v?([0-9][0-9A-Za-z.+-]*)$/.exec(c)
    if (m) { out.floor = m[1]; out.floorInclusive = false; continue }
    m = /^<=\s*v?([0-9][0-9A-Za-z.+-]*)$/.exec(c)
    if (m) { out.ceil = m[1]; out.ceilInclusive = true; continue }
    m = /^<\s*v?([0-9][0-9A-Za-z.+-]*)$/.exec(c)
    if (m) { out.ceil = m[1]; out.ceilInclusive = false; continue }
    return null
  }
  if (!out.floor && !out.ceil) return null
  return out
}

const cmpVer = (a, b) => {
  const split = (v) => String(v).trim().replace(/^v/i, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  const x = split(a), y = split(b)
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) {
    const p = x[i], q = y[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = typeof p === 'number', qn = typeof q === 'number'
    if (pn && qn) { if (p !== q) return p < q ? -1 : 1; continue }
    if (pn !== qn) return pn ? 1 : -1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

const renderRange = (r) => {
  const parts = []
  if (r.floor) parts.push('>=' + r.floor)
  if (r.ceil) parts.push((r.ceilInclusive ? '<=' : '<') + r.ceil)
  return parts.join(',')
}

/**
 * 合并两个区间，只许放宽：下界取更低者、上界取更高者。
 * 任一边解析不了就退回 a（本壳清单），绝不让无法解析的数据扩大范围。
 */
export const unionRange = (a, b) => {
  const pa = parseSimpleRange(a)
  const pb = parseSimpleRange(b)
  if (!pa) return { range: typeof a === 'string' ? a : '', widened: false }
  if (!pb) return { range: a, widened: false }
  const floor = !pa.floor ? pb.floor
    : !pb.floor ? pa.floor
      : (cmpVer(pb.floor, pa.floor) < 0 ? pb.floor : pa.floor)
  let take = 'a'
  if (!pa.ceil && !pb.ceil) take = 'a'
  else if (!pa.ceil) take = 'b'
  else if (!pb.ceil) take = 'a'
  else {
    const c = cmpVer(pb.ceil, pa.ceil)
    take = c > 0 ? 'b' : c === 0 && pb.ceilInclusive && !pa.ceilInclusive ? 'b' : 'a'
  }
  const merged = renderRange({
    floor,
    ceil: take === 'b' ? pb.ceil : pa.ceil,
    ceilInclusive: take === 'b' ? pb.ceilInclusive : pa.ceilInclusive,
  })
  return { range: merged, widened: normalized(merged) !== normalized(a) }
}

const normalized = (r) => {
  const p = parseSimpleRange(r)
  return p ? renderRange(p) : String(r || '')
}

// ---- 声明校验 ---------------------------------------------------------------

export const validateCompat = (raw, opts = {}) => {
  const localShell = String(opts.localShell || '')
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'not-an-object' }
  if (!Number.isInteger(raw.schemaVersion)) return { ok: false, error: 'no-schema' }
  if (raw.schemaVersion > SCHEMA_VERSION) return { ok: false, error: 'schema-too-new' }
  if (raw.minShell) {
    if (!/^\d+\.\d+\.\d+/.test(String(raw.minShell))) return { ok: false, error: 'bad-min-shell' }
    if (localShell && cmpVer(localShell, raw.minShell) < 0) return { ok: false, error: 'shell-too-old' }
  }
  const d = raw.dsh
  if (!d || typeof d !== 'object' || typeof d.range !== 'string') return { ok: false, error: 'no-range' }
  const p = parseSimpleRange(d.range)
  if (!p) return { ok: false, error: 'unparseable-range' }
  if (!p.ceil) return { ok: false, error: 'no-ceiling' }
  return {
    ok: true,
    data: {
      schemaVersion: raw.schemaVersion,
      updatedAt: raw.updatedAt || '',
      minShell: raw.minShell || '',
      range: normalized(d.range),
      verified: Array.isArray(d.verified) ? d.verified.filter((x) => typeof x === 'string').slice(0, 50) : [],
      note: typeof d.note === 'string' ? d.note.slice(0, 400) : '',
      patchedFiles: raw.patchedFiles && typeof raw.patchedFiles === 'object' ? raw.patchedFiles : {},
    },
  }
}

// ---- 读取：清单 + 缓存 + 网络 ------------------------------------------------

export const readManifestRange = (root = ROOT) => {
  const m = readJson(paths(root).manifest)
  return m && m.requires && typeof m.requires.dsh === 'string' ? m.requires.dsh : ''
}

export const readLocalShellVersion = (root = ROOT) => {
  const m = readJson(paths(root).manifest)
  return m && typeof m.shellVersion === 'string' ? m.shellVersion : ''
}

/** 只用本地缓存（不联网）。缓存过期也照用：它只会放宽，而且断网时更需要它。 */
export const effectiveDshRangeSync = (root = ROOT) => {
  const manifestRange = readManifestRange(root)
  const cached = readJson(paths(root).cache)
  const v = validateCompat(cached, { localShell: readLocalShellVersion(root) })
  if (!v.ok) return { range: manifestRange, source: 'manifest', reason: v.error, compat: null, manifestRange }
  const u = unionRange(manifestRange, v.data.range)
  return { range: u.range, source: u.widened ? 'compat' : 'manifest', compat: v.data, manifestRange }
}

const withTimeout = (ms) => {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  t.unref?.()
  return c.signal
}

/** 联网刷新。失败一律静默返回 ok:false。测试钩子：DSH_COMPAT_FILE=<本地路径> 时不联网。 */
export const refreshCompat = async (opts = {}) => {
  const root = opts.root || ROOT
  const p = paths(root)
  const ttl = Number.isFinite(opts.ttl) ? opts.ttl : CACHE_TTL
  if (!opts.force) {
    try {
      const meta = readJson(p.stamp)
      if (meta && Number(meta.at) && Date.now() - Number(meta.at) < ttl && existsSync(p.cache)) {
        return { ok: true, source: 'cache', at: Number(meta.at) }
      }
    } catch { }
  }
  let text = ''
  try {
    if (process.env.DSH_COMPAT_FILE) {
      const f = process.env.DSH_COMPAT_FILE
      if (!existsSync(f)) return { ok: false, error: 'no-file' }
      if (statSync(f).size > MAX_BYTES) return { ok: false, error: 'too-big' }
      text = readFileSync(f, 'utf8')
    } else {
      const res = await fetch(COMPAT_URL, { signal: withTimeout(opts.timeoutMs || 3000), headers: { 'cache-control': 'no-cache' } })
      if (!res.ok) return { ok: false, error: 'http-' + res.status }
      const len = Number(res.headers.get('content-length') || 0)
      if (len > MAX_BYTES) return { ok: false, error: 'too-big' }
      text = await res.text()
      if (text.length > MAX_BYTES) return { ok: false, error: 'too-big' }
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
  let raw = null
  try { raw = JSON.parse(stripBom(text)) } catch { return { ok: false, error: 'bad-json' } }
  const v = validateCompat(raw, { localShell: readLocalShellVersion(root) })
  if (!v.ok) return { ok: false, error: v.error }
  try {
    mkdirSync(dirname(p.cache), { recursive: true })
    writeFileSync(p.cache, JSON.stringify(raw), 'utf8')
    writeFileSync(p.stamp, JSON.stringify({ at: Date.now() }, 'utf8'))
  } catch { }
  return { ok: true, source: 'network', data: v.data }
}

export const effectiveDshRange = async (opts = {}) => {
  const r = await refreshCompat(opts)
  const e = effectiveDshRangeSync(opts.root || ROOT)
  return Object.assign({}, e, { refreshed: r })
}

// ---- CLI --------------------------------------------------------------------

const isMain = (() => {
  try {
    const self = fileURLToPath(import.meta.url).toLowerCase()
    const argv1 = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : ''
    return !!argv1 && self === argv1
  } catch { return false }
})()

if (isMain) {
  const argv = process.argv.slice(2)
  const rootArg = argv.indexOf('--root')
  const root = rootArg >= 0 ? argv[rootArg + 1] : ROOT
  // 2026-11-27：以前把 refreshCompat 的结果直接丢掉，用户只看到"未采用（not-an-object）"，
  // 完全不知道是没网、还是远端 404、还是 JSON 坏了。现在把真实原因带出来。
  let refreshErr = ''
  if (argv.includes('--refresh')) {
    const r = await refreshCompat({ root, force: true })
    if (r && r.ok === false) refreshErr = String(r.error || 'unknown')
  }
  const e = effectiveDshRangeSync(root)
  if (argv.includes('--one-line')) {
    const src = e.source === 'compat' ? 'compat ' + (e.compat && e.compat.updatedAt ? e.compat.updatedAt.slice(0, 10) : '') : 'manifest'
    console.log((e.range || '(未声明)') + '  [' + src + ']')
  } else if (argv.includes('--json')) {
    console.log(JSON.stringify(e, null, 2))
  } else {
    console.log('  本壳清单 : ' + (e.manifestRange || '(未声明)'))
    console.log('  生效区间 : ' + (e.range || '(未声明)') + '   <- 来自 ' + (e.source === 'compat' ? '远端兼容声明（已放宽）' : '本壳清单'))
    if (e.compat) {
      console.log('  声明时间 : ' + (e.compat.updatedAt || '?'))
      console.log('  已验证内核: ' + (e.compat.verified.join(', ') || '(未列出)'))
      if (e.compat.note) console.log('  说明     : ' + e.compat.note)
    } else if (e.reason) {
      console.log('  远端声明 : 未采用（' + e.reason + '）' + (refreshErr ? '，本次刷新失败原因：' + refreshErr : ''))
    }
  }
}