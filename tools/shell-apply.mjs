/**
 * 便携壳换装引擎：备份 → 原子替换/删除 → 自检 → 迁移；任何一步失败整体回滚，断电可恢复。
 *
 * 这是**库**不是 CLI：由 tools\shell-update.mjs 的 apply / rollback / recover 子命令调用。
 * 本文件刻意不认识"哪些路径算壳"（白名单由调用方用 isAllowed 注入），也不碰网络
 * （要装的文件由调用方先下到 stage 并逐个对过 sha256）。
 *
 * 契约（opts 里全是绝对路径）：
 *   listBackups(backupRoot) -> [{ dir, name, startedAt, from, to, phase }]   // 新 → 旧
 *   applyUpdate({ root, stage, backupRoot, journalPath,
 *                 manifest: { raw: Buffer, files: { rel: sha256 }, userOwned: [], remove?: [] },
 *                 installed: { present, shellVersion, files: { rel: sha256 } },
 *                 isAllowed: (rel) => bool,
 *                 verify: { cmd: string[] | null, enabled: bool },
 *                 migrations: [{ id, script, args }], dryRun, logger })
 *   rollbackUpdate(opts)  用最新一份备份整体还原
 *   recoverUpdate(opts)   有残留 journal 就按里面的备份还原，没有就是 noop
 *
 * 六条铁律：
 *   1) 动盘之前先把整份计划的 staging 全部校验完（逐个 sha256 对上），不过就一个字节都不写。
 *   2) 每个路径先过"规范化 + isAllowed"两道闸：.. / 盘符 / 绝对路径 / NUL 一律拒。
 *   3) userOwned 且被用户改过的文件永不覆盖，只记 preserved。
 *   4) 只删"上一版清单里自己装过"的文件；用户手放进 tools\ 的东西永远不删。
 *   5) 每份备份都带 meta.json：进程被杀也能光凭磁盘上的 meta 精确还原。
 *   6) 不吞异常：所有失败都是 ok:false + errors[]，并且尽量把已经写进去的文件还原回去。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** 残留 journal（相对 root）。apply 动手前写、成功后清；断电后 recoverUpdate 靠它找备份。 */
export const APPLY_JOURNAL = 'tmp/shell-update-journal.json'
/** 备份目录名前缀：<backupRoot>\shell-backup-<yyyyMMdd-HHmmss>[-n] */
export const BACKUP_PREFIX = 'shell-backup-'

const BACKUP_META = 'meta.json'
const BACKUP_FILES = 'files'
const META_VERSION = 1
const JOURNAL_VERSION = 1
/** verify / 迁移的输出最多留这么多字节（只为从里面挑出 FAIL 行，不改变"边跑边打"） */
const CAPTURE_LIMIT = 200 * 1024
const SHA_RE = /^[0-9a-f]{64}$/

// ---- 小工具 -----------------------------------------------------------------
const noop = () => {}
const toPosix = (p) => String(p).replace(/\\/g, '/')
const pad2 = (n) => String(n).padStart(2, '0')
const nowIso = () => new Date().toISOString()
const errText = (e) => String((e && (e.message || e.code)) || e)
const sortPaths = (list) => list.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const sha256File = (abs) => sha256(readFileSync(abs))

/** yyyyMMdd-HHmmss（本地时间；备份目录名靠它排序，所以必须是定宽） */
const stampOf = (d) => String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate())
  + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())

/**
 * 清单里的相对路径 → 规范正斜杠相对路径；返回 null 表示不可用。
 * 拒绝：.. / . / 空段 / 盘符 / 绝对路径 / UNC / 含 NUL。
 */
export const normalizeRel = (rel) => {
  if (typeof rel !== 'string') return null
  const raw = rel.trim()
  if (!raw) return null
  if (raw.indexOf('\0') !== -1) return null
  if (isAbsolute(raw)) return null
  const p = toPosix(raw).replace(/\/{2,}/g, '/')
  if (!p || p.charAt(0) === '/' || /^[A-Za-z]:/.test(p)) return null
  for (const seg of p.split('/')) if (!seg || seg === '.' || seg === '..') return null
  return p
}

const absOf = (base, rel) => join(base, ...rel.split('/'))

/** 目标是否真的落在 base 里面（isAllowed 万一写错，这是最后一道闸） */
const isInside = (base, absPath) => {
  const b = resolve(base).replace(/[\\/]+$/, '').toLowerCase()
  const a = resolve(absPath).toLowerCase()
  return a === b || a.startsWith(b + '\\') || a.startsWith(b + '/')
}

const relToRoot = (root, abs) => {
  try {
    const r = relative(root, abs)
    if (!r || r.startsWith('..') || isAbsolute(r)) return ''
    return toPosix(r)
  } catch { return '' }
}

const readJsonFile = (abs) => {
  try { return JSON.parse(readFileSync(abs, 'utf8')) } catch { return null }
}

