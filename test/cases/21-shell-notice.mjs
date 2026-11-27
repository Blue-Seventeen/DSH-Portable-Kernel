import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ROOT, assert, copyShellRoot, run, tmpDir } from '../lib.mjs'

/**
 * 真实事故回归（2026-11-26）：用户"习惯双击 start-desktop.cmd"，
 * 十几天里从未收到过壳更新提示——因为 start-desktop.cmd 这条路径根本不查壳更新
 * （只有 dsh-portable.cmd 的菜单会查）。现在 check-update.cmd 里加了一条缓存版检查
 * （shell-update.mjs check --cached 180 --notice），只输出一行。
 *
 * --notice 的三条硬约束（都在这里固化）：
 *   1. 远端确实更新才输出，且只一行（不能把整段 notes 糊到启动窗口里）；
 *   2. 同版本、只是本地有改动 → 必须静默（否则改了壳文件后每次启动都喊"有新版"）；
 *   3. 已有更新但被兼容性挡下 → 输出"挡下"那句，不能假装没有。
 *
 * 夹具：把 shell-update.mjs + version-range.mjs 拷进隔离根，配一份本地清单
 * 和一份"远端清单文件"，用 --manifest <本地文件> 走 kind=local 分支（不联网、不写缓存）。
 */

const copyTool = (dir, name) => {
  mkdirSync(join(dir, 'tools'), { recursive: true })
  // 1.0.0 起 tools/ 分组了：按名字找真实位置
  const TOOL_GROUP = { 'shell-update.mjs': 'update', 'shell-apply.mjs': 'update', 'version-range.mjs': 'update', 'compat-live.mjs': 'update', 'update-check.mjs': 'update', 'shell-migrations.mjs': 'update', 'asar-lite.mjs': 'lib', 'say.ps1': 'lib', 'patch-fs.mjs': 'patch' }
  const g = TOOL_GROUP[name] || 'lib'
  mkdirSync(dirname(join(dir, 'tools', g, name)), { recursive: true })
  copyFileSync(join(ROOT, 'tools', g, name), join(dir, 'tools', g, name))
  copyShellRoot(dir)
}

const makeShell = (installedVersion) => {
  const dir = tmpDir('shell-notice')
  copyTool(dir, 'shell-update.mjs')
  // shell-update 静态 import 这两个：少拷一个就是 ERR_MODULE_NOT_FOUND（夹具也会假红）
  copyTool(dir, 'shell-apply.mjs')
  copyTool(dir, 'version-range.mjs')
  // 2026-11-27 起 shell-update 还静态 import compat-live.mjs（兼容性活声明）
  copyTool(dir, 'compat-live.mjs')
  writeFileSync(join(dir, 'shell-version.json'), JSON.stringify({
    schemaVersion: 2,
    updaterMin: 2,
    channel: 'stable',
    shellVersion: installedVersion,
    tag: 'v' + installedVersion,
    requires: { dsh: '>=0.2.1-rc.5', node: '>=24.0.0' },
    files: { 'README.md': 'a'.repeat(64) },
    userOwned: [],
  }, null, 2), 'utf8')
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  return dir
}

/** 造一份"远端清单"；override 可改写任意字段（用来造 blocked） */
const writeRemote = (dir, remoteVersion, override) => {
  const base = {
    schemaVersion: 2,
    updaterMin: 2,
    channel: 'stable',
    shellVersion: remoteVersion,
    tag: 'v' + remoteVersion,
    minShellVersion: '0.1.0',
    requires: { dsh: '>=0.2.1-rc.5', node: '>=24.0.0' },
    files: { 'README.md': 'a'.repeat(64) },
    userOwned: [],
    notes: { added: ['x'], fixed: ['y'], optimized: [], breaking: [], upgrade: [], rollback: [] },
  }
  const p = join(dir, 'remote-manifest.json')
  writeFileSync(p, JSON.stringify(Object.assign(base, override || {}), null, 2), 'utf8')
  return p
}

