import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, read, run, assert, tmpDir, jsonObject } from '../lib.mjs'

const PATCH_ALL_TWICE = () => {
  const a = run(['tools/patch/patch-all.mjs', '--check', '--json'])
  const b = run(['tools/patch/patch-all.mjs', '--check', '--json'])
  return { a, b }
}

export const cases = [
  {
    name: 'patch-all --check 连跑两次结论一致（幂等、不落盘）',
    fn() {
      const { a, b } = PATCH_ALL_TWICE()
      const ja = jsonObject(a.out)
      const jb = jsonObject(b.out)
      assert(ja && jb, '拿不到 JSON')
      const key = (j) => JSON.stringify((j.families || []).map((f) => [f.family, f.state, f.code]))
      assert(key(ja) === key(jb), '两次结论不同：' + key(ja) + ' vs ' + key(jb))
    },
  },
  {
    name: '暂存队列 JSON 损坏时不会崩（stage-list 仍可用）',
    fn() {
      const root = tmpDir('queue-corrupt')
      try {
        mkdirSync(join(root, 'home', 'profiles'), { recursive: true })
        mkdirSync(join(root, 'home', 'plugin-stage'), { recursive: true })
        for (const name of ['queue.json', 'stage.json']) {
          writeFileSync(join(root, 'home', 'plugin-stage', name), '{ this is not json', 'utf8')
        }
        const r = run(['tools/profile/plugin-shared.mjs', '--root', root, 'stage-list'])
        assert(r.code === 0 || r.code === 1, '退出码异常：' + r.code)
        assert(!/SyntaxError|Unexpected token/.test(r.out), '把 JSON 解析异常抛给用户了：' + r.out.trim().slice(-200))
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
  {
    name: 'market-history 容忍坏行 / 空文件 / 缺 log',
    fn() {
      const root = tmpDir('mh-robust')
      const dir = join(root, 'home', 'profiles', 'desktop', '.dsh-market')
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'drain.ndjson'), 'not json\n{"state":"succeeded"}\n\n', 'utf8')
        const r = run(['tools/profile/market-history.mjs', '--root', root, '--all'])
        assert(r.code === 0, '退出码 ' + r.code + '：' + r.out.trim().slice(-200))
        const left = readFileSync(join(dir, 'drain.ndjson'), 'utf8')
        assert(left.includes('not json'), '坏行被删掉了（应原样保留）')
        assert(!left.includes('succeeded'), '已结束记录没清掉')
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
  {
    name: 'preflight 对损坏的检查缓存不崩',
    fn() {
      const cache = join(ROOT, 'tmp', 'shell-check.json')
      let backup = null
      try { backup = readFileSync(cache, 'utf8') } catch { backup = null }
      try {
        mkdirSync(join(ROOT, 'tmp'), { recursive: true })
        writeFileSync(cache, '{ broken json', 'utf8')
        const r = run(['tools/lib/preflight.mjs'])
        assert(r.code === 0 || r.code === 1, '退出码异常 ' + r.code)
        assert(!/Unexpected token|SyntaxError/.test(r.out), '把解析异常抛给用户了')
      } finally {
        if (backup === null) rmSync(cache, { force: true })
        else writeFileSync(cache, backup, 'utf8')
      }
    },
  },
  {
    name: '启动器里的 goto 标签都存在',
    fn() {
      for (const f of readdirSync(ROOT).filter((n) => n.endsWith('.cmd'))) {
        const text = read(f)
        const labels = new Set([...text.matchAll(/^:([A-Za-z0-9_]+)/gm)].map((m) => m[1].toLowerCase()))
        const gotos = [...text.matchAll(/goto\s+:?([A-Za-z0-9_]+)/gi)].map((m) => m[1].toLowerCase())
        // goto :eof 是 cmd 的内建目标（跳到文件尾），不是真标签
        const missing = [...new Set(gotos)].filter((g) => g !== 'eof' && !labels.has(g))
        assert(missing.length === 0, f + ' 里 goto 到不存在的标签：' + missing.join(', '))
      }
    },
  },
  {
    name: '所有文档里写的 dsh-portable 动作都真实存在',
    fn() {
      const ps1 = read('dsh-portable.ps1')
      const setLine = ps1.split(/\r?\n/).find((l) => l.includes('[ValidateSet(')) || ''
      const actions = new Set([...setLine.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]))
      // 1.0.0：工具拆成 tools/<组>/ 与 devtools/ 两棵树；doc/ 是本机档案（保留历史旧路径），不参与校验
      const files = ['README.md']
      const known = new Set()
      const scan = (d) => {
        for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
          if (e.isDirectory()) scan(d + '/' + e.name)
          else known.add(e.name)
        }
      }
      for (const base of ['tools', 'devtools']) { try { scan(base) } catch { } }
      const missing = []
      for (const f of files) {
        for (const m of read(f).matchAll(/dsh-portable\.cmd\s+([a-z0-9-]+)/g)) {
          const a = m[1]
          if (!actions.has(a) && !['help', 'version'].includes(a)) missing.push(f + ' → ' + a)
        }
      }
      assert(missing.length === 0, '动作表里没有：' + [...new Set(missing)].join('; '))
    },
  },
  {
    name: '文档里引用的 tools/*.mjs 都存在（示例名除外）',
    fn() {
      // 文档里有些是"假设性示例"（教用户放自己的脚本、讲删除规则），它们本来就不该存在
      const EXAMPLES = new Set(['my-test.mjs', 'old.mjs', 'user.mjs', 'evil.mjs', 'nonexistent.mjs'])
      // 1.0.0：工具拆成 tools/<组>/ 与 devtools/ 两棵树；doc/ 是本机档案（保留历史旧路径），不参与校验
      const files = ['README.md']
      const known = new Set()
      const scan = (d) => {
        for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
          if (e.isDirectory()) scan(d + '/' + e.name)
          else known.add(e.name)
        }
      }
      for (const base of ['tools', 'devtools']) { try { scan(base) } catch { } }
      const missing = []
      for (const f of files) {
        for (const m of read(f).matchAll(/(?<!dev)tools[\\/](?:[a-z]+[\\/])?([A-Za-z0-9_-]+\.mjs)/g)) {
          if (EXAMPLES.has(m[1])) continue
          if (!known.has(m[1])) missing.push(f + ' → ' + m[1])
        }
      }
      assert(missing.length === 0, '引用了不存在的脚本：' + [...new Set(missing)].join('; '))
    },
  },
  {
    name: '大树备份（desktop/app）只留 1 份，且 tidy 会回收',
    fn() {
      const ps1 = read('dsh-portable.ps1')
      assert(!/'desktop\.bak-' 2/.test(ps1), 'desktop.bak 的保留数还是 2（会白占约 1 GB）')
      assert(!/'app\.bak-' 2/.test(ps1), 'app.bak 的保留数还是 2')
      assert(/'desktop\.bak-' 1/.test(ps1), '没有把 desktop.bak 调成只留 1 份')
      assert(ps1.includes("RemoveOldBackups 'shell-backup-' 2"), 'tidy 没有回收壳备份')
    },
  },
  {
    name: '--brief 的失败输出只有一行（离线时不在启动里刷屏）',
    fn() {
      const ERR = join(ROOT, 'tmp', 'shell-check.err.json')
      const r = run(['tools/update/shell-update.mjs', 'check', '--manifest', 'http://127.0.0.1:9/shell-version.json', '--brief', '--allow-untrusted'])
      rmSync(ERR, { force: true })   // 别把"失败记录"留给后面的用例
      assert(r.code === 1, '退出码应为 1，实际 ' + r.code)
      const lines = r.out.trim().split(/\r?\n/).filter(Boolean)
      assert(lines.length <= 2, '输出行数太多：' + lines.length)
      assert(lines[0].includes('shell-update:'), '首行不是简短报错：' + lines[0])
    },
  },
  {
    name: '--quiet-fail 不刷屏、只写错误记录（给 [11] 用）',
    fn() {
      const ERR = join(ROOT, 'tmp', 'shell-check.err.json')
      const backup = existsSync(ERR) ? readFileSync(ERR, 'utf8') : null
      try {
        rmSync(ERR, { force: true })
        const r = run(['tools/update/shell-update.mjs', 'check', '--manifest', 'http://127.0.0.1:9/shell-version.json', '--brief', '--quiet-fail', '--allow-untrusted'])
        assert(r.code === 1, '退出码应为 1，实际 ' + r.code)
        assert(!/shell-update:/.test(r.out), '--quiet-fail 不该往 stderr 打错误：' + r.out.trim().slice(-160))
        assert(existsSync(ERR), '没有写错误记录文件')
        const e = JSON.parse(readFileSync(ERR, 'utf8'))
        assert(typeof e.error === 'string' && e.error.length > 0, '错误记录里没有原因')
      } finally {
        if (backup === null) rmSync(ERR, { force: true })
        else writeFileSync(ERR, backup, 'utf8')
      }
    },
  },
  {
    name: 'clean-ship refresh 内容幂等（时间戳不再每次都变）',
    fn() {
      const gitDiff = () => {
        try {
          return String(execFileSync('git', ['diff'], { cwd: ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }))
        } catch { return '' }
      }
      const r1 = run(['devtools/clean-ship.mjs', 'refresh'])
      assert(r1.code === 0, 'refresh 失败：' + r1.out.trim().slice(-200))
      const mid = gitDiff()
      const r2 = run(['devtools/clean-ship.mjs', 'refresh'])
      assert(r2.code === 0, 'refresh 失败：' + r2.out.trim().slice(-200))
      assert(mid === gitDiff(), '第二次 refresh 又改了内容（shipTime/generatedAt 没保住？）')
    },
  },
  {
    name: 'fix-attachment --check 可运行（报告重定向/补丁/旧附件）',
    fn() {
      const r = run(['tools/patch/fix-attachment.mjs', '--check'])
      assert(r.code === 0, '退出码 ' + r.code + '：' + r.out.trim().slice(-200))
      assert(r.out.includes('附件库状态'), '输出缺少摘要：' + r.out.trim().slice(-200))
    },
  },
  {
    name: '安装/清理相关命令在 ps1 分派里都有分支',
    fn() {
      const ps1 = read('dsh-portable.ps1')
      const required = ['market-history', 'fix-attachment', 'plugin-stage', 'plugin-stage-list', 'plugin-activate', 'fix-state', 'tidy', 'doctor', 'verify', 'shell-update', 'migrate-store']
      const missing = required.filter((a) => !new RegExp("^\\s*'" + a + "'\\s*\\{", 'm').test(ps1))
      assert(missing.length === 0, '缺分派分支：' + missing.join(', '))
    },
  },
]
