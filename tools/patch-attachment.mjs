#!/usr/bin/env node
/**
 * 附件库补丁：把 `@deepseek-ai/dsh-attachment-local` 的 `link()` 换成"硬链接失败就 copy"。
 *
 * 背景：exFAT 不支持硬链接。附件库发布对象时调 `link(staged, target)`（内容寻址、不可变），
 * 失败即抛 ATTACHMENT_WRITE_FAILED —— 界面表现是图片附件全挂（"Unable to persist attachment."）。
 * 以前的绕法是�� `cordis.patch.yml` 里把 attachment-local 的 dshHome 指到 NTFS 的
 * `C:\Users\<用户>\.dsh`：能用，但数据离开便携目录、写死用户名，换机就失效。
 *
 * 本补丁只改一处 import + 插一个 3 行 shim，覆盖该包全部 `link()` 调用：
 *   - 成功时行为与官方完全一致（仍是硬链接）；
 *   - 失败（exFAT）时退化成 copy（对象是内容寻址的不可变文件，copy 语义等价）。
 * 同时改 `app\node_modules\...`（Web/CLI 用）与 `desktop\resources\app.asar`（桌面窗口用）。
 *
 * 用法：
 *   node tools\patch-attachment.mjs --check [--json]    # 查状态（不写盘）
 *   node tools\patch-attachment.mjs --apply             # 打补丁
 *   node tools\patch-attachment.mjs --revert            # 还原
 *   node tools\patch-attachment.mjs --selftest          # 夹具自测（不碰真文件）
 *
 * 退出码：0 无需改动 / 2 已改动 / 4 需要处理（锚点不匹配或缺文件）/ 3 目标被占用 / 1 失败
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve as _resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEntry, writeEntry, recoverAsar } from './asar-lite.mjs'

const _rootArg = process.argv.indexOf('--root')
const ROOT = _rootArg >= 0 ? _resolve(process.argv[_rootArg + 1]) : dirname(dirname(fileURLToPath(import.meta.url)))
const PKG_DIR = join(ROOT, 'app', 'node_modules', '@deepseek-ai', 'dsh-attachment-local')
const TARGET = join(PKG_DIR, 'lib', 'index.js')
const ASAR = process.env.H3RX_PATCH_ATTACHMENT_ASAR || join(ROOT, 'desktop', 'resources', 'app.asar')
const ASAR_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js'
const MARK = 'h3rx-attachment-patch: link-fallback'
const SHIM = `\n/* ${MARK} —— exFAT 没有硬链接：失败时退化成 copy（内容是内容寻址的不可变对象，语义等价） */\nconst link = async (src, dst) => { try { await __h3rxLink(src, dst) } catch { await writeFile(dst, await readFile(src), { flag: 'wx' }) } };\n`

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const EXIT = { OK: 0, FAIL: 1, APPLIED: 2, LOCKED: 3, NEEDS: 4 }

const line = (s) => process.stdout.write(s + '\n')
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

/** 找 import 块：`import { ... } from "node:fs/promises"`，允许跨行 */
const IMPORT_RE = /import\s*\{([\s\S]*?)\}\s*from\s*(["'])node:fs\/promises\2\s*;?/

const hasLinkClause = (text) => {
  const m = text.match(IMPORT_RE)
  if (!m) return false
  return m[1].split(',').some((x) => x.trim() === 'link')
}

const siteApply = (text) => {
  if (text.includes(MARK)) return text
  const m = text.match(IMPORT_RE)
  if (!m || !hasLinkClause(text)) return null
  const clause = m[1]
    .split(',')
    .map((x) => x.trim())
    .map((x) => (x === 'link' ? 'link as __h3rxLink' : x))
    .join(', ')
  const head = m[0].replace(m[1], ' ' + clause + ' ')
  const i = text.indexOf(m[0]) + m[0].length
  return text.slice(0, text.indexOf(m[0])) + head + SHIM + text.slice(i)
}

const siteRevert = (text) => {
  if (!text.includes(MARK)) return text
  let t = text.replace(SHIM, '')
  // 兼容"shim 被手动改过"的情况：按标记行到 const link 行整段删
  t = t.replace(new RegExp('\\n/\\* ' + MARK + '[\\s\\S]*?\\nconst link = async[^\\n]*\\n'), '\n')
  t = t.replace(/link as __h3rxLink/g, 'link')
  return t
}

const syntaxOk = (file) => {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'ignore', timeout: 30000 })
    return true
  } catch { return false }
}

const fileCheck = () => {
  if (!existsSync(TARGET)) return { state: 'missing' }
  const text = readFileSync(TARGET, 'utf8')
  if (text.includes(MARK)) return { state: 'applied' }
  if (!siteApply(text)) return { state: 'anchor-mismatch' }
  return { state: 'not-patched' }
}

const asarCheck = () => {
  recoverAsar(ASAR)
  if (!existsSync(ASAR)) return { state: 'missing' }
  try {
    const r = readEntry(ASAR, ASAR_ENTRY)
    if (r.state !== 'ok') return { state: r.state }
    if (r.text.includes(MARK)) return { state: 'applied' }
    if (!siteApply(r.text)) return { state: 'anchor-mismatch' }
    return { state: 'not-patched' }
  } catch (error) {
    return { state: 'unreadable', message: String(error.message || error) }
  }
}


const applyFile = () => {
  const pre = fileCheck()
  if (pre.state === 'applied') return { state: 'already' }
  if (pre.state !== 'not-patched') return pre
  const cur = readFileSync(TARGET, 'utf8')
  const next = siteApply(cur)
  if (!next) return { state: 'anchor-mismatch' }
  const bak = TARGET + '.bak-h3rx-' + Date.now()
  copyFileSync(TARGET, bak)
  writeFileSync(TARGET, next, 'utf8')
  if (!syntaxOk(TARGET)) {
    copyFileSync(bak, TARGET)
    return { state: 'syntax-failed-restored' }
  }
  return { state: 'applied', backup: bak }
}

const applyAsar = () => {
  const pre = asarCheck()
  if (pre.state === 'applied') return { state: 'already' }
  if (pre.state !== 'not-patched') return pre
  const r = readEntry(ASAR, ASAR_ENTRY)
  const next = siteApply(r.text)
  if (!next) return { state: 'anchor-mismatch' }
  return writeEntry(ASAR, ASAR_ENTRY, next)
}

const revertFile = () => {
  if (!existsSync(TARGET)) return { state: 'missing' }
  const cur = readFileSync(TARGET, 'utf8')
  if (!cur.includes(MARK)) return { state: 'not-patched' }
  const next = siteRevert(cur)
  if (next.includes(MARK)) return { state: 'revert-mismatch' }
  writeFileSync(TARGET, next, 'utf8')
  if (!syntaxOk(TARGET)) return { state: 'revert-syntax-failed' }
  for (const f of readdirSync(dirname(TARGET))) {
    if (f.startsWith('index.js.bak-h3rx-')) { try { unlinkSync(join(dirname(TARGET), f)) } catch { } }
  }
  return { state: 'reverted' }
}

const revertAsar = () => {
  const pre = asarCheck()
  if (pre.state === 'not-patched') return { state: 'not-patched' }
  if (pre.state !== 'applied') return pre
  const r = readEntry(ASAR, ASAR_ENTRY)
  const next = siteRevert(r.text)
  if (next.includes(MARK)) return { state: 'revert-mismatch' }
  return writeEntry(ASAR, ASAR_ENTRY, next)
}

// ---------------------------------------------------------------- selftest
const FIXTURES = [
  'import { chmod, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";\nconst x = 1;\n',
  'import {\n  chmod,\n  link,\n  readFile,\n  writeFile,\n} from "node:fs/promises";\nawait link(a, b);\n',
]
const selftest = () => {
  let pass = 0
  const results = []
  for (const [i, src] of FIXTURES.entries()) {
    const patched = siteApply(src)
    const again = patched ? siteApply(patched) : null
    const reverted = patched ? siteRevert(patched) : null
    // 还原不要求逐字节相同（多行 import 会被压成一行），只要求：去掉 shim、恢复 link、能再打上
    const ok = Boolean(patched)
      && patched.includes(MARK)
      && patched.includes('link as __h3rxLink')
      && again === patched
      && !reverted.includes(MARK)
      && !reverted.includes('__h3rxLink')
      && Boolean(siteApply(reverted))
    results.push({ fixture: i + 1, ok })
    if (ok) pass++
  }
  // 负例：没有 link 的 import 不该被改
  const noLink = 'import { readFile, writeFile } from "node:fs/promises";\n'
  const negOk = siteApply(noLink) === null
  results.push({ fixture: 'no-link', ok: negOk })
  if (negOk) pass++
  const total = FIXTURES.length + 1
  if (jsonMode) out({ ok: pass === total, passed: pass, total, results })
  else {
    for (const r of results) line('  ' + (r.ok ? 'ok    ' : 'FAIL  ') + 'fixture ' + r.fixture)
    line('结论：' + (pass === total ? 'SELFTEST PASS（' + pass + '/' + total + '）' : 'FAIL（' + pass + '/' + total + '）'))
  }
  return pass === total ? EXIT.OK : EXIT.FAIL
}

// ---------------------------------------------------------------- CLI
const main = () => {
  if (args.includes('--selftest')) return selftest()
  const onlyApp = args.includes('--app-only')
  if (args.includes('--check')) {
    const file = fileCheck()
    const asar = onlyApp ? { state: 'skipped' } : asarCheck()
    const bad = [file, asar].filter((r) => ['missing', 'anchor-mismatch', 'unreadable', 'entry-missing'].includes(r.state))
    const done = file.state === 'applied' && (onlyApp || asar.state === 'applied')
    if (jsonMode) out({ ok: bad.length === 0, patched: done, file, asar })
    else {
      line('附件库补丁（' + MARK + '）')
      line('  app  目录：' + file.state)
      line('  app.asar ：' + asar.state)
    }
    if (bad.length) return EXIT.NEEDS
    return done ? EXIT.OK : EXIT.APPLIED
  }
  if (args.includes('--apply')) {
    const file = applyFile()
    const asar = onlyApp ? { state: 'skipped' } : applyAsar()
    const states = [file.state, asar.state].filter((s) => s !== 'skipped')
    const locked = states.includes('locked')
    const failed = states.some((s) => !['applied', 'already', 'unchanged'].includes(s))
    if (jsonMode) out({ ok: !failed && !locked, file, asar })
    else {
      line('附件库补丁：app=' + file.state + '，asar=' + asar.state)
      if (locked) line('  桌面程序正在运行：asar 被占用，下次启动会自动补（本工具已先修 app 目录那份）')
    }
    if (locked) return EXIT.LOCKED
    return failed ? EXIT.FAIL : EXIT.APPLIED
  }
  if (args.includes('--revert')) {
    const file = revertFile()
    const asar = onlyApp ? { state: 'skipped' } : revertAsar()
    if (jsonMode) out({ ok: true, file, asar })
    else line('附件库补丁还原：app=' + file.state + '，asar=' + asar.state)
    return EXIT.OK
  }
  line('用法：node tools\\patch-attachment.mjs --check | --apply | --revert | --selftest [--json] [--app-only]')
  return EXIT.FAIL
}

const code = main()
process.exit(code)
