#!/usr/bin/env node
// 给 DSH 打"硬链接不可用 -> rename"的补丁（只在 compat 档需要）。
//
// 背景：dsh-fs-local 发布新文件时用 link() 做"不覆盖创建"（createIfAbsent）。
// exFAT 没有硬链接，CreateHardLinkW 失败（本机实测 EISDIR，pnpm 也报 ERR_PNPM_EISDIR），
// 于是"新建文件"整条路径挂掉。这里把它降级成 rename（同目录原子替换）。
//
// 两个落点都要打，否则只修一半：
//   1) app\node_modules\@deepseek-ai\dsh-fs-local\lib\index.js      —— Web / CLI 用
//   2) desktop\resources\app.asar 里的同名条目                      —— 桌面窗口用（Electron 从 asar 里加载）
//
// asar 的改法是"安全重建"：改完先逐条校验（除目标外每个条目的 sha256 必须与原件一致），
// 通过后才把原 asar 改名成备份、把新文件换上去；任何一步失败都自动还原。
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync, openSync, readSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PKG_DIR = join(ROOT, 'app', 'node_modules', '@deepseek-ai', 'dsh-fs-local')
const TARGET = join(PKG_DIR, 'lib', 'index.js')
const ASAR = join(ROOT, 'desktop', 'resources', 'app.asar')
const ASAR_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js'
const MARK = 'h3rx-fs-patch: link-fallback'
const SUPPORTED = ['0.2.1-rc.5']

const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet')
const say = (m) => { if (!quiet) console.log('  ' + m) }
const EXIT = { OK: 0, ANCHOR: 1, APPLIED: 2, NOT_PATCHED: 4 }

const ANCHOR = `\t\tif (createIfAbsent !== void 0) try {
\t\t\tawait linkFile(tempPath, absolutePath);
\t\t} catch (error) {
\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
\t\t}`

const PATCHED = `\t\tif (createIfAbsent !== void 0) try {
\t\t\tawait linkFile(tempPath, absolutePath);
\t\t} catch (error) {
\t\t\t/* ${MARK} */
\t\t\tconst code = error && typeof error === 'object' ? error.code : void 0;
\t\t\tif (code === 'ENOTSUP' || code === 'ENOSYS' || code === 'EPERM' || code === 'EACCES' || code === 'EISDIR' || code === 'EXDEV') await rename(tempPath, absolutePath);
\t\t\telse await throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
\t\t}`

// 只留最近一份备份：asar 备份有 174 MB，堆多了会把 U 盘吃满
const pruneBackups = (dir, prefix) => {
  try {
    const list = readdirSync(dir).filter((f) => f.startsWith(prefix)).sort()
    for (const f of list.slice(0, -1)) { try { unlinkSync(join(dir, f)) } catch { } }
  } catch { }
}
const stamp = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
const pkgVersion = () => {
  try { return JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version || '' } catch { return '' }
}
const syntaxOk = (file) => spawnSync(process.execPath, ['--check', file], { stdio: 'ignore', windowsHide: true }).status === 0

