/**
 * desktop-console 脱敏器。
 *
 * 背景：桌面程序（及它的 dsh-host 子进程）会把 stdout 写到启动它的控制台，Windows 要等最后一个
 * 挂着的进程退出才回收窗口 —— 所以必须重定向，否则双击后那个黑框会留一整个会话。
 * 但官方启动横幅里带一次性本地引导令牌（`dsh web: http://127.0.0.1:PORT/?token=…`），
 * 直接 `> logs\desktop-console.log` 就等于把令牌明文写进磁盘，拷包/发日志时会一起泄露。
 *
 * 做法：`exe 2>&1 | node tools\mask-log.mjs <ROOT>`，逐行流式过滤后落盘：
 *   - token / cookie 一类换成 <redacted>
 *   - 其余诊断信息（报错、端口、inspector 行）原样保留
 * 只依赖 node 内置模块；任何异常都不抛，绝不阻断桌面程序。
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..')
const logDir = join(root, 'logs')
const logFile = join(logDir, 'desktop-console.log')
const MAX_BYTES = 256 * 1024

const mask = (line) => String(line)
  .replace(/([?&]token=)[^\s&"'#]+/gi, '$1<redacted>')
  .replace(/(dsh-auth-)[A-Za-z0-9._-]+/g, '$1<redacted>')
  .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1<redacted>')
  .replace(/(("|')?(api[_-]?key|authorization)("|')?\s*[:=]\s*("|')?)[^\s"',}]{8,}/gi, '$1<redacted>')

let out = null
try {
  mkdirSync(logDir, { recursive: true })
  // 轮转：只留一份旧日志，避免一个会话跑几天把盘写满
  try {
    if (existsSync(logFile) && statSync(logFile).size > MAX_BYTES) renameSync(logFile, logFile + '.1')
  } catch { /* 文件被占用就不轮转，不影响主流程 */ }
  out = createWriteStream(logFile, { flags: 'a' })
  out.on('error', () => { out = null })
} catch { out = null }

let buf = ''
const flushLine = (line) => { try { if (out) out.write(mask(line) + '\n') } catch { /* ignore */ } }

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    flushLine(buf.slice(0, i))
    buf = buf.slice(i + 1)
  }
})
process.stdin.on('end', () => {
  if (buf) flushLine(buf)
  try { if (out) out.end() } catch { /* ignore */ }
})
process.stdin.on('error', () => {})
process.stdout.on('error', () => {})