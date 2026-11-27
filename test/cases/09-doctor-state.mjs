import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, read, assert } from '../lib.mjs'
import { execFileSync } from 'node:child_process'

const CACHE = join(ROOT, 'tmp', 'shell-check.json')
const version = () => JSON.parse(read('shell-version.json')).shellVersion

/** 跑 doctor（.cmd 入口，真正的用户路径），返回 shell-upd 那一行 */
const doctorUpd = () => {
  // .cmd 不能直接 execFile：Windows 上必须经 cmd.exe /c（否则 EINVAL）
  const comspec = process.env.ComSpec || 'cmd.exe'
  const out = execFileSync(comspec, ['/c', join(ROOT, 'dsh-portable.cmd'), 'doctor'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const line = String(out).split(/\r?\n/).find((l) => l.trim().startsWith('shell-upd'))
  return line ? line.trim() : ''
}

const withCache = (payload, fn) => {
  mkdirSync(join(ROOT, 'tmp'), { recursive: true })
  const backup = existsSync(CACHE) ? readFileSync(CACHE, 'utf8') : null
  try {
    writeFileSync(CACHE, JSON.stringify(payload), 'utf8')
    fn()
  } finally {
    if (backup === null) rmSync(CACHE, { force: true })
    else writeFileSync(CACHE, backup, 'utf8')
  }
}

export const cases = [
  {
    name: 'doctor 不念旧版本缓存（归属校验）',
    fn() {
      withCache({ at: Date.now(), summary: { local: '0.0.1', remote: '0.0.2', status: 'update-available' } }, () => {
        const line = doctorUpd()
        assert(line.includes('旧版本'), '应提示"缓存属于旧版本"，实际：' + line)
        assert(!/0\.0\.2 可更新/.test(line), '不该把 0.0.2 念成可更新：' + line)
      })
    },
  },
  {
    name: 'doctor 在本地版本匹配且远端更新时才说"可更新"',
    fn() {
      withCache({ at: Date.now(), summary: { local: version(), remote: '9.9.9', status: 'update-available' } }, () => {
        const line = doctorUpd()
        assert(line.includes('9.9.9 可更新'), '应提示 9.9.9 可更新，实际：' + line)
      })
    },
  },
  {
    name: 'doctor 对 up-to-date 缓存说"已是最新"',
    fn() {
      withCache({ at: Date.now(), summary: { local: version(), remote: version(), status: 'up-to-date' } }, () => {
        const line = doctorUpd()
        assert(line.includes('已是最新'), '应显示已是最新，实际：' + line)
      })
    },
  },
]
