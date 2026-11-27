import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, assert } from '../lib.mjs'

/**
 * 机械守卫（2026-11-27 事故晋升）：**清单只允许以"老读取器认得的形状"增长。**
 *
 * 事故经过：v0.6.2 清单里多了一个 `update.cmd`，所有 ≤0.6.1 的机器读清单时直接
 * `whitelist-violation` 拒绝整份清单——不是"看不到更新"，是"永远升不了级"。
 *
 * 根因是**读清单的代码跑在用户机器上，是旧的**。所以每次发布都必须回答：
 * "上一版装在用户机器上的那个读取器，能接受这一版的清单吗？"
 *
 * 本测试自动回答它：
 *   1. 取上一个 tag 的 shell-version.json（= 老用户装的东西）；
 *   2. 取本工作树的清单（= 这次要发的东西）；
 *   3. 差集里的每个新路径都必须是"老读取器容忍的形状"；
 *   4. 若上一版读取器是严格白名单，则一个新文件都不许加 —— 必须先发容忍规则。
 */

const mod = await import(pathToFileURL(join(ROOT, 'tools', 'update', 'shell-update.mjs')).href)

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })

const prevTag = () => {
  try {
    const tags = git(['tag', '--list', 'v*', '--sort=-v:refname']).trim().split(/\r?\n/).filter(Boolean)
    return tags[0] || null
  } catch {
    return null
  }
}

const manifestAt = (ref) => JSON.parse(git(['show', ref + ':shell-version.json']))
const manifestNow = () => JSON.parse(readFileSync(join(ROOT, 'shell-version.json'), 'utf8'))

/** 老读取器能容忍的"新形状"：根目录壳脚本；tools/ 下则是前缀放行 */
const TOLERATED_NEW = [/^[a-z0-9][a-z0-9._-]*\.(cmd|bat|ps1)$/i, /^tools\//i]

export const cases = [
  {
    name: '升级链守卫：本版清单新增的文件，上一版装在用户机器上的读取器必须能接受',
    fn() {
      const tag = prevTag()
      if (!tag) return // 全新仓库，还没有可比的上传点
      let oldSrc = ''
      try {
        oldSrc = git(['show', tag + ':tools/update/shell-update.mjs'])
      } catch {
        return // 早期版本结构不同，跳过
      }
      const oldTolerant = /ROOT_ENTRY_RE/.test(oldSrc)

      const oldFiles = Object.keys(manifestAt(tag).files || {})
      const newFiles = Object.keys(manifestNow().files || {})
      const added = newFiles.filter((f) => !oldFiles.includes(f))
      if (added.length === 0) return

      if (!oldTolerant) {
        assert(
          false,
          '上一版 ' + tag + ' 的读取器是严格白名单，本版却新增了 ' + added.length + ' 个文件（' +
            added.slice(0, 5).join(', ') + '）。这会让所有 ' + tag + ' 及更早的用户 whitelist-violation、' +
            '永久无法升级。正确做法：先发一版"只有容忍规则、不加文件"的壳，下一版再加文件。'
        )
      }

      const bad = added.filter((f) => !TOLERATED_NEW.some((re) => re.test(f)))
      assert(
        bad.length === 0,
        '这些新增文件不在老读取器容忍的形状里（根目录 cmd/bat/ps1，或 tools/ 下），' +
          '老用户会因 whitelist-violation 无法升级：' + bad.join(', ')
      )
    },
  },
  {
    name: '升级链守卫：当前读取器必须仍然向前兼容（容忍规则不能被删掉）',
    fn() {
      const src = readFileSync(join(ROOT, 'tools', 'update', 'shell-update.mjs'), 'utf8')
      assert(
        /ROOT_ENTRY_RE/.test(src),
        'ROOT_ENTRY_RE 不见了：下一个小版本只要新增根目录脚本，就会掐断所有老用户的升级路'
      )
    },
  },
  {
    name: '升级链守卫：清单里的每个路径当前读取器都认（否则本次发布自带死锁）',
    fn() {
      const files = Object.keys(manifestNow().files || {})
      assert(files.length > 0, '清单是空的，不对劲')
      const bad = files.filter((f) => !mod.isAllowedShellPath(f))
      assert(bad.length === 0, '清单里有读取器不认的路径（会 self-block）：' + bad.slice(0, 6).join(', '))
    },
  },
  {
    name: '升级链守卫：永久升级入口 update.cmd 必须在清单里（否则新用户拿不到入口）',
    fn() {
      const files = Object.keys(manifestNow().files || {})
      assert(
        files.includes('update.cmd'),
        'update.cmd 不在清单里：新装的用户没有双击升级入口，只能靠命令行——这正是 0.6.2 之前的状态。'
      )
    },
  },
]
