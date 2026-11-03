#!/usr/bin/env node
/**
 * tools/shell-release.mjs —— 便携壳发布工具（GitHub Release 版本线）
 *
 * 一句话：把"改壳 → 自测 → 打 tag → 发 GitHub Release → 端到端验证能升级"这条链子收成四条命令。
 *
 *   node tools\shell-release.mjs prepare --version 0.1.0 [--channel stable] [--dry-run] [--skip-gates]
 *   node tools\shell-release.mjs publish [--push] [--dry-run] [--token-env GH_TOKEN]
 *   node tools\shell-release.mjs verify-published [--version 0.1.0] [--json] [--dry-run]
 *   node tools\shell-release.mjs defaults [--json]
 *
 * 退出码：0 = 成功（verify-published 也含"首个版本，跳过"），1 = 失败，2 = 用法/参数错误。
 *
 * ---------------------------------------------------------------------------
 * 一、prepare（改版本 + 过门禁 + 打整包 + 提交 + 打 tag）
 *   1) 校验 --version 是合法 semver；读仓库根 RELEASE-NOTES.md 的 `## v<version>` 小节，
 *      把其中 6 个小节解析成 notes 对象（缺哪个小节就直接失败并点名，绝不留半成品）。
 *   2) 把 schemaVersion/updaterMin/channel/tag/releasedAt/minShellVersion/requires/notes/notesUrl/
 *      userOwned 写进根 shell-version.json —— **保留 files 字段原样**（files 由 clean-ship refresh 重算）。
 *      清单里原本没有 userOwned 时写入下面 DEFAULT_USER_OWNED 那份默认列表并打印提示。
 *   3) 依次跑门禁（子进程，stdio 继承）：
 *        node tools\clean-ship.mjs refresh
 *        node tools\verify-shell.mjs
 *        node tools\selftest-shell-update.mjs
 *      --skip-gates 可跳过（**只在一次已经全绿的重跑里用**）。
 *   4) 再 refresh 一次 → "字段没被 refresh 吃掉"的后置校验。
 *   5) 按清单 files **打整包** harness-shell-<ver>.zip（不含 shell-version.json 本身，
 *      否则"清单记 zip.sha256 / zip 里又有清单"就成了死循环），算 sha256+bytes，
 *      把 `zip:{name,sha256,bytes}` 写回清单，再 refresh 一次（refresh 保留 zip 字段）。
 *   6) git add -A → git commit → git tag -a。tag 一旦存在就拒绝（永不移动/删除已发布 tag）。
 *   7) tag 自校验：tag 里的 shell-version.json 必须带 zip 字段，且 files 里每个 sha256
 *      都要等于 `git show <tag>:<path>` 的真实字节（防止 refresh 之后又有人改文件）。
 *   --dry-run：只打印"字段变更 + 命令 + 整包的 name/bytes/sha256 前 12 位"，仓库一个字节都不写、
 *              不跑门禁、不碰 git（整包会在 %TEMP% 里试打一次以拿到真实 sha，然后删掉）。
 *
 * 二、publish（推远端 + 建 Release + 传资产 + 校验下载 sha）
 *   1) git push origin master、git push origin v<ver>（--no-push 跳过）。
 *   2) 取 token：优先 env（--token-env 指定名，其次 GH_TOKEN / GITHUB_TOKEN），
 *      否则 `git credential fill`（protocol=https host=github.com）。**token 任何情况下都不打印**，
 *      日志里只有来源/长度/"已脱敏"。
 *   3) GET /repos/<repo>/releases/tags/v<ver>：200 复用，404 则 POST /releases
 *      （tag_name、name、body=RELEASE-NOTES 该版本小节原文、prerelease:false、make_latest:true）。
 *   4) 资产两个：
 *        shell-version.json      —— 字节必须取自 `git show v<ver>:shell-version.json`（不是工作树！）
 *        harness-shell-<ver>.zip —— 用 tools\7z\7z.exe 打包 tag 里清单 files 列出的壳文件
 *                                   （git ls-tree + git show 落到 %TEMP%，时间戳钉成 FIXED_MTIME_MS
 *                                    后打包，所以 prepare 与 publish 两次打包字节相同）
 *                                   不含 shell-version.json / version.json / .git*（清单见 isZipShellPath）
 *   4b) 重打包后先自校验：sha256 必须等于 tag 清单里的 zip.sha256，且每个入包文件的 sha256
 *       必须等于清单 files[<path>]；对不上就在上传前失败（宁可发不出去，也不发一个坏包）。
 *   5) 上传后 GET 资产下载地址，比对 sha256 与本地一致；不一致就报失败。
 *   任何一步失败都打印"人能照做"的补救说明（含网页上传哪个文件）。--dry-run 只打印完整步骤。
 *
 * 三、verify-published（拿"上一个 tag"当老用户，端到端验能升级）
 *   1) 找上一个版本 tag（semver 比当前版本小的最大值）；没有就报"首个版本，跳过"（退出码 0）。
 *   2) git clone --branch <prevTag> --depth 1 <本仓库 file:// URL> 到 %TEMP%。
 *   3) 在 clone 里跑 `node tools\shell-update.mjs check --manifest <releases/latest/download/shell-version.json> --json`，
 *      断言 ok && status=update-available && remote=<version>。
 *   4) 再跑 stage 到临时目录，逐文件比对 sha256 与远端清单一致；并断言 clone 里的用户数据
 *      （home/sessions、home/storages、home/settings.yaml、home/.credentials.yaml …）哈希前后不变。
 *   5) 顺带断言：Release 上那个 shell-version.json 的字节 == `git show v<ver>:shell-version.json`。
 *   打印 PASS/FAIL 表，清理临时目录，失败退出码 1。--dry-run 只打印计划（不 clone、不联网、不写盘）。
 *
 * 四、defaults：输出默认 repo / 清单 URL / base / tag 模板 / 系统更新侧退出码表（供 verify-shell 断言）。
 *
 * ---------------------------------------------------------------------------
 * 自测接缝：--root <dir> 可把"仓库根"换成 fixture 目录（只读 fixture 的 RELEASE-NOTES.md 与
 * shell-version.json），配合 --dry-run 就能在完全不碰真仓库的情况下验证 notes 解析与计划输出。
 *
 * 编码铁律：本文件 UTF-8 无 BOM + LF-only（.gitattributes: *.mjs text eol=lf）。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const NODE = join(ROOT, 'runtime/node/bin/node.exe')
export const SEVEN = join(ROOT, 'tools/7z/7z.exe')
export const SHELL_MANIFEST = 'shell-version.json'
export const NOTES_FILE = 'RELEASE-NOTES.md'
export const RELEASING_FILE = 'RELEASING.md'

/** 默认仓库（remote 解析不出来时兜底；正常情况下从 `git remote get-url origin` 读） */
export const DEFAULT_REPO = 'Blue-Seventeen/hack3rx-harness'
/** 默认清单地址：releases/latest/download —— 永远指"最新的非 prerelease/非 draft"那一版 */
export const DEFAULT_MANIFEST_URL = 'https://github.com/Blue-Seventeen/hack3rx-harness/releases/latest/download/shell-version.json'
/** 默认文件基址模板：每个版本的资产挂在 <base>/<tag>/ 下 */
export const DEFAULT_BASE_URL = 'https://github.com/Blue-Seventeen/hack3rx-harness/releases/download/v<shellVersion>'
/** 默认 tag 模板 */
export const TAG_TEMPLATE = 'v<shellVersion>'

/** 清单里原样保留、由本脚本负责写入的字段顺序 */
export const RELEASE_FIELDS = [
  'schemaVersion', 'updaterMin', 'channel', 'shellVersion', 'tag', 'releasedAt',
  'minShellVersion', 'generatedAt', 'requires', 'files', 'zip', 'userOwned', 'notes', 'notesUrl',
]

/**
 * 打包时把所有文件的时间戳钉成这个固定值（2000-01-01T00:00:00Z）。
 * 原因：7z 会把 mtime 写进 zip，不钉时间戳的话"同一个 tag 打两次包"字节就不一样，
 * 清单里的 zip.sha256 与 publish 时重打的包对不上。钉住之后 7z 输出可复现（已实测）。
 */
export const FIXED_MTIME_MS = Date.UTC(2000, 0, 1)
export const ZIP_DISPLAY_NAME = (version) => 'harness-shell-' + version + '.zip'

/** notes 的 6 个小节：key 进 JSON，title 是 RELEASE-NOTES.md 里的中文小节名，aliases 兼容英文 */
export const NOTES_SECTIONS = [
  { key: 'added', title: '新增', aliases: ['新增', '新功能', 'added', 'feature', 'features'] },
  { key: 'fixed', title: '修复', aliases: ['修复', '修复内容', 'fixed', 'fixes', 'bugfix', 'bugfixes'] },
  { key: 'optimized', title: '优化', aliases: ['优化', '优化内容', 'optimized', 'optimised', 'improved', 'performance'] },
  { key: 'breaking', title: '破坏性变更', aliases: ['破坏性变更', '破坏性变化', '不兼容变更', 'breaking', 'breaking changes', 'breaking change'] },
  { key: 'upgrade', title: '升级会做什么', aliases: ['升级会做什么', '升级动作', '升级时会发生什么', 'upgrade', 'upgrade steps', 'what upgrade does'] },
  { key: 'rollback', title: '如何回退', aliases: ['如何回退', '回退', '回退方法', 'rollback', 'how to roll back', 'how to rollback'] },
]

/** 清单里缺 userOwned 时由本脚本写进去的默认列表（用户私有、升级时绝不覆盖/绝不删除） */
export const DEFAULT_USER_OWNED = [
  'home/cordis.patch.yml',
  'home/profiles/package.json',
  'home/profiles/pnpm-workspace.yaml',
  'home/profiles/pnpm-lock.yaml',
  'home/profiles/web/package.json',
  'home/profiles/web/pnpm-workspace.yaml',
  'home/profiles/web/pnpm-lock.yaml',
  'home/profiles/web/cordis.patch.yml',
  'home/profiles/desktop/package.json',
  'home/profiles/desktop/pnpm-workspace.yaml',
  'home/profiles/desktop/pnpm-lock.yaml',
]

const DEFAULT_REQUIRES = { dsh: '>=0.2.1-rc.5', node: '>=24.0.0' }
const DEFAULT_UPDATER_MIN = 2
const VALID_CHANNELS = ['stable', 'beta', 'rc', 'alpha']
const GIT = process.env.SHELL_RELEASE_GIT || 'git'
const MAX_BUF = 64 * 1024 * 1024

// ---- 小工具 ----------------------------------------------------------------
class ReleaseError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'ReleaseError'
    this.detail = detail ? String(detail) : ''
  }
}

const log = (m) => console.log(m === undefined ? '' : m)
const warn = (m) => console.error('WARN  ' + m)
const help = (m) => console.error(m)
const blank = () => console.log('')

let REPO_ROOT = ROOT

/** 自测接缝：把"仓库根"换掉（--root）；只影响本进程读文件与跑 git 的 cwd，不写真仓库 */
const setRoot = (dir) => {
  REPO_ROOT = resolve(String(dir))
  return REPO_ROOT
}
const rootOf = () => REPO_ROOT

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const sha256File = (p) => sha256(readFileSync(p))
const fmtBytes = (n) => {
  const k = Number(n) || 0
  if (k < 1024) return k + ' B'
  if (k < 1024 * 1024) return (k / 1024).toFixed(1) + ' KB'
  return (k / 1024 / 1024).toFixed(2) + ' MB'
}
const pad = (s, n) => {
  const t = String(s)
  const w = [...t].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  return t + ' '.repeat(Math.max(0, n - w))
}

