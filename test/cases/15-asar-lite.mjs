import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, tmpDir } from '../lib.mjs'
import { readEntry, writeEntry } from '../../tools/lib/asar-lite.mjs'

/** 拼一个最小合法 asar：header + 对齐 + 数据区 */
const buildAsar = (entries) => {
  const files = {}
  const chunks = []
  let off = 0
  for (const { name, text } of entries) {
    const buf = Buffer.from(text, 'utf8')
    files[name] = { size: buf.length, offset: String(off) }
    chunks.push(buf)
    off += buf.length
  }
  const json = Buffer.from(JSON.stringify({ files }), 'utf8')
  const pad = (4 - (json.length % 4)) % 4
  const header = Buffer.alloc(16)
  header.writeUInt32LE(4, 0)
  header.writeUInt32LE(json.length + pad + 8, 4)
  header.writeUInt32LE(json.length + pad + 4, 8)
  header.writeUInt32LE(json.length, 12)
  return Buffer.concat([header, json, Buffer.alloc(pad), ...chunks])
}

const makeAsar = (entries) => {
  const dir = tmpDir('asar-lite')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'app.asar')
  writeFileSync(file, buildAsar(entries))
  return { dir, file }
}

export const cases = [
  {
    name: 'asar-lite：读条目拿到原文',
    fn() {
      const { dir, file } = makeAsar([{ name: 'a.txt', text: 'alpha' }, { name: 'b.txt', text: 'beta' }])
      try {
        const r = readEntry(file, 'a.txt')
        assert(r.state === 'ok', '状态 ' + r.state)
        assert(r.text === 'alpha', '内容不符：' + r.text)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
  },
  {
    name: 'asar-lite：改一个条目，其它条目逐字节不变',
    fn() {
      const { dir, file } = makeAsar([{ name: 'a.txt', text: 'alpha' }, { name: 'b.txt', text: 'beta-longer-content' }])
      try {
        const before = readEntry(file, 'b.txt')
        const w = writeEntry(file, 'a.txt', 'ALPHA-v2')
        assert(w.state === 'applied', '写入状态 ' + w.state)
        assert(readEntry(file, 'a.txt').text === 'ALPHA-v2', '目标条目没更新')
        const after = readEntry(file, 'b.txt')
        assert(after.text === before.text, '其它条目内容变了')
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
  },
  {
    name: 'asar-lite：内容相同返回 unchanged（幂等）',
    fn() {
      const { dir, file } = makeAsar([{ name: 'a.txt', text: 'same' }])
      try {
        assert(writeEntry(file, 'a.txt', 'same').state === 'unchanged', '应返回 unchanged')
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
  },
  {
    name: 'asar-lite：目标条目不存在 / 文件不存在时明确报状态',
    fn() {
      const { dir, file } = makeAsar([{ name: 'a.txt', text: 'x' }])
      try {
        assert(readEntry(file, 'nope.txt').state === 'entry-missing', '应报 entry-missing')
        assert(writeEntry(file, 'nope.txt', 'y').state === 'entry-missing', '写入也应报 entry-missing')
        assert(readEntry(join(dir, 'missing.asar'), 'a.txt').state === 'missing', '应报 missing')
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
  },
  {
    name: 'asar-lite：写大内容后重新读回一致（偏移重排正确）',
    fn() {
      const big = 'x'.repeat(5000)
      const { dir, file } = makeAsar([{ name: 'a.txt', text: 'small' }, { name: 'b.txt', text: 'tail' }])
      try {
        assert(writeEntry(file, 'a.txt', big).state === 'applied', '写入失败')
        assert(readEntry(file, 'a.txt').text === big, '大内容读回不一致')
        assert(readEntry(file, 'b.txt').text === 'tail', '尾部条目被破坏')
        const raw = readFileSync(file)
        assert(raw.readUInt32LE(0) === 4, 'asar 魔数被破坏')
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
  },
]
