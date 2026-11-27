import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, read, run, assert, jsonOfLastLine, tmpDir } from '../lib.mjs'

/** 把当前清单复制到临时目录：给 check/apply 当"本地清单源"用（不联网） */
const makeManifestCopy = () => {
  const dir = tmpDir('manifest')
  mkdirSync(dir, { recursive: true })
  const dst = join(dir, 'shell-version.json')
  writeFileSync(dst, readFileSync(join(ROOT, 'shell-version.json')))
  return { dir, file: dst }
}

export const cases = [
  {
    name: 'check --cached 0 不回放任何缓存（启动路径总是真查）',
    fn() {
      const { dir, file } = makeManifestCopy()
      const cacheFile = join(ROOT, 'tmp', 'shell-check.json')
      mkdirSync(join(ROOT, 'tmp'), { recursive: true })
      const backup = existsSync(cacheFile) ? readFileSync(cacheFile, 'utf8') : null
      try {
        const cur = JSON.parse(read('shell-version.json')).shellVersion
        writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), source: file, version: '9.9.9', summary: { local: cur, remote: '9.9.9', status: 'update-available' } }), 'utf8')
        const r = run(['tools/update/shell-update.mjs', 'check', '--manifest', file, '--cached', '0'])
        assert(!r.out.includes('9.9.9'), '仍然回放了缓存：' + r.out.trim().slice(-200))
      } finally {
        if (backup === null) rmSync(cacheFile, { force: true })
        else writeFileSync(cacheFile, backup, 'utf8')
        rmSync(dir, { recursive: true, force: true })
      }
    },
  },
  {
    name: 'snooze --clear 能撤销"这次不更新"',
    fn() {
      const SNOOZE = join(ROOT, 'tmp', 'shell-snooze.json')
      mkdirSync(join(ROOT, 'tmp'), { recursive: true })
      const backup = existsSync(SNOOZE) ? readFileSync(SNOOZE, 'utf8') : null
      try {
        writeFileSync(SNOOZE, JSON.stringify({ version: '9.9.9', at: Date.now(), until: Date.now() + 86400000 }), 'utf8')
        const r = run(['tools/update/shell-update.mjs', 'snooze', '--clear'])
        assert(r.code === 0, 'clear 退出码 ' + r.code + '：' + r.out.trim().slice(-200))
        assert(!existsSync(SNOOZE), 'snooze 文件没被删掉（--clear 没生效）')
      } finally {
        if (backup === null) rmSync(SNOOZE, { force: true })
        else writeFileSync(SNOOZE, backup, 'utf8')
      }
    },
  },
  {
    name: 'check --manifest（本地副本、不联网）判为 up-to-date',
    fn() {
      const { dir, file } = makeManifestCopy()
      try {
        const r = run(['tools/update/shell-update.mjs', 'check', '--manifest', file, '--json'])
        const j = jsonOfLastLine(r.out)
        assert(j, '拿不到 JSON：' + r.out.trim().slice(-200))
        assert(j.status === 'up-to-date', 'status 应为 up-to-date，实际 ' + j.status)
        assert(j.local === j.remote, 'local/remote 应相同：' + j.local + ' / ' + j.remote)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
  },
  {
    name: 'apply 同版本时直接返回 upToDate（不再打印"推进到同一版"）',
    fn() {
      const { dir, file } = makeManifestCopy()
      try {
        const r = run(['tools/update/shell-update.mjs', 'apply', '--manifest', file, '--dry-run', '--json'])
        const j = jsonOfLastLine(r.out)
        assert(j, '拿不到 JSON：' + r.out.trim().slice(-300))
        assert(j.upToDate === true, 'upToDate 应为 true，实际 ' + JSON.stringify(j).slice(0, 200))
        assert((j.applied || []).length === 0, 'up-to-date 时不该有 applied')
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
  },
  {
    name: '检查缓存绑定本地版本（伪造上一版缓存必须被忽略）',
    fn() {
      const { dir, file } = makeManifestCopy()
      const cacheDir = join(ROOT, 'tmp')
      mkdirSync(cacheDir, { recursive: true })
      const cacheFile = join(cacheDir, 'shell-check.json')
      let backup = null
      try { backup = readFileSync(cacheFile, 'utf8') } catch { backup = null }
      try {
        // 缓存来源与本次一致，但 local 是"上一版" → 必须不复用（否则会显示 9.9.9）
        const fake = { at: Date.now(), source: file, version: '9.9.9', summary: { local: '0.0.1', remote: '9.9.9', status: 'update-available', exitCode: 0 } }
        writeFileSync(cacheFile, JSON.stringify(fake), 'utf8')
        const r = run(['tools/update/shell-update.mjs', 'check', '--manifest', file, '--cached', '1440'])
        assert(!r.out.includes('9.9.9'), '回放了过期缓存（出现 9.9.9）：' + r.out.trim().slice(-200))
      } finally {
        if (backup === null) rmSync(cacheFile, { force: true })
        else writeFileSync(cacheFile, backup, 'utf8')
        rmSync(dir, { recursive: true, force: true })
      }
    },
  },
]