/** 跑 git，永不抛：返回 {code, out, err, buf} */
const runGit = (args, opts = {}) => {
  const res = spawnSync(GIT, args, {
    cwd: opts.cwd || rootOf(),
    encoding: opts.raw ? 'buffer' : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout || 180000,
    maxBuffer: opts.maxBuffer || MAX_BUF,
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }, opts.env || {}),
  })
  if (opts.raw) {
    return { code: res.status === null ? 1 : res.status, buf: res.stdout || Buffer.alloc(0), err: String(res.stderr || '') }
  }
  return {
    code: res.status === null ? 1 : res.status,
    out: String(res.stdout || ''),
    err: String(res.stderr || ''),
    error: res.error ? String(res.error.message || res.error) : '',
  }
}

const gitOk = (args, opts) => {
  const r = runGit(args, opts)
  if (r.code !== 0) throw new ReleaseError('git ' + args.join(' ') + ' 失败', (r.err || r.error || '').trim())
  return r.out
}

/** 跑 node 子进程并把输出透传到当前控制台（门禁专用） */
const runNodeInherit = (scriptRel, args) => {
  const abs = join(ROOT, scriptRel)
  const shown = 'node ' + scriptRel.replace(/\//g, '\\') + (args.length ? ' ' + args.join(' ') : '')
  log('  $ ' + shown)
  const r = spawnSync(process.execPath, [abs, ...args], {
    cwd: rootOf(),
    stdio: 'inherit',
    env: Object.assign({}, process.env),
  })
  return { code: r.status === null ? 1 : r.status, shown }
}

// ---- semver（够用即可：主/次/修 + prerelease 比较）--------------------------
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

export const parseSemver = (v) => {
  const m = SEMVER_RE.exec(String(v === undefined || v === null ? '' : v).trim().replace(/^v/i, ''))
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
    build: m[5] || '',
    raw: m[0],
    version: m[1] + '.' + m[2] + '.' + m[3] + (m[4] ? '-' + m[4] : ''),
  }
}

export const validSemver = (v) => !!parseSemver(v)

export const cmpSemver = (a, b) => {
  const A = typeof a === 'string' ? parseSemver(a) : a
  const B = typeof b === 'string' ? parseSemver(b) : b
  if (!A || !B) throw new ReleaseError('版本号无法比较：' + String(a) + ' vs ' + String(b))
  for (const k of ['major', 'minor', 'patch']) if (A[k] !== B[k]) return A[k] < B[k] ? -1 : 1
  if (!A.pre.length && !B.pre.length) return 0
  if (!A.pre.length) return 1
  if (!B.pre.length) return -1
  const n = Math.max(A.pre.length, B.pre.length)
  for (let i = 0; i < n; i++) {
    const x = A.pre[i]
    const y = B.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d) return d < 0 ? -1 : 1
      continue
    }
    if (xn !== yn) return xn ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// ---- RELEASE-NOTES.md 解析 --------------------------------------------------
const normHeading = (s) => String(s)
  .replace(/[*`_]/g, '')
  .replace(/[（(][^）)]*[)）]/g, '')
  .replace(/[：:]\s*$/, '')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, ' ')

const EMPTY_ITEMS = new Set(['无', '暂无', '没有', 'none', 'n/a', 'na', '-', '—', '–', '()'])
const isEmptyItem = (x) => EMPTY_ITEMS.has(String(x).toLowerCase().replace(/[。.,，;；:：]$/, '').trim())

const listItems = (lines) => {
  const out = []
  let fence = false
  for (const raw of lines) {
    const l = String(raw).trim()
    if (/^```/.test(l)) { fence = !fence; continue }
    if (!l) continue
    if (!fence && /^#{1,6}\s/.test(l)) continue
    const item = l
      .replace(/^[-*+•]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .trim()
    if (!item) continue
    out.push(item)
  }
  if (out.length && out.every(isEmptyItem)) return []
  return out
}

const HEAD_VER_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?)/

/**
 * 解析 RELEASE-NOTES.md 里 `## v<version>` 这一节。
 * 返回 { found, version, date, heading, sectionText, notes, missing }
 *  - notes：{added,fixed,optimized,breaking,upgrade,rollback} 六个数组（小节内容只有"无"时给 []）
 *  - missing：缺的小节中文名（调用方决定是否致命）
 *  - sectionText：该版本小节原文（含 `## v...` 标题行），用作 GitHub Release 的 body
 */
export const parseNotes = (text, version) => {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)
  const want = String(version || '').trim().replace(/^v/i, '')
  const result = {
    found: false, version: want, date: '', heading: '', sectionText: '',
    notes: { added: [], fixed: [], optimized: [], breaking: [], upgrade: [], rollback: [] },
    missing: NOTES_SECTIONS.map((s) => s.title),
  }
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i])
    if (!m) continue
    const vm = HEAD_VER_RE.exec(m[1].trim())
    if (!vm) continue
    if (vm[1].replace(/^v/i, '') !== want) continue
    start = i
    result.heading = lines[i].trim()
    const dm = /(\d{4}-\d{2}-\d{2})/.exec(m[1])
    result.date = dm ? dm[1] : ''
    break
  }
  if (start < 0) return result

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i])) { end = i; break }
  }
  const bodyLines = lines.slice(start + 1, end)
  result.found = true
  result.sectionText = lines.slice(start, end).join('\n').replace(/[ \t]+$/gm, '').trim()

  const subs = []
  let cur = null
  for (const raw of bodyLines) {
    const h = /^###\s+(.+?)\s*$/.exec(String(raw))
    if (h) { cur = { title: h[1], lines: [] }; subs.push(cur); continue }
    if (cur) cur.lines.push(raw)
  }
  const missing = []
  for (const sec of NOTES_SECTIONS) {
    const hit = subs.find((x) => sec.aliases.some((a) => normHeading(a) === normHeading(x.title)))
    if (!hit) { missing.push(sec.title); continue }
    result.notes[sec.key] = listItems(hit.lines)
  }
  result.missing = missing
  return result
}

/** 解析 + 缺小节即失败（prepare 用这一版） */
export const parseNotesStrict = (text, version) => {
  const parsed = parseNotes(text, version)
  if (!parsed.found) {
    throw new ReleaseError(
      'RELEASE-NOTES.md 里没有 `## v' + version + '` 这一节',
      '先写这一节再发布：' + join(rootOf(), NOTES_FILE),
    )
  }
  if (parsed.missing.length) {
    throw new ReleaseError(
      'RELEASE-NOTES.md 的 v' + version + ' 缺小节：' + parsed.missing.join('、'),
      '六个 `### ` 小节必须都在（没有内容就写"无"）：' + NOTES_SECTIONS.map((s) => s.title).join(' / '),
    )
  }
  return parsed
}

// ---- 清单读写 ---------------------------------------------------------------
export const manifestPath = () => join(rootOf(), SHELL_MANIFEST)

export const readManifest = (opts = {}) => {
  const p = manifestPath()
  let text
  try {
    text = readFileSync(p, 'utf8')
  } catch (e) {
    if (opts.missingOk) return { path: p, present: false, text: '', json: {}, files: {} }
    throw new ReleaseError('读不到壳清单：' + p, String((e && e.message) || e))
  }
  let json
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new ReleaseError('壳清单不是合法 JSON：' + p, String((e && e.message) || e))
  }
  if (!json || typeof json !== 'object') throw new ReleaseError('壳清单不是对象：' + p, '')
  const files = json.files && typeof json.files === 'object' && !Array.isArray(json.files) ? json.files : {}
  return { path: p, present: true, text, json, files }
}

export const writeManifestJson = (obj, file) => {
  const p = file || manifestPath()
  const text = JSON.stringify(obj, null, 2) + '\n'
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, Buffer.from(text, 'utf8'))
  return { path: p, bytes: Buffer.byteLength(text), text }
}

// ---- 仓库/远端 --------------------------------------------------------------
export const resolveRepo = (explicit) => {
  if (explicit) return String(explicit)
  const r = runGit(['remote', 'get-url', 'origin'])
  if (r.code === 0) {
    const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/i.exec(r.out.trim())
    if (m) return m[1] + '/' + m[2]
  }
  return DEFAULT_REPO
}

const tagExists = (tag) => runGit(['rev-parse', '-q', '--verify', 'refs/tags/' + tag]).code === 0

/** 所有形如 v<semver> 的 tag，按 semver 从新到旧 */
export const listSemverTags = () => {
  const r = runGit(['tag', '--sort=-v:refname'])
  const raw = r.code === 0 ? r.out.split('\n').map((s) => s.trim()).filter(Boolean) : []
  return raw
    .filter((t) => parseSemver(t))
    .map((t) => ({ tag: t, semver: parseSemver(t) }))
    .sort((a, b) => cmpSemver(b.semver, a.semver))
}

export const gitShow = (tag, rel) => {
  const r = runGit(['show', tag + ':' + rel], { raw: true })
  if (r.code !== 0) throw new ReleaseError('取不到 tag 里的文件：' + tag + ':' + rel, r.err.trim())
  return r.buf
}

export const listTagFiles = (tag) => {
  const out = gitOk(['ls-tree', '-r', '--name-only', tag])
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

// ---- zip 白名单（发布资产用，跟"壳白名单"不是一份东西）----------------------
/** 根目录随壳走的一批脚本 */
const ZIP_ROOT_FILES = [
  'dsh-portable.ps1', 'preflight.cmd', 'start-web.cmd', 'start-desktop.cmd', 'dsh-portable.cmd',
  'dsh.cmd', 'dsh-plugin.cmd', 'dsh-plugin-shared.cmd', 'check-update.cmd', 'env.cmd',
  'readme.md', 'license', 'license.md', 'license.txt', 'release-notes.md', 'releasing.md',
]
/** 永不进 zip：清单自己单独作为资产上传；version.json 是官方层出厂快照；仓库元数据也不进 */
const ZIP_DENY = new Set(['version.json', 'shell-version.json', '.gitattributes', '.gitignore', 'thumbs.db', 'desktop.ini'])

/**
 * 该路径是否进 harness-shell-<ver>.zip：
 *   tools/ 下的 .mjs/.ps1/.cmd/.md + tools/7z 二进制、runtime/vcredist、根脚本、README/LICENSE/
 *   RELEASE-NOTES.md/RELEASING.md、home/profiles 的清单与主题文件、home/cordis.patch.yml。
 */
export const isZipShellPath = (rel) => {
  const low = String(rel || '').replace(/\\/g, '/').toLowerCase()
  if (!low || low.startsWith('.git') || low.includes('/.git')) return false
  if (ZIP_DENY.has(low)) return false
  if (ZIP_ROOT_FILES.includes(low)) return true
  if (low.startsWith('tools/7z/')) return true
  if (low.startsWith('tools/')) return /\.(mjs|ps1|cmd|md)$/.test(low)
  if (low.startsWith('runtime/vcredist/')) return true
  if (low === 'home/cordis.patch.yml') return true
  if (low.startsWith('home/profiles/')) {
    const base = low.slice(low.lastIndexOf('/') + 1)
    if (base === 'package.json') return true
    if (base.startsWith('pnpm-') && /\.(yaml|yml)$/.test(base)) return true
    if (base === 'cordis.yml' || base === 'cordis.patch.yml') return true
    if (low.includes('/themes/')) return /\.(json|yml|yaml|css|svg|png|webp)$/.test(low)
  }
  return false
}

export const zipFileList = (tag) => listTagFiles(tag).filter(isZipShellPath)

// ---- 准备阶段（prepare）-----------------------------------------------------
const GATES = [
  { name: 'clean-ship refresh', script: 'tools/clean-ship.mjs', args: ['refresh'] },
  { name: 'verify-shell', script: 'tools/verify-shell.mjs', args: [] },
  { name: 'selftest-shell-update', script: 'tools/selftest-shell-update.mjs', args: [] },
]

const preview = (v) => {
  if (v === undefined) return '缺失'
  if (v === null) return 'null'
  if (Array.isArray(v)) return v.length + ' 项'
  if (typeof v === 'object') return '{' + Object.keys(v).length + ' 项}'
  return JSON.stringify(v)
}

const describeManifestChanges = (before, after) => {
  const rows = []
  const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])]
  for (const k of keys) {
    if (k === 'files') continue
    const b = before[k]
    const a = after[k]
    if (a === undefined) { rows.push([k, preview(b), '（移除）']); continue }
    if (b !== undefined && JSON.stringify(b) === JSON.stringify(a)) continue
    rows.push([k, preview(b), preview(a)])
  }
  return rows
}

