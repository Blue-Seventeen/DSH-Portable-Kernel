#!/usr/bin/env node
/**
 * 补丁锚点回归（纯文本，不碰任何文件）：官方升级后最容易坏的就是"锚点还认不认得出补丁点"。
 * 这里把两代真实形状（0.2.1-rc.5 / 0.2.2-rc.1）和 pnpm 的几种写法当夹具，断言：
 *   - 能定位到补丁点（findSite / locate）
 *   - 改写后仍能精确还原（siteRevert → 原文）
 *
 * 用法：node tools\selftest-patches.mjs [--quiet]
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const quiet = process.argv.includes('--quiet')
const say = (m) => { if (!quiet) console.log(m) }

const CHECKS = [
  { tool: 'patch-fs.mjs', label: 'fs-local 锚点' },
  { tool: 'patch-pnpm.mjs', label: 'pnpm 锚点' },
]

let failed = 0
for (const item of CHECKS) {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', item.tool), '--selftest'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  })
  const text = ((r.stdout || '') + (r.stderr || '')).trim()
  if (!quiet) for (const line of text.split(/\r?\n/)) console.log(line)
  if (r.status !== 0) {
    failed++
    console.error('  ' + item.label + '：失败（' + item.tool + ' --selftest exit ' + r.status + '）')
  }
}
if (failed) {
  console.error('  补丁锚点自测失败：' + failed + '/' + CHECKS.length)
  process.exit(1)
}
say('  补丁锚点自测通过：' + CHECKS.length + '/' + CHECKS.length)
process.exit(0)