// ---- 落盘：一律 .new + rename，绝不在原路径上就地写 ---------------------------------
const writeFileAtomic = (abs, buf) => {
  mkdirSync(dirname(abs), { recursive: true })
  const tmp = abs + '.new'
  try {
    writeFileSync(tmp, buf)
    const got = sha256File(tmp)
    const want = sha256(buf)
    if (got !== want) throw new Error('落盘后 sha256 与期望不一致：' + abs)
    renameSync(tmp, abs) // Windows 上等价 MoveFileEx(REPLACE_EXISTING)：覆盖是原子的
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch {}
    throw e
  }
}

const writeJsonAtomic = (abs, obj) => {
  writeFileAtomic(abs, Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8'))
}

// ---- 结果对象 ---------------------------------------------------------------
const newResult = (action) => ({
  ok: true,
  action,
  from: '',
  to: '',
  backup: '',
  journal: '',
  applied: [],
  deleted: [],
  preserved: [],
  skipped: [],
  verify: { ok: true, code: 0, failed: [], ran: false },
  migrations: [],
  rolledBack: false,
  errors: [],
  // 以下为附加字段（契约之外的补充信息，调用方可以忽略）
  warnings: [],
  dryRun: false,
  noop: false,
  journalCleared: false,
})

// ---- 备份清单 ---------------------------------------------------------------
/**
 * 列出 backupRoot 下的全部备份，新 → 旧。
 * 只认 shell-backup-* 目录；meta.json 坏了也照样列出来（from/to 为空），不抛异常。
 */
export const listBackups = (backupRoot) => {
  if (!backupRoot) return []
  const base = String(backupRoot)
  let ents = []
  try { ents = readdirSync(base, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const d of ents) {
    if (!d.isDirectory() || !d.name.startsWith(BACKUP_PREFIX)) continue
    const dir = join(base, d.name)
    const meta = readJsonFile(join(dir, BACKUP_META))
    out.push({
      dir,
      name: d.name,
      startedAt: String((meta && meta.startedAt) || ''),
      from: String((meta && meta.from) || ''),
      to: String((meta && meta.to) || ''),
      phase: String((meta && meta.phase) || ''),
    })
  }
  out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  return out
}

const readMeta = (backupDir) => {
  const j = readJsonFile(join(backupDir, BACKUP_META))
  return j && typeof j === 'object' ? j : null
}

// ---- opts 归一 --------------------------------------------------------------
/** 所有动作共用的最小上下文；参数不合法一律抛错（由各入口转成 ok:false） */
const baseContext = (input) => {
  const o = input && typeof input === 'object' ? input : {}
  if (!o.root || typeof o.root !== 'string') throw new Error('缺少 root（必须是仓库根绝对路径）')
  const root = resolve(o.root)
  let st = null
  try { st = statSync(root) } catch {}
  if (!st) throw new Error('root 不存在：' + root)
  if (!st.isDirectory()) throw new Error('root 不是目录：' + root)
  const backupRoot = o.backupRoot ? resolve(String(o.backupRoot)) : join(root, 'cache')
  const journalPath = o.journalPath ? resolve(String(o.journalPath)) : join(root, APPLY_JOURNAL)
  const logger = typeof o.logger === 'function' ? o.logger : noop
  const installedRaw = o.installed && typeof o.installed === 'object' ? o.installed : {}
  const files = new Map() // 小写 → { rel, sha }
  const warnings = []
  const src = installedRaw.files && typeof installedRaw.files === 'object' ? installedRaw.files : {}
  for (const rawRel of Object.keys(src)) {
    const rel = normalizeRel(rawRel)
    if (!rel) { warnings.push('上一版清单里有非法路径，已忽略：' + String(rawRel)); continue }
    const sha = typeof src[rawRel] === 'string' ? src[rawRel].trim().toLowerCase() : ''
    if (!SHA_RE.test(sha)) { warnings.push('上一版清单里 ' + rel + ' 的 sha256 不合法，已忽略'); continue }
    files.set(rel.toLowerCase(), { rel, sha })
  }
  const v = o.verify && typeof o.verify === 'object' ? o.verify : {}
  const cmd = Array.isArray(v.cmd) && v.cmd.length ? v.cmd.map(String) : null
  return {
    root,
    backupRoot,
    journalPath,
    logger,
    warnings,
    installed: {
      present: !!installedRaw.present,
      shellVersion: String(installedRaw.shellVersion || ''),
      files,
    },
    verify: { cmd, enabled: !!cmd && v.enabled !== false },
  }
}

/** 从 manifest.raw 里取目标版本号（取不到就算了，不因此失败） */
const versionOfManifest = (m) => {
  if (m && typeof m.shellVersion === 'string' && m.shellVersion.trim()) return m.shellVersion.trim()
  try {
    const j = JSON.parse(Buffer.isBuffer(m && m.raw) ? m.raw.toString('utf8') : String((m && m.raw) || ''))
    return j && typeof j.shellVersion === 'string' ? j.shellVersion.trim() : ''
  } catch { return '' }
}

/**
 * 清单校验：路径过闸 + sha256 形状 + 大小写重名。
 * 有任何一条不合用就整体拒绝（不写、不删、不建目录）。
 */
const validateManifest = (manifest, isAllowed) => {
  const errors = []
  const files = {}
  if (!manifest || typeof manifest !== 'object') return { errors: ['缺少 manifest'], files, userOwned: [], remove: [] }
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    return { errors: ['manifest.files 不是对象'], files, userOwned: [], remove: [] }
  }
  const seen = new Map()
  for (const rawRel of Object.keys(manifest.files)) {
    const rel = normalizeRel(rawRel)
    if (!rel) { errors.push('清单路径非法（.. / 盘符 / 绝对路径 / NUL 一律拒）：' + JSON.stringify(String(rawRel))); continue }
    if (!isAllowed(rel)) { errors.push('清单路径被 isAllowed（白名单）拒绝：' + rel); continue }
    const low = rel.toLowerCase()
    if (seen.has(low)) { errors.push('清单路径大小写重名：' + seen.get(low) + ' / ' + rel); continue }
    seen.set(low, rel)
    const raw = manifest.files[rawRel]
    const sha = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (!SHA_RE.test(sha)) { errors.push('清单里 ' + rel + ' 的 sha256 不是 64 位 hex'); continue }
    files[rel] = sha
  }
  if (!Object.keys(files).length && !errors.length) errors.push('清单 files 为空：拒绝把壳换成空目录')
  const clean = (list, label) => {
    const out = []
    for (const rawRel of Array.isArray(list) ? list : []) {
      const rel = normalizeRel(rawRel)
      if (!rel) { errors.push(label + ' 里有非法路径：' + JSON.stringify(String(rawRel))); continue }
      out.push(rel)
    }
    return out
  }
  return { errors, files, userOwned: clean(manifest.userOwned, 'manifest.userOwned'), remove: clean(manifest.remove, 'manifest.remove') }
}

// ---- 计划 -------------------------------------------------------------------
/**
 * 语义 1 + 2：
 *   manifest 里每个路径 → add / skip / preserved / update
 *   installed 里有、manifest 里没有、白名单过、且不是 userOwned → delete
 */
const buildPlan = (ctx) => {
  const { root, manifest, installed, isAllowed, isUserOwned } = ctx
  const writes = []
  const skipped = []
  const preserved = []
  const errors = []
  for (const rel of sortPaths(Object.keys(manifest.files))) {
    const remoteSha = manifest.files[rel]
    const abs = absOf(root, rel)
    if (!isInside(root, abs)) { errors.push('目标路径逃出 root：' + rel); continue }
    let localSha = null
    let isDir = false
    try {
      const st = statSync(abs)
      if (st.isDirectory()) isDir = true
      else if (st.isFile()) localSha = sha256File(abs)
    } catch {}
    if (isDir) { errors.push('目标路径是个目录，拒绝覆盖：' + rel); continue }
    if (localSha === null) { writes.push({ path: rel, action: 'add', remoteSha, localSha: null }); continue }
    if (localSha === remoteSha) { skipped.push(rel); continue }
    // userOwned：只要"现在"和"装的时候"不一致，就认为用户改过 → 保留，绝不覆盖
    const base = installed.files.get(rel.toLowerCase())
    const baseSha = base ? base.sha : null
    if (isUserOwned(rel) && localSha !== baseSha) { preserved.push(rel); continue }
    writes.push({ path: rel, action: 'update', remoteSha, localSha })
  }

  const manifestLower = new Set(Object.keys(manifest.files).map((p) => p.toLowerCase()))
  const deletes = []
  const deleteSkipped = []
  const considerDelete = (rel) => {
    const low = rel.toLowerCase()
    if (manifestLower.has(low)) return
    if (deletes.indexOf(rel) !== -1) return
    if (!isAllowed(rel)) { deleteSkipped.push(rel + '（不在白名单）'); return }
    if (isUserOwned(rel)) { deleteSkipped.push(rel + '（userOwned，属于用户数据）'); return }
    const abs = absOf(root, rel)
    if (!isInside(root, abs)) return
    if (!existsSync(abs)) return
    deletes.push(rel)
  }
  for (const [, ent] of installed.files) considerDelete(ent.rel)
  for (const rel of manifest.remove) considerDelete(rel)

  return {
    writes,
    skipped: sortPaths(skipped),
    preserved: sortPaths(preserved),
    deletes: sortPaths(deletes),
    deleteSkipped,
    errors,
  }
}

/** 语义 3：计划里每个待写文件都必须在 stage 里存在且 sha256 与清单一致 */
const validateStage = (stage, writes) => {
  const errors = []
  let st = null
  try { st = statSync(stage) } catch {}
  if (!st) return { ok: false, errors: ['staging 目录不存在：' + stage] }
  if (!st.isDirectory()) return { ok: false, errors: ['staging 不是目录：' + stage] }
  for (const w of writes) {
    const abs = absOf(stage, w.path)
    if (!isInside(stage, abs)) { errors.push('staging 路径逃出 stage 目录：' + w.path); continue }
    let isFile = false
    try { isFile = statSync(abs).isFile() } catch {}
    if (!isFile) { errors.push('staging 里缺这个文件：' + w.path + '（' + abs + '）'); continue }
    let got = ''
    try { got = sha256File(abs) } catch (e) { errors.push('staging 文件读不出：' + w.path + '（' + errText(e) + '）'); continue }
    if (got !== w.remoteSha) {
      errors.push('staging 内容与清单 sha256 不一致：' + w.path + '（stage ' + got.slice(0, 12) + '… / 清单 ' + w.remoteSha.slice(0, 12) + '…）')
    }
  }
  return { ok: errors.length === 0, errors }
}

// ---- 备份 -------------------------------------------------------------------
/** 语义 4：<backupRoot>\shell-backup-<stamp>\{meta.json, files\<rel>}，动手前先把要动的文件原样抄进去 */
const backupOne = (root, filesDir, rel) => {
  const abs = absOf(root, rel)
  const dst = absOf(filesDir, rel)
  const want = sha256File(abs) // 先取 sha 再抄，缩小 TOCTOU 窗口
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(abs, dst)
  const got = sha256File(dst)
  if (got !== want) throw new Error('备份校验失败：' + rel + '（原 ' + want + ' / 备份 ' + got + '）')
  return { existed: true, sha256: want, bytes: statSync(dst).size }
}

const createBackup = (ctx, plan) => {
  mkdirSync(ctx.backupRoot, { recursive: true })
  const stamp = stampOf(new Date())
  let name = BACKUP_PREFIX + stamp
  let n = 1
  while (existsSync(join(ctx.backupRoot, name))) { n += 1; name = BACKUP_PREFIX + stamp + '-' + n }
  const dir = join(ctx.backupRoot, name)
  const filesDir = join(dir, BACKUP_FILES)
  mkdirSync(filesDir, { recursive: true })

  const files = {}
  for (const w of plan.writes) {
    files[w.path] = w.localSha === null ? { existed: false, sha256: null } : backupOne(ctx.root, filesDir, w.path)
  }
  for (const rel of plan.deletes) files[rel] = backupOne(ctx.root, filesDir, rel)

  const meta = {
    schemaVersion: META_VERSION,
    tool: 'shell-apply',
    action: 'apply',
    from: ctx.from,
    to: ctx.to,
    root: ctx.root,
    startedAt: ctx.startedAt,
    finishedAt: null,
    phase: 'writing',
    backupRoot: ctx.backupRoot,
    backupName: name,
    manifestSha256: sha256(ctx.manifest.raw && ctx.manifest.raw.length ? ctx.manifest.raw : Buffer.alloc(0)),
    installed: { present: ctx.installed.present, shellVersion: ctx.installed.shellVersion },
    planned: {
      add: plan.writes.filter((w) => w.action === 'add').map((w) => w.path),
      update: plan.writes.filter((w) => w.action === 'update').map((w) => w.path),
      delete: plan.deletes,
      preserved: plan.preserved,
      skipped: plan.skipped,
    },
    applied: [],
    deleted: [],
    preserved: plan.preserved,
    skipped: plan.skipped,
    verify: { ok: null, code: null, failed: [] },
    migrations: [],
    files,
  }
  return { dir, name, meta, metaPath: join(dir, BACKUP_META) }
}

/** 写 meta 失败不该改写换装结论，但要让它出现在 warnings 里 */
const safeWriteMeta = (backup, patch) => {
  Object.assign(backup.meta, patch || {})
  try { writeJsonAtomic(backup.metaPath, backup.meta); return '' } catch (e) { return errText(e) }
}

// ---- 还原（rollback / recover / 失败回滚 共用一条路） ---------------------------
/**
 * 按 meta.files 把文件状态整体还原到 apply 之前：
 *   existed:true  → 从 files\<rel> 抄回去（先验 sha256）
 *   existed:false → 本次新增的，删掉
 * 顺带清掉可能残留的 <abs>.new。
 * 不看 isAllowed：备份是我们自己写的账本，只要路径规范化过、且落在 root 里就还原
 * （否则"新版本把某路径移出白名单"会导致旧文件永远回不去）。
 */
const restoreBackup = (ctx, backupDir, meta) => {
  const errors = []
  const restored = []
  const removed = []
  if (!backupDir || !existsSync(backupDir)) {
    return { ok: false, errors: ['备份目录不存在，无法还原：' + String(backupDir)], restored, removed }
  }
  const entries = meta && meta.files && typeof meta.files === 'object' && !Array.isArray(meta.files) ? meta.files : null
  if (!entries) return { ok: false, errors: ['备份缺少 meta.files，无法还原：' + backupDir], restored, removed }
  const filesDir = join(backupDir, BACKUP_FILES)
  for (const rel of sortPaths(Object.keys(entries))) {
    const info = entries[rel] && typeof entries[rel] === 'object' ? entries[rel] : {}
    const safeRel = normalizeRel(rel)
    if (!safeRel) { errors.push('备份里有非法路径，已跳过：' + JSON.stringify(String(rel))); continue }
    const abs = absOf(ctx.root, safeRel)
    if (!isInside(ctx.root, abs)) { errors.push('备份路径逃出 root，已跳过：' + safeRel); continue }
    if (info.existed) {
      const bakAbs = absOf(filesDir, safeRel)
      if (!existsSync(bakAbs)) { errors.push('备份里缺这个文件，还原不了：' + safeRel); continue }
      let buf = null
      try { buf = readFileSync(bakAbs) } catch (e) { errors.push('备份文件读不出：' + safeRel + '（' + errText(e) + '）'); continue }
      if (info.sha256 && sha256(buf) !== String(info.sha256).toLowerCase()) {
        errors.push('备份文件已损坏（sha256 不符）：' + safeRel)
        continue
      }
      try { writeFileAtomic(abs, buf); restored.push(safeRel) } catch (e) { errors.push('还原失败：' + safeRel + '（' + errText(e) + '）') }
    } else if (existsSync(abs)) {
      try { rmSync(abs, { force: true }); removed.push(safeRel) } catch (e) { errors.push('删除本次新增的文件失败：' + safeRel + '（' + errText(e) + '）') }
    }
    try { rmSync(abs + '.new', { force: true }) } catch {}
  }
  return { ok: errors.length === 0, errors, restored, removed }
}

// ---- 跑子进程（verify / 迁移） -----------------------------------------------
/**
 * 边跑边把子进程输出原样打到自己的 stdout/stderr（等于 stdio 继承），
 * 同时留一份用来从里面挑 FAIL 行 → result.verify.failed。
 */
const runCommand = (cmd, cwd) => new Promise((done) => {
  let child = null
  try {
    child = spawn(String(cmd[0]), cmd.slice(1).map(String), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (e) {
    done({ ok: false, code: -1, error: e, output: '' })
    return
  }
  let output = ''
  let settled = false
  const finish = (v) => { if (!settled) { settled = true; done(v) } }
  const tee = (stream) => (chunk) => {
    output += chunk.toString('utf8')
    if (output.length > CAPTURE_LIMIT) output = output.slice(-CAPTURE_LIMIT)
    try { stream.write(chunk) } catch {}
  }
  child.stdout.on('data', tee(process.stdout))
  child.stderr.on('data', tee(process.stderr))
  child.on('error', (e) => finish({ ok: false, code: -1, error: e, output }))
  child.on('close', (code, signal) => finish({
    ok: code === 0 && !signal,
    code: code === null || code === undefined ? -1 : code,
    signal: signal || null,
    output,
  }))
})

const ANSI_RE = /\x1b\[[0-9;]*m/g
const FAIL_LINE_RE = /(^|[\s\[\]（(])(FAIL|FAILED|ERROR|✗|✘)/i

const extractFailures = (output, code) => {
  const out = []
  for (const raw of String(output || '').replace(ANSI_RE, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || !FAIL_LINE_RE.test(line)) continue
    out.push(line.length > 200 ? line.slice(0, 200) + '…' : line)
    if (out.length >= 20) break
  }
  if (!out.length && code !== 0) out.push('退出码 ' + code)
  return out
}

/** 语义 8：迁移脚本必须是 tools\ 下的 .mjs、且在本次清单里；失败只记 message，不整体回滚 */
const runMigrations = async (ctx) => {
  const out = []
  const manifestLower = new Set(Object.keys(ctx.manifest.files).map((p) => p.toLowerCase()))
  for (const m of ctx.migrations) {
    const id = String((m && m.id) || '(未命名迁移)')
    const script = normalizeRel(m && m.script)
    const args = Array.isArray(m && m.args) ? m.args.map(String) : []
    if (!script) { out.push({ id, ok: false, message: '迁移脚本路径非法：' + JSON.stringify(String(m && m.script)) }); continue }
    if (!script.startsWith('tools/') || !script.endsWith('.mjs')) {
      out.push({ id, ok: false, message: '迁移脚本必须是 tools/ 下的 .mjs（不执行）：' + script })
      continue
    }
    if (!manifestLower.has(script.toLowerCase())) {
      out.push({ id, ok: false, message: '迁移脚本不在本次清单里（不执行，防止跑到陈旧/来路不明的脚本）：' + script })
      continue
    }
    const abs = absOf(ctx.root, script)
    if (!isInside(ctx.root, abs) || !existsSync(abs)) {
      out.push({ id, ok: false, message: '迁移脚本不存在（未落盘）：' + abs })
      continue
    }
    ctx.logger('  迁移 ' + id + '：' + script + (args.length ? ' ' + args.join(' ') : ''))
    const r = await runCommand([process.execPath, abs, ...args], ctx.root)
    if (r.ok) out.push({ id, ok: true, message: '完成（退出码 0）' })
    else out.push({ id, ok: false, message: '失败：' + (r.error ? '无法启动（' + errText(r.error) + '）' : '退出码 ' + r.code) })
  }
  return out
}

// ---- journal（语义 5） ------------------------------------------------------
const journalPlan = (plan) => ({
  add: plan.writes.filter((w) => w.action === 'add').map((w) => w.path),
  update: plan.writes.filter((w) => w.action === 'update').map((w) => w.path),
  delete: plan.deletes,
  preserved: plan.preserved,
  skipped: plan.skipped,
})

const clearJournal = (journalPath) => {
  try { rmSync(journalPath, { force: true }); return true } catch { return false }
}

const resolveJournalBackup = (journal, ctx) => {
  const cands = []
  if (journal && typeof journal.backup === 'string' && journal.backup) cands.push(resolve(journal.backup))
  if (journal && typeof journal.backupRel === 'string' && journal.backupRel) cands.push(resolve(ctx.root, journal.backupRel))
  if (journal && typeof journal.backupName === 'string' && journal.backupName) {
    if (journal.backupRoot) cands.push(join(resolve(String(journal.backupRoot)), journal.backupName))
    cands.push(join(ctx.backupRoot, journal.backupName))
    cands.push(join(ctx.root, 'cache', journal.backupName)) // 整个壳目录被搬过家时的兜底
  }
  for (const c of cands) {
    try { if (statSync(c).isDirectory()) return c } catch {}
  }
  return ''
}

// ---- apply -----------------------------------------------------------------
const applyContext = (input, result) => {
  const base = baseContext(input)
  const o = input && typeof input === 'object' ? input : {}
  const isAllowed = typeof o.isAllowed === 'function' ? o.isAllowed : () => false
  const mv = validateManifest(o.manifest, isAllowed)
  if (mv.errors.length) {
    result.ok = false
    result.errors.push(...mv.errors)
    return null
  }
  const userOwnedSet = new Set(mv.userOwned.map((p) => p.toLowerCase()))
  const ctx = Object.assign(base, {
    stage: o.stage ? resolve(String(o.stage)) : join(base.root, 'tmp', 'stage'),
    dryRun: !!o.dryRun,
    isAllowed,
    isUserOwned: (rel) => userOwnedSet.has(String(rel).toLowerCase()),
    manifest: {
      raw: Buffer.isBuffer(o.manifest.raw) ? o.manifest.raw : Buffer.alloc(0),
      files: mv.files,
      userOwned: mv.userOwned,
      remove: mv.remove,
    },
    migrations: Array.isArray(o.migrations) ? o.migrations.filter((m) => m && typeof m === 'object') : [],
    startedAt: nowIso(),
    from: base.installed.shellVersion,
    to: versionOfManifest(o.manifest),
  })
  result.warnings.push(...base.warnings)
  result.from = ctx.from
  result.to = ctx.to
  return ctx
}

/**
 * 换装。返回契约里的 result 对象；任何失败都是 ok:false + errors[]。
 * dryRun 时 applied / deleted 里放的是**计划**，不是既成事实。
 */
export const applyUpdate = async (opts) => {
  const result = newResult('apply')
  let ctx = null
  try { ctx = applyContext(opts, result) } catch (e) {
    result.ok = false
    result.errors.push('参数不合法：' + errText(e))
    return result
  }
  if (!ctx) return result
  const { root, stage, journalPath, logger } = ctx
  let backup = null

  try {
    // 1) 计划
    const plan = buildPlan(ctx)
    result.warnings.push(...plan.deleteSkipped.map((s) => '不删 ' + s))
    if (plan.errors.length) {
      result.ok = false
      result.errors.push(...plan.errors)
      return result
    }
    result.preserved = plan.preserved
    result.skipped = plan.skipped
    if (ctx.dryRun) {
      result.dryRun = true
      result.applied = plan.writes.map((w) => ({ path: w.path, action: w.action }))
      result.deleted = plan.deletes.slice()
    }
    logger('壳换装计划：写入 ' + plan.writes.length + ' 个（新增 '
      + plan.writes.filter((w) => w.action === 'add').length + ' / 更新 '
      + plan.writes.filter((w) => w.action === 'update').length + '），删除 ' + plan.deletes.length
      + ' 个，保留用户改动 ' + plan.preserved.length + ' 个，跳过 ' + plan.skipped.length + ' 个')
    for (const w of plan.writes) logger('  ' + (w.action === 'add' ? '+ ' : '~ ') + w.path)
    for (const d of plan.deletes) logger('  - ' + d)
    for (const p of plan.preserved) logger('  = ' + p + '（userOwned 且被改过，保留用户版本）')

    if (!plan.writes.length && !plan.deletes.length) {
      result.noop = true
      logger('没有要换的文件（壳已经是最新）')
      return result
    }
    if (ctx.dryRun) {
      logger('dryRun：只算计划，不写盘、不建目录、不跑 verify 与迁移')
      return result
    }

    // 2) staging 全量校验（有任何一条不过 → 一个字节都不写）
    const stageCheck = validateStage(stage, plan.writes)
    if (!stageCheck.ok) {
      result.ok = false
      result.errors.push(...stageCheck.errors)
      result.warnings.push('staging 校验没过，未写任何文件（壳保持原样）')
      return result
    }

    // 3) 备份 → meta → journal（此时还没动壳里的任何文件）
    backup = createBackup(ctx, plan)
    result.backup = backup.dir
    const metaErr = safeWriteMeta(backup, {})
    if (metaErr) result.warnings.push('写备份 meta 失败（不影响换装，但断电恢复会缺账本）：' + metaErr)
    logger('备份：' + backup.dir)

    const journal = {
      version: JOURNAL_VERSION,
      state: 'applying',
      action: 'apply',
      from: ctx.from,
      to: ctx.to,
      root,
      startedAt: ctx.startedAt,
      updatedAt: nowIso(),
      phase: 'writing',
      backup: backup.dir,
      backupRel: relToRoot(root, backup.dir),
      backupRoot: ctx.backupRoot,
      backupName: backup.name,
      manifestSha256: sha256(ctx.manifest.raw),
      plan: journalPlan(plan),
      applied: [],
      deleted: [],
      verify: { ok: null, code: null },
    }
    writeJsonAtomic(journalPath, journal)
    result.journal = journalPath

    // 4) 原子替换 + 删除
    const applied = []
    const deleted = []
    result.applied = applied
    result.deleted = deleted
    for (const w of plan.writes) {
      const buf = readFileSync(absOf(stage, w.path))
      if (sha256(buf) !== w.remoteSha) throw new Error('staging 文件在换装途中变了（拒绝落盘）：' + w.path)
      writeFileAtomic(absOf(root, w.path), buf)
      applied.push({ path: w.path, action: w.action })
      logger('  ' + (w.action === 'add' ? '+ ' : '~ ') + w.path + '  已落盘')
    }
    for (const rel of plan.deletes) {
      const abs = absOf(root, rel)
      if (!isInside(root, abs)) throw new Error('删除路径逃出 root：' + rel)
      rmSync(abs, { force: true })
      deleted.push(rel)
      logger('  - ' + rel + '  已删除')
    }

    // 5) 自检（语义 7）：不通过就整体回滚
    if (ctx.verify.enabled) {
      journal.phase = 'verifying'
      journal.applied = applied.slice()
      journal.deleted = deleted.slice()
      journal.updatedAt = nowIso()
      try { writeJsonAtomic(journalPath, journal) } catch (e) { result.warnings.push('更新 journal 失败：' + errText(e)) }
      logger('换装完成，跑自检：' + ctx.verify.cmd.join(' '))
      const v = await runCommand(ctx.verify.cmd, root)
      result.verify = { ok: v.ok, code: v.code, failed: extractFailures(v.output, v.code), ran: true }
      if (!v.ok) {
        result.ok = false
        result.errors.push(v.error
          ? '无法启动自检（' + errText(v.error) + '），已按备份回滚'
          : '自检不通过（退出码 ' + v.code + '），已按备份回滚到 ' + (ctx.from || '换装前'))
        logger('  自检不通过，开始回滚')
        const rb = restoreBackup(ctx, backup.dir, backup.meta)
        result.rolledBack = true
        result.errors.push(...rb.errors)
        if (rb.ok) result.journalCleared = clearJournal(journalPath)
        const me = safeWriteMeta(backup, { phase: 'rolled-back', finishedAt: nowIso(), rolledBack: true, verify: result.verify, applied, deleted })
        if (me) result.warnings.push('写备份 meta 失败：' + me)
        logger(rb.ok ? '  已回滚到换装前的壳（备份 ' + backup.dir + '）' : '  回滚没有全部成功，详见 errors')
        return result
      }
      logger('  自检通过')
    }

    // 6) 迁移（语义 8）：失败只记 message，不整体回滚
    if (ctx.migrations.length) {
      journal.phase = 'migrating'
      journal.updatedAt = nowIso()
      try { writeJsonAtomic(journalPath, journal) } catch (e) { result.warnings.push('更新 journal 失败：' + errText(e)) }
      result.migrations = await runMigrations(ctx)
      for (const m of result.migrations) if (!m.ok) logger('  迁移未成功 ' + m.id + '：' + m.message)
    }

    // 7) 收尾：清 journal、把账本写全
    result.journalCleared = clearJournal(journalPath)
    const me = safeWriteMeta(backup, {
      phase: 'done',
      finishedAt: nowIso(),
      applied,
      deleted,
      verify: result.verify,
      migrations: result.migrations,
    })
    if (me) result.warnings.push('写备份 meta 失败：' + me)
    result.ok = true
    logger('换装完成：' + (applied.length) + ' 个文件已写入，' + deleted.length + ' 个已删除')
    return result
  } catch (e) {
    result.ok = false
    result.errors.push('换装过程中出错：' + errText(e))
    logger('  出错，开始按备份回滚')
    if (backup) {
      const rb = restoreBackup(ctx, backup.dir, backup.meta)
      result.rolledBack = true
      result.errors.push(...rb.errors)
      if (rb.ok) result.journalCleared = clearJournal(journalPath)
      const me = safeWriteMeta(backup, { phase: 'rolled-back', finishedAt: nowIso(), rolledBack: true, verify: result.verify })
      if (me) result.warnings.push('写备份 meta 失败：' + me)
      logger(rb.ok ? '  已回滚到换装前的壳（备份 ' + backup.dir + '）' : '  回滚没有全部成功，详见 errors')
    } else {
      result.warnings.push('失败发生在备份之前，壳里没有任何文件被改动')
    }
    return result
  }
}

// ---- rollback（语义 9） -----------------------------------------------------
/** 用最新一份备份整体还原；journal 指向同一份备份时顺手清掉 */
export const rollbackUpdate = async (opts) => {
  const result = newResult('rollback')
  let ctx = null
  try { ctx = baseContext(opts) } catch (e) {
    result.ok = false
    result.errors.push('参数不合法：' + errText(e))
    return result
  }
  result.from = ctx.installed.shellVersion
  result.warnings.push(...ctx.warnings)
  try {
    const backups = listBackups(ctx.backupRoot)
    if (!backups.length) {
      result.ok = false
      result.errors.push('没有可用的备份：' + ctx.backupRoot)
      return result
    }
    const latest = backups[0]
    const meta = readMeta(latest.dir)
    if (!meta) {
      result.ok = false
      result.backup = latest.dir
      result.errors.push('备份缺少 meta.json，无法还原：' + latest.dir)
      return result
    }
    result.backup = latest.dir
    result.from = String(meta.to || result.from)
    result.to = String(meta.from || '')
    ctx.logger('按备份还原 ' + latest.name + '（' + (meta.to || '?') + ' -> ' + (meta.from || '?') + '）')
    const rb = restoreBackup(ctx, latest.dir, meta)
    result.errors.push(...rb.errors)
    result.rolledBack = rb.restored.length + rb.removed.length > 0
    result.ok = rb.ok
    for (const rel of rb.restored) ctx.logger('  <- ' + rel)
    for (const rel of rb.removed) ctx.logger('  x  ' + rel)
    if (rb.ok) {
      const journal = existsSync(ctx.journalPath) ? readJsonFile(ctx.journalPath) : null
      const journalBackup = journal ? resolveJournalBackup(journal, ctx) : ''
      if (journal && (!journalBackup || journalBackup.toLowerCase() === latest.dir.toLowerCase())) {
        result.journal = ctx.journalPath
        result.journalCleared = clearJournal(ctx.journalPath)
      }
      const me = safeWriteMeta({ meta, metaPath: join(latest.dir, BACKUP_META), dir: latest.dir }, {
        phase: 'rolled-back', rolledBackAt: nowIso(), rolledBack: true,
      })
      if (me) result.warnings.push('写备份 meta 失败：' + me)
    }
    if (ctx.verify.enabled) {
      ctx.logger('还原后自检：' + ctx.verify.cmd.join(' '))
      const v = await runCommand(ctx.verify.cmd, ctx.root)
      result.verify = { ok: v.ok, code: v.code, failed: extractFailures(v.output, v.code), ran: true }
      if (!v.ok) {
        result.ok = false
        result.errors.push(v.error ? '无法启动还原后的自检（' + errText(v.error) + '）' : '还原后的壳自检不通过（退出码 ' + v.code + '）')
      }
    }
    return result
  } catch (e) {
    result.ok = false
    result.errors.push('回滚出错：' + errText(e))
    return result
  }
}

// ---- recover（语义 10） -----------------------------------------------------
/** 有残留 journal → 按其中的备份还原（= 一次回滚）并清 journal；没有 → noop */
export const recoverUpdate = async (opts) => {
  const result = newResult('recover')
  let ctx = null
  try { ctx = baseContext(opts) } catch (e) {
    result.ok = false
    result.errors.push('参数不合法：' + errText(e))
    return result
  }
  result.from = ctx.installed.shellVersion
  result.warnings.push(...ctx.warnings)
  try {
    if (!existsSync(ctx.journalPath)) {
      result.noop = true
      ctx.logger('没有残留 journal：上次换装是干净的，不需要恢复')
      return result
    }
    result.journal = ctx.journalPath
    const journal = readJsonFile(ctx.journalPath)
    if (!journal || typeof journal !== 'object') {
      result.ok = false
      result.errors.push('journal 不是合法 JSON，无法判断备份位置（未改动任何文件）：' + ctx.journalPath)
      result.warnings.push('可以手工确认后用 rollback 按最新备份还原')
      return result
    }
    const backupDir = resolveJournalBackup(journal, ctx)
    if (!backupDir) {
      result.ok = false
      result.errors.push('journal 里记的备份目录都找不到（备份可能被删了）：' + ctx.journalPath)
      return result
    }
    const meta = readMeta(backupDir)
    if (!meta) {
      result.ok = false
      result.backup = backupDir
      result.errors.push('备份缺少 meta.json，无法还原：' + backupDir)
      return result
    }
    result.backup = backupDir
    result.from = String(meta.to || result.from)
    result.to = String(meta.from || '')
    ctx.logger('发现残留 journal（phase=' + String(journal.phase || '?') + '），按备份 ' + backupDir + ' 还原')
    const rb = restoreBackup(ctx, backupDir, meta)
    result.errors.push(...rb.errors)
    result.ok = rb.ok
    result.rolledBack = rb.ok
    for (const rel of rb.restored) ctx.logger('  <- ' + rel)
    for (const rel of rb.removed) ctx.logger('  x  ' + rel)
    if (rb.ok) {
      result.journalCleared = clearJournal(ctx.journalPath)
      const me = safeWriteMeta({ meta, metaPath: join(backupDir, BACKUP_META), dir: backupDir }, {
        phase: 'recovered', recoveredAt: nowIso(), rolledBack: true,
      })
      if (me) result.warnings.push('写备份 meta 失败：' + me)
      ctx.logger('已恢复到换装前的壳')
    } else {
      ctx.logger('恢复没有全部成功，journal 保留（下次还能再试）')
    }
    return result
  } catch (e) {
    result.ok = false
    result.errors.push('恢复出错：' + errText(e))
    return result
  }
}