const noteSummary = (notes) => NOTES_SECTIONS
  .map((s) => s.title + ' ' + (Array.isArray(notes[s.key]) ? notes[s.key].length : 0) + ' 条')
  .join(' / ')

const notesUrlFor = (repo, tag) => 'https://github.com/' + repo + '/releases/tag/' + tag

/** 组一份 v2 清单（files 内容由 refresh 重算，这里只把原 files 摆回去免得提交前是空的） */
const buildReleaseManifest = (current, info) => {
  const out = {}
  for (const k of RELEASE_FIELDS) {
    if (k === 'files') out.files = info.files
    else if (k === 'zip') { if (info.zip) out.zip = info.zip }
    else if (k === 'generatedAt') { if (current.generatedAt) out.generatedAt = current.generatedAt }
    else if (k === 'schemaVersion') out.schemaVersion = info.schemaVersion
    else if (k === 'updaterMin') out.updaterMin = info.updaterMin
    else if (k === 'channel') out.channel = info.channel
    else if (k === 'shellVersion') out.shellVersion = info.version
    else if (k === 'tag') out.tag = info.tag
    else if (k === 'releasedAt') out.releasedAt = info.releasedAt
    else if (k === 'minShellVersion') out.minShellVersion = info.minShellVersion
    else if (k === 'requires') out.requires = info.requires
    else if (k === 'userOwned') out.userOwned = info.userOwned
    else if (k === 'notes') out.notes = info.notes
    else if (k === 'notesUrl') out.notesUrl = info.notesUrl
  }
  // 保留清单里其它未知字段（将来加字段时不被发布工具吃掉）
  for (const k of Object.keys(current)) if (!(k in out)) out[k] = current[k]
  return out
}

const commitIdentity = ['-c', 'user.name=Blue-Seventeen', '-c', 'user.email=Blue-Seventeen@users.noreply.github.com']

/** 清单 files 里哪些路径进整包（= 壳白名单 ∩ files；永远排除清单自己） */
export const zipPathsFromFiles = (files) => Object.keys(files || {})
  .filter((rel) => String(rel).toLowerCase() !== SHELL_MANIFEST.toLowerCase())
  .filter(isZipShellPath)
  .sort()

/**
 * 打整包。sources 决定字节从哪儿来：
 *   - 'worktree'：从 <root>/<rel> 读（prepare 用；此时 tag 还没建）
 *   - { tag }   ：从 `git show <tag>:<rel>` 读（publish 用；必须以 tag 字节为准）
 * 时间戳统一钉成 FIXED_MTIME_MS，所以两种来源打出来的 zip 字节完全一致（已实测）。
 */
export const buildShellZip = (paths, opts = {}) => {  if (!existsSync(SEVEN)) throw new ReleaseError('缺 7z：' + SEVEN, 'tools\\7z\\7z.exe 必须随仓库存在')
  if (!paths.length) throw new ReleaseError('没有可打包的壳文件', '清单 files 是空的？先跑 clean-ship refresh')
  const outPath = opts.outPath
  if (!outPath) throw new ReleaseError('buildShellZip 缺 outPath', '')
  const stage = mkdtempSync(join(tmpdir(), 'shell-release-zip-'))
  const fixed = new Date(FIXED_MTIME_MS)
  try {
    for (const rel of paths) {
      let bytes
      if (opts.tag) {
        bytes = gitShow(opts.tag, rel)
      } else {
        const abs = join(rootOf(), ...rel.split('/'))
        try { bytes = readFileSync(abs) } catch (e) {
          throw new ReleaseError('读不到待打包文件：' + rel, String((e && e.message) || e))
        }
      }
      const dest = join(stage, ...rel.split('/'))
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, bytes)
      utimesSync(dest, fixed, fixed) // 钉时间戳 → 7z 输出可复现
    }
    mkdirSync(dirname(outPath), { recursive: true })
    rmSync(outPath, { force: true })
    const r = spawnSync(SEVEN, ['a', '-tzip', '-mx=9', '-bso0', '-bsp0', outPath, ...paths], {
      cwd: stage,
      encoding: 'utf8',
      timeout: 600000,
      maxBuffer: 32 * 1024 * 1024,
    })
    if (r.status !== 0) {
      throw new ReleaseError('7z 打包失败（退出码 ' + r.status + '）', truncate(String(r.stdout || '') + String(r.stderr || '')))
    }
    const bytes = readFileSync(outPath)
    return { path: outPath, bytes, sha: sha256(bytes), fileCount: paths.length }
  } finally {
    try { rmSync(stage, { recursive: true, force: true }) } catch { /* 临时目录，删不掉也无所谓 */ }
  }
}

/** --dry-run 时估算"将要打进去的文件"：已跟踪 + 未忽略的未跟踪（= git add -A 会提交的） */
const guessZipPathsForDryRun = (currentFiles) => {
  const fromFiles = zipPathsFromFiles(currentFiles)
  if (fromFiles.length) return { paths: fromFiles, source: '清单现有 files（refresh 后可能略有变化）' }
  const r = runGit(['ls-files', '--cached', '--others', '--exclude-standard'])
  const paths = r.code === 0
    ? r.out.split('\n').map((s) => s.trim()).filter(Boolean).filter((rel) => isZipShellPath(rel) && rel.toLowerCase() !== SHELL_MANIFEST.toLowerCase()).sort()
    : []
  return { paths, source: 'git ls-files（清单里还没有 files，用工作树估算）' }
}

