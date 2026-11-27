import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, NODE, assert, tmpDir } from '../lib.mjs'
import { stateOf } from '../../tools/patch/patch-all.mjs'

/**
 * patch-all 退出码映射回归（2026-11-12 修复）。
 *
 * 两个真实事故在这里固化：
 *   1. exit 2 误映射：`code===2?'applied'` 不分模式/家族——patch-pnpm 的 2 = EXIT_ADAPT
 *      （锚点失配，patch-pnpm.mjs:43）被当成"已打上"，官方换内置 pnpm 后装卸插件全链路静默；
 *      patch-attachment 的 check 模式也出 2（半打）。修复：MODE 门控 + pnpm 的 exitMap 特例。
 *   2. env-blocked 伪红：spawnSync 被受限沙箱 EPERM 拦截时 r.status===null，旧代码映射成
 *      code=1 → 4 个 family 全 failed，与真实锚点失配无法区分（R21②）。修复：独立状态
 *      env-blocked，聚合退出码 5，不进 hardFail。
 *
 * 集成用例用 patch-all 进程 + 真实受沙箱影响的运行环境（能跑到 env-blocked 就说明伪红已灭）；
 * 映射用例直接单测 stateOf（导出即为此）。
 */

export const cases = [
  {
    name: 'patch-all：pnpm 的 exit 2（ADAPT 锚点失配）在 apply/check 都判 needs-work，不是 applied',
    fn() {
      for (const mode of ['apply', 'check']) {
        assert(stateOf('pnpm', mode, 2, true) === 'needs-work', 'pnpm exit 2 在 ' + mode + ' 应为 needs-work，实际 ' + stateOf('pnpm', mode, 2, true))
      }
    },
  },
  {
    name: 'patch-all：fs/attachment 的 exit 2 按模式门控（apply=applied，check=needs-work）',
    fn() {
      assert(stateOf('fs', 'apply', 2, true) === 'applied', 'fs apply/2 应为 applied（本次有改动）')
      assert(stateOf('fs', 'check', 2, true) === 'needs-work', 'fs check/2 应为 needs-work（check 不该有"本次改动"语义）')
      assert(stateOf('attachment', 'apply', 2, true) === 'applied', 'attachment apply/2 应为 applied')
      assert(stateOf('attachment', 'check', 2, true) === 'needs-work', 'attachment check/2（半打）应为 needs-work')
      // market 不出 2（契约矩阵：只 0/1），但映射表兜底行为同样按模式门控
      assert(stateOf('market', 'apply', 2, true) === 'applied', 'market apply/2 兜底应为 applied')
      assert(stateOf('market', 'check', 2, true) === 'needs-work', 'market check/2 兜底应为 needs-work')
    },
  },
  {
    name: 'patch-all：其余退出码语义不变（0/1/3/4 与 revert）',
    fn() {
      assert(stateOf('fs', 'apply', 0, true) === 'applied', 'apply/0 应为 applied')
      assert(stateOf('fs', 'apply', 1, true) === 'failed', 'apply/1（anchor-mismatch）应为 failed')
      assert(stateOf('fs', 'apply', 3, true) === 'needs-work', 'apply/3（locked）应为 needs-work')
      assert(stateOf('fs', 'apply', 4, true) === 'needs-work', 'apply/4（not-patched）应为 needs-work')
      assert(stateOf('fs', 'check', 4, true) === 'needs-work', 'check/4 应为 needs-work')
      assert(stateOf('fs', 'check', 1, true) === 'failed', 'check/1 应为 failed')
      assert(stateOf('fs', 'revert', 0, true) === 'reverted', 'revert/0 应为 reverted')
      assert(stateOf('fs', 'revert', 1, true) === 'failed', 'revert/1 应为 failed')
    },
  },
  {
    name: 'patch-all：子进程没启动（status=null）判 env-blocked，不是 failed',
    fn() {
      assert(stateOf('pnpm', 'check', null, false) === 'env-blocked', '未启动应判 env-blocked')
      assert(stateOf('market', 'apply', null, false) === 'env-blocked', '未启动任何家族都应判 env-blocked')
      // 反向：正常退出的判定不受 spawned=false 影响（不该有人这么调，但契约要明确）
      assert(stateOf('fs', 'apply', 1, true) === 'failed', '正常退出 1 仍是 failed')
    },
  },
  {
    name: 'patch-all：集成——本会话若被沙箱拦截，输出 env-blocked 且整体 exit 5（伪红已灭）',
    fn() {
      // 直接跑真 patch-all：受限会话（EPERM）下应为 env-blocked/5；完全权限下应为真实状态（0/2/4，无 failed）。
      // 两种环境都断言同一件事：不允许出现"failed 且 detail 为空"（= 伪红签名）。
      const out = execFileSync(NODE, [join(ROOT, 'tools', 'patch', 'patch-all.mjs'), '--check', '--json'], {
        encoding: 'utf8', cwd: ROOT, timeout: 120000, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const j = JSON.parse(String(out))
      for (const f of j.families) {
        if (f.state === 'env-blocked') {
          assert(f.code === null, 'env-blocked 的 code 应为 null，实际 ' + f.code)
          assert(/未启动/.test(f.detail), 'env-blocked 的 detail 应说明子进程未启动，实际：' + f.detail)
          continue
        }
        assert(f.state !== 'failed' || String(f.detail || '').trim().length > 0,
          '伪红签名：family=' + f.family + ' state=failed 且 detail 为空（子进程没起来的旧 bug）')
      }
    },
  },
  {
    name: 'patch-all：聚合退出码不把 env-blocked 算成硬失败（受限会话里 exit 5 非 1）',
    fn() {
      // 在受限会话里跑文本模式，拿退出码：EPERM 环境应得 5（env-blocked），普通环境得 0/2/4。
      // 唯独不该出现 1（旧 bug 把 EPERM 映射成 code=1 → hardFail → exit 1）。
      let code
      try {
        execFileSync(NODE, [join(ROOT, 'tools', 'patch', 'patch-all.mjs'), '--check', '--quiet'], {
          encoding: 'utf8', cwd: ROOT, timeout: 120000, windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        code = 0
      } catch (e) {
        code = e.status === null || e.status === undefined ? 1 : e.status
      }
      assert(code !== 1, 'patch-all --check 退出码为 1：要么真锚点失配（detail 应非空），要么 env-blocked 被误判成硬失败（旧 bug）。code=' + code)
      assert([0, 2, 4, 5].includes(code), '聚合退出码应在 {0,2,4,5} 内，实际 ' + code)
    },
  },
]
