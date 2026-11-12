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
 *   5 = env-blocked：子进程根本没起来（受限沙箱 spawnSync EPERM），不是补丁状态。
 *       2026-11-12 事故：把 null status 当成 code=1 → "4 个 family 全 failed" 的伪红，
 *       与真实锚点失配无法区分，误导排查（R21②）。
 *
 * 退出码→状态映射是**本文件唯一的权威契约**（2026-11-12 修复）：
 *   - 以前 `code===2 ? 'applied'` 不分模式：patch-pnpm 的 2 = EXIT_ADAPT（锚点失配，
 *     patch-pnpm.mjs:43）被当成"已打上"→ 官方换内置 pnpm 后装卸插件全链路静默；
 *     patch-attachment 的 check 模式也出 2（半打：app 旧补丁 + asar 被官方整份换掉）。
 *   - 现在 2 的语义按模式门控：apply → applied（本次有改动）；check/revert → needs-work。
 *   - 家族特例在 FAMILIES 条目的 exitMap 里声明（pnpm: 2 恒为 needs-work），加第五族
 *     只改表不动控制流。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
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

/**
 * 家族条目：compat = 只在 exFAT 档生效；exitMap = 覆盖默认映射的特例（键为退出码，值为状态名）。
 * patch-pnpm 的 2（EXIT_ADAPT，锚点失配）在 check/apply 两模式语义一致（patch-pnpm.mjs:295/304），
 * 恒映射 needs-work。
 */
const FAMILIES = [
  { family: 'market', file: 'patch-market.mjs', compat: false },
  { family: 'fs', file: 'patch-fs.mjs', compat: true },
  { family: 'pnpm', file: 'patch-pnpm.mjs', compat: true, exitMap: { 2: 'needs-work' } },
  { family: 'attachment', file: 'patch-attachment.mjs', compat: true },
]

const say = (m) => { if (!QUIET && !JSONOUT) console.log(m) }

/**
 * 退出码 → 状态。MODE 门控是修复的核心：
 *   - apply 模式：0=无改动、2=本次打上（都是 applied）、3/4=needs-work、其余 failed
 *   - check 模式：0=applied（已是打好的状态）、2=needs-work（attachment 半打 / 不该出现在 check，
 *     出现即异常）、3/4=needs-work、其余 failed
 *   - revert 模式：0=reverted、其余（除特例外）failed
 * status === null（spawnSync 没能启动子进程，r.error 必有值）→ 'env-blocked'：
 *   环境不可查 ≠ 补丁失败，不进 hardFail。
 * 导出给测试（test/cases/20-patch-all.mjs）：映射是本次修复的核心逻辑，必须可直接单测。
 */
export const stateOf = (family, mode, code, spawned) => {
  if (!spawned) return 'env-blocked'
  const item = FAMILIES.find((f) => f.family === family)
  if (item && item.exitMap && item.exitMap[code]) return item.exitMap[code]
  if (mode === 'revert') {
    if (code === 0) return 'reverted'
    return 'failed'
  }
  if (code === 0) return 'applied'
  if (code === 2) return mode === 'apply' ? 'applied' : 'needs-work'
  // 3 = 目标文件被运行中的程序占用（典型：桌面正在用 app.asar）。下次启动会自动补上，属 WARN。
  if (code === 3 || code === 4) return 'needs-work'
  return 'failed'
}

const runOne = (item) => {
  if (item.compat && !compatOnly()) return { family: item.family, state: 'n/a', code: 0, detail: '非 exFAT（native 档）' }
  const args = [join(ROOT, 'tools', item.file), '--' + MODE, '--quiet']
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000 })
  // r.status === null 且 r.error 存在 = 子进程根本没启动（EPERM/ENOENT 等），不是工具的正常退出
  const spawned = !(r.status === null && r.error)
  const code = r.status === null ? null : r.status
  const text = ((r.stdout || '') + (r.stderr || '')).trim()
  const state = stateOf(item.family, MODE, code, spawned)
  const detail = state === 'env-blocked'
    ? '子进程未启动（' + (r.error && r.error.code ? r.error.code : 'spawn 失败') + '）：受限会话/安全拦截，非补丁状态'
    : state === 'needs-work' && code === 3 ? '目标被占用（桌面在跑），下次启动自动补'
      : text.split(/\r?\n/).slice(-4).join(' | ')
  return { family: item.family, state, code, detail }
}

// 只有"直接跑这个文件"才执行 CLI：被 test/cases/20-patch-all.mjs 静态 import（单测 stateOf）
// 时不能有副作用——否则 import 会立刻 spawnSync 四族补丁并 process.exit 把测试 runner 一起带走
// （2026-11-12 实测：test/run.mjs 整个静默退出，只剩 patch-all 自己的表）。守卫写法同 shell-update.mjs。
const isMain = (() => {
  try {
    const self = fileURLToPath(import.meta.url)
    const argv1 = process.argv[1] ? resolve(process.argv[1]) : ''
    return !!argv1 && self.toLowerCase() === argv1.toLowerCase()
  } catch { return false }
})()

const main = () => {
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
  const envBlocked = rows.some((r) => r.state === 'env-blocked')
  const changed = rows.some((r) => r.state === 'applied' && r.code === 2)
  if (hardFail) process.exit(1)
  if (needsWork) process.exit(4)
  if (envBlocked) process.exit(5)
  process.exit(changed ? 2 : 0)
}

if (isMain) main()