const prepare = (opts) => {
  const version = String(opts.version || '').trim().replace(/^v/i, '')
  if (!version) throw new ReleaseError('prepare 缺少 --version', '例：node tools\\shell-release.mjs prepare --version 0.1.0')
  if (!validSemver(version)) throw new ReleaseError('版本号不是合法 semver：' + JSON.stringify(opts.version), '例：0.1.0 / 1.2.3-rc.1')
  if (version.includes('+')) throw new ReleaseError('版本号不带 build metadata（+xxx）：' + version, 'tag 名里出现 + 会让 shell-update 的版本比较变复杂')
  const channel = String(opts.channel || 'stable').trim()
  if (!VALID_CHANNELS.includes(channel)) throw new ReleaseError('未知 channel：' + channel, '可选：' + VALID_CHANNELS.join(' / '))
  const tag = 'v' + version
  const repo = resolveRepo(opts.repo)

  const notesPath = join(rootOf(), NOTES_FILE)
  if (!existsSync(notesPath)) throw new ReleaseError('缺 ' + NOTES_FILE, '仓库根必须有这个文件：' + notesPath)
  const parsed = parseNotesStrict(readFileSync(notesPath, 'utf8'), version)

  const current = readManifest({ missingOk: true })
  const curJson = current.json || {}
  const curVersion = String(curJson.shellVersion || '').trim()
  if (curVersion && validSemver(curVersion) && cmpSemver(version, curVersion) < 0) {
    warn('版本号比清单里的 ' + curVersion + ' 更小（' + version + '）：确认不是手滑？')
  }

  const updaterMin = opts.updaterMin === undefined
    ? (Number.isInteger(curJson.updaterMin) ? curJson.updaterMin : DEFAULT_UPDATER_MIN)
    : Number(opts.updaterMin)
  if (!Number.isInteger(updaterMin) || updaterMin < 1) throw new ReleaseError('--updater-min 必须是正整数：' + opts.updaterMin, '')
  const minShellVersion = String(opts.minShellVersion || curJson.minShellVersion || version).trim()
  if (!validSemver(minShellVersion)) throw new ReleaseError('minShellVersion 不是合法 semver：' + minShellVersion, '')

  const requires = {
    dsh: String(opts.dshRange || (curJson.requires && curJson.requires.dsh) || DEFAULT_REQUIRES.dsh).trim(),
    node: String(opts.nodeRange || (curJson.requires && curJson.requires.node) || DEFAULT_REQUIRES.node).trim(),
  }

  let userOwned
  let userOwnedSource
  if (Array.isArray(curJson.userOwned) && curJson.userOwned.length) {
    userOwned = curJson.userOwned.map((s) => String(s))
    userOwnedSource = '沿用清单现有 ' + userOwned.length + ' 项'
  } else {
    userOwned = DEFAULT_USER_OWNED.slice()
    userOwnedSource = '由 shell-release 写入默认 ' + userOwned.length + ' 项'
  }

  let releasedAt
  if (opts.date) {
    const d = new Date(opts.date)
    if (Number.isNaN(d.getTime())) throw new ReleaseError('--date 不是合法时间：' + opts.date, '例：2026-11-04T08:00:00Z')
    releasedAt = d.toISOString()
  } else {
    releasedAt = new Date().toISOString()
  }
  if (!opts.date && parsed.date && parsed.date !== releasedAt.slice(0, 10)) {
    warn('RELEASE-NOTES.md 的小节日期是 ' + parsed.date + '，而 releasedAt 会是 ' + releasedAt
      + '（差一天不算错，但列表页和清单会对不上）：要一致就加 --date ' + parsed.date + 'T08:00:00Z，或改小节标题日期')
  }

  const notesUrl = notesUrlFor(repo, tag)
  const info = {
    schemaVersion: 2,
    updaterMin,
    channel,
    version,
    tag,
    releasedAt,
    minShellVersion,
    requires,
    userOwned,
    notes: parsed.notes,
    notesUrl,
    files: current.files,
    zip: null,
  }
  const next = buildReleaseManifest(curJson, info)
  // 整包 sha 每次都要重算，旧 zip 字段先摘掉（下面第 5 步再写回来）
  delete next.zip
  const changes = describeManifestChanges(curJson, next)
  const commitMsg = 'chore(release): 壳 ' + tag
  const tagMsg = '壳 ' + tag + '（详见 ' + NOTES_FILE + '）'
  const planned = [
    'node tools\\clean-ship.mjs refresh',
    'node tools\\verify-shell.mjs',
    'node tools\\selftest-shell-update.mjs',
    'node tools\\clean-ship.mjs refresh',
    '打整包 ' + ZIP_DISPLAY_NAME(version) + '（按清单 files）→ 把 zip{name,sha256,bytes} 写回清单',
    'node tools\\clean-ship.mjs refresh（保留 zip 字段，重算 files）',
    'git add -A',
    'git ' + commitIdentity.join(' ') + ' commit -m "' + commitMsg + '"',
    'git ' + commitIdentity.join(' ') + ' tag -a ' + tag + ' -m "' + tagMsg + '"',
    'tag 自校验：tag 里的清单带 zip 字段，且 files 每个 sha256 == git show ' + tag + ':<path>',
  ]

  if (opts.dryRun) {
    log('=== prepare --dry-run（仓库零写入 / 不跑门禁 / 不动 git）===')
    log(pad('仓库根', 15) + ': ' + rootOf())
    log(pad('版本', 15) + ': ' + version + ' → tag ' + tag + '（channel ' + channel + '）')
    log(pad('releasedAt', 15) + ': ' + releasedAt)
    log(pad('minShellVersion', 15) + ': ' + minShellVersion + '，updaterMin ' + updaterMin + '，schemaVersion 2')
    log(pad('requires', 15) + ': dsh ' + requires.dsh + ' / node ' + requires.node)
    log(pad('notes', 15) + ': ' + noteSummary(parsed.notes))
    log(pad('notesUrl', 15) + ': ' + notesUrl)
    log(pad('userOwned', 15) + ': ' + userOwnedSource)
    log(pad('RELEASE-NOTES', 15) + ': ' + notesPath)
    log(pad('小节标题', 15) + ': ' + parsed.heading + (parsed.date ? '（日期 ' + parsed.date + '）' : ''))
    blank()
    log('将写入 ' + manifestPath() + '：')
    if (!changes.length) log('  （字段无变化）')
    for (const [k, b, a] of changes) log('  ' + pad(k, 16) + pad(b, 22) + ' → ' + a)
    log('  ' + pad('files', 16) + String(Object.keys(current.files).length) + ' 项（保留；稍后由 clean-ship refresh 重算）')
    blank()

    // 整包：dry-run 只在 %TEMP% 里试打一次拿真实 sha（仓库零写入），打完就删
    const guess = guessZipPathsForDryRun(current.files)
    const tmpZip = join(tmpdir(), 'shell-release-dryrun', ZIP_DISPLAY_NAME(version))
    let zipLine = '（跳过：没有可打包的文件）'
    try {
      if (guess.paths.length) {
        const z = buildShellZip(guess.paths, { outPath: tmpZip })
        zipLine = ZIP_DISPLAY_NAME(version) + '：' + fmtBytes(z.bytes.length) + '，sha256 ' + z.sha.slice(0, 12) + '…，' + z.fileCount + ' 个文件'
        log('整包（' + guess.source + '，%TEMP% 试打后已删）:')
        log('  ' + pad('name', 10) + ': ' + ZIP_DISPLAY_NAME(version))
        log('  ' + pad('bytes', 10) + ': ' + z.bytes.length + '（' + fmtBytes(z.bytes.length) + '）')
        log('  ' + pad('sha256', 10) + ': ' + z.sha.slice(0, 12) + '…（完整值会写进清单 zip.sha256）')
        log('  ' + pad('files', 10) + ': ' + z.fileCount + ' 个（不含 shell-version.json）')
        for (const rel of guess.paths.slice(0, 10)) log('    + ' + rel)
        if (guess.paths.length > 10) log('    …还有 ' + (guess.paths.length - 10) + ' 个')
      } else {
        log('整包: ' + zipLine)
      }
    } catch (e) {
      zipLine = '（试打失败：' + truncate((e && e.message) || e, 200) + '）'
      warn('整包试打失败（dry-run 继续）：' + truncate((e && e.message) || e, 300))
    } finally {
      try { rmSync(dirname(tmpZip), { recursive: true, force: true }) } catch { /* 临时目录 */ }
    }
    blank()
    log('随后将依次执行：')
    planned.forEach((c, i) => log('  ' + (i + 1) + ') ' + c))
    if (opts.skipGates) warn('--skip-gates：真实执行时会跳过门禁命令')
    blank()
    log('（--dry-run：仓库一个字节都没写、门禁没跑、git 没动）')
    return 0
  }

  log('=== prepare 壳 ' + tag + ' ===')
  const written = writeManifestJson(next)
  log('已写入 ' + written.path + '（' + fmtBytes(written.bytes) + '）')
  log('  ' + pad('notes', 14) + ': ' + noteSummary(parsed.notes))
  log('  ' + pad('userOwned', 14) + ': ' + userOwnedSource)
  if (userOwnedSource.startsWith('由 shell-release')) {
    log('  提示：清单里原本没有 userOwned，本次由 shell-release 写入默认列表（含 pnpm 锁文件等用户私有文件）')
  }

  if (!opts.skipGates) {
    blank()
    log('--- 门禁 1/3：clean-ship refresh（生成 files）---')
    const r1 = runNodeInherit('tools/clean-ship.mjs', ['refresh'])
    if (r1.code !== 0) {
      throw new ReleaseError(
        '门禁失败：clean-ship refresh（退出码 ' + r1.code + '）',
        '清单已写入但**没有**提交、没有打 tag。修好之后重跑 prepare 即可。',
      )
    }
    log('--- 门禁 2/3：verify-shell ---')
    if (!existsSync(join(ROOT, 'tools/verify-shell.mjs'))) throw new ReleaseError('缺 tools/verify-shell.mjs', '先把它做出来，或临时 --skip-gates')
    const r2 = runNodeInherit('tools/verify-shell.mjs', [])
    if (r2.code !== 0) {
      throw new ReleaseError(
        '门禁失败：verify-shell（退出码 ' + r2.code + '）',
        '清单已写入但**没有**提交、没有打 tag。修好之后重跑 prepare 即可。',
      )
    }
    log('--- 门禁 3/3：selftest-shell-update ---')
    if (!existsSync(join(ROOT, 'tools/selftest-shell-update.mjs'))) {
      throw new ReleaseError(
        '缺 tools/selftest-shell-update.mjs（换装引擎的自测）',
        '这个门禁不能跳：它是"换装引擎不会烧掉用户文件"的唯一证据。--skip-gates 只在已经全绿的重跑里用。',
      )
    }
    const r3 = runNodeInherit('tools/selftest-shell-update.mjs', [])
    if (r3.code !== 0) {
      throw new ReleaseError(
        '门禁失败：selftest-shell-update（退出码 ' + r3.code + '）',
        '清单已写入但**没有**提交、没有打 tag。修好之后重跑 prepare 即可。',
      )
    }
    log('--- 门禁全绿 ---')
    blank()
    log('--- 再刷一次清单（让 files 收下新字段）---')
    const r4 = runNodeInherit('tools/clean-ship.mjs', ['refresh'])
    if (r4.code !== 0) {
      throw new ReleaseError('clean-ship refresh（第二次）失败：退出码 ' + r4.code, '清单已写入但未提交；修好后重跑 prepare。')
    }
  }

  const checkFields = (j, withZip) => {
    const problems = []
    if (j.schemaVersion !== 2) problems.push('schemaVersion 不是 2（实际 ' + preview(j.schemaVersion) + '）')
    if (String(j.shellVersion || '') !== version) problems.push('shellVersion 不是 ' + version + '（实际 ' + preview(j.shellVersion) + '）')
    if (String(j.tag || '') !== tag) problems.push('tag 不是 ' + tag + '（实际 ' + preview(j.tag) + '）')
    if (!Number.isInteger(j.updaterMin)) problems.push('updaterMin 丢了')
    if (!j.notes || typeof j.notes !== 'object') problems.push('notes 丢了')
    else for (const s of NOTES_SECTIONS) if (!Array.isArray(j.notes[s.key])) problems.push('notes.' + s.key + ' 不是数组')
    if (!Array.isArray(j.userOwned) || !j.userOwned.length) problems.push('userOwned 丢了')
    if (String(j.notesUrl || '') !== notesUrl) problems.push('notesUrl 不是 ' + notesUrl)
    if (!Object.keys(j.files || {}).length) problems.push('files 是空的')
    if (withZip) {
      if (!j.zip || typeof j.zip !== 'object') problems.push('zip 丢了')
      else {
        if (String(j.zip.name || '') !== ZIP_DISPLAY_NAME(version)) problems.push('zip.name 不是 ' + ZIP_DISPLAY_NAME(version))
        if (!/^[0-9a-f]{64}$/.test(String(j.zip.sha256 || ''))) problems.push('zip.sha256 不是 64 位小写十六进制')
        if (!Number.isInteger(j.zip.bytes) || j.zip.bytes <= 0) problems.push('zip.bytes 不是正整数')
      }
    }
    return problems
  }

  if (!opts.noPostcheck) {
    const afterFields = readManifest()
    const problems = checkFields(afterFields.json, false)
    if (problems.length) {
      throw new ReleaseError(
        'clean-ship refresh 之后清单字段不对：' + problems.join('；'),
        'refresh 必须原样保留 shell-release 写入的 v2 字段。先修 tools/clean-ship.mjs 的 refresh，再重跑 prepare（现在还没提交、没打 tag，安全）。',
      )
    }
    log('后置校验 1：schemaVersion/tag/notes/userOwned/notesUrl/files 都在 ✓（files ' + Object.keys(afterFields.json.files).length + ' 项）')
  }

  // ---- 第 5 步：打整包 → 写 zip 字段 → 再 refresh --------------------------
  blank()
  log('--- 整包（按清单 files 打包，不含 shell-version.json）---')
  const filesNow = readManifest().json.files || {}
  const zipPaths = zipPathsFromFiles(filesNow)
  if (!zipPaths.length) throw new ReleaseError('清单 files 里没有可打包的壳文件', '检查 shell-update 的白名单与 clean-ship refresh')
  if (!Object.keys(filesNow).some((k) => k.toLowerCase() === NOTES_FILE.toLowerCase())) {
    warn(NOTES_FILE + ' 不在清单 files 里 → 整包不含它。若要随整包发布，请把它加进壳白名单（shell-update.mjs）。')
  }
  const assetsDir = opts.assetsDir ? resolve(String(opts.assetsDir)) : join(tmpdir(), 'shell-release', tag)
  const zipPath = join(assetsDir, ZIP_DISPLAY_NAME(version))
  const zip = buildShellZip(zipPaths, { outPath: zipPath })
  log('  已打包 ' + zip.fileCount + ' 个文件 → ' + zip.path + '（' + fmtBytes(zip.bytes.length) + '）')
  log('  zip.sha256 = ' + zip.sha.slice(0, 12) + '…（' + zip.sha + '）')

  const withZip = readManifest()
  const nextWithZip = buildReleaseManifest(withZip.json, Object.assign({}, info, {
    files: withZip.json.files,
    zip: { name: ZIP_DISPLAY_NAME(version), sha256: zip.sha, bytes: zip.bytes.length },
  }))
  writeManifestJson(nextWithZip)
  log('  已把 zip{name,sha256,bytes} 写回 ' + manifestPath())

  log('  再 refresh 一次（refresh 保留 zip 字段，files 应保持不变）---')
  const r5 = runNodeInherit('tools/clean-ship.mjs', ['refresh'])
  if (r5.code !== 0) throw new ReleaseError('clean-ship refresh（写 zip 后）失败：退出码 ' + r5.code, '清单已写入但未提交；修好后重跑 prepare。')

  if (!opts.noPostcheck) {
    const afterZip = readManifest()
    const problems = checkFields(afterZip.json, true)
    const filesAfter = afterZip.json.files || {}
    const lost = Object.keys(filesNow).filter((k) => !(k in filesAfter))
    if (lost.length) problems.push('refresh 之后 files 少了 ' + lost.length + ' 个（' + lost.slice(0, 3).join(', ') + '）')
    if (problems.length) {
      throw new ReleaseError(
        '写 zip 字段后再 refresh，清单不对：' + problems.join('；'),
        'refresh 必须保留 shell-release 写入的 zip 字段。先修 tools/clean-ship.mjs，再重跑 prepare。',
      )
    }
    log('后置校验 2：zip{name,sha256,bytes} 在，files 仍 ' + Object.keys(filesAfter).length + ' 项 ✓')
  }

  // ---- 第 6 步：提交 + 打 tag ---------------------------------------------
  blank()
  log('--- 提交与打 tag ---')
  const statusBefore = runGit(['status', '--porcelain'])
  const changedPaths = statusBefore.out.split('\n').map((s) => s.trim()).filter(Boolean)
  log('工作树改动：' + (changedPaths.length ? changedPaths.length + ' 个路径' : '无'))
  for (const p of changedPaths.slice(0, 30)) log('  ' + p)
  if (changedPaths.length > 30) log('  …还有 ' + (changedPaths.length - 30) + ' 个')
  gitOk(['add', '-A'])
  const staged = runGit(['diff', '--cached', '--name-only']).out.split('\n').map((s) => s.trim()).filter(Boolean)
  let commitSha = runGit(['rev-parse', '--short', 'HEAD']).out.trim()
  if (staged.length) {
    gitOk([...commitIdentity, 'commit', '-m', commitMsg])
    commitSha = runGit(['rev-parse', '--short', 'HEAD']).out.trim()
    log('已提交 ' + commitSha + '（' + staged.length + ' 个路径）')
  } else {
    warn('没有可提交的改动，跳过 git commit（tag 会打在当前 HEAD ' + commitSha + ' 上）')
  }

  if (tagExists(tag)) {
    throw new ReleaseError(
      'tag 已存在：' + tag,
      '已发布的 tag 永不移动、永不删除（见 RELEASING.md「坏版本处置」）。要重发就换一个版本号。',
    )
  }
  gitOk([...commitIdentity, 'tag', '-a', tag, '-m', tagMsg])
  log('已打 tag ' + tag + ' → ' + commitSha)

  // ---- 第 7 步：tag 自校验 -------------------------------------------------
  blank()
  log('--- tag 自校验 ---')
  const tagManifestBytes = gitShow(tag, SHELL_MANIFEST)
  const tagManifest = JSON.parse(tagManifestBytes.toString('utf8').replace(/^\uFEFF/, ''))
  const problems = checkFields(tagManifest, true)
  if (String(tagManifest.zip && tagManifest.zip.sha256) !== zip.sha) problems.push('tag 里 zip.sha256 与刚打的包不一致（tag 打在了错提交上？）')
  const tagFiles = tagManifest.files || {}
  const badSha = []
  for (const [rel, want] of Object.entries(tagFiles)) {
    try {
      const got = sha256(gitShow(tag, rel))
      if (got !== want) badSha.push(rel + '（清单 ' + want.slice(0, 12) + '… / 实物 ' + got.slice(0, 12) + '…）')
    } catch (e) {
      badSha.push(rel + '（tag 里没有这个文件）')
    }
  }
  if (badSha.length) problems.push('files 里 ' + badSha.length + ' 个 sha256 与 tag 实物不符：' + badSha.slice(0, 3).join('；'))
  if (problems.length) {
    throw new ReleaseError(
      'tag 自校验失败：' + problems.join('；'),
      'tag ' + tag + ' 还没推远端，可以 `git tag -d ' + tag + '` 后修好再重跑 prepare（**只在推送前**允许这么做）。',
    )
  }
  log('tag 里的清单：schemaVersion 2 / zip.sha256 ' + zip.sha.slice(0, 12) + '… / files ' + Object.keys(tagFiles).length + ' 项全部与实物一致 ✓')

  blank()
  log('=== prepare 完成 ===')
  log('  版本   : ' + version + '（' + tag + '，channel ' + channel + '）')
  log('  提交   : ' + commitSha)
  log('  notes  : ' + noteSummary(parsed.notes))
  log('  整包   : ' + ZIP_DISPLAY_NAME(version) + '（' + fmtBytes(zip.bytes.length) + '，sha256 ' + zip.sha.slice(0, 12) + '…）')
  log('  下一步 : node tools\\shell-release.mjs publish')
  return 0
}

