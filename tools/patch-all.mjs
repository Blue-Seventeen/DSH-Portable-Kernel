#!/usr/bin/env node
/**
 * 四族补丁的统一入口：market（商城路径 + drain 语义）/ fs（exFAT 硬链接回退）/ pnpm（项目注册容错）/ attachment（附件库 link 回退）。
 *
 * 为什么要有它：
 *   1) 官方升级（update-app / update-desktop / bootstrap / 商城自更新）会整份替换这些文件，
 *      补丁随之消失。以前只有 `patch-fs` 在启动器里跑、`patch-pnpm` 只在 `repair` 里跑，
 *      于是"升级完能启动、但商城装不上插件"这种半坏状态没人发现（2026-11-04 实测）。
 *   2) 三族各自一套退出码/输出，启动器里写三行判断既难读也容易漏。
 *
 * 用法：
 *   node tools\patch-all.mjs --apply [--quiet] [--json]   打补丁（幂等）
 *   node tools\patch-all.mjs --check [--json]             只查状态
 *   node tools\patch-all.mjs --revert                     全部回退
 *
 * 退出码：0 全好 / 2 本次有改动 / 4 有没打上（可继续用，属 WARN）/ 1 硬失败（锁定、锚点彻底失配）
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const QUIET = argv.includes('--quiet')
const JSONOUT = argv.includes('--json')
const MODE = argv.includes('--revert') ? 'revert' : argv.includes('--apply') ? 'apply' : 'check'

/** fs / pnpm 两族只在 exFAT（compat 档）需要；native 档直接标 n/a */
const compatOnly = () => {
  const profile = process.env.DSH_FS_PROFILE
  if (!profile) return true // 启动器总会先 call env.cmd；手工跑时按"需要"处理
  return profile === 'compat'
}

const FAMILIES = [
  { family: 'market', file: 'patch-market.mjs', compat: false },
  { family: 'fs', file: 'patch-fs.mjs', compat: true },
  { family: 'pnpm', file: 'patch-pnpm.mjs', compat: true },
  { family: 'attachment', file: 'patch-attachment.mjs', compat: true },
]

const say = (m) => { if (!QUIET && !JSONOUT) console.log(m) }

const runOne = (item) => {
  if (item.compat && !compatOnly()) return { family: item.family, state: 'n/a', code: 0, detail: '非 exFAT（native 档）' }
  const args = [join(ROOT, 'tools', item.file), '--' + MODE, '--quiet']
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000 })
  const code = r.status === null ? 1 : r.status
  const text = ((r.stdout || '') + (r.stderr || '')).trim()
  const state = code === 0
    ? (MODE === 'revert' ? 'reverted' : 'applied')
    : code === 2 ? 'applied'
      // 3 = 目标文件被运行中的程序占用（典型：桌面正在用 app.asar）。下次启动会自动补上，属 WARN。
      : code === 3 ? 'needs-work'
        : code === 4 ? 'needs-work' : 'failed'
  const detail = code === 3 ? '目标被占用（桌面在跑），下次启动自动补' : text.split(/\r?\n/).slice(-4).join(' | ')
  return { family: item.family, state, code, detail }
}

const rows = FAMILIES.map(runOne)

if (JSONOUT) {
  console.log(JSON.stringify({ mode: MODE, at: new Date().toISOString(), families: rows }, null, 2))
} else if (!QUIET) {
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n)
  for (const r of rows) {
    const cut = r.detail && r.detail.length > 120 ? r.detail.slice(0, 120) + '…' : r.detail
    console.log('  ' + pad(r.family, 12) + pad(r.state, 12) + (cut ? '  ' + cut : ''))
  }
}

const hardFail = rows.some((r) => r.state === 'failed')
const needsWork = rows.some((r) => r.state === 'needs-work')
const changed = rows.some((r) => r.state === 'applied' && r.code === 2)
if (hardFail) process.exit(1)
if (needsWork) process.exit(4)
process.exit(changed ? 2 : 0)
