import { closeSync, existsSync, openSync, readFileSync, readSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// 只依赖 version-range.mjs（零依赖纯函数）：本脚本会被测试单独拷进隔离目录运行（test 18），
// 不能 import shell-update.mjs（会把整个自更新 CLI 拖进来 → 隔离目录 MODULE_NOT_FOUND）。
import { satisfiesRange } from './version-range.mjs'

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

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const stripBom = (s) => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

/**
 * app 版本：`app\package.json` 是 pnpm 生成的清单，升级后只剩 dependencies（没有 version），
 * 所以必须回退到真正装进来的官方包。这与 dsh-portable.ps1 的 AppVersion 是同一套语义。
 *
 * 真实事故：这里只读 package.json 的 version，升级后永远得到空串，
 * 于是 `latest.app && cur.app` 短路，便携目录的 app 再也不会提示更新（表现为 `installed: app=?`）。
 */
function appVersion() {
  try {
    const a = JSON.parse(read(join(root, 'app', 'package.json')))
    if (a && a.version) return a.version
  } catch {}
  try {
    const b = JSON.parse(read(join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')))
    if (b && b.version) return b.version
  } catch {}
  return ''
}

/**
 * 从 asar 里取根 package.json。只读头部 + 目标条目，不整份读入
 * （desktop 的 app.asar 有 200MB 级，readFileSync 全读会让每次启动白等好几秒）。
 *
 * 内容起点 = 8 + headerSize。绝不能写成 16 + jsonLen：
 * asar 的 JSON 段按 4 字节对齐，新版 asar 实测带 3 字节 padding，
 * 漏掉它就会整体读歪、版本号解析失败（真实事故：升到 0.2.2 之后 desktop 再也不提示更新）。
 */
function asarPackageJson(asarPath) {
  let fd
  try {
    if (!existsSync(asarPath)) return null
    fd = openSync(asarPath, 'r')
    const head = Buffer.alloc(8)
    if (readSync(fd, head, 0, 8, 0) !== 8) return null
    if (head.readUInt32LE(0) !== 4) return null
    const headerSize = head.readUInt32LE(4)
    if (!(headerSize > 8 && headerSize < 32 * 1024 * 1024)) return null
    const pick = Buffer.alloc(headerSize)
    if (readSync(fd, pick, 0, headerSize, 8) !== headerSize) return null
    const jsonLen = pick.readUInt32LE(4)
    if (!(jsonLen > 0 && jsonLen + 8 <= headerSize)) return null
    const header = JSON.parse(pick.subarray(8, 8 + jsonLen).toString('utf8'))
    const find = (node, prefix) => {
      for (const [name, entry] of Object.entries(node || {})) {
        const p = prefix ? prefix + '/' + name : name
        if (entry && entry.files) {
          const hit = find(entry.files, p)
          if (hit) return hit
        } else if (p === 'package.json' && entry && typeof entry.offset === 'string') {
          return entry
        }
      }
      return null
    }
    const hit = find(header.files, '')
    if (!hit) return null
    const off = Number(hit.offset)
    const size = Number(hit.size)
    if (!(size > 0 && size < 4 * 1024 * 1024)) return null
    const body = Buffer.alloc(size)
    if (readSync(fd, body, 0, size, 8 + headerSize + off) !== size) return null
    return JSON.parse(body.toString('utf8'))
  } catch { return null }
  finally { if (fd !== undefined) { try { closeSync(fd) } catch {} } }
}

/**
 * desktop 版本：以 app.asar 里的官方清单为准。
 * 回退链（2026-11-12 调研修正）：asar 读不出来时读 `DeepSeek Harness.exe` 的产品版本资源——
 * 旧回退 `desktop\version.dsh` 是死代码（官方从不写这个文件，两台实测机器都没有），
 * 坏了等于回退到空。exe 路径与 dsh-portable.ps1 的 DesktopVersion 同源，且 exe 资源
 * 由官方安装器维护、永远随桌面层走。
 */
function exeFileVersion(exePath) {
  let fd
  try {
    if (!existsSync(exePath)) return ''
    fd = openSync(exePath, 'r')
    // PE：DOS 头 e_lfanew@0x3c → PE 签名 → COFF 头 → OptionalHeader 里找 .rsrc 节，
    // 再从资源目录一层层找 VERSIONINFO\StringFileInfo。太重，这里只做最实用的退化：
    // 就地搜 UTF-16LE 的 "0.2.2-rc.1" 形态版本串（ProductVersion 结构在 exe 里是明文）。
    const size = 4 * 1024 * 1024
    const buf = Buffer.alloc(Math.min(size, fstatSize(fd)))
    readSync(fd, buf, 0, buf.length, 0)
    const text = buf.toString('utf16le')
    const m = text.match(/(\d+\.\d+\.\d+-rc\.\d+|\d+\.\d+\.\d+)/)
    return m ? m[1] : ''
  } catch { return '' }
  finally { if (fd !== undefined) { try { closeSync(fd) } catch {} } }
}
const fstatSize = (fd) => { try { return readSync(fd, Buffer.alloc(0), 0, 0, null) === null ? 0 : 0 } catch { return 0 } }
function desktopVersion() {
  const pkg = asarPackageJson(join(root, 'desktop', 'resources', 'app.asar'))
  if (pkg && pkg.version) return pkg.version
  // asar 解析失败（比如官方再改头部结构）时的兜底：exe 资源里的版本串
  const v = exeFileVersion(join(root, 'desktop', 'DeepSeek Harness.exe'))
  if (v) return v
  return read(join(root, 'desktop', 'version.dsh')).trim()
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
const cur = { app: appVersion(), desktop: desktopVersion() }
const sameLocal = (a, b) => Boolean(a) && Boolean(b) && a.app === b.app && a.desktop === b.desktop

if (!force) {
  try {
    const s = JSON.parse(read(stamp))
    // 只答了一半的缓存按 15 分钟算（别让一次网络抽风把某项更新压 6 小时，也别每次启动都重查）
    const complete = s && s.done && s.done.app && s.done.desktop
    const ttl = complete ? TTL : Math.min(TTL, 15 * 60 * 1000)
    // 缓存里同时记着"当时本地是什么版本"。本地版本一变（最典型的就是刚升级完），
    // 旧结论立刻作废重查 —— 否则升级成功后 6 小时内每次启动都会把同一句
    // "有新版本"再问一遍，用户只能反复按 Y、反复重装。
    if (s && s.ts && Date.now() - s.ts < ttl && sameLocal(s.local, cur)) {
      if (process.argv.includes('--verbose')) console.log(`cached ${Math.round((Date.now() - s.ts) / 60000)} min ago`)
      if (s.out) console.log(s.out)
      process.exit(0)
    }
  } catch {}
}

const latest = await remote()

// ---- 内核-壳适配闸门（doc/compat-report-2026-11-12.md §4.2）------------------
// 区间来自本地壳清单 requires.dsh；出界时不推 UPD（不诱导 update-all），改给 KERN 提示：
// 升壳 / 冻结 / 维持现状三选一——冻结合法且安全。frozen.json 存在则内核提示全静默。
const manifest = (() => { try { return JSON.parse(stripBom(read(join(root, 'shell-version.json')))) } catch { return null } })()
const range = manifest && manifest.requires && typeof manifest.requires.dsh === 'string' ? manifest.requires.dsh : ''
// frozen.json 是用户手写的文件：可能带 BOM（记事本默认 UTF-8 BOM），JSON.parse 会直接抛——剥掉再解析
const frozen = (() => { try { const j = JSON.parse(stripBom(read(join(root, 'frozen.json')))); return j && j.dsh ? j : null } catch { return null } })()
const fits = (v) => (range && v ? satisfiesRange(v, range) !== false : true)
const lines = []
if (frozen) {
  lines.push(`FROZEN 已冻结于 dsh ${frozen.dsh}${frozen.reason ? '（' + frozen.reason + '）' : ''}；内核更新提示已静默（解冻：删除 frozen.json 或 dsh-portable.cmd unfreeze）`)
} else {
  const appFit = fits(latest.app)
  const deskFit = fits(latest.desktop)
  const upd = []
  if (latest.app && cur.app && isNewer(latest.app, cur.app) && appFit) upd.push(`app ${cur.app} -> ${latest.app}`)
  if (latest.desktop && cur.desktop && isNewer(latest.desktop, cur.desktop) && deskFit) upd.push(`desktop ${cur.desktop} -> ${latest.desktop}`)
  if (upd.length) lines.push('UPD ' + upd.join(' | '))
  const out = []
  if (latest.app && appFit === false) out.push(`app ${latest.app}`)
  if (latest.desktop && deskFit === false) out.push(`desktop ${latest.desktop}`)
  if (out.length) {
    lines.push(
      `KERN 官方 ${out.join(' / ')} 已超出本壳适配区间（${range}）`,
      '  补丁只对区间内内核负责：出界后商城装卸/exFAT 新建文件/附件会静默失效',
      '  ① 升壳适配：dsh-portable.cmd shell-update check（有适配壳就 apply -Force）',
      '  ② 没有就冻结当前组合（合法且安全）：新建 frozen.json 写 {"dsh":"' + (cur.app || '?') + '"}',
      '  ③ 都不做 = 维持现状继续用（这就是冻结）')
  }
}
const line = lines.join('\n')
// 记下"哪些远端真的答了"：一个都没答就别写缓存（否则接下来 6 小时都在骗自己已是最新），
// 只答一半也只算半份，下次照样重查。
const done = { app: Boolean(latest.app), desktop: Boolean(latest.desktop) }
if (done.app || done.desktop) {
  try {
    mkdirSync(join(root, 'tmp'), { recursive: true })
    writeFileSync(stamp, JSON.stringify({ ts: Date.now(), out: line, done, local: cur }), 'utf8')
  } catch {}
}
if (process.argv.includes('--verbose')) {
  console.log(`installed: app=${cur.app || '?'} desktop=${cur.desktop || '?'}`)
  console.log(`latest:    app=${latest.app || '?'} desktop=${latest.desktop || '?'}`)
  console.log(`range:     ${range || '(未声明)'}  frozen=${frozen ? frozen.dsh : 'no'}`)
}
if (line) console.log(line)