// ---- publish --dry-run 的计划输出 -----------------------------------------
const printPublishPlan = (ctx, opts) => {
  const repo = ctx.repo
  const tag = ctx.tag
  const latest = 'https://github.com/' + repo + '/releases/latest/download/' + SHELL_MANIFEST
  const canReadTag = tagExists(tag)
  log('=== publish --dry-run（只打印；不推送、不联网、不上传、不写仓库）===')
  log(pad('版本', 14) + ': ' + ctx.version + '（tag ' + tag + '）')
  log(pad('仓库', 14) + ': ' + repo)
  log('')
  if (opts.push === false) log('1) 推送      : （--no-push，跳过）')
  else {
    log('1) 推送 master: git push origin master')
    log('   推送 tag   : git push origin ' + tag)
  }
  const tok = readToken(opts.tokenEnv)
  if (tok.token) log('2) token     : 取到（来源 ' + tok.source + '，长度 ' + tok.token.length + '，已脱敏）')
  else log('2) token     : 取不到（来源 ' + tok.source + (tok.error ? '，' + tok.error : '') + '）→ 真实发布前先 set ' + (opts.tokenEnv || 'GH_TOKEN') + '=<PAT>')
  log('3) 查 Release: GET https://api.github.com/repos/' + repo + '/releases/tags/' + tag)
  log('               → 404 则 POST https://api.github.com/repos/' + repo + '/releases')
  log('                 {tag_name:' + tag + ', name:"壳 ' + tag + '", body:<RELEASE-NOTES 小节原文>, prerelease:false, make_latest:true}')
  log('4) 资产      : ' + SHELL_MANIFEST + '（字节取自 git show ' + tag + ':' + SHELL_MANIFEST + '，不是工作树）')
  if (canReadTag) {
    try {
      const bytes = gitShow(tag, SHELL_MANIFEST)
      const j = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
      log('               sha256 ' + sha256(bytes) + '（' + fmtBytes(bytes.length) + '）')
      if (j.zip && j.zip.name) {
        log('               清单 zip 字段：' + j.zip.name + ' / ' + (j.zip.bytes ? fmtBytes(j.zip.bytes) : '?') + ' / sha256 ' + String(j.zip.sha256 || '').slice(0, 12) + '…')
      } else {
        log('               清单里没有 zip 字段 → 老版本 apply --full 会报"没有可用的整包信息"（先跑 prepare 新版）')
      }
    } catch (e) {
      log('               （读不到 tag 里的清单：' + (e && e.message ? e.message : String(e)) + '）')
    }
  } else {
    log('               tag 还不存在 → 先跑 prepare')
  }
  if (opts.zip === false) log('               harness-shell-' + ctx.version + '.zip：（--no-zip，跳过）')
  else if (!canReadTag) log('               harness-shell-' + ctx.version + '.zip：tag 还不存在，先跑 prepare')
  else {
    try {
      const j = JSON.parse(gitShow(tag, SHELL_MANIFEST).toString('utf8').replace(/^\uFEFF/, ''))
      const paths = zipPathsFromFiles(j.files || {})
      log('               harness-shell-' + ctx.version + '.zip：按清单 files ' + paths.length + ' 个文件重打（时间戳钉死 → 可复现）')
      for (const rel of paths.slice(0, 12)) log('                 + ' + rel)
      if (paths.length > 12) log('                 …还有 ' + (paths.length - 12) + ' 个')
      log('               重打后校验 sha256 == 清单 zip.sha256' + (j.zip && j.zip.sha256 ? '（' + String(j.zip.sha256).slice(0, 12) + '…）' : '（清单里没有 zip 字段，只打印）'))
    } catch (e) {
      log('               harness-shell-' + ctx.version + '.zip：（列不出文件：' + (e && e.message ? e.message : String(e)) + '）')
    }
  }
  log('5) 上传      : POST https://uploads.github.com/repos/' + repo + '/releases/<id>/assets?name=<资产名>')
  log('6) 下载校验  : GET 资产 browser_download_url → 比对 sha256 与本地一致（不一致算失败）')
  log('')
  log('发布后自检：node tools\\shell-release.mjs verify-published --version ' + ctx.version)
  log('清单地址（用户侧默认源）：' + latest)
  log('')
  log('（--dry-run：以上一条都没执行）')
}

// ---- token（绝不打印明文）----------------------------------------------------
/**
 * 取 GitHub token。返回 { token, source, error }：
 *   1) --token-env 指定的环境变量名 → 2) GH_TOKEN → 3) GITHUB_TOKEN
 *   4) 都没有就 `git credential fill`（protocol=https host=github.com）
 * token 只进请求头，任何日志都不出现明文（只报来源/长度/"已脱敏"）。
 */
export const readToken = (envName) => {
  const names = []
  if (envName) names.push(String(envName))
  names.push('GH_TOKEN', 'GITHUB_TOKEN')
  const seen = new Set()
  for (const n of names) {
    if (!n || seen.has(n)) continue
    seen.add(n)
    const val = process.env[n]
    if (val && String(val).trim()) return { token: String(val).trim(), source: 'env:' + n, error: '' }
  }
  const res = spawnSync(GIT, ['credential', 'fill'], {
    cwd: rootOf(),
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    input: 'protocol=https\nhost=github.com\n\n',
    env: Object.assign({}, process.env, {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: process.env.GCM_INTERACTIVE || 'never',
    }),
  })
  if (res.status !== 0) {
    return {
      token: '',
      source: 'git-credential',
      error: 'git credential fill 退出码 ' + (res.status === null ? 'null（超时/没装 git）' : res.status)
        + '（' + truncate(res.stderr || res.error || '无输出', 200) + '）',
    }
  }
  const kv = {}
  for (const line of String(res.stdout || '').split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1)
  }
  if (!kv.password) return { token: '', source: 'git-credential', error: '凭据里没有 password 字段' }
  // 注意：只报来源，不报 username / password（日志里永远不出现凭据的任何片段）
  return { token: kv.password, source: 'git-credential', error: '' }
}

const truncate = (s, n = 600) => {
  const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

// ---- GitHub API -------------------------------------------------------------
const GH = 'https://api.github.com'
const UPLOADS = 'https://uploads.github.com'

const ghHeaders = (token) => ({
  Authorization: 'Bearer ' + token,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'hack3rx-shell-release/1.0',
})

/**
 * 一次请求拿 byte / json / 文本。
 * 注意：shell-update.mjs 的 --json 把中文转成了 \uXXXX（纯 ASCII 单行），
 * 这里一律先 JSON.parse，别直接拿字符串比中文。
 */
const httpGet = async (url, headers) => {
  const r = await fetch(url, { headers })
  const buf = Buffer.from(await r.arrayBuffer())
  let json = null
  try { json = buf.length ? JSON.parse(buf.toString('utf8')) : null } catch { json = null }
  return { status: r.status, ok: r.ok, json, text: buf.toString('utf8'), buf }
}

const httpJson = async (url, init) => {
  const r = await fetch(url, init)
  const buf = Buffer.from(await r.arrayBuffer())
  let json = null
  try { json = buf.length ? JSON.parse(buf.toString('utf8')) : null } catch { json = null }
  return { status: r.status, ok: r.ok, json, text: buf.toString('utf8'), buf }
}

const lastJsonLine = (text) => {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]) } catch { /* 继续往上找 */ }
  }
  return null
}

// ---- publish ----------------------------------------------------------------
const notesForTag = (tag, version) => {
  try {
    const text = gitShow(tag, NOTES_FILE).toString('utf8')
    return parseNotesStrict(text, version)
  } catch (e) {
    const p = join(rootOf(), NOTES_FILE)
    if (!existsSync(p)) throw e
    warn('tag ' + tag + ' 里取不到 ' + NOTES_FILE + '，改用工作树里的：' + p)
    return parseNotesStrict(readFileSync(p, 'utf8'), version)
  }
}

const buildManifestAsset = (ctx, assetsDir) => {
  const bytes = gitShow(ctx.tag, SHELL_MANIFEST) // 必须取 tag 的字节，不是工作树
  let parsed = null
  try { parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) } catch { parsed = null }
  if (!parsed) throw new ReleaseError('tag 里的 ' + SHELL_MANIFEST + ' 不是合法 JSON', ctx.tag + ':' + SHELL_MANIFEST)
  if (String(parsed.shellVersion || '') !== ctx.version) {
    throw new ReleaseError(
      'tag 里的清单版本与本次发布不一致：' + preview(parsed.shellVersion) + ' != ' + ctx.version,
      '说明 tag 打在了错的提交上（先 prepare 再 publish，别手工改 shell-version.json）',
    )
  }
  ctx.tagManifest = parsed
  if (!parsed.zip || !parsed.zip.sha256) {
    warn('tag 里的清单没有 zip{name,sha256,bytes} 字段 → apply --full 用不了；建议重跑 prepare')
  }
  mkdirSync(assetsDir, { recursive: true })
  const p = join(assetsDir, SHELL_MANIFEST)
  writeFileSync(p, bytes)
  return { name: SHELL_MANIFEST, path: p, bytes, sha: sha256(bytes) }
}

