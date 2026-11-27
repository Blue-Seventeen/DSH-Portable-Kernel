import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, assert, run, tmpDir } from '../lib.mjs'

/**
 * 真实事故回归（2026-11-27）：用户双击 dsh-portable.cmd（默认动作 = doctor 体检），
 * 输出停在 "login-bak : 0" 之后就不动了，看起来像卡死。
 *
 * 根因：doctor 的 Get-LeftoverCount 用递归全量遍历 tmp / cache / logs。
 * 那个便携目录的 tmp 里堆了 84 万文件（dsh 运行时目录、Office 转换临时目录、自测夹具…），
 * 在 exFAT 上遍历一遍实测 85% CPU 烧了 3.9 分钟。
 *
 * 修复：只查「会留下半成品的固定位置」——两个 journal、app.next/desktop.next、
 * cache\update\*.part、以及 tmp/cache/logs 顶层的散落临时文件。常数级开销。
 *
 * 这里固化三条：
 *   1. 函数体内不许出现递归参数（否则又会随 tmp 膨胀而变慢）；
 *   2. 不许用文件系统的过滤器参数（Windows 按 8.3 后缀匹配，"*.tmp" 会连 xxx.tmp.png 也算上）；
 *   3. 行为正确：已知残留必须数到，深层子目录里的东西一律不算。
 */

/** 从真实的 dsh-portable.ps1 里按花括号配平抽出函数（测的就是真代码，不复制粘贴） */
const extractFunction = (src, name) => {
  const i = src.indexOf('function ' + name + ' {')
  assert(i !== -1, '找不到函数 ' + name)
  let depth = 0
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') {
      depth--
      if (depth === 0) return src.slice(i, k + 1)
    }
  }
  throw new Error('函数花括号不配平：' + name)
}

const write = (p, body) => writeFileSync(p, body, 'utf8')

/** 造夹具：已知残留 + 一坨深层垃圾（新实现必须完全忽略深层） */
const makeFixture = () => {
  const dir = tmpDir('leftover')
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, 'tmp')
  const cache = join(dir, 'cache')
  const update = join(cache, 'update')
  mkdirSync(tmp, { recursive: true })
  mkdirSync(update, { recursive: true })

  // 应当数到的（4 个）
  write(join(tmp, 'update-journal.json'), '{}')
  write(join(tmp, 'shell-update-journal.json'), '{}')
  mkdirSync(join(dir, 'desktop.next'), { recursive: true })
  write(join(update, 'deepseek-harness-9.9.9-win-x64.exe.part'), 'x')
  write(join(tmp, 'stray.tmp'), 'x')
  // → app.next 也加上，共 6 个
  mkdirSync(join(dir, 'app.next'), { recursive: true })

  // 不该数到的：深层子目录
  mkdirSync(join(tmp, 'dsh-spill-AAA', 'nested', 'deeper'), { recursive: true })
  write(join(tmp, 'dsh-spill-AAA', 'nested', 'deeper', 'junk.part'), 'x')
  write(join(tmp, 'dsh-spill-AAA', 'nested', 'junk.tmp'), 'x')
  // 不该数到的：活跃会话的截图临时文件（名字以 .tmp.png 结尾，不算 .tmp）
  write(join(tmp, 'abcd-1234.tmp.png'), 'x')
  // 不该数到的：cache 下的正经缓存（子目录里）
  mkdirSync(join(cache, 'pnpm-store', 'v11'), { recursive: true })
  write(join(cache, 'pnpm-store', 'v11', 'index.json.tmp'), 'x')

  return dir
}

export const cases = [
  {
    name: '体检残留统计：不许递归遍历 tmp（84 万文件会把 doctor 烧几分钟）',
    fn() {
      const src = readFileSyncOrThrow(join(ROOT, 'dsh-portable.ps1'))
      const fn = extractFunction(src, 'Get-LeftoverCount')
      assert(!/-Recurse/.test(fn), 'Get-LeftoverCount 又出现了递归遍历（tmp 一膨胀体检就会卡住）')
      assert(!/-Filter/.test(fn), 'Get-LeftoverCount 用了过滤器参数（按 8.3 后缀匹配会误报 xxx.tmp.png）')
      assert(/-like/.test(fn), 'Get-LeftoverCount 应该用 -like 精确匹配文件名')
    },
  },
  {
    name: '体检残留统计：已知残留数得到，深层子目录一律不算',
    fn() {
      const src = readFileSyncOrThrow(join(ROOT, 'dsh-portable.ps1'))
      const fn = extractFunction(src, 'Get-LeftoverCount')
      const dir = makeFixture()
      try {
        const probe = join(dir, 'probe.ps1')
        const body = [
          "$Root = '" + dir + "'",
          "$Journal = Join-Path $Root 'tmp\\update-journal.json'",
          "$UpdateCache = Join-Path $Root 'cache\\update'",
          fn,
          '$sw = [Diagnostics.Stopwatch]::StartNew()',
          '$c = Get-LeftoverCount',
          '$sw.Stop()',
          "Write-Output ('COUNT=' + $c)",
          "Write-Output ('MS=' + [int]$sw.Elapsed.TotalMilliseconds)",
        ].join('\r\n')
        write(probe, body)
        const r = run(['powershell', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe], { raw: true })
        const count = Number((/COUNT=(\d+)/.exec(r.out) || [])[1])
        const ms = Number((/MS=(\d+)/.exec(r.out) || [])[1])
        assert(Number.isFinite(count), '探针没输出 COUNT：' + r.out.trim().slice(-300))
        // 2 个 journal + app.next + desktop.next + cache\update\*.part + tmp\stray.tmp = 6
        assert(count === 6, '残留计数应为 6（实际 ' + count + '）：深层垃圾或 .tmp.png 被误算了')

        assert(Number.isFinite(ms), '探针没输出 MS')
        assert(ms < 3000, '统计耗时 ' + ms + ' ms，太慢（新实现应该是常数级、几十毫秒）')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  },
]

const readFileSyncOrThrow = (p) => readFileSync(p, 'utf8')