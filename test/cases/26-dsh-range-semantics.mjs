import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, assert } from '../lib.mjs'

/**
 * 内核兼容区间语义（用户 2026-11-27 定下的规矩）：
 *
 *   下界 = 我们真正动手支持过的最早内核（更早的没做，可以拒）
 *   上界 = 我们已经适配并验证到的最新内核，**每次发壳都要往右推**
 *
 * 事故：上界连续几个版本没动（一直是 `<0.2.2-rc.2`），而 npm 上 latest 早就到了 rc.5；
 * 更糟的是它被当成**硬阻断**，于是"内核比壳新"的用户永远收不到壳更新 ——
 * 包括我们自己用 0.6.x 出厂的新用户（出厂内核 rc.5 vs 壳声明 <rc.2，自相矛盾）。
 *
 * 这里钉死两件事：
 *   1. 区间必须写上界，且上界必须是**闭**的（rc.2 是我们适配过的，不该被 `<` 排除）；
 *   2. "内核高于上界"只能警告，不能阻断（否则一上游发版就锁死存量用户）。
 */

const mod = await import(pathToFileURL(join(ROOT, 'tools', 'update', 'shell-update.mjs')).href)
const manifest = JSON.parse(readFileSync(join(ROOT, 'shell-version.json'), 'utf8'))
const range = manifest.requires && manifest.requires.dsh

export const cases = [
  {
    name: '内核区间：必须写上界（开区间等于放弃"适配到哪"这个信息）',
    fn() {
      assert(typeof range === 'string' && range.trim(), 'requires.dsh 缺失')
      const hasUpper = /[<>]=?\s*v?\d/.test(String(range).split(',').map((s) => s.trim()).filter((s) => s.startsWith('<')).join(','))
      assert(hasUpper || /<=?\s*v?\d/.test(range), 'requires.dsh 没有上界：' + range)
    },
  },
  {
    name: '内核区间：上界必须是闭区间且包含已适配的 0.2.2-rc.2',
    fn() {
      // 0.2.2-rc.1 / rc.2 是我们真正适配验证过的一代（doc/compat-report-2026-11-12.md §2.2），
      // 之前写成 `<0.2.2-rc.2` 把 rc.2 本身排除了，而很多用户的桌面就是 rc.2。
      assert(
        mod.satisfiesRange('0.2.2-rc.2', range) === true,
        '0.2.2-rc.2 落在区间外（' + range + '）：它是我们适配过的内核，不该被排除'
      )
      // 2026-11-27：npm 上 latest 已到 0.2.2-rc.5，两个被打的包（fs-local / attachment-local）
      // 在 rc.2→rc.5 之间逐字节不变，所以适配面确实覆盖到 rc.5，上界必须跟上来。
      assert(
        mod.satisfiesRange('0.2.1-rc.5', range) === true,
        '下界 0.2.1-rc.5 自己不在区间内（' + range + '），区间写错了'
      )
    },
  },
  {
    name: '内核区间：清单基线可以保守，但活声明必须覆盖当前最新内核（发版不必为每颗内核重打包）',
    fn() {
      const compat = JSON.parse(readFileSync(join(ROOT, 'compat.json'), 'utf8'))
      const live = compat && compat.dsh && compat.dsh.range
      assert(typeof live === 'string' && live.trim(), 'compat.json 没声明内核区间')
      // 2026-11-27：npm latest 已是 0.2.2-rc.5，且两个被打补丁的包在 rc.2→rc.5 逐字节不变
      assert(
        mod.satisfiesRange('0.2.2-rc.5', live) === true,
        '活声明没覆盖当前最新内核 0.2.2-rc.5（' + live + '）—— 用户会看到"内核出界"的假警告'
      )
    },
  },
  {
    name: '内核区间：比上界更新只能警告，绝不能再阻断壳升级（否则上游一发版就锁死存量用户）',
    fn() {
      const src = readFileSync(join(ROOT, 'tools', 'update', 'shell-update.mjs'), 'utf8')
      assert(
        /advisories\.push\(\{ code: 'requires-dsh-too-new'/.test(src),
        'requires-dsh-too-new 又回到 blockers 里了：内核比壳新会重新变成"壳永远升不了"'
      )
      assert(
        /blockers\.push\(\{ code: 'requires-dsh-too-new'/.test(src) === false,
        'requires-dsh-too-new 同时出现在 blockers 里（会被硬拦）'
      )
    },
  },
  {
    name: '内核区间：compatBlockers 必须分成硬拦与警告两类',
    fn() {
      const src = readFileSync(join(ROOT, 'tools', 'update', 'shell-update.mjs'), 'utf8')
      assert(/const advisories = \[\]/.test(src), 'compatBlockers 里没有 advisories 列表')
      assert(/return \{ blockers, advisories \}/.test(src), 'compatBlockers 的返回值没分成两类')
      const destructured = (src.match(/const \{ blockers, advisories \} = compatBlockers/g) || []).length
      assert(destructured === 3, 'compatBlockers 有 3 个调用点，实际解构了 ' + destructured + ' 个（有地方还在当数组用）')
    },
  },
  {
    name: '内核区间：发版脚本必须自动比对 npm 上的最新内核（上界不许再"一直写着不变"）',
    fn() {
      const src = readFileSync(join(ROOT, 'devtools', 'shell-release.mjs'), 'utf8')
      assert(/checkRangeStale/.test(src), 'prepare 里没有上界过期检查')
      assert(/registry\.npmjs\.org/.test(src), '上界检查没有真的去查 npm')
      assert(/allow-stale-range/.test(src), '没有 --allow-stale-range 显式豁免通道（会导致上游发版直接卡死我们的发布）')
    },
  },
]