/**
 * 重打整包：文件集 = tag 清单 files ∩ zip 白名单（**永不含 shell-version.json 自己**）。
 * 先逐个断言 tag 里文件的 sha256 与清单一致，再打包，再断言包 sha256 == 清单 zip.sha256。
 * 时间戳钉死 FIXED_MTIME_MS，所以和 prepare 打的那一份字节必然相同。
 */
const buildZipAsset = (ctx, assetsDir) => {
  const manifest = ctx.tagManifest || {}
  const files = manifest.files || {}
  const paths = zipPathsFromFiles(files)
  if (!paths.length) throw new ReleaseError('tag 清单里没有可打包的壳文件', '检查 isZipShellPath 白名单与 clean-ship refresh 的输出')
  const badSha = []
  for (const rel of paths) {
    try {
      const got = sha256(gitShow(ctx.tag, rel))
      if (got !== files[rel]) badSha.push(rel)
    } catch { badSha.push(rel + '（tag 里缺这个文件）') }
  }
  if (badSha.length) {
    throw new ReleaseError(
      'tag 里有 ' + badSha.length + ' 个文件与清单 sha256 不符：' + badSha.slice(0, 4).join(', '),
      '清单是 prepare 时按工作树算的，tag 里应当一字不差。别手工改 tag 内容，重跑 prepare。',
    )
  }
  const name = ZIP_DISPLAY_NAME(ctx.version)
  mkdirSync(assetsDir, { recursive: true })
  const p = join(assetsDir, name)
  const zip = buildShellZip(paths, { tag: ctx.tag, outPath: p })
  log('    打包 ' + zip.fileCount + ' 个壳文件 → ' + p + '（' + fmtBytes(zip.bytes.length) + '）')
  if (manifest.zip && manifest.zip.sha256) {
    if (manifest.zip.sha256 !== zip.sha) {
      throw new ReleaseError(
        '整包 sha256 与清单里的 zip.sha256 不符：清单 ' + String(manifest.zip.sha256).slice(0, 12) + '… / 实物 ' + zip.sha.slice(0, 12) + '…',
        '说明 prepare 之后又改过壳文件（或换过 7z 版本）。重跑 prepare 让清单与整包重新对齐。',
      )
    }
    log('    整包 sha256 与清单 zip.sha256 一致（' + zip.sha.slice(0, 12) + '…）')
  }
  return { name, path: p, bytes: zip.bytes, sha: zip.sha, fileCount: zip.fileCount }
}

const ensureRelease = async (ctx, token, opts) => {
  const h = ghHeaders(token)
  const got = await httpGet(GH + '/repos/' + ctx.repo + '/releases/tags/' + ctx.tag, h)
  if (got.ok && got.json && got.json.id) {
    log('  Release 已存在，复用：' + (got.json.html_url || ctx.releaseUrl) + '（id ' + got.json.id + '）')
    if (opts.syncNotes) {
      const patched = await httpJson(GH + '/repos/' + ctx.repo + '/releases/' + got.json.id, {
        method: 'PATCH',
        headers: Object.assign({ 'Content-Type': 'application/json' }, h),
        body: JSON.stringify({ body: ctx.body }),
      })
      if (!patched.ok) warn('--sync-notes 更新 Release 说明失败：HTTP ' + patched.status)
      else log('  已用 RELEASE-NOTES 小节刷新 Release 说明')
    }
    return got.json
  }
  if (got.status !== 404) throw new ReleaseError('查 Release 失败：HTTP ' + got.status, truncate(got.text))
  const payload = {
    tag_name: ctx.tag,
    name: '壳 ' + ctx.tag,
    body: ctx.body,
    draft: false,
    prerelease: false,
    make_latest: 'true',
  }
  const cre = await httpJson(GH + '/repos/' + ctx.repo + '/releases', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, h),
    body: JSON.stringify(payload),
  })
  if (!cre.ok || !cre.json || !cre.json.id) {
    throw new ReleaseError('创建 Release 失败：HTTP ' + cre.status, truncate(cre.text))
  }
  log('  已创建 Release：' + (cre.json.html_url || ctx.releaseUrl) + '（id ' + cre.json.id + '）')
  return cre.json
}

const uploadAsset = async (ctx, token, releaseId, asset) => {
  const h = ghHeaders(token)
  const list = await httpGet(GH + '/repos/' + ctx.repo + '/releases/' + releaseId + '/assets?per_page=100', h)
  if (list.ok && Array.isArray(list.json)) {
    for (const old of list.json.filter((x) => x && x.name === asset.name)) {
      log('    同名资产已存在，先删：' + old.name + '（id ' + old.id + '）')
      const del = await httpJson(GH + '/repos/' + ctx.repo + '/releases/assets/' + old.id, { method: 'DELETE', headers: h })
      if (!del.ok && del.status !== 404) throw new ReleaseError('删旧资产失败：HTTP ' + del.status, truncate(del.text))
    }
  }
  const up = await httpJson(
    UPLOADS + '/repos/' + ctx.repo + '/releases/' + releaseId + '/assets?name=' + encodeURIComponent(asset.name),
    { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, h), body: asset.bytes },
  )
  if (!up.ok || !up.json || !up.json.id) {
    throw new ReleaseError('上传资产 ' + asset.name + ' 失败：HTTP ' + up.status, truncate(up.text))
  }
  log('    已上传 ' + asset.name + '（' + fmtBytes(asset.bytes.length) + '，id ' + up.json.id + '）')
  return up.json
}

const verifyRemoteAsset = async (ctx, token, asset, remote) => {
  const h = ghHeaders(token)
  const url = (remote && remote.browser_download_url) || (GH + '/repos/' + ctx.repo + '/releases/assets/' + remote.id)
  const dl = await httpGet(url, Object.assign({}, h, { Accept: 'application/octet-stream' }))
  if (!dl.ok) return { ok: false, detail: '下载资产失败：HTTP ' + dl.status + '（' + truncate(dl.text, 200) + '）' }
  const got = sha256(dl.buf)
  if (got !== asset.sha) return { ok: false, detail: 'sha256 不一致：远端 ' + got + ' / 本地 ' + asset.sha }
  return { ok: true, detail: 'sha256 ' + got + '（' + fmtBytes(dl.buf.length) + '）' }
}

const printRemedy = (ctx, assetsDir, opts) => {
  help('')
  help('补救（按顺序做，做完可以重跑 publish，已完成的步骤会复用）:')
  help('  1) 推送失败：在仓库根手动跑 `git push origin master` 与 `git push origin ' + ctx.tag + '`；')
  help('     被拒（non-fast-forward）先 `git pull --rebase origin master` 再推。')
  help('  2) 401/403：token 权限不够。fine-grained PAT 需要 Contents: Read and write；')
  help('     经典 PAT 需要 repo scope。取不到 token 时先 set ' + (opts.tokenEnv || 'GH_TOKEN') + '=<PAT> 再跑。')
  help('  3) Release/资产失败可以在网页上补齐：')
  help('     打开 ' + ctx.releaseUrl + ' → 若没有 Release：Draft a new release，Tag 选 ' + ctx.tag + '，')
  help('     Title 填 `壳 ' + ctx.tag + '`，正文粘贴 RELEASE-NOTES.md 的 `## ' + ctx.tag + '` 小节，不勾 pre-release。')
  help('     然后把下面文件拖进 Assets（文件名不要改）：')
  help('       ' + SHELL_MANIFEST + '  ← 别用工作树那份！用 `git show ' + ctx.tag + ':' + SHELL_MANIFEST + ' > ' + SHELL_MANIFEST)
  help('       ' + ZIP_DISPLAY_NAME(ctx.version) + '  ← ' + join(assetsDir, ZIP_DISPLAY_NAME(ctx.version)))
  help('  4) 补齐后自检：node tools\\shell-release.mjs verify-published --version ' + ctx.version)
}

const publish = async (opts) => {
  const manifest = readManifest()
  const version = String(opts.version || manifest.json.shellVersion || '').trim().replace(/^v/i, '')
  if (!validSemver(version)) {
    throw new ReleaseError('清单里的 shellVersion 不是合法 semver：' + preview(manifest.json.shellVersion), '先跑 prepare --version <ver>')
  }
  const tag = 'v' + version
  const repo = resolveRepo(opts.repo)
  const ctx = {
    version,
    tag,
    repo,
    releaseUrl: 'https://github.com/' + repo + '/releases/tag/' + tag,
    body: '',
    tagManifest: null,
  }
  const assetsDir = opts.assetsDir ? resolve(String(opts.assetsDir)) : join(tmpdir(), 'shell-release', tag)

  if (opts.dryRun) {
    printPublishPlan(ctx, opts)
    return 0
  }

  log('=== publish 壳 ' + tag + '（' + repo + '）===')
  const parsed = notesForTag(tag, version)
  ctx.body = parsed.sectionText
  log('  Release 说明取自 tag 里的 ' + NOTES_FILE + '（' + ctx.body.split('\n').length + ' 行）')
  log('  notes：' + noteSummary(parsed.notes))
  log('  资产目录：' + assetsDir)

  try {
    if (opts.push !== false) {
      const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']).out.trim() || 'master'
      if (branch !== 'master') warn('当前分支是 ' + branch + '（不是 master）：会推 ' + branch)
      log('  → git push origin ' + branch)
      gitOk(['push', 'origin', branch])
      log('  → git push origin ' + tag)
      gitOk(['push', 'origin', tag])
      log('  已推送 ' + branch + ' 与 ' + tag)
    } else {
      log('  （--no-push：跳过 git push）')
    }
  } catch (e) {
    const err = e instanceof ReleaseError ? e : new ReleaseError(String((e && e.message) || e))
    help('')
    help('发布失败（git push）：' + err.message)
    if (err.detail) help('  ' + err.detail)
    printRemedy(ctx, assetsDir, opts)
    return 1
  }

  let tok
  try {
    tok = readToken(opts.tokenEnv)
    if (!tok.token) {
      help('')
      help('发布失败：取不到 GitHub token（' + tok.source + (tok.error ? '，' + tok.error : '') + '）')
      printRemedy(ctx, assetsDir, opts)
      return 1
    }
    log('  token：已取到（来源 ' + tok.source + '，长度 ' + tok.token.length + '，已脱敏）')
  } catch (e) {
    help('')
    help('发布失败：取 token 时出错：' + truncate((e && e.message) || e, 300))
    printRemedy(ctx, assetsDir, opts)
    return 1
  }

  const assets = []
  let release = null
  try {
    log('  → 查/建 Release ' + tag)
    release = await ensureRelease(ctx, tok.token, opts)

    log('  → 准备资产')
    const manifestAsset = buildManifestAsset(ctx, assetsDir)
    assets.push(manifestAsset)
    log('    ' + SHELL_MANIFEST + '：' + fmtBytes(manifestAsset.bytes.length) + '，sha256 ' + manifestAsset.sha)
    if (opts.zip !== false) {
      const zipAsset = buildZipAsset(ctx, assetsDir)
      assets.push(zipAsset)
      log('    ' + zipAsset.name + '：' + fmtBytes(zipAsset.bytes.length) + '，sha256 ' + zipAsset.sha)
    } else {
      log('    （--no-zip：只发清单）')
    }

    const uploaded = []
    for (const a of assets) {
      const remote = await uploadAsset(ctx, tok.token, release.id, a)
      uploaded.push({ asset: a, remote })
    }
    if (opts.verifyAssets !== false) {
      for (const u of uploaded) {
        const v = await verifyRemoteAsset(ctx, tok.token, u.asset, u.remote)
        if (!v.ok) throw new ReleaseError('资产下载校验失败：' + u.asset.name, v.detail)
        log('    校验 ' + u.asset.name + '：' + v.detail)
      }
    }
  } catch (e) {
    const err = e instanceof ReleaseError ? e : new ReleaseError(String((e && e.message) || e))
    help('')
    help('发布失败：' + err.message)
    if (err.detail) help('  ' + err.detail)
    printRemedy(ctx, assetsDir, opts)
    return 1
  }

  const releaseUrl = (release && release.html_url) || ctx.releaseUrl
  blank()
  log('=== publish 完成 ===')
  log('  Release : ' + releaseUrl)
  log('  资产    : ' + assets.map((a) => a.name).join('、'))
  log('  本地副本: ' + assetsDir)
  log('  清单地址: https://github.com/' + repo + '/releases/latest/download/' + SHELL_MANIFEST)
  log('  下一步  : node tools\\shell-release.mjs verify-published --version ' + version)
  return 0
}

