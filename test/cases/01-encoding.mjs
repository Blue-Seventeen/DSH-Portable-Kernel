import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, assert } from '../lib.mjs'

const cmdFiles = () => readdirSync(ROOT).filter((f) => f.endsWith('.cmd')).sort()
const bytes = (rel) => readFileSync(join(ROOT, rel))

export const cases = [
  {
    name: '根目录 .cmd 全是纯 ASCII + CRLF',
    fn() {
      const bad = []
      for (const f of cmdFiles()) {
        const b = bytes(f)
        if (b.some((x) => x > 127)) bad.push(f + '（非 ASCII）')
        if (b.some((x, i) => x === 10 && (i === 0 || b[i - 1] !== 13))) bad.push(f + '（有 LF-only 行）')
      }
      assert(bad.length === 0, bad.join('；'))
    },
  },
  {
    name: 'dsh-portable.ps1 只有一个 UTF-8 BOM',
    fn() {
      const b = bytes('dsh-portable.ps1')
      assert(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf, '缺 BOM（PowerShell 5.1 会读成乱码）')
      assert(!(b[3] === 0xef && b[4] === 0xbb && b[5] === 0xbf), 'BOM 重复了')
    },
  },
  {
    name: 'tools/lib/say.ps1 只有一个 UTF-8 BOM',
    fn() {
      const b = bytes('tools/lib/say.ps1')
      assert(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf, '缺 BOM')
      assert(!(b[3] === 0xef && b[4] === 0xbb && b[5] === 0xbf), 'BOM 重复了')
    },
  },
  {
    name: '文档/清单类文本无 BOM 且是合法 UTF-8',
    fn() {
      for (const f of ['README.md', 'RELEASE-NOTES.md', 'version.json', 'shell-version.json']) {
        const b = bytes(f)
        assert(b[0] !== 0xef, f + ' 带 BOM')
        const text = b.toString('utf8')
        assert(!text.includes('\uFFFD'), f + ' 含替换字符（不是 UTF-8）')
        assert(Buffer.from(text, 'utf8').equals(b), f + ' 往返编码不一致')
      }
    },
  },
  {
    name: 'tools/*.mjs 全部用 LF（避免 tag 自校验哈希不符）',
    fn() {
      const bad = []
      for (const name of readdirSync(join(ROOT, 'tools')).filter((n) => n.endsWith('.mjs'))) {
        const b = readFileSync(join(ROOT, 'tools', name))
        if (b.some((x, i) => x === 13 && b[i + 1] === 10)) bad.push(name)
      }
      assert(bad.length === 0, 'CRLF 文件：' + bad.join(', '))
    },
  },
]
