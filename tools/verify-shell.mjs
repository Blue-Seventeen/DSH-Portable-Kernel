/**
 * 兼容转发桩（1.0.6 起）。
 *
 * 为什么需要它：
 *   0.5.x - 0.7.x 的 shell-update 把"换装后自检"的路径**写死**成 tools\verify-shell.mjs。
 *   1.0.0 把工具按职责分了组，自检搬到 tools\verify\verify-shell.mjs —— 于是老客户端
 *   换装到新结构后，自检启动时那条路径已经不存在，node 报 Cannot find module，
 *   旧代码判定"自检不通过"→ 整份回滚。结果是：**带清单的老壳永远升不到新结构**。
 *   （2026-11-27 在真实 0.5.1 安装上实测踩到，只能靠 --no-verify 绕过。）
 *
 * 修法：
 *   在新结构里保留这个路径，做一层**瘦转发**：把参数原样交给真正的自检脚本，
 *   退出码原样透传。这样老客户端的自检照常真跑，安全网没有缺口。
 *
 * 注意：
 *   - 本文件只做转发，不实现任何检查，避免两份逻辑漂移。
 *   - 打印给用户看的文字一律 ASCII（这个桩可能在老壳的控制台里跑，代码页不确定）；
 *     文件本身是 UTF-8 无 BOM + LF，与仓库其它 .mjs 一致。
 *   - 新版客户端（1.0.6+）直接调用 tools\verify\verify-shell.mjs，不会经过这里；
 *     这个桩只为"上一代客户端"存在，未来可以随最低支持版本一起下线。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const real = join(here, 'verify', 'verify-shell.mjs')

if (!existsSync(real)) {
  process.stderr.write('verify-shell: cannot find ' + real + ' (shell incomplete; re-run shell-update)\n')
  process.exit(2)
}

const r = spawnSync(process.execPath, [real, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true })
if (r.error) {
  process.stderr.write('verify-shell: failed to start real verifier: ' + String(r.error.message || r.error) + '\n')
  process.exit(2)
}
process.exit(r.status === null || r.status === undefined ? 1 : r.status)