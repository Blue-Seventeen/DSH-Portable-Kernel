import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, read, run, assert } from '../lib.mjs'

const CACHE = join(ROOT, 'tmp', 'shell-check.json')
const currentVersion = () => JSON.parse(read('shell-version.json')).shellVersion

/** 用一份临时缓存跑 preflight，跑完恢复原缓存（用例不许留下副作用） */
const ERR = join(ROOT, 'tmp', 'shell-check.err.json')
const withCache = (payload, fn) => {
  mkdirSync(join(ROOT, 'tmp'), { recursive: true })
  const backup = existsSync(CACHE) ? readFileSync(CACHE, 'utf8') : null
  const errBackup = existsSync(ERR) ? readFileSync(ERR, 'utf8') : null
  try {
    // 清掉"上次检查失败"记录：本用例要验证的是缓存展示，不是失败态
    rmSync(ERR, { force: true })
    writeFileSync(CACHE, JSON.stringify(payload), 'utf8')
    fn()
  } finally {
    if (backup === null) rmSync(CACHE, { force: true })
    else writeFileSync(CACHE, backup, 'utf8')
    if (errBackup === null) rmSync(ERR, { force: true })
    else writeFileSync(ERR, errBackup, 'utf8')
  }
}

const preflightOut = () => run(['tools/lib/preflight.mjs']).out

export const cases = [
  {
    name: '旧版本的"有更新"缓存不会显示（升级后旧缓存作废）',
    fn() {
      withCache({ at: Date.now(), summary: { local: '0.0.1', remote: '0.0.2', status: 'update-available', exitCode: 0 } }, () => {
        const out = preflightOut()
        assert(!out.includes('有可用更新'), '仍然显示了旧缓存里的更新提示')
      })
    },
  },
  {
    name: '缓存 local 与当前版本一致且远端更新时才提示',
    fn() {
      withCache({ at: Date.now(), summary: { local: currentVersion(), remote: '9.9.9', status: 'update-available', exitCode: 0 } }, () => {
        const out = preflightOut()
        assert(out.includes('9.9.9'), '本地版本匹配、远端更新时应当提示，实际输出里没有 9.9.9')
      })
    },
  },
  {
    name: 'up-to-date 缓存不提示"有可用更新"',
    fn() {
      withCache({ at: Date.now(), summary: { local: currentVersion(), remote: currentVersion(), status: 'up-to-date', exitCode: 4 } }, () => {
        const out = preflightOut()
        assert(!out.includes('有可用更新'), 'up-to-date 时不该显示更新提示')
      })
    },
  },
  {
    name: '缓存超过 24 小时不再提示',
    fn() {
      withCache({ at: Date.now() - 25 * 3600 * 1000, summary: { local: currentVersion(), remote: '9.9.9', status: 'update-available', exitCode: 0 } }, () => {
        const out = preflightOut()
        assert(!out.includes('有可用更新'), '过期缓存不该再提示')
      })
    },
  },
  {
    name: '[11] 对 up-to-date 缓存显示"检查于…"，对旧版本缓存显示"上次检查是…"',
    fn() {
      const cur = currentVersion()
      withCache({ at: Date.now() - 3600 * 1000, summary: { local: cur, remote: cur, status: 'up-to-date', exitCode: 4 } }, () => {
        assert(preflightOut().includes('检查于'), 'up-to-date 时应显示检查时间')
      })
      withCache({ at: Date.now() - 3600 * 1000, summary: { local: '0.0.1', remote: '0.0.2', status: 'update-available' } }, () => {
        const out = preflightOut()
        assert(out.includes('上次检查是'), '旧版本缓存应显示"上次检查是…"')
      })
    },
  },
  {
    name: '同版本但本地有改动时，[11] 说明"本地有 N 处改动"',
    fn() {
      const cur = currentVersion()
      withCache({ at: Date.now(), summary: { local: cur, remote: cur, changed: 3, status: 'update-available' } }, () => {
        const out = preflightOut()
        assert(out.includes('本地有 3 处改动'), '应说明本地改动，实际：' + out.split(/\r?\n/).filter((l) => l.includes('改动') || l.includes('状态')).join(' | '))
      })
    },
  },
  {
    name: '未知状态不冒充"已是最新"',
    fn() {
      withCache({ at: Date.now(), summary: { local: currentVersion(), remote: currentVersion(), status: 'whatever' } }, () => {
        const out = preflightOut()
        assert(out.includes('状态未知'), '未知状态应照实说，实际：' + out.split(/\r?\n/).filter((l) => l.includes('更新') || l.includes('最新')).join(' | '))
      })
    },
  },
  {
    name: '被兼容性挡下时显示"挡下"而不是"没有新版本"',
    fn() {
      withCache({ at: Date.now(), summary: { local: currentVersion(), remote: '9.9.9', status: 'blocked', blockers: [{ code: 'x', message: 'demo' }] } }, () => {
        const out = preflightOut()
        assert(out.includes('被兼容性挡下'), '应提示被挡下，实际没有')
        assert(!out.includes('还没检查过'), 'blocked 时不该说没检查过')
      })
    },
  },
  {
    name: '检查失败时 [11] 明说"本次检查失败"，不冒充已是最新',
    fn() {
      const cur = currentVersion()
      withCache({ at: Date.now() - 3600 * 1000, summary: { local: cur, remote: cur, status: 'up-to-date', exitCode: 4 } }, () => {
        // 造一条"比缓存更新"的失败记录
        writeFileSync(ERR, JSON.stringify({ at: Date.now(), error: '取不到清单：超时（10000ms）' }), 'utf8')
        const out = preflightOut()
        assert(out.includes('本次检查失败'), '应显示本次检查失败，实际：' + out.split(/\r?\n/).filter((l) => l.includes('检查')).join(' | '))
        assert(out.includes('超时'), '应带失败原因')
        assert(out.includes('上次成功'), '应说明上次成功的时间')
      })
    },
  },
  {
    name: '[11] 直接给出"当前版本 / 最新版本"两行',
    fn() {
      const cur = currentVersion()
      withCache({ at: Date.now(), summary: { local: cur, remote: '9.9.9', status: 'update-available' } }, () => {
        const out = preflightOut()
        assert(out.includes('当前版本'), '缺少"当前版本"行')
        assert(out.includes('最新版本'), '缺少"最新版本"行')
        assert(out.includes('9.9.9'), '最新版本应显示远端版本号')
      })
    },
  },
  {
    name: '没有缓存时说"还没检查过"（不是"没有新版本"）',
    fn() {
      withCache({ at: Date.now(), summary: { local: currentVersion(), remote: currentVersion(), status: 'up-to-date' } }, () => {
        // 先制造"无缓存"：删掉再跑
        rmSync(CACHE, { force: true })
        rmSync(ERR, { force: true })
        const out = preflightOut()
        assert(out.includes('还没检查过'), '无缓存时应说还没检查过，实际：' + out.split(/\r?\n/).filter((l) => l.includes('更新') || l.includes('检查')).join(' | '))
      })
    },
  },
]