// ---- verify-published -------------------------------------------------------
/** 这些是"用户数据"，检查/升级过程里一个字节都不许变 */
const USER_DATA_PATHS = [
  'home/sessions',
  'home/storages',
  'home/settings.yaml',
  'home/settings.yaml.imported',
  'home/.credentials.yaml',
  'home/.anonymous-user-id',
  'home/logs',
  'home/dsh-market',
  'home/.plugin-manager',
  'logs',
  'cache',
]

const hashPath = (base, rel) => {
  const out = new Map()
  const abs = join(base, ...rel.split('/'))
  let st
  try { st = statSync(abs) } catch { return out }
  if (st.isFile()) { out.set(rel, sha256File(abs)); return out }
  if (!st.isDirectory()) return out
  const walk = (dir, prefix) => {
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const d of ents) {
      const childRel = (prefix ? prefix + '/' : '') + d.name
      const childAbs = join(dir, d.name)
      if (d.isDirectory()) walk(childAbs, childRel)
      else if (d.isFile()) {
        try { out.set(childRel, sha256File(childAbs)) } catch { /* 读不到就跳过（不算失败） */ }
      }
    }
  }
  walk(abs, '')
  return out
}

const hashUserData = (base) => {
  const map = new Map()
  for (const rel of USER_DATA_PATHS) for (const [k, v] of hashPath(base, rel)) map.set(k, v)
  return map
}

