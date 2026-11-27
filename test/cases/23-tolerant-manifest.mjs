import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, assert } from '../lib.mjs'

/**
 * 真实事故回归（2026-11-27）：发布 v0.6.2 时清单里多了一个 `update.cmd`，
 * 结果**所有老用户的升级路被永久掐断**：
 *
 *   whitelist-violation: 清单有 1 条不可用，拒绝整份清单：update.cmd（不在白名单）
 *
 * 根因：`isAllowedShellPath` 同时被"写清单的人"和"读清单的人"使用，而读清单的是
 * **已经装出去的旧版本**——它的白名单里没有新文件名，于是一整份合法清单被判非法。
 * 也就是说：**发一个新文件 = 让所有老用户再也升不了级**。
 *
 * 修法：根目录下的壳脚本（`*.cmd` / `*.bat` / `*.ps1`）不要求逐个登记。
 * 安全边界不放：`app/`、`desktop/`、`runtime/`、`home/` 以及 SHELL_DENY 照样拒绝。
 *
 * 这里把两条都钉死：该放的必须放（否则升级链会再次断掉），该拒的必须拒（否则就是提权洞）。
 */

const mod = await import(pathToFileURL(join(ROOT, 'tools', 'update', 'shell-update.mjs')).href)
const allow = (p) => mod.isAllowedShellPath(p)

export const cases = [
  {
    name: '清单向前兼容：根目录壳脚本不必逐个登记（否则新增入口会掐断所有老用户的升级）',
    fn() {
      const mustAllow = [
        'update.cmd', // 本次新增的永久升级入口
        'repair.cmd', // 以后可能新增的修复入口
        'UPDATE.CMD', // Windows 大小写不敏感
        'a.ps1',
        'b.bat',
        'dsh-portable.ps1',
      ]
      const bad = mustAllow.filter((p) => !allow(p))
      assert(bad.length === 0, '这些根目录脚本被误拒了（老用户会因此无法升级）：' + bad.join(', '))
    },
  },
  {
    name: '清单安全边界：壳范围之外的一切仍然拒绝',
    fn() {
      const mustDeny = [
        'evil.exe',
        'app/x.js',
        'app/node_modules/@deepseek-ai/dsh/lib/bin.js',
        'desktop/resources/app.asar',
        'desktop/y.exe',
        'runtime/node/bin/node.exe',
        'runtime/vcredist/../evil.cmd',
        'version.json',
        '.gitignore',
        '.gitattributes',
        'home/profiles/pnpm-workspace.yaml',
        'home/profiles/desktop/cordis.patch.yml',
        'tools/../../evil.cmd', // 路径逃逸
        'C:/windows/system32/evil.cmd', // 盘符绝对路径
        '/etc/passwd',
        'tools/../app/x.js',
        '',
      ]
      const leaked = mustDeny.filter((p) => allow(p))
      assert(leaked.length === 0, '这些越界/禁止路径被放行了（安全漏洞）：' + leaked.join(', '))
    },
  },
  {
    name: '清单安全边界：tools/ 与 runtime/vcredist/ 前缀照旧放行',
    fn() {
      const mustAllow = ['tools/lib/say.ps1', 'tools/update/shell-update.mjs', 'runtime/vcredist/vc_redist.x64.exe']
      const bad = mustAllow.filter((p) => !allow(p))
      assert(bad.length === 0, '这些壳内路径被误拒：' + bad.join(', '))
    },
  },
  {
    name: '用户可变文件仍被识别（换装时"改过就保留"）',
    fn() {
      const owned = [
        'home/profiles/package.json',
        'home/profiles/pnpm-lock.yaml',
        'home/profiles/web/package.json',
        'home/profiles/desktop/pnpm-lock.yaml',
      ]
      const bad = owned.filter((p) => !mod.isUserOwnedPath(p))
      assert(bad.length === 0, '这些用户可变文件没被识别成 userOwned（升级会覆盖用户配置）：' + bad.join(', '))
      assert(!mod.isUserOwnedPath('tools/lib/say.ps1'), 'tools/ 下的文件不该算用户可变')
    },
  },
  {
    name: '容忍规则必须收窄到 cmd/bat/ps1，不能顺手放行任意根目录文件',
    fn() {
      const src = readFileSync(join(ROOT, 'tools', 'update', 'shell-update.mjs'), 'utf8')
      const m = /const ROOT_ENTRY_RE = \/\^\[a-z0-9\][^/]*\/[^\n]*\n/.exec(src)
      assert(m, '找不到 ROOT_ENTRY_RE 定义（容忍规则被改名或删除，请同步更新本测试）')
      const line = m[0]
      assert(/\(cmd\|bat\|ps1\)/.test(line), 'ROOT_ENTRY_RE 的扩展名集合变了，现在是：' + line.trim())
      assert(!/exe|js|json|dll/.test(line), 'ROOT_ENTRY_RE 里混进了不该放行的扩展名：' + line.trim())
    },
  },
]
