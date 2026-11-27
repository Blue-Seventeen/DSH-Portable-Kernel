/**
 * 壳根定位（1.0.0 起统一用它，别再靠"往上数几层"）。
 *
 * 背景：0.x 时代所有工具都平铺在 tools/ 下，`dirname(dirname(import.meta.url))` 正好是壳根。
 * 1.0.0 把 tools/ 分了组（update / patch / profile / lib / verify），同一段代码就多退了一层，
 * 于是 ROOT 变成 `<root>\tools` —— 清单扫描直接扫出 0 个文件。固定层数是脆的。
 *
 * 规则（就近优先，只往上走一层层判断）：
 *   这一层有 `shell-version.json` / `dsh-portable.ps1` / `dsh-portable.cmd` → 就是壳根；
 *   或者这一层有 `tools\` 目录 → 也当壳根。
 *
 * 为什么"有 tools\ 也算"：测试夹具都建在工作区的 tmp\ 下，自带一个迷你 `tools\` 但没有清单。
 * 如果只认标记文件，夹具里的工具会一路串到真工作区，去读真实清单和真实 app
 * （2026-11-27 就是这么把一批用例搞成假红/假绿的）。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKERS = ['shell-version.json', 'dsh-portable.ps1', 'dsh-portable.cmd']
const MAX_UP = 8

/** @param {string|URL} from 通常直接传 import.meta.url */
export const shellRoot = (from) => {
  let dir
  try {
    // import.meta.url 是**字符串**（"file:///G:/..."），不是 URL 对象。
    // 直接拿它 dirname 会得到 "file:///G:/x" 这种伪路径，existsSync 永远 false，
    // 一路退到 "." —— ROOT 就变成相对当前工作目录了（2026-11-27 踩过）。
    const s = typeof from === 'string' ? from : from && from.href ? from.href : String(from)
    dir = dirname(/^file:/i.test(s) ? fileURLToPath(new URL(s)) : s)
  } catch {
    return process.cwd()
  }
  for (let i = 0; i < MAX_UP; i++) {
    if (MARKERS.some((m) => existsSync(join(dir, m)))) return dir
    if (existsSync(join(dir, 'tools'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return dir
}