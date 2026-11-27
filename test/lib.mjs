import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TEST_DIR = dirname(fileURLToPath(import.meta.url))
export const ROOT = dirname(TEST_DIR)
const bundled = join(ROOT, 'runtime', 'node', 'bin', 'node.exe')
export const NODE = existsSync(bundled) ? bundled : process.execPath

export const read = (p) => readFileSync(join(ROOT, p), 'utf8')
export const exists = (p) => existsSync(join(ROOT, p))
export const sha = (p) => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex')

/** 跑一个 node 脚本（或任意可执行文件），返回 { code, out }；不抛异常 */
export const run = (args, opts = {}) => {
  const cmd = opts.raw ? args[0] : NODE
  const full = opts.raw ? args.slice(1) : args
  try {
    const out = execFileSync(cmd, full, {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: opts.timeout ?? 180000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out: String(out || '') }
  } catch (e) {
    return { code: e.status === undefined || e.status === null ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

export const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}

/** 临时目录（用例改文件只能改这里） */
/**
 * 把 tools/lib/shell-root.mjs 拷进夹具根。
 * 1.0.0 起每个工具都 import 它来定位壳根；夹具少拷这一个就是 ERR_MODULE_NOT_FOUND（夹具假红）。
 */
export const copyShellRoot = (dir) => {
  const dest = join(dir, 'tools', 'lib', 'shell-root.mjs')
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(join(ROOT, 'tools', 'lib', 'shell-root.mjs'), dest)
}

export const tmpDir = (name) => {
  const dir = join(process.env.TEMP || process.env.TMP || ROOT, 'shell-test-' + name + '-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8))
  return dir
}

/** 从输出里取 JSON：先按整段解析（--json 常是格式化输出），再回退到"最后一行是 JSON" */
export const jsonOfLastLine = (text) => {
  const raw = String(text || '').trim()
  try { return JSON.parse(raw) } catch { /* 不是整段 JSON */ }
  const lines = raw.split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]) } catch { /* 继续往前找 */ }
  }
  return null
}

/** 从"人类输出 + JSON"混合里抠出 JSON 对象（首 { 到末 }）；失败返回 null */
export const jsonObject = (text) => {
  const raw = String(text || '')
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(raw.slice(a, b + 1)) } catch { return null }
}
