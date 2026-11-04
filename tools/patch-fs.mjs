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
const ASAR = process.env.H3RX_PATCH_FS_ASAR || join(ROOT, 'desktop', 'resources', 'app.asar')
// H3RX_PATCH_FS_ASAR 只给自测/排障用（在副本上验证重写与回滚）；正常流程不要设它
const ASAR_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js'
const MARK = 'h3rx-fs-patch: link-fallback'
/** 版本只用于报告；判据永远是"能不能语义定位到补丁点" */
const VERIFIED_APP = ['0.2.1-rc.5']

/* 语义锚点：不依赖缩进、引号、变量名。两代真实形状都能命中——
 *  0.2.1-rc.5: if (createIfAbsent !== void 0) try { await linkFile(...) } catch (error) { await throwGuardedCreateFailure(...) }
 *  0.2.2-rc.1: if (options.createIfAbsent) try { await linkFile(...) } catch (error) { await throwGuardedCreateFailure(..., displayPath, ...) }
 * 为什么不用整段字面：官方改一次缩进/参数名/重构就失配（2026-11-04 实测：0.2.2-rc.1 换行后 asar 直接 anchor-mismatch）。
 */
const SITE_IF = /if\s*\(([^)]*createIfAbsent[^)]*)\)\s*try\s*\{/
const SITE_LINK = /await\s+link\w*\s*\([^)]*\)\s*;/
const SITE_CATCH = /\}\s*catch\s*\(\s*(\w+)\s*\)\s*\{/
const FALLBACK_CODES = ['ENOTSUP', 'ENOSYS', 'EPERM', 'EACCES', 'EISDIR', 'EXDEV']
const MARK_LINE = '/* ' + MARK + ' */'

/** 从 `{` 起配平找到对应的 `}`（跳过字符串/模板/注释；这两份源码里够用） */
const matchBrace = (text, openAt) => {
  let depth = 0
  let quote = null
  for (let i = openAt; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue }
    if (ch === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); if (end < 0) return -1; i = end + 1; continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

/** 定位"发布新文件用硬链接、失败要回退 rename"的那段 try/catch */
const findSite = (text) => {
  const head = SITE_IF.exec(text)
  if (!head) return null
  const afterHead = head.index + head[0].length
  const seg = text.slice(afterHead, afterHead + 600)
  const link = SITE_LINK.exec(seg)
  if (!link) return null
  const afterLink = afterHead + link.index + link[0].length
  const catchM = SITE_CATCH.exec(text.slice(afterLink, afterLink + 400))
  if (!catchM) return null
  const bodyStart = afterLink + catchM.index + catchM[0].length
  const bodyEnd = matchBrace(text, bodyStart - 1)
  if (bodyEnd < 0) return null
  const body = text.slice(bodyStart, bodyEnd)
  // 只处理"单语句"catch 体：这样 else 分支不必加花括号，还原也能按字符串精确剥离
  if (body.split(';').filter((s) => s.trim().length).length !== 1) return null
  return { bodyStart, bodyEnd, errVar: catchM[1] }
}

const indentAt = (text, at) => {
  const lineStart = text.lastIndexOf('\n', at) + 1
  const m = /^[ \t]*/.exec(text.slice(lineStart, at))
  return m ? m[0] : ''
}

/** 在 catch 体首插入分支：exFAT 上 link 的 EISDIR/EPERM… → rename。返回 null = 找不到可改的点 */
const siteApply = (text) => {
  const site = findSite(text)
  if (!site) return null
  // 缩进取 catch 体里第一条语句的缩进（体首通常是换行）
  let firstNonSpace = site.bodyStart
  while (firstNonSpace < text.length && /\s/.test(text[firstNonSpace])) firstNonSpace++
  const indent = indentAt(text, firstNonSpace)
  const cond = site.errVar + ' && typeof ' + site.errVar + " === 'object' && ("
    + FALLBACK_CODES.map((c) => site.errVar + ".code === '" + c + "'").join(' || ') + ')'
  const insert = '\n' + indent + MARK_LINE + '\n' + indent
    + 'if (' + cond + ') { await rename(tempPath, absolutePath); } else '
  return text.slice(0, site.bodyStart) + insert + text.slice(site.bodyStart)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 精确剥离 siteApply 插入的片段（不依赖备份） */
const siteRevert = (text) => {
  // v2：/* MARK */ + if (cond) { rename } else <原语句>
  const v2 = new RegExp('\\n[ \\t]*' + escapeRe(MARK_LINE) + '\\n[ \\t]*if \\([^\\n]*\\) \\{ await rename\\(tempPath, absolutePath\\); \\} else ')
  const once = text.replace(v2, '')
  if (once !== text) return once
  // v1 老补丁（三行：const code / if / else）也要能精确剥掉，否则 --revert 会卡在 revert-mismatch
  const v1 = new RegExp('\\n[ \\t]*' + escapeRe(MARK_LINE) + '\\n[ \\t]*const code = [^\\n]*\\n[ \\t]*if \\(code === [^\\n]*\\) await rename\\(tempPath, absolutePath\\);\\n[ \\t]*else ')
  return text.replace(v1, '')
}

const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet')
const say = (m) => { if (!quiet) console.log('  ' + m) }
const EXIT = { OK: 0, ANCHOR: 1, APPLIED: 2, LOCKED: 3, NOT_PATCHED: 4 }

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
/** asar 里那份 fs-local 的版本（和 app 目录里那份可能不是同一代；unpacked 条目也能读） */
const asarVersion = () => {
  try {
    const rel = 'dsh/node_modules/@deepseek-ai/dsh-fs-local/package.json'
    const unpacked = join(ROOT, 'desktop', 'resources', 'app.asar.unpacked', rel.split('/').join('\\'))
    if (existsSync(unpacked)) return JSON.parse(readFileSync(unpacked, 'utf8')).version || ''
    const buf = readFileSync(ASAR)
    const info = readAsarInfo(buf)
    const node = getNode(info.header, rel)
    if (!node || node.unpacked) return ''
    const start = info.dataStart + Number(node.offset)
    return JSON.parse(buf.subarray(start, start + Number(node.size)).toString('utf8')).version || ''
  } catch { return '' }
}
const syntaxOk = (file) => spawnSync(process.execPath, ['--check', file], { stdio: 'ignore', windowsHide: true }).status === 0

// ---------------------------------------------------------------- npm 副本
const appCheck = () => {
  if (!existsSync(TARGET)) return { state: 'missing' }
  const text = readFileSync(TARGET, 'utf8')
  const version = pkgVersion()
  if (text.includes(MARK)) return { state: 'applied', version }
  if (findSite(text)) return { state: 'not-patched', version }
  return { state: 'anchor-mismatch', version }
}
const appApply = () => {
  const version = pkgVersion()
  const cur = readFileSync(TARGET, 'utf8')
  if (cur.includes(MARK)) return { state: 'already', version }
  const next = siteApply(cur)
  if (!next) return { state: 'anchor-mismatch', version }
  const bak = TARGET + '.bak-h3rx-' + stamp()
  writeFileSync(bak, cur, 'utf8')
  writeFileSync(TARGET, next, 'utf8')
  if (!syntaxOk(TARGET)) {
    writeFileSync(TARGET, cur, 'utf8')
    try { unlinkSync(bak) } catch { }
    return { state: 'syntax-failed-restored', version }
  }
  pruneBackups(dirname(TARGET), 'index.js.bak-h3rx-')
  return { state: 'applied', backup: bak, version, unknownVersion: !VERIFIED_APP.includes(version) }
}
const appRevert = () => {
  if (!existsSync(TARGET)) return { state: 'missing' }
  const cur = readFileSync(TARGET, 'utf8')
  if (cur.includes(MARK)) {
    const restored = siteRevert(cur)
    if (restored === cur || restored.includes(MARK)) return { state: 'revert-mismatch' }
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
      return { state: 'applied', version: asarVersion() }
    }
    if (findSite(text)) return { state: 'not-patched', version: asarVersion() }
    return { state: 'anchor-mismatch', version: asarVersion() }
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
  const text = newBuf.subarray(info.dataStart + Number(node.offset), info.dataStart + Number(node.offset) + Number(node.size)).toString('utf8')
  if (expect === 'patched') {
    if (!text.includes(MARK) || !text.includes('rename(tempPath, absolutePath)')) throw new Error('目标条目补丁缺失')
  } else if (text.includes(MARK) || !findSite(text)) {
    throw new Error('目标条目还原不完整（mark=' + text.includes(MARK) + ' site=' + Boolean(findSite(text)) + '）')
  }
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
  } else {
    const patchedText = siteApply(text)
    if (!patchedText) return { state: 'anchor-mismatch', version: asarVersion() }
    next = Buffer.from(patchedText, 'utf8')
  }
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
  const restored = siteRevert(text)
  if (restored === text || restored.includes(MARK)) return { state: 'revert-mismatch' }
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
if (argv.includes('--selftest')) {
  // 纯文本回归：不碰任何文件。锚点必须同时认 0.2.1 与 0.2.2 两代真实形状，且能精确还原。
  const cases = [
    {
      name: 'fs-local 0.2.1（tab 缩进，createIfAbsent !== void 0）',
      text: ['\t\tif (createIfAbsent !== void 0) try {',
        '\t\t\tawait linkFile(tempPath, absolutePath);',
        '\t\t} catch (error) {',
        '\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);',
        '\t\t}'].join('\n'),
    },
    {
      name: 'fs-local 0.2.2（2 空格，options.createIfAbsent，displayPath）',
      text: ['    if (options.createIfAbsent) try {',
        '        await linkFile(tempPath, absolutePath);',
        '    } catch (error) {',
        '        await throwGuardedCreateFailure(error, absolutePath, displayPath, inspectPublicationTarget);',
        '    }'].join('\n'),
    },
  ]
  let bad = 0
  for (const c of cases) {
    const patched = siteApply(c.text)
    const back = patched ? siteRevert(patched) : null
    const ok = Boolean(patched) && patched.includes(MARK) && back === c.text
    console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + c.name)
    if (!ok) bad++
  }
  console.log(bad ? '  patch-fs 自测失败：' + bad : '  patch-fs 自测通过：' + cases.length)
  process.exit(bad ? 1 : 0)
}
if (mode === 'check') {
  const a = onlyAsar ? { state: 'skipped' } : appCheck()
  const s = onlyApp ? { state: 'skipped' } : asarCheck()
  if (!quiet) {
    console.log('  app  : ' + a.state + '  (' + TARGET.replace(ROOT + '\\', '') + ', fs-local ' + (a.version || '?') + ')')
    console.log('  asar : ' + s.state + '  (desktop/resources/app.asar, fs-local ' + (s.version || '?') + ')')
  }
  const bad = [a.state, s.state].some((x) => x === 'anchor-mismatch')
  if (bad) process.exit(EXIT.ANCHOR)
  const needsWork = new Set(['not-patched', 'stale-integrity', 'missing', 'entry-missing', 'header-invalid', 'unreadable'])
  const missing = [a.state, s.state].some((x) => needsWork.has(x))
  process.exit(missing ? EXIT.NOT_PATCHED : EXIT.OK)
}
if (mode === 'revert') {
  let failed = false
  if (!onlyAsar) { const r = appRevert(); say('app  : ' + r.state + ' (fs-local ' + (pkgVersion() || '?') + ')'); if (!['reverted', 'not-patched', 'missing'].includes(r.state)) failed = true }
  if (!onlyApp) { const r = asarRevert(); say('asar : ' + r.state + (r.message ? ' ' + r.message : '')); if (!['reverted', 'not-patched', 'missing'].includes(r.state)) failed = true }
  process.exit(failed ? EXIT.ANCHOR : EXIT.OK)
}
let applied = 0
let hardFail = false
let locked = false
if (!onlyAsar) {
  const r = appApply()
  say('app  : ' + r.state + (r.backup ? ' (' + r.backup.split('\\').pop() + ')' : '') + (r.unknownVersion ? ' [版本不在白名单，按锚点处理]' : '') + (r.message ? ' ' + r.message : ''))
  if (r.state === 'applied') applied++
  if (r.state === 'anchor-mismatch' || r.state === 'syntax-failed-restored') hardFail = true
}
if (!onlyApp) {
  const r = asarApply()
  say('asar : ' + r.state + (r.backup ? ' (' + r.backup.split('\\').pop() + ')' : '') + (r.message ? ' ' + r.message : ''))
  if (r.state === 'applied') applied++
  if (r.state === 'locked') locked = true
  if (r.state === 'anchor-mismatch' || r.state === 'swap-failed-restored' || r.state === 'verify-failed-restored' || r.state === 'unreadable') hardFail = true
}
if (hardFail) process.exit(EXIT.ANCHOR)
// asar 被运行中的桌面占着：不是错误，下次启动会补上
if (locked) process.exit(EXIT.LOCKED)
process.exit(applied > 0 ? EXIT.APPLIED : EXIT.OK)