const withShell = (installedVersion, fn) => {
  const dir = makeShell(installedVersion)
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** 跑 check，返回 { code, out }（test/lib 的 run() 已经捕获非零退出码，别自己再包一层 try/catch） */
const check = (dir, extraArgs) =>
  run([join(dir, 'tools', 'update', 'shell-update.mjs'), 'check', '--manifest', join(dir, 'remote-manifest.json'), ...extraArgs])

const nonEmptyLines = (out) => String(out).trim().split(/\r?\n/).filter((l) => l.trim())

export const cases = [
  {
    name: '壳更新提示：--notice 只输出一行，不带 notes 明细',
    fn() {
      withShell('0.5.1', (dir) => {
        writeRemote(dir, '0.5.2')
        const { code, out } = check(dir, ['--notice'])
        assert(code === 0, '--notice 在有更新时应退出 0，实际 ' + code)
        const lines = nonEmptyLines(out)
        assert(lines.length === 1, '--notice 应只输出一行，实际 ' + lines.length + ' 行：\n' + out)
        assert(out.includes('壳有新版'), '--notice 没说明"壳有新版"：' + out.trim())
        assert(out.includes('0.5.1') && out.includes('0.5.2'), '--notice 没带上版本号：' + out.trim())
        // 启动窗口里不能出现 notes 的六节内容（--brief 会把整段贴出来，正是它不适合启动提示）
        assert(!out.includes('破坏性变更'), '--notice 把 notes 明细也打出来了（应只一行）')
      })
    },
  },
  {
    name: '壳更新提示：同版本、只是本地有改动时必须静默（否则每次启动都喊有新版）',
    fn() {
      withShell('0.5.2', (dir) => {
        writeRemote(dir, '0.5.2')
        const { out } = check(dir, ['--notice'])
        assert(String(out).trim() === '', '同版本时 --notice 的输出必须为空，实际：' + out)
      })
    },
  },
  {
    name: '壳更新提示：--notice 与 --brief 互不干扰',
    fn() {
      withShell('0.5.2', (dir) => {
        writeRemote(dir, '0.5.2')
        assert(String(check(dir, ['--notice']).out).trim() === '', '--notice 无更新时应完全静默')
        const brief = check(dir, ['--brief']).out
        assert(brief.includes('SHELL'), '--brief 的既有输出被 --notice 影响了：' + brief)
      })
    },
  },
  {
    name: '壳更新提示：被兼容性挡下时要说"挡下"，不能当作没更新',
    fn() {
      withShell('0.5.1', (dir) => {
        // 本机装了一个 rc.5 内核；远端清单却要求 >=9.9.9 → satisfiesRange 为 false → blocked。
        // 注意：compatBlockers 只在能读到本机 dsh 版本时才判 requires.dsh，
        // 所以夹具必须给出 app\node_modules\@deepseek-ai\dsh\package.json（真实壳也有）。
        const dshDir = join(dir, 'app', 'node_modules', '@deepseek-ai', 'dsh')
        mkdirSync(dshDir, { recursive: true })
        writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.5' }), 'utf8')
        writeRemote(dir, '0.5.2', { requires: { dsh: '>=9.9.9', node: '>=24.0.0' } })
        const { code, out } = check(dir, ['--notice'])
        assert(code === 3, '被挡下时 --notice 应退出 3（EXIT_BLOCKED），实际 ' + code + '，输出：' + out)
        assert(out.includes('挡下'), '被挡下时没说出来：' + out.trim())
        assert(nonEmptyLines(out).length === 1, '挡下时也应只一行，实际：' + out)
      })
    },
  },
  {
    name: '壳更新提示：--notice 必须用短超时 + 单次尝试（启动路径不能被网络拖住）',
    fn() {
      // 2026-11-26 复测：一次网络卡顿把 check-update.cmd 整体拖到 91 秒（正常 6 秒）。
      // 启动路径上不能等，--notice 必须比交互式检查更急：4 秒、单次。
      // 漏报一次不要紧（下次启动还会查，--quiet-fail 保证失败不出噪音），拖住启动才是事故。
      const src = readFileSync(join(ROOT, 'tools', 'update', 'shell-update.mjs'), 'utf8')
      assert(/if \(a\.notice\) \{ FETCH_TIMEOUT_MS = 4000; RETRIES = 1 \}/.test(src),
        '--notice 没有设置短超时单次尝试（网络抽风会把启动拖到几十秒）')
      // 交互式/--brief 的长超时不能跟着一起被改短
      assert(/if \(a\.brief\) \{ FETCH_TIMEOUT_MS = 10000; RETRIES = 2 \}/.test(src),
        '--brief 的超时被改动了（交互式检查需要更宽松的重试）')
    },
  },
  {
    name: 'check-update.cmd：内核检查没输出时不能再吐 "语法不正确"（UPDLINE 必须用哨兵初值）',
    fn() {
      // 2026-11-26 复测发现：UPDLINE 原来初始化为空串，随后 `if /i "%UPDLINE:~0,4%"=="UPD "` 在
      // 空值上展开成空文本，cmd 直接把整条 if 判为语法错误并打印
      // "The syntax of the command is incorrect."——每次双击启动都多一行红字。
      // 老脚本永远有一条内核消息要解析，这条路到不了；0.6.0 让内核检查可以沉默，才暴露出来。
      //
      // 做法：把真实文件里的「verdict」段原样抽出来跑，两种输入各验一次。
      // 不复制粘贴那几行——用例必须盯着真文件，否则改坏了也检测不到。
      const src = readFileSync(join(ROOT, 'check-update.cmd'), 'utf8')
      const lines = src.split(/\r?\n/)
      const start = lines.findIndex((l) => l.startsWith('rem --- 3) verdict'))
      const end = lines.findIndex((l, i) => i > start && l.trim() === ':hold')
      assert(start !== -1 && end !== -1, '找不到 check-update.cmd 的 verdict 段')

      const verdict = lines.slice(start, end).filter((l) => !/^\s*rem/i.test(l) && l.trim() !== '')
      assert(verdict.some((l) => /set "UPDLINE=-"/.test(l)), 'UPDLINE 没有用哨兵初值初始化')
      assert(!verdict.some((l) => /set "UPDLINE="\s*$/.test(l)), 'UPDLINE 仍被初始化为空串')

      const runVerdict = (kernMsg, shellNotice) => {
        const dir = tmpDir('verdict')
        mkdirSync(dir, { recursive: true })   // tmpDir() 只拼路径，不建目录
        try {
          const body = [
            '@echo off',
            'set "KERNMSG="',
            'set "SHELLNOTICE="',
            kernMsg ? 'set "KERNMSG=1"' : 'rem no kernel msg',
            shellNotice ? 'set "SHELLNOTICE=1"' : 'rem no shell notice',
            'set "MSGFILE=%~dp0msg.txt"',
            ...(kernMsg ? [':write_msg'] : []),
            ...verdict.map((l) => l.replace(/%MSGFILE%/g, '%~dp0msg.txt')),
            ':hold',
            'echo [HOLD]',
            'exit /b 0',
            ':upd_ask',
            'echo [UPD_ASK]',
            'exit /b 0',
          ].join('\r\n')
          writeFileSync(join(dir, 'v.cmd'), body, 'ascii')
          writeFileSync(join(dir, 'msg.txt'), kernMsg ? kernMsg + '\r\n' : '', 'utf8')
          // .cmd 不能直接 execFileSync（Windows 上会 ENOENT），必须过 cmd /c
          const r = run(['cmd', '/c', join(dir, 'v.cmd')], { raw: true })
          return { code: r.code, out: r.out }
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }

      // 场景 1：两边都沉默 → 不许有任何输出、不许进停留、退出码 0
      const silent = runVerdict('', false)
      assert(!/syntax of the command/i.test(silent.out), '内核沉默时仍报语法错误：' + silent.out)
      assert(!silent.out.includes('[HOLD]'), '两边都没有提示时不该停留')
      assert(silent.code === 0, '内核沉默时应正常退出，实际 ' + silent.code + '：' + silent.out)

      // 场景 2：内核有 KERN 消息 → 进停留
      const kern = runVerdict('KERN app 1.0 -> 9.9', false)
      assert(!/syntax of the command/i.test(kern.out), 'KERN 时仍报语法错误：' + kern.out)
      assert(kern.out.includes('[HOLD]'), 'KERN 时应停留：' + kern.out)

      // 场景 3：UPD 前缀 → 必须进 Y/N 询问（哨兵不能把 UPD 判定带偏）
      const upd = runVerdict('UPD app 1.0 -> 2.0', false)
      assert(upd.out.includes('[UPD_ASK]'), 'UPD 前缀没有进入 Y/N 询问：' + upd.out)
    },
  },
  {
    name: '壳更新提示：check-update.cmd 确实接了 --notice，且通知会触发停留',
    fn() {
      const src = readFileSync(join(ROOT, 'check-update.cmd'), 'utf8')
      assert(/shell-update\.mjs"?\s+check\s+--cached\s+\d+\s+--notice/.test(src),
        'check-update.cmd 没接 shell-update --notice（双击 start-desktop.cmd 就看不到壳更新）')
      assert(/if defined SHELLNOTICE goto hold/.test(src), '有壳更新时没有进入停留分支')
      assert(/if defined SHELLNOTICE powershell .* -Key shell-hold/.test(src), '停留时没打印 shell-hold 说明')
      // 纯 ASCII 铁律：.cmd 里不能有中文（双击时按 OEM 代码页解析会错位）
      assert(/^[\x00-\x7F]*$/.test(src), 'check-update.cmd 含有非 ASCII 字符')
    },
  },
  {
    name: '脚本卫生：所有 .cmd 的 rem 行都不得含 "/?"（会打印 REM 帮助文本）',
    fn() {
      // 2026-11-26 实测：env.cmd 里一行被写成 "rem ???/???"，每次启动都往控制台
      // 糊三行英文 REM 帮助（"Records comments (remarks) in a batch file..."）。
      const cmds = ['env.cmd', 'check-update.cmd', 'start-desktop.cmd', 'start-web.cmd', 'preflight.cmd', 'dsh-portable.cmd']
      for (const f of cmds) {
        let src
        try { src = readFileSync(join(ROOT, f), 'utf8') } catch { continue }
        const bad = src.split(/\r?\n/).filter((l) => /^\s*rem/i.test(l) && l.includes('/?'))
        assert(bad.length === 0, f + ' 的 rem 行含 "/?"，会打印 REM 帮助：' + (bad[0] || ''))
        assert(/^[\x00-\x7F]*$/.test(src), f + ' 含有非 ASCII 字符（.cmd 必须纯 ASCII）')
      }
    },
  },
]