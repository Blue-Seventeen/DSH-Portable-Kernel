/**
 * asar 单条目改写（给补丁工具复用）。
 *
 * 为什么需要：`app.asar` 是 Electron 的归档，改里面一个文件要重算所有条目偏移 + integrity，
 * 还要保证"除目标条目外一个字节都不变"。`tools\patch-fs.mjs` 里有一套验证过的实现，
 * 这里抽出通用版本给别的补丁（如 attachment-local）共用，避免各写一套后漂移。
 *
 * 只做两件事：
 *   readEntry(asarPath, entry)  → { text, buf, info, node }
 *   writeEntry(asarPath, entry, newText) → 原子换装（备份 → 校验 → 换 → 复核 → 清理）
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

export const readAsarInfo = (buf) => {
  if (buf.length < 16) throw new Error('asar 太短')
  const u0 = buf.readUInt32LE(0)
  const jsonLen = buf.readUInt32LE(12)
  if (u0 !== 4 || jsonLen <= 0 || 16 + jsonLen > buf.length) throw new Error('asar 头部不合法')
  const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'))
  const pad = (4 - (jsonLen % 4)) % 4
  return { header, jsonLen, dataStart: 16 + jsonLen + pad }
}

export const getNode = (header, path) => {
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

const integrityOf = (buf, blockSize) => {
  const size = blockSize > 0 ? blockSize : 4194304
  const blocks = []
  for (let i = 0; i < buf.length; i += size) blocks.push(sha(buf.subarray(i, i + size)))
  return { algorithm: 'SHA256', hash: sha(buf), blockSize: size, blocks }
}

const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

/** 读 asar 里某个条目的文本；条目不存在时 node 为 null */
export const readEntry = (asarPath, entry) => {
  if (!existsSync(asarPath)) return { state: 'missing' }
  const buf = readFileSync(asarPath)
  const info = readAsarInfo(buf)
  const node = getNode(info.header, entry)
  if (!node) return { state: 'entry-missing', buf, info }
  const start = info.dataStart + Number(node.offset)
  return { state: 'ok', buf, info, node, text: buf.subarray(start, start + Number(node.size)).toString('utf8') }
}

const buildAsar = (buf, info, entry, newContent) => {
  const header = JSON.parse(JSON.stringify(info.header))
  const target = getNode(header, entry)
  const targetOldOffset = Number(target.offset)
  const targetOldSize = Number(target.size)
  const delta = newContent.length - targetOldSize
  const entries = packedEntries(header)
  const oldOffsets = new Map(entries.map(({ entry: e }) => [e, Number(e.offset)]))
  for (const { entry: e } of entries) {
    if (e === target) continue
    const off = Number(e.offset)
    if (off > targetOldOffset) e.offset = String(off + delta)
  }
  target.size = newContent.length
  if (target.integrity) target.integrity = integrityOf(newContent, Number(target.integrity.blockSize) || 4194304)
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const pad = (4 - (json.length % 4)) % 4
  const dataStart = 16 + json.length + pad
  const ordered = entries.slice().sort((a, b) => oldOffsets.get(a.entry) - oldOffsets.get(b.entry))
  const total = dataStart + ordered.reduce((s, { entry: e }) => s + (e === target ? newContent.length : Number(e.size)), 0)
  const out = Buffer.alloc(total)
  out.writeUInt32LE(4, 0)
  out.writeUInt32LE(json.length + pad + 8, 4)
  out.writeUInt32LE(json.length + pad + 4, 8)
  out.writeUInt32LE(json.length, 12)
  json.copy(out, 16)
  let pos = dataStart
  for (const { entry: e } of ordered) {
    if (e === target) { newContent.copy(out, pos); pos += newContent.length; continue }
    const src = info.dataStart + oldOffsets.get(e)
    const size = Number(e.size)
    buf.copy(out, pos, src, src + size)
    pos += size
  }
  return out
}

