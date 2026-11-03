import { readFileSync, existsSync } from 'node:fs'

// 只有"线上比本地新"才提示；本地更新（例如装了更新的预发布版）不该被降级
const parseVer = (v) => {
  const s = String(v).trim().replace(/^v/i, '')
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
const isNewer = (latest, cur) => {
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
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }

function appVersion() {
  try { return JSON.parse(read(join(root, 'app', 'package.json'))).version || '' } catch { return '' }
}

function asarPackageJson(asarPath) {
  try {
    const buf = readFileSync(asarPath)
    const jsonLen = buf.readUInt32LE(12)
    const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'))
    const base = 16 + jsonLen
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node)) {
        const p = prefix ? prefix + '/' + name : name
        if (entry && entry.files) {
          const hit = walk(entry.files, p)
          if (hit) return hit
        }
        else if (p === 'package.json' && typeof entry.offset === 'string') {
          const off = Number(entry.offset)
          return JSON.parse(buf.subarray(base + off, base + off + Number(entry.size)).toString('utf8'))
        }
      }
      return null
    }
    return walk(header.files || {}, '')
  } catch { return null }
}

function desktopVersion() {
  const pkg = asarPackageJson(join(root, 'desktop', 'resources', 'app.asar'))
  if (pkg && pkg.version) return pkg.version
  const marker = read(join(root, 'desktop', 'version.dsh')).trim()
  return marker
}

// 定时器必须 unref：否则 fetch 早早结束也要空等 4 秒才退出（启动器里白等）
const withTimeout = (ms) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); t.unref?.(); return c.signal }

async function remote() {
  const out = { app: '', desktop: '' }
  const jobs = [
    fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest', { signal: withTimeout(4000) })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) out.app = j.version || '' }).catch(() => {}),
    fetch('https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml', { signal: withTimeout(4000) })
      .then((r) => (r.ok ? r.text() : '')).then((t) => { const m = t.match(/^version:\s*(\S+)/m); if (m) out.desktop = m[1] }).catch(() => {}),
  ]
  await Promise.all(jobs)
  return out
}

const force = process.argv.includes('--force')
const stamp = join(root, 'tmp', 'update-check.json')
const TTL = 6 * 60 * 60 * 1000
if (!force) {
  try {
    const s = JSON.parse(read(stamp))
    // 只答了一半的缓存按 15 分钟算（别让一次网络抽风把某项更新压 6 小时，也别每次启动都重查）
    const complete = s && s.done && s.done.app && s.done.desktop
    const ttl = complete ? TTL : Math.min(TTL, 15 * 60 * 1000)
    if (s && s.ts && Date.now() - s.ts < ttl) {
      if (process.argv.includes('--verbose')) console.log(`cached ${Math.round((Date.now() - s.ts) / 60000)} min ago`)
      if (s.out) console.log(s.out)
      process.exit(0)
    }
  } catch {}
}

const cur = { app: appVersion(), desktop: desktopVersion() }
const latest = await remote()
const parts = []
if (latest.app && cur.app && isNewer(latest.app, cur.app)) parts.push(`app ${cur.app} -> ${latest.app}`)
if (latest.desktop && cur.desktop && isNewer(latest.desktop, cur.desktop)) parts.push(`desktop ${cur.desktop} -> ${latest.desktop}`)
if (process.argv.includes('--verbose')) {
  console.log(`installed: app=${cur.app || '?'} desktop=${cur.desktop || '?'}`)
  console.log(`latest:    app=${latest.app || '?'} desktop=${latest.desktop || '?'}`)
}
const line = parts.length ? 'UPD ' + parts.join(' | ') : ''
// 记下"哪些远端真的答了"：一个都没答就别写缓存（否则接下来 6 小时都在骗自己已是最新），
// 只答一半也只算半份，下次照样重查。
const done = { app: Boolean(latest.app), desktop: Boolean(latest.desktop) }
if (done.app || done.desktop) {
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(root, 'tmp'), { recursive: true })
    writeFileSync(stamp, JSON.stringify({ ts: Date.now(), out: line, done }), 'utf8')
  } catch {}
}
if (line) console.log(line)