// ---------------------------------------------------------------- npm 副本
const appCheck = () => {
  if (!existsSync(TARGET)) return { state: 'missing' }
  const text = readFileSync(TARGET, 'utf8')
  if (text.includes(MARK)) return { state: 'applied' }
  if (text.includes(ANCHOR)) return { state: 'not-patched' }
  return { state: 'anchor-mismatch' }
}
const appApply = (text) => {
  const v = pkgVersion()
  const cur = readFileSync(TARGET, 'utf8')
  // 版本白名单只做提示：真正的判据是锚点是否还在（官方升级后锚点失配才需要人工复核）
  const unknownVersion = !SUPPORTED.includes(v)
  if (cur.includes(MARK)) return { state: 'already' }
  if (!cur.includes(ANCHOR)) return { state: 'anchor-mismatch', version: v }
  const bak = TARGET + '.bak-h3rx-' + stamp()
  writeFileSync(bak, cur, 'utf8')
  writeFileSync(TARGET, text(cur), 'utf8')
  if (!syntaxOk(TARGET)) {
    writeFileSync(TARGET, cur, 'utf8')
    try { unlinkSync(bak) } catch { }
    return { state: 'syntax-failed-restored' }
  }
  pruneBackups(dirname(TARGET), 'index.js.bak-h3rx-')
  return { state: 'applied', backup: bak, unknownVersion }
}
const appRevert = () => {
  if (!existsSync(TARGET)) return { state: 'missing' }
  const cur = readFileSync(TARGET, 'utf8')
  if (cur.includes(MARK)) {
    const restored = cur.replace(PATCHED, ANCHOR)
    if (!restored.includes(ANCHOR)) return { state: 'revert-mismatch' }
    writeFileSync(TARGET, restored, 'utf8')
    if (!syntaxOk(TARGET)) { writeFileSync(TARGET, cur, 'utf8'); return { state: 'revert-syntax-failed' } }
    return { state: 'reverted' }
  }
  const dir = dirname(TARGET)
  const list = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('index.js.bak-h3rx-')).sort() : []
  if (!list.length) return { state: 'not-patched' }
  const bak = join(dir, list[list.length - 1])
  writeFileSync(TARGET, readFileSync(bak, 'utf8'), 'utf8')
  return { state: syntaxOk(TARGET) ? 'reverted' : 'revert-syntax-failed', backup: list[list.length - 1] }
}
// ---------------------------------------------------------------- asar
const readAsarInfo = (buf) => {
  if (buf.length < 16) throw new Error('asar 太短')
  const u0 = buf.readUInt32LE(0)
  const jsonLen = buf.readUInt32LE(12)
  if (u0 !== 4 || jsonLen <= 0 || 16 + jsonLen > buf.length) throw new Error('asar 头部不合法')
  const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'))
  const pad = (4 - (jsonLen % 4)) % 4
  return { header, jsonLen, dataStart: 16 + jsonLen + pad }
}
const getNode = (header, path) => {
  let n = header
  for (const part of path.split('/')) { n = n && n.files ? n.files[part] : null; if (!n) return null }
  return n
}
const packedEntries = (header) => {
  const out = []
  const walk = (node, prefix) => {
    for (const key of Object.keys(node.files || {})) {
      const value = node.files[key]
      const path = prefix ? prefix + '/' + key : key
      if (value.files) walk(value, path)
      else if (!value.unpacked && !value.link) out.push({ path, entry: value })
    }
  }
  walk(header, '')
  return out
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
// asar 的 integrity 约定：hash = 整个文件的 SHA256；blocks = 按 blockSize 切片逐块 SHA256
// （单块时两者相等，与本机现网 asar 的样本一致）。改了内容就必须一起重算，否则元数据自相矛盾。
const integrityOf = (buf, blockSize) => {
  const size = blockSize > 0 ? blockSize : 4194304
  const blocks = []
  for (let i = 0; i < buf.length; i += size) blocks.push(sha(buf.subarray(i, i + size)))
  return { algorithm: 'SHA256', hash: sha(buf), blockSize: size, blocks }
}
// 换装过程中崩溃会留下临时件：ASAR 缺失时先尝试恢复，避免"桌面打不开"。
const recoverAsar = () => {
  if (existsSync(ASAR)) return
  let list = []
  try { list = readdirSync(dirname(ASAR)) } catch { return }
  const cand = list.find((f) => f.startsWith('app.asar.revert-old-h3rx-')) || list.find((f) => f.startsWith('app.asar.new-h3rx-'))
  if (cand) { try { renameSync(join(dirname(ASAR), cand), ASAR) } catch { } }
}
const asarCheck = () => {
  recoverAsar()
  if (!existsSync(ASAR)) return { state: 'missing' }
  let fd
  try {
    fd = openSync(ASAR, 'r')
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const jsonLen = head.readUInt32LE(12)
    if (head.readUInt32LE(0) !== 4 || jsonLen <= 0) return { state: 'header-invalid' }
    const hb = Buffer.alloc(jsonLen)
    readSync(fd, hb, 0, jsonLen, 16)
    const header = JSON.parse(hb.toString('utf8'))
    const node = getNode(header, ASAR_ENTRY)
    if (!node) return { state: 'entry-missing' }
    const dataStart = 16 + jsonLen + ((4 - (jsonLen % 4)) % 4)
    const size = Number(node.size)
    const content = Buffer.alloc(size)
    readSync(fd, content, 0, size, dataStart + Number(node.offset))
    const text = content.toString('utf8')
    if (text.includes(MARK)) {
      if (node.integrity) {
        const want = integrityOf(content, Number(node.integrity.blockSize) || 4194304)
        if (JSON.stringify(want) !== JSON.stringify(node.integrity)) return { state: 'stale-integrity' }
      }
      return { state: 'applied' }
    }
    if (text.includes(ANCHOR)) return { state: 'not-patched' }
    return { state: 'anchor-mismatch' }
  } catch (error) {
    return { state: 'unreadable', message: String(error.message || error) }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { }
  }
}
const buildAsar = (buf, info, newContent) => {
  const header = JSON.parse(JSON.stringify(info.header))
  const target = getNode(header, ASAR_ENTRY)
  const targetOldOffset = Number(target.offset)
  const targetOldSize = Number(target.size)
  const delta = newContent.length - targetOldSize
  const entries = packedEntries(header)
  const oldOffsets = new Map(entries.map(({ entry }) => [entry, Number(entry.offset)]))
  for (const { entry } of entries) {
    if (entry === target) continue
    const off = Number(entry.offset)
    if (off > targetOldOffset) entry.offset = String(off + delta)
  }
  target.size = newContent.length
  if (target.integrity) target.integrity = integrityOf(newContent, Number(target.integrity.blockSize) || 4194304)
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const pad = (4 - (json.length % 4)) % 4
  const dataStart = 16 + json.length + pad
  const ordered = entries.slice().sort((a, b) => oldOffsets.get(a.entry) - oldOffsets.get(b.entry))
  const total = dataStart + ordered.reduce((s, { entry }) => s + (entry === target ? newContent.length : Number(entry.size)), 0)
  const out = Buffer.alloc(total)
  out.writeUInt32LE(4, 0)
  out.writeUInt32LE(json.length + pad + 8, 4)
  out.writeUInt32LE(json.length + pad + 4, 8)
  out.writeUInt32LE(json.length, 12)
  json.copy(out, 16)
  let pos = dataStart
  for (const { entry } of ordered) {
    if (entry === target) { newContent.copy(out, pos); pos += newContent.length; continue }
    const src = info.dataStart + oldOffsets.get(entry)
    const size = Number(entry.size)
    buf.copy(out, pos, src, src + size)
    pos += size
  }
  return out
}
const verifyAsar = (oldBuf, oldInfo, newBuf, newContent, expect = 'patched') => {
  const info = readAsarInfo(newBuf)
  const oldList = packedEntries(oldInfo.header).slice().sort((a, b) => a.path.localeCompare(b.path))
  const newList = packedEntries(info.header).slice().sort((a, b) => a.path.localeCompare(b.path))
  if (oldList.length !== newList.length) throw new Error('条目数不一致')
  for (let i = 0; i < oldList.length; i++) {
    const a = oldList[i]; const b = newList[i]
    if (a.path !== b.path) throw new Error('条目顺序/名称不一致：' + a.path)
    if (a.path === ASAR_ENTRY) continue
    const ao = oldInfo.dataStart + Number(a.entry.offset); const an = info.dataStart + Number(b.entry.offset)
    const as = Number(a.entry.size); const bs = Number(b.entry.size)
    if (as !== bs) throw new Error('条目大小变了：' + a.path)
    if (sha(oldBuf.subarray(ao, ao + as)) !== sha(newBuf.subarray(an, an + bs))) throw new Error('条目内容变了：' + a.path)
  }
  const node = getNode(info.header, ASAR_ENTRY)
  const text = newBuf.subarray(info.dataStart + Number(node.offset), info.dataStart + Number(node.offset) + Number(node.size))
  if (expect === 'patched') {
    if (!text.includes(MARK) || !text.includes('rename(tempPath, absolutePath)')) throw new Error('目标条目补丁缺失')
  } else if (text.includes(MARK) || !text.includes(ANCHOR)) throw new Error('目标条目还原不完整')
  if (Number(node.size) !== newContent.length) throw new Error('目标条目大小不符')
  if (node.integrity) {
    const want = integrityOf(newContent, Number(node.integrity.blockSize) || 4194304)
    if (JSON.stringify(want) !== JSON.stringify(node.integrity)) throw new Error('目标条目 integrity 重算不符')
  }
  for (let i = 0; i < oldList.length; i++) {
    if (oldList[i].path === ASAR_ENTRY) continue
    if (JSON.stringify(oldList[i].entry.integrity) !== JSON.stringify(newList[i].entry.integrity)) throw new Error('条目 integrity 被改动：' + oldList[i].path)
  }
  return true
}
const asarApply = () => {
  const pre = asarCheck()
  if (pre.state === 'applied') return { state: 'already' }
  if (pre.state === 'missing') return { state: 'missing' }
  recoverAsar()
  if (!existsSync(ASAR)) return { state: 'missing' }
  const buf = readFileSync(ASAR)
  const info = readAsarInfo(buf)
  const node = getNode(info.header, ASAR_ENTRY)
  if (!node) return { state: 'entry-missing' }
  const start = info.dataStart + Number(node.offset)
  const text = buf.subarray(start, start + Number(node.size)).toString('utf8')
  let next
  if (text.includes(MARK)) {
    const content = Buffer.from(text, 'utf8')
    const want = node.integrity ? integrityOf(content, Number(node.integrity.blockSize) || 4194304) : null
    if (!node.integrity || JSON.stringify(want) === JSON.stringify(node.integrity)) return { state: 'already' }
    next = content // 内容已经打过，只补 integrity 元数据
  } else if (text.includes(ANCHOR)) {
    next = Buffer.from(text.replace(ANCHOR, PATCHED), 'utf8')
  } else return { state: 'anchor-mismatch' }
  const out = buildAsar(buf, info, next)
  verifyAsar(buf, info, out, next, 'patched')
  const stampStr = stamp()
  const bak = ASAR + '.bak-h3rx-' + stampStr
  const tmp = ASAR + '.new-h3rx-' + stampStr
  writeFileSync(tmp, out)
  try {
    renameSync(ASAR, bak)
  } catch (error) {
    try { unlinkSync(tmp) } catch { }
    return { state: 'locked', message: '桌面程序可能正在运行（' + (error.code || '') + '）；先退出再试' }
  }
  try {
    renameSync(tmp, ASAR)
  } catch (error) {
    try { renameSync(bak, ASAR) } catch { }
    try { unlinkSync(tmp) } catch { }
    return { state: 'swap-failed-restored', message: String(error.code || error.message) }
  }
  // 换完再读一遍确认
  try {
    const check = asarCheck()
    if (check.state !== 'applied') throw new Error('换装后校验失败')
  } catch (error) {
    try { unlinkSync(ASAR); renameSync(bak, ASAR) } catch { }
    return { state: 'verify-failed-restored', message: String(error.message) }
  }
  // 逆向还原已能精确去掉补丁，174 MB 的 asar 备份不再需要，成功后直接删掉
  try { unlinkSync(bak) } catch { }
  for (const f of readdirSync(dirname(ASAR))) {
    if (f.startsWith('app.asar.new-h3rx-') || f.startsWith('app.asar.revert-old-h3rx-') || f.startsWith('app.asar.bak-h3rx-')) { try { unlinkSync(join(dirname(ASAR), f)) } catch { } }
  }
  return { state: 'applied', backup: null }
}
const asarRevert = () => {
  recoverAsar()
  if (!existsSync(ASAR)) return { state: 'missing' }
  const buf = readFileSync(ASAR)
  const info = readAsarInfo(buf)
  const node = getNode(info.header, ASAR_ENTRY)
  if (!node) return { state: 'entry-missing' }
  const start = info.dataStart + Number(node.offset)
  const text = buf.subarray(start, start + Number(node.size)).toString('utf8')
  if (!text.includes(MARK)) return { state: 'not-patched' }
  let restored = text.replace(PATCHED, ANCHOR)
  if (!restored.includes(ANCHOR) || restored.includes(MARK)) {
    // 旧补丁字节可能与当前 PATCHED 不完全一致：按标记块整体剥离（不依赖备份）
    restored = text.replace(/\r?\n\t\t\t\/\* h3rx-fs-patch: link-fallback \*\/\r?\n\t\t\tconst code = [^\n]*\r?\n\t\t\tif \(code === [^\n]*\r?\n/, '\n')
  }
  if (!restored.includes(ANCHOR) || restored.includes(MARK)) return { state: 'revert-mismatch' }
  const next = Buffer.from(restored, 'utf8')
  const out = buildAsar(buf, info, next)
  verifyAsar(buf, info, out, next, 'restored')
  const tmp = ASAR + '.revert-h3rx-' + stamp()
  writeFileSync(tmp, out)
  try {
    renameSync(ASAR, ASAR + '.revert-old-h3rx-' + stamp())
  } catch (error) {
    try { unlinkSync(tmp) } catch { }
    return { state: 'locked', message: '桌面程序可能正在运行（' + (error.code || '') + '）；先退出再试' }
  }
  try {
    renameSync(tmp, ASAR)
  } catch (error) {
    try { renameSync(readdirSync(dirname(ASAR)).find((f) => f.startsWith('app.asar.revert-old-h3rx-')) ? join(dirname(ASAR), readdirSync(dirname(ASAR)).find((f) => f.startsWith('app.asar.revert-old-h3rx-'))) : ASAR, ASAR) } catch { }
    try { unlinkSync(tmp) } catch { }
    return { state: 'swap-failed', message: String(error.code || error.message) }
  }
  // 清掉换下来的旧文件
  for (const f of readdirSync(dirname(ASAR))) {
    if (f.startsWith('app.asar.revert-old-h3rx-')) { try { unlinkSync(join(dirname(ASAR), f)) } catch { } }
  }
  const check = asarCheck()
  return { state: check.state === 'not-patched' ? 'reverted' : 'verify-failed' }
}
// ---------------------------------------------------------------- CLI
const onlyApp = argv.includes('--app-only')
const onlyAsar = argv.includes('--asar-only')
const mode = argv.includes('--revert') ? 'revert' : argv.includes('--apply') ? 'apply' : 'check'

if (argv.includes('--help') || argv.includes('-h')) {
  console.log('用法: node tools/patch-fs.mjs [--check|--apply|--revert] [--app-only|--asar-only] [--quiet]')
  console.log('  --check   0=全部已打/不适用 / 4=有未打 / 1=锚点或环境不匹配')
  console.log('  --apply   打补丁（npm 副本 + desktop/app.asar；各自先备份，校验失败自动还原）')
  console.log('  --revert  用最近备份还原两处')
  process.exit(0)
}
if (mode === 'check') {
  const a = onlyAsar ? { state: 'skipped' } : appCheck()
  const s = onlyApp ? { state: 'skipped' } : asarCheck()
  if (!quiet) {
    console.log('  app  : ' + a.state + '  (' + TARGET.replace(ROOT + '\\', '') + ')')
    console.log('  asar : ' + s.state + '  (desktop/resources/app.asar)')
  }
  const bad = [a.state, s.state].some((x) => x === 'anchor-mismatch' || x === 'unsupported-version')
  if (bad) process.exit(EXIT.ANCHOR)
  const needsWork = new Set(['not-patched', 'stale-integrity', 'missing', 'entry-missing', 'header-invalid', 'unreadable'])
  const missing = [a.state, s.state].some((x) => needsWork.has(x))
  process.exit(missing ? EXIT.NOT_PATCHED : EXIT.OK)
}
if (mode === 'revert') {
  let failed = false
  if (!onlyAsar) { const r = appRevert(); say('app  : ' + r.state); if (!['reverted', 'not-patched', 'missing'].includes(r.state)) failed = true }
  if (!onlyApp) { const r = asarRevert(); say('asar : ' + r.state + (r.message ? ' ' + r.message : '')); if (!['reverted', 'not-patched', 'missing'].includes(r.state)) failed = true }
  process.exit(failed ? EXIT.ANCHOR : EXIT.OK)
}
let applied = 0
let hardFail = false
if (!onlyAsar) {
  const r = appApply((text) => text.replace(ANCHOR, PATCHED))
  say('app  : ' + r.state + (r.backup ? ' (' + r.backup.split('\\').pop() + ')' : '') + (r.unknownVersion ? ' [版本不在白名单，按锚点处理]' : '') + (r.message ? ' ' + r.message : ''))
  if (r.state === 'applied') applied++
  if (r.state === 'anchor-mismatch' || r.state === 'unsupported-version' || r.state === 'syntax-failed-restored') hardFail = true
}
if (!onlyApp) {
  const r = asarApply()
  say('asar : ' + r.state + (r.backup ? ' (' + r.backup.split('\\').pop() + ')' : '') + (r.message ? ' ' + r.message : ''))
  if (r.state === 'applied') applied++
  if (r.state === 'anchor-mismatch' || r.state === 'locked' || r.state === 'swap-failed-restored' || r.state === 'verify-failed-restored' || r.state === 'unreadable') hardFail = true
}
if (hardFail) process.exit(EXIT.ANCHOR)
process.exit(applied > 0 ? EXIT.APPLIED : EXIT.OK)