/** 除目标条目外，其它条目必须逐字节不变（否则拒绝落盘） */
const verifyOthers = (oldBuf, oldInfo, newBuf, entry) => {
  const info = readAsarInfo(newBuf)
  const oldList = packedEntries(oldInfo.header).slice().sort((a, b) => a.path.localeCompare(b.path))
  const newList = packedEntries(info.header).slice().sort((a, b) => a.path.localeCompare(b.path))
  if (oldList.length !== newList.length) throw new Error('条目数不一致')
  for (let i = 0; i < oldList.length; i++) {
    const a = oldList[i]
    const b = newList[i]
    if (a.path !== b.path) throw new Error('条目名称不一致：' + a.path)
    if (a.path === entry) continue
    const ao = oldInfo.dataStart + Number(a.entry.offset)
    const an = info.dataStart + Number(b.entry.offset)
    const as = Number(a.entry.size)
    const bs = Number(b.entry.size)
    if (as !== bs) throw new Error('条目大小变了：' + a.path)
    if (sha(oldBuf.subarray(ao, ao + as)) !== sha(newBuf.subarray(an, an + bs))) throw new Error('条目内容变了：' + a.path)
  }
  const node = getNode(info.header, entry)
  const text = newBuf.subarray(info.dataStart + Number(node.offset), info.dataStart + Number(node.offset) + Number(node.size)).toString('utf8')
  return { text, node, info }
}

/**
 * 原子写入 asar 里的一个条目。失败一律回滚，调用方拿到 { state }。
 * state: applied / unchanged / missing / entry-missing / locked / verify-failed-restored
 */
export const writeEntry = (asarPath, entry, newText) => {
  const read = readEntry(asarPath, entry)
  if (read.state !== 'ok') return { state: read.state }
  if (read.text === newText) return { state: 'unchanged' }
  const next = Buffer.from(newText, 'utf8')
  const out = buildAsar(read.buf, read.info, entry, next)
  try {
    verifyOthers(read.buf, read.info, out, entry)
  } catch (error) {
    return { state: 'verify-failed', message: String(error.message || error) }
  }
  const s = stamp()
  const bak = asarPath + '.bak-h3rx-' + s
  const tmp = asarPath + '.new-h3rx-' + s
  writeFileSync(tmp, out)
  try {
    renameSync(asarPath, bak)
  } catch (error) {
    try { unlinkSync(tmp) } catch { }
    return { state: 'locked', message: '桌面程序可能正在运行（' + (error.code || '') + '）；退出后再试' }
  }
  try {
    renameSync(tmp, asarPath)
  } catch (error) {
    try { renameSync(bak, asarPath) } catch { }
    try { unlinkSync(tmp) } catch { }
    return { state: 'swap-failed-restored', message: String(error.code || error.message) }
  }
  // 复核：目标条目内容正确 + 其它条目未变（verifyOthers 已保证后者，这里抽读确认）
  try {
    const after = readEntry(asarPath, entry)
    if (after.state !== 'ok' || after.text !== newText) throw new Error('换装后读回不一致')
  } catch (error) {
    try { unlinkSync(asarPath); renameSync(bak, asarPath) } catch { }
    return { state: 'verify-failed-restored', message: String(error.message || error) }
  }
  try { unlinkSync(bak) } catch { }
  for (const f of readdirSync(dirname(asarPath))) {
    if (f.startsWith('app.asar.new-h3rx-') || f.startsWith('app.asar.bak-h3rx-') || f.startsWith('app.asar.revert-old-h3rx-')) {
      try { unlinkSync(join(dirname(asarPath), f)) } catch { }
    }
  }
  return { state: 'applied' }
}

/** 崩溃残留恢复：asar 缺失而旁边有 .new/.bak/.revert-old 时，挑一个改名回来 */
export const recoverAsar = (asarPath) => {
  if (existsSync(asarPath)) return false
  let list = []
  try { list = readdirSync(dirname(asarPath)) } catch { return false }
  const base = asarPath.split(/[\\/]/).pop()
  const cand = list.find((f) => f.startsWith(base + '.revert-old-h3rx-')) || list.find((f) => f.startsWith(base + '.bak-h3rx-')) || list.find((f) => f.startsWith(base + '.new-h3rx-'))
  if (!cand) return false
  try { renameSync(join(dirname(asarPath), cand), asarPath); return true } catch { return false }
}
