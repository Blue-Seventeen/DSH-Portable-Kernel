import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, assert } from '../lib.mjs'

/**
 * 运行期依赖必须在壳里（2026-11-27 教训）。
 *
 * 1.0.0 重排时我把 tools/7z 当成"只给发布用的打包器"挪进了 devtools（不进清单、不进整包）。
 * 这是**判断错误**：7z 在运行期至少三处在用 ——
 *   - shell-update --full 解整包
 *   - dsh-portable.ps1 更新内核时解官方 tar.gz
 *   - 更新桌面窗口时解 NSIS 里的 $PLUGINSDIR\app-64.7z（tar 顶不了）
 * 后果：1.0.1 的用户一旦需要 --full 或更新内核/桌面，会直接 no-7z 失败。
 *
 * 这个用例守两件事：
 *   1) 运行期必需的工具必须在清单里（清单 = 用户手上会有的东西）
 *   2) 化石清单清理绝不能把"新版清单里还有"的路径当成残留删掉
 */

export const cases = [
  {
    name: '壳清单必须带 7z（运行期解包依赖，不是发布工具）',
    fn() {
      const m = JSON.parse(readFileSync(join(ROOT, 'shell-version.json'), 'utf8'))
      for (const rel of ['tools/7z/7z.exe', 'tools/7z/7z.dll']) {
        assert(rel in m.files, '清单里没有 ' + rel + '（用户装完就没有解包能力）')
        assert(existsSync(join(ROOT, rel)), '磁盘上缺 ' + rel)
      }
    },
  },
  {
    name: '壳里所有"运行期引用"的工具都在清单内（不许有 devtools 泄漏）',
    fn() {
      const m = JSON.parse(readFileSync(join(ROOT, 'shell-version.json'), 'utf8'))
      const inManifest = new Set(Object.keys(m.files))
      // 这些文件会在用户机器上被执行，任何一个路径写错都会让用户侧功能失效
      const runtimeRefs = [
        'tools/update/shell-update.mjs',
        'tools/update/shell-apply.mjs',
        'tools/update/update-check.mjs',
        'tools/update/compat-live.mjs',
        'tools/update/version-range.mjs',
        'tools/update/shell-migrations.mjs',
        'tools/patch/patch-all.mjs',
        'tools/profile/plugin-shared.mjs',
        'tools/profile/fix-pnpm-state.mjs',
        'tools/lib/shell-root.mjs',
        'tools/lib/preflight.mjs',
        'tools/lib/say.ps1',
        'tools/lib/download.mjs',
        'tools/lib/asar-lite.mjs',
        'tools/lib/mask-log.mjs',
        'tools/verify/verify-shell.mjs',
        'tools/7z/7z.exe',
        'tools/7z/7z.dll',
      ]
      const missing = runtimeRefs.filter((r) => !inManifest.has(r))
      assert(missing.length === 0, '这些运行期文件不在清单里：' + missing.join(', '))
    },
  },
  {
    name: '运行期脚本引用 devtools 时必须优雅降级（用户没有那个目录）',
    fn() {
      const files = [
        'dsh-portable.ps1',
        'tools/update/shell-update.mjs',
        'tools/lib/preflight.mjs',
        'tools/verify/verify-shell.mjs',
      ]
      for (const f of files) {
        const t = readFileSync(join(ROOT, f), 'utf8')
        // 7z 是运行期依赖，绝对不许指向 devtools
        assert(!/devtools[\\/]7z/.test(t), f + ' 又把 7z 指向 devtools 了（那是运行期解包依赖）')
      }
      // ps1 里若引用 devtools 的其他工具（维护者命令），必须紧跟存在性检查与说明
      const ps1 = readFileSync(join(ROOT, 'dsh-portable.ps1'), 'utf8')
      const lines = ps1.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (!/Join-Path \$Root 'devtools/.test(lines[i])) continue
        const next = lines.slice(i + 1, i + 4).join('\n')
        assert(/Test-Path/.test(next), 'L' + (i + 1) + ' 引用 devtools 后没有 Test-Path 存在性检查：' + lines[i].trim())
      }
    },
  },
  {
    name: '化石清单清理不许删"新版清单里仍然存在"的路径',
    fn() {
      const src = readFileSync(join(ROOT, 'tools/update/shell-update.mjs'), 'utf8')
      assert(/const live = new Set\(\)/.test(src), 'pruneLegacy 没有 live 集合')
      assert(/if \(live\.has\(lower\(rel\)\)\) continue/.test(src), 'pruneLegacy 没跳过当前清单里的路径')
      assert(/if \(liveSet\.has\(lower\(rel\)\)\) continue/.test(src), 'computeRemoved 无清单分支没跳过当前清单里的路径')
      // 前置条件：新版清单里确实有 tools/7z（否则上面的重叠保护永远用不上，测了个寂寞）
      const m = JSON.parse(readFileSync(join(ROOT, 'shell-version.json'), 'utf8'))
      assert('tools/7z/7z.exe' in m.files, '前置条件不成立：新版清单里应有 tools/7z/7z.exe')
    },
  },

  {
    name: 'verify 不许依赖 devtools：用户环境没有那个目录，跑 verify 不能报红',
    fn() {
      const src = readFileSync(join(ROOT, 'tools/verify/verify-shell.mjs'), 'utf8')
      // 1) 必需文件清单里不许出现 devtools（那是维护者工具，用户没有）
      const needBlock = src.match(/const need = \[([\s\S]*?)\]/)
      assert(needBlock, '找不到必需文件清单')
      assert(!/devtools\//.test(needBlock[1]), '必需文件清单里又混进了 devtools：' + needBlock[1].match(/devtools\/[^']+/g))
      // 2) 任何对 devtools 的执行都必须先过 MAINT 守卫
      const lines = src.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (!/run\(\[join\(ROOT, 'devtools\//.test(lines[i])) continue
        const before = lines.slice(Math.max(0, i - 3), i).join('\n')
        assert(/MAINT\(/.test(before), 'L' + (i + 1) + ' 执行 devtools 前没有 MAINT 守卫：' + lines[i].trim())
      }
    },
  },
]
