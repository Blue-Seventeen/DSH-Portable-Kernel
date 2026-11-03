/**
 * 行尾 / BOM 归一（发布前必跑，防止"清单哈希"与"tag 里的字节"对不上）。
 *
 * 为什么需要它：仓库约定 = `.cmd` 纯 ASCII + CRLF，`.ps1` 单个 UTF-8 BOM + LF，
 * 其余文本（.md/.json/.mjs/.yml/.yaml）UTF-8 无 BOM + LF。但 PowerShell 的
 * `[IO.File]::WriteAllText` / `Set-Content` 会按 CRLF 写，编辑工具也可能改写行尾；
 * 而 `.gitattributes` 只对 text 文件做 eol=lf 归一（`*.ps1` / `*.cmd` 是 `-text`，原样入库），
 * 于是工作树的字节 != tag 里的字节，`shell-release prepare` 的「tag 自校验」就会失败。
 *
 *   node tools\normalize-eol.mjs            # 就地归一（只改行尾/BOM，不改内容）
 *   node tools\normalize-eol.mjs --check    # 只检查：有问题 exit 1，不写盘
 *   node tools\normalize-eol.mjs --json     # 机器可读（单行纯 ASCII）
 *
 * 扫描范围 = "壳文件"：根脚本 + README/LICENSE/RELEASE-NOTES/RELEASING + tools/。
 * 不碰：app/ desktop/ runtime/ home/ cache/ logs/ tmp/ .git/ node_modules/ plugins/ doc/（doc 是本机交接文档，不进仓库）。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CHECK = process.argv.includes('--check')
const JSON_OUT = process.argv.includes('--json')
const SKIP_DIRS = new Set(['app', 'desktop', 'runtime', 'home', 'cache', 'logs', 'tmp', '.git', 'doc', 'node_modules', 'plugins'])
const TEXT_EXT = new Set(['.cmd', '.ps1', '.mjs', '.md', '.json', '.yml', '.yaml', '.txt'])
const toPosix = (p) => p.split('\\').join('/')
const same = (a, b) => a.length === b.length && a.equals(b)

const walk = (dir, rel, out) => {
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const d of ents) {
    const r = rel ? rel + '/' + d.name : d.name
    if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) walk(join(dir, d.name), r, out) }
    else if (TEXT_EXT.has(extname(d.name).toLowerCase())) out.push(r)
  }
}

/**
 * 归一一份文件的字节。
 * @returns {{ok:boolean, out:Buffer, changed:boolean, reasons:string[]}}
 *   ok=false 表示有"修不了"的问题（.cmd 含非 ASCII、BOM 缺失且不是 UTF-8 可修的情形）。
 */
const fixBytes = (rel, buf) => {
  const low = rel.toLowerCase()
  const isCmd = low.endsWith('.cmd')
  const isPs1 = low.endsWith('.ps1')
  const reasons = []
  let bad = false
  let out = Buffer.from(buf)

  const hasBom = out.length >= 3 && out[0] === 0xef && out[1] === 0xbb && out[2] === 0xbf
  const doubleBom = out.length >= 6 && out[3] === 0xef && out[4] === 0xbb && out[5] === 0xbf
  if (doubleBom) { out = out.subarray(3) }
  
  if (!isPs1 && hasBom) { out = out.subarray(3) }

  let hasCrlf = out.includes(Buffer.from([13, 10]))
  let loneCr = false
  for (let i = 0; i < out.length; i++) if (out[i] === 13 && out[i + 1] !== 10) { loneCr = true; break }

  if (isCmd) {
    if (hasCrlf || loneCr) {
      const lf = out.toString('latin1').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      out = Buffer.from(lf.replace(/\n/g, '\r\n'), 'latin1')
    }
    const nonAscii = out.findIndex((x) => x > 0x7f)
    if (nonAscii !== -1) { reasons.push('.cmd 含非 ASCII（偏移 ' + nonAscii + '，修不了）'); bad = true }
  } else {
    if (hasCrlf || loneCr) {
      const text = out.toString('latin1').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      out = Buffer.from(text, 'latin1')
    }
    if (isPs1 && !hasBom) out = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), out])
  }
  const changed = !same(out, buf)
  if (changed) {
    const bits = [isCmd ? '行尾→CRLF' : '行尾→LF']
    if (doubleBom) bits.push('去掉重复 BOM')
    if (isPs1 && !hasBom) bits.push('补 BOM')
    if (!isPs1 && hasBom) bits.push('去 BOM')
    reasons.unshift(bits.join(' + '))
  }
  return { ok: !bad, out, changed, reasons }
}

const files = []
walk(ROOT, '', files)
files.sort()

const rows = []
let changed = 0
let failed = 0
for (const rel of files) {
  const abs = join(ROOT, rel)
  let buf = null
  try { if (!statSync(abs).isFile()) continue; buf = readFileSync(abs) } catch { continue }
  const r = fixBytes(rel, buf)
  if (r.changed) changed += 1
  if (!r.ok) failed += 1
  if (r.changed && !CHECK) {
    try { writeFileSync(abs, r.out) } catch (e) { r.reasons.push('写盘失败：' + e.message); failed += 1 }
  }
  if (r.reasons.length) rows.push({ path: toPosix(rel), reasons: r.reasons, fixed: !CHECK && r.changed, ok: r.ok })
}

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ ok: failed === 0, action: CHECK ? 'check' : 'fix', scanned: files.length, changed, failed, rows }) + '\n')
  process.exit(failed > 0 ? 1 : (CHECK && changed > 0 ? 1 : 0))
}

console.log('行尾/BOM ' + (CHECK ? '检查' : '归一') + '：扫描 ' + files.length + ' 个文本壳文件')
for (const r of rows) console.log('  ' + (r.fixed ? 'FIXED' : (r.ok ? 'BAD  ' : 'FAIL ')) + '  ' + r.path + '  ' + r.reasons.join('；'))
if (!rows.length) console.log('  全部符合约定（.cmd=ASCII+CRLF，.ps1=单 BOM+LF，其余=UTF-8 无 BOM+LF）')
console.log('结论：' + (failed === 0 ? (CHECK ? (changed ? changed + ' 个文件不符合约定（可运行不带 --check 修掉）' : '无问题') : '已归一 ' + changed + ' 个文件') : failed + ' 个文件仍有问题'))
process.exit(failed > 0 ? 1 : (CHECK && changed > 0 ? 1 : 0))