const sameMap = (a, b) => {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

const printRows = (rows) => {
  const width = rows.reduce((m, r) => {
    const w = [...r.label].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
    return Math.max(m, w)
  }, 0)
  for (const r of rows) log((r.skip ? 'SKIP  ' : r.ok ? 'PASS  ' : 'FAIL  ') + pad(r.label, width) + '  ' + (r.detail || ''))
}

const verifyPublished = async (opts) => {
  const manifest = readManifest()
  const version = String(opts.version || manifest.json.shellVersion || '').trim().replace(/^v/i, '')
  if (!validSemver(version)) {
    throw new ReleaseError('清单里的 shellVersion 不是合法 semver：' + preview(manifest.json.shellVersion), '用 --version 指定要验的版本')
  }
  const tag = 'v' + version
  const repo = resolveRepo(opts.repo)
  const manifestUrl = 'https://github.com/' + repo + '/releases/latest/download/' + SHELL_MANIFEST
  const tags = listSemverTags()
  const prev = opts.prevTag
    ? { tag: String(opts.prevTag), semver: parseSemver(opts.prevTag) || { raw: String(opts.prevTag) } }
    : tags.filter((t) => cmpSemver(t.semver, parseSemver(version)) < 0)[0]

  const out = { ok: true, version, tag, prevTag: prev ? prev.tag : null, manifestUrl, skipped: false, rows: [] }
  const finishJson = (code) => {
    if (opts.json) process.stdout.write(JSON.stringify(out) + '\n')
    return code
  }

  if (!prev) {
    log('=== verify-published 壳 ' + tag + ' ===')
    log('本地 tag 列表：' + (tags.length ? tags.map((t) => t.tag).join(', ') : '（空）'))
    log('当前没有更早的版本 tag：首个版本，跳过端到端升级验证。')
    log('（等下一版发布时，这一步会自动拿 ' + tag + ' 当"老用户"来验。）')
    out.skipped = true
    out.rows.push({ label: '首个版本', ok: true, skip: true, detail: '没有更早的 tag 可当老用户' })
    return finishJson(0)
  }

  const work = opts.dryRun ? '' : mkdtempSync(join(tmpdir(), 'shell-verify-'))
  const cloneDir = join(work, 'shell')
  const stageDir = join(work, 'stage')
  const repoUrl = pathToFileURL(rootOf()).href

  if (opts.dryRun) {
    log('=== verify-published --dry-run（只打印，不 clone、不联网、不写盘）===')
    log(pad('当前版本', 16) + ': ' + version + '（' + tag + '）')
    log(pad('上一个 tag', 16) + ': ' + prev.tag)
    log(pad('清单地址', 16) + ': ' + manifestUrl)
    log(pad('临时目录', 16) + ': ' + join(tmpdir(), 'shell-verify-*'))
    blank()
    log('将依次执行：')
    log('  1) git clone --quiet --branch ' + prev.tag + ' --depth 1 ' + repoUrl + ' <tmp>/shell')
    log('  2) node <tmp>/shell/tools/shell-update.mjs check --manifest ' + manifestUrl + ' --json')
    log('     断言 ok && status=update-available && remote=' + version + '（注意：输出里的中文是 \\uXXXX，先 JSON.parse）')
    log('  3) node <tmp>/shell/tools/shell-update.mjs stage --manifest ' + manifestUrl + ' --stage <tmp>/stage --json')
    log('     逐文件比对 sha256 与远端清单一致')
    log('  4) 断言 clone 里 ' + USER_DATA_PATHS.slice(0, 4).join(' / ') + ' 等用户数据哈希前后不变')
    log('  5) 断言 Release 上 shell-version.json 的字节 == git show ' + tag + ':' + SHELL_MANIFEST)
    log('  6) 断言 Release 资产里有整包 zip 且 size == 清单 zip.bytes')
    blank()
    log('（--dry-run：以上一条都没执行）')
    out.rows.push({ label: 'dry-run 计划', ok: true, detail: 'prev=' + prev.tag + ' → ' + tag })
    return finishJson(0)
  }

  log('=== verify-published 壳 ' + tag + '（拿 ' + prev.tag + ' 当老用户）===')
  {
    const r = runGit(['clone', '--quiet', '--branch', prev.tag, '--depth', '1', repoUrl, cloneDir], { cwd: work, timeout: 300000 })
    const ok = r.code === 0
    out.rows.push({ label: 'clone ' + prev.tag, ok, detail: ok ? cloneDir : truncate(r.err || r.error) })
    if (!ok) {
      printRows(out.rows)
      blank()
      log('结论：FAIL —— clone 失败，无法继续（先确认本地有 tag ' + prev.tag + '）')
      out.ok = false
      return finishJson(1)
    }
  }

  const cloneUpdate = join(cloneDir, 'tools', 'shell-update.mjs')
  const before = hashUserData(cloneDir)
  const remote = await httpGet(manifestUrl, { 'User-Agent': 'hack3rx-shell-release/1.0' })
  const remoteJson = remote.json || {}
  const expected = remoteJson.files && typeof remoteJson.files === 'object' ? remoteJson.files : {}

  out.rows.push({
    label: 'GET 远端清单',
    ok: remote.ok && !!remote.json,
    detail: 'HTTP ' + remote.status + (remote.ok ? '，' + Object.keys(expected).length + ' 个文件' : '（' + truncate(remote.text, 200) + '）'),
  })
  out.rows.push({ label: '清单 schemaVersion=2', ok: remoteJson.schemaVersion === 2, detail: '实际 ' + preview(remoteJson.schemaVersion) })
  out.rows.push({ label: '清单 tag == ' + tag, ok: String(remoteJson.tag || '') === tag, detail: '实际 ' + preview(remoteJson.tag) })
  out.rows.push({ label: '清单 shellVersion == ' + version, ok: String(remoteJson.shellVersion || '') === version, detail: '实际 ' + preview(remoteJson.shellVersion) })
  const notesMissing = NOTES_SECTIONS.filter((s) => !Array.isArray(remoteJson.notes && remoteJson.notes[s.key])).map((s) => s.title)
  out.rows.push({ label: '清单 notes 六小节齐全', ok: !notesMissing.length, detail: notesMissing.length ? '缺 ' + notesMissing.join('、') : 'added/fixed/optimized/breaking/upgrade/rollback' })

  const zipField = remoteJson.zip && typeof remoteJson.zip === 'object' ? remoteJson.zip : null
  if (zipField) {
    const shapeOk = String(zipField.name || '') === ZIP_DISPLAY_NAME(version) && /^[0-9a-f]{64}$/.test(String(zipField.sha256 || '')) && Number.isInteger(zipField.bytes) && zipField.bytes > 0
    out.rows.push({ label: '清单 zip{name,sha256,bytes} 形状正确', ok: shapeOk, detail: shapeOk ? zipField.name + ' / ' + fmtBytes(zipField.bytes) + ' / ' + String(zipField.sha256).slice(0, 12) + '…' : JSON.stringify(zipField).slice(0, 200) })
  } else {
    out.rows.push({ label: '清单 zip{name,sha256,bytes} 形状正确', ok: false, detail: '清单里没有 zip 字段 → apply --full 用不了' })
  }

  try {
    const tagBytes = gitShow(tag, SHELL_MANIFEST)
    const same = sha256(tagBytes) === sha256(remote.buf)
    out.rows.push({
      label: 'Release 清单字节 == tag 字节',
      ok: same,
      detail: same ? sha256(tagBytes) : 'tag ' + sha256(tagBytes) + ' / 远端 ' + sha256(remote.buf),
    })
  } catch (e) {
    out.rows.push({ label: 'Release 清单字节 == tag 字节', ok: true, skip: true, detail: '本地没有 tag ' + tag + '（' + truncate((e && e.message) || e, 120) + '）' })
  }

  if (zipField) {
    const rel = await httpGet(GH + '/repos/' + repo + '/releases/latest', { 'User-Agent': 'hack3rx-shell-release/1.0' })
    const assets = rel.ok && rel.json && Array.isArray(rel.json.assets) ? rel.json.assets : null
    if (!assets) {
      out.rows.push({ label: 'Release 里有整包资产', ok: false, skip: true, detail: '列不出资产（HTTP ' + rel.status + '，可能限流）' })
    } else {
      const hit = assets.find((a) => a && a.name === zipField.name)
      out.rows.push({
        label: 'Release 里有整包资产 ' + zipField.name,
        ok: !!hit && Number(hit.size) === Number(zipField.bytes),
        detail: hit ? 'size ' + hit.size + '（清单 ' + zipField.bytes + '）' : '资产列表里没有它：' + assets.map((a) => a.name).join(', '),
      })
      const man = assets.find((a) => a && a.name === SHELL_MANIFEST)
      out.rows.push({ label: 'Release 里有 ' + SHELL_MANIFEST + ' 资产', ok: !!man, detail: man ? 'size ' + man.size : '没有' })
    }
  }

  if (!existsSync(cloneUpdate)) {
    out.rows.push({ label: 'clone 里有 tools/shell-update.mjs', ok: false, detail: cloneUpdate })
  } else {
    const chk = spawnSync(process.execPath, [cloneUpdate, 'check', '--manifest', manifestUrl, '--json'], {
      cwd: cloneDir, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024,
    })
    const parsed = lastJsonLine(chk.stdout)
    const okStatus = !!parsed && parsed.ok !== false && parsed.status === 'update-available'
    out.rows.push({
      label: 'check → update-available',
      ok: okStatus && chk.status === 0,
      detail: parsed
        ? 'status=' + parsed.status + ' remote=' + preview(parsed.remote) + ' local=' + preview(parsed.local) + '，退出码 ' + chk.status
        : '退出码 ' + chk.status + '，输出解析不了：' + truncate((chk.stdout || '') + (chk.stderr || ''), 300),
    })
    out.rows.push({
      label: 'check.remote == ' + version,
      ok: String((parsed && parsed.remote) || '').trim().replace(/^v/i, '') === version,
      detail: 'remote=' + preview(parsed && parsed.remote),
    })

    const stg = spawnSync(process.execPath, [cloneUpdate, 'stage', '--manifest', manifestUrl, '--stage', stageDir, '--json'], {
      cwd: cloneDir, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024,
    })
    const staged = existsSync(stageDir) ? hashPath(stageDir, '.') : new Map()
    const stagedNorm = new Map()
    for (const [k, v] of staged) stagedNorm.set(k.replace(/^\.\//, ''), v)
    const missing = []
    const mismatch = []
    for (const [rel, sha] of Object.entries(expected)) {
      const got = stagedNorm.get(rel)
      if (!got) missing.push(rel)
      else if (got !== sha) mismatch.push(rel)
    }
    const expectedKeys = new Set(Object.keys(expected).map((k) => k.toLowerCase()))
    const extra = [...stagedNorm.keys()].filter((k) => {
      const low = k.toLowerCase()
      return !expectedKeys.has(low) && low !== SHELL_MANIFEST.toLowerCase()
    })
    out.rows.push({
      label: 'stage → 临时目录',
      ok: stg.status === 0,
      detail: '退出码 ' + stg.status + (stg.status === 0 ? '，落盘 ' + stagedNorm.size + ' 个文件' : '：' + truncate((stg.stdout || '') + (stg.stderr || ''), 300)),
    })
    out.rows.push({
      label: 'staged 逐文件 sha 与清单一致',
      ok: !missing.length && !mismatch.length,
      detail: missing.length || mismatch.length
        ? '缺 ' + missing.length + ' 个（' + missing.slice(0, 3).join(', ') + '）；sha 不符 ' + mismatch.length + ' 个（' + mismatch.slice(0, 3).join(', ') + '）'
        : '全部 ' + Object.keys(expected).length + ' 项一致',
    })
    out.rows.push({
      label: 'staged 没有多余文件',
      ok: !extra.length,
      detail: extra.length ? extra.slice(0, 5).join(', ') : '',
    })
  }

  const after = hashUserData(cloneDir)
  out.rows.push({
    label: '用户数据零改动',
    ok: sameMap(before, after),
    detail: before.size === after.size ? before.size + ' 个文件哈希一致' : '文件数 ' + before.size + ' → ' + after.size,
  })

  printRows(out.rows)
  const failed = out.rows.filter((r) => !r.ok && !r.skip)
  out.ok = !failed.length
  blank()
  if (failed.length) log('结论：FAIL（' + failed.length + '/' + out.rows.length + ' 项不通过）—— 版本 ' + tag + ' 不能对外宣布可升级')
  else log('结论：PASS（' + out.rows.length + ' 项全部通过）—— ' + prev.tag + ' 能自动升到 ' + tag + '，用户数据零改动')

  if (!opts.keep) {
    try { rmSync(work, { recursive: true, force: true }) } catch { warn('临时目录清理失败（可手动删）：' + work) }
  } else {
    log('（--keep：临时目录保留在 ' + work + '）')
  }
  return finishJson(failed.length ? 1 : 0)
}

// ---- defaults ---------------------------------------------------------------
const buildDefaults = (repo) => ({
  name: 'shell-release',
  repo,
  owner: repo.split('/')[0],
  remote: 'https://github.com/' + repo,
  manifest: 'https://github.com/' + repo + '/releases/latest/download/' + SHELL_MANIFEST,
  base: 'https://github.com/' + repo + '/releases/download/v<shellVersion>',
  tag: TAG_TEMPLATE,
  releaseUrl: 'https://github.com/' + repo + '/releases/tag/v<shellVersion>',
  notesUrl: 'https://github.com/' + repo + '/releases/tag/v<shellVersion>',
  assets: [SHELL_MANIFEST, 'harness-shell-<shellVersion>.zip'],
  notesFile: NOTES_FILE,
  releasingFile: RELEASING_FILE,
  notesSections: NOTES_SECTIONS.map((s) => ({ key: s.key, title: s.title })),
  manifestFields: RELEASE_FIELDS,
  schemaVersion: 2,
  updaterMin: DEFAULT_UPDATER_MIN,
  requires: DEFAULT_REQUIRES,
  zipNameTemplate: 'harness-shell-<shellVersion>.zip',
  exitCodes: { 0: '成功', 1: '失败', 2: '用法或参数错误' },
  shellUpdateExitCodes: {
    0: '有可用更新（stage 成功也是 0）', 1: '失败/取不到清单', 2: '用法错误', 3: '校验不通过', 4: '已是最新（无需更新）',
  },
  verifyPublishedExitCodes: { 0: '通过或首个版本跳过', 1: '不通过' },
})

const defaults = (opts) => {
  const repo = resolveRepo(opts.repo)
  const data = buildDefaults(repo)
  if (opts.json) {
    process.stdout.write(JSON.stringify(data) + '\n')
    return 0
  }
  log('=== 壳发布默认值（shell-release defaults）===')
  log(pad('repo', 14) + ': ' + data.repo)
  log(pad('remote', 14) + ': ' + data.remote)
  log(pad('manifest', 14) + ': ' + data.manifest)
  log(pad('base', 14) + ': ' + data.base)
  log(pad('tag', 14) + ': ' + data.tag)
  log(pad('releaseUrl', 14) + ': ' + data.releaseUrl)
  log(pad('assets', 14) + ': ' + data.assets.join('、'))
  log(pad('schemaVersion', 14) + ': ' + data.schemaVersion + '（updaterMin ' + data.updaterMin + '）')
  log(pad('requires', 14) + ': dsh ' + data.requires.dsh + ' / node ' + data.requires.node)
  log(pad('notes 小节', 14) + ': ' + data.notesSections.map((s) => s.title).join(' / '))
  blank()
  log('退出码（shell-release）：')
  for (const [k, v] of Object.entries(data.exitCodes)) log('  ' + k + ' = ' + v)
  log('退出码（shell-update，供上游判读）：')
  for (const [k, v] of Object.entries(data.shellUpdateExitCodes)) log('  ' + k + ' = ' + v)
  return 0
}

// ---- CLI --------------------------------------------------------------------
const USAGE = [
  '用法：',
  '  node tools\\shell-release.mjs prepare --version 0.1.0 [--channel stable] [--dry-run] [--skip-gates]',
  '  node tools\\shell-release.mjs publish [--push] [--dry-run] [--token-env GH_TOKEN]',
  '  node tools\\shell-release.mjs verify-published [--version 0.1.0] [--json] [--dry-run]',
  '  node tools\\shell-release.mjs defaults [--json]',
  '',
  'prepare 可加：--updater-min <n> --min-shell-version <ver> --date <ISO>',
  '             --dsh-range <range> --node-range <range> --no-postcheck --root <dir> --assets-dir <dir>',
  'publish 可加：--version <ver> --repo <owner/name> --no-push --no-zip --sync-notes',
  '             --assets-dir <dir> --skip-asset-verify',
  'verify-published 可加：--prev-tag <tag> --keep --repo <owner/name>',
  '',
  '退出码：0 成功（verify-published 的"首个版本，跳过"也是 0）/ 1 失败 / 2 用法或参数错误',
  '',
  '细节：RELEASING.md；版本规则：doc/agent-develop-doc/10-release-and-versioning.md',
].join('\n')

const BOOL_FLAGS = new Set([
  '--dry-run', '--skip-gates', '--json', '--push', '--no-push', '--no-zip',
  '--no-postcheck', '--sync-notes', '--skip-asset-verify', '--keep', '--help',
])
const VALUE_FLAGS = new Set([
  '--version', '--channel', '--token-env', '--repo', '--updater-min', '--min-shell-version',
  '--date', '--dsh-range', '--node-range', '--assets-dir', '--prev-tag', '--root',
])

export const parseArgs = (argv) => {
  const out = { cmd: '', flags: new Set(), vals: {}, bad: '' }
  for (let i = 0; i < argv.length; i++) {
    let t = String(argv[i])
    if (t === '--help' || t === '-h' || t === '/?' || t === 'help') { out.flags.add('--help'); continue }
    if (t.startsWith('--')) {
      let val
      const eq = t.indexOf('=')
      if (eq > 0) { val = t.slice(eq + 1); t = t.slice(0, eq) }
      if (VALUE_FLAGS.has(t)) {
        if (val === undefined) {
          val = argv[++i]
          if (val === undefined) { out.bad = t + ' 缺少取值'; return out }
        }
        out.vals[t] = String(val)
        continue
      }
      if (BOOL_FLAGS.has(t)) {
        if (val !== undefined) { out.bad = t + ' 不接受取值'; return out }
        out.flags.add(t)
        continue
      }
      out.bad = '未知参数 ' + t
      return out
    }
    if (!out.cmd) { out.cmd = t; continue }
    out.bad = '多余参数 ' + t
    return out
  }
  return out
}

const main = async () => {
  const a = parseArgs(process.argv.slice(2))
  if (a.flags.has('--help')) { log(USAGE); return 0 }
  if (a.bad) { help('shell-release: ' + a.bad + '\n\n' + USAGE); return 2 }
  if (!a.cmd) { help(USAGE); return 2 }
  if (a.vals['--root']) setRoot(a.vals['--root'])
  const f = (n) => a.flags.has(n)
  const v = (n) => a.vals[n]
  const repo = v('--repo')
  switch (a.cmd) {
    case 'prepare':
      return prepare({
        version: v('--version'),
        channel: v('--channel'),
        dryRun: f('--dry-run'),
        skipGates: f('--skip-gates'),
        updaterMin: v('--updater-min'),
        minShellVersion: v('--min-shell-version'),
        date: v('--date'),
        dshRange: v('--dsh-range'),
        nodeRange: v('--node-range'),
        noPostcheck: f('--no-postcheck'),
        repo,
        assetsDir: v('--assets-dir'),
      })
    case 'publish':
      return await publish({
        push: !f('--no-push'),
        dryRun: f('--dry-run'),
        tokenEnv: v('--token-env'),
        version: v('--version'),
        repo,
        zip: !f('--no-zip'),
        syncNotes: f('--sync-notes'),
        assetsDir: v('--assets-dir'),
        verifyAssets: !f('--skip-asset-verify'),
      })
    case 'verify-published':
      return await verifyPublished({
        version: v('--version'),
        json: f('--json'),
        dryRun: f('--dry-run'),
        prevTag: v('--prev-tag'),
        keep: f('--keep'),
        repo,
      })
    case 'defaults':
      return defaults({ json: f('--json'), repo })
    default:
      help('shell-release: 未知子命令 ' + a.cmd + '\n\n' + USAGE)
      return 2
  }
}

const isMain = () => {
  try {
    return resolve(process.argv[1] || '').toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()
  } catch {
    return false
  }
}

if (isMain()) {
  main()
    .then((code) => { process.exitCode = typeof code === 'number' ? code : 0 })
    .catch((e) => {
      help('')
      help('shell-release 失败：' + ((e && e.message) || String(e)))
      if (e && e.detail) help('  ' + e.detail)
      else if (e && e.stack && !(e instanceof ReleaseError)) help(e.stack)
      process.exitCode = 1
    })
}
