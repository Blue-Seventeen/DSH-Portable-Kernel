import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, assert } from '../lib.mjs'

/**
 * 从 Release zip 解压出来的壳没有 `shell-version.json`（整包故意不含清单：
 * 清单要记 zip 自己的 sha256，塞进去就成了循环依赖）。
 *
 * 2026-11-27 QA 实测出的 P0：这种"无清单"安装，普通 `apply` **100% 失败**——
 *
 *   shell-update.mjs 的 computePlan 里有一条"tools/ 目录下的陌生文件是用户自建脚本，永不覆盖"
 *   的保护条款，判据是 `installed.files[rel] === undefined`。可是没有本地清单时
 *   `installed.files` 是空对象，于是**所有内容有变化的 tools 文件全被判 preserved**：
 *   不下载、不进 staging。而 shell-apply 的 plan 只认 userOwned，其余一律要求 staging 里有它，
 *   原子预写校验必然报 `staging 里缺这个文件`，整包一个字节都不落盘。
 *
 * 修法：这条"陌生文件=用户自建"的推断，只在**存在本地清单**时成立。
 * 无从证明是用户改动时，以远端清单为准（远端清单本身就声明了"这个路径是壳文件"）。
 *
 * 这个缺陷能发布出去，是因为发布门禁只比"清单 vs 资产"，从没测过"zip 装出来的壳能不能自己升"。
 * 下面这几条就是补这个盲区。
 */

const mod = await import(pathToFileURL(join(ROOT, 'tools', 'update', 'shell-update.mjs')).href)

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

/** 造一份远端清单：两个 tools 文件 + 一个 userOwned */
const remoteManifest = () => ({
  files: { 'tools/patch/patch-fs.mjs': SHA_A, 'tools/custom.mjs': SHA_A, 'home/profiles/package.json': SHA_A },
  userOwned: ['home/profiles/package.json'],
})

const actionOf = (rows, p) => (rows.find((r) => r.path === p) || {}).action

/** 模拟"本地文件都在，但内容都是旧版"（sha 与远端清单不同） */
const LOCAL_OLD = { 'tools/patch/patch-fs.mjs': SHA_B, 'tools/custom.mjs': SHA_B, 'home/profiles/package.json': SHA_B }

export const cases = [
  {
    name: '无本地清单（zip 安装）：内容有差异的 tools 文件必须判 update，不能判 preserved',
    fn() {
      // 本地三个文件都存在但内容都"旧"（sha 与远端不同）
      const plan = mod.computePlanForTest
        ? mod.computePlanForTest(remoteManifest(), { present: false, files: {} }, LOCAL_OLD)
        : null
      assert(plan, 'shell-update 没有导出 computePlanForTest（测试钩子）')
      assert(
        actionOf(plan, 'tools/patch/patch-fs.mjs') === 'update',
        '无清单时 tools/patch/patch-fs.mjs 被判成 ' + actionOf(plan, 'tools/patch/patch-fs.mjs') +
        ' —— 这正是 P0：它会被跳过、不进 staging，apply 必然报"staging 里缺这个文件"'
      )
      assert(actionOf(plan, 'tools/custom.mjs') === 'update', '无清单时陌生 tools 文件也该更新')
    },
  },
  {
    name: '有本地清单且该路径确实没装过：仍然保留（保护用户自建脚本的原有行为不许丢）',
    fn() {
      const plan = mod.computePlanForTest(
        remoteManifest(),
        { present: true, files: { 'tools/patch/patch-fs.mjs': SHA_B } }, // 装过 patch-fs，没装过 custom
        LOCAL_OLD
      )
      assert(
        actionOf(plan, 'tools/patch/patch-fs.mjs') === 'update',
        '装过的文件内容变了就该更新，实际 ' + actionOf(plan, 'tools/patch/patch-fs.mjs')
      )
      assert(
        actionOf(plan, 'tools/custom.mjs') === 'preserved',
        '有过清单、但这版没装过它 → 视为用户自建脚本，应保留，实际 ' + actionOf(plan, 'tools/custom.mjs')
      )
    },
  },
  {
    name: '存在本地清单时 userOwned 依旧不动（no-manifest 修复不许波及用户数据）',
    fn() {
      const plan = mod.computePlanForTest(remoteManifest(), { present: false, files: {} }, LOCAL_OLD)
      assert(
        actionOf(plan, 'home/profiles/package.json') === 'preserved',
        'userOwned 在无清单时也必须保留，实际 ' + actionOf(plan, 'home/profiles/package.json')
      )
    },
  },
  {
    name: '文档：旧壳人工介入必须写 --full（普通 apply 在无清单时升不动）',
    fn() {
      const say = readFileSync(join(ROOT, 'tools', 'lib', 'say.ps1'), 'utf8')
      const bad = /apply --to 0\.6\.2 (?!.*--full).*--force/.exec(say)
      assert(!bad, 'say.ps1 里仍有不带 --full 的两步走写法：' + (bad && bad[0]))
      const live = readFileSync(join(ROOT, 'tools', 'update', 'compat-live.mjs'), 'utf8')
      assert(/--refresh/.test(live), 'compat-live 丢了 --refresh')
    },
  },
  {
    name: '发布门禁盲区：必须有"无本地清单也能升"的测试（否则 P0 会再次发布出去）',
    fn() {
      const src = readFileSync(join(ROOT, 'tools', 'update', 'shell-update.mjs'), 'utf8')
      assert(
        /computePlanForTest/.test(src),
        'shell-update 没有导出 computePlanForTest：这条 P0 就又没有守卫了'
      )
      const tree = readFileSync(join(ROOT, 'devtools', 'shell-release.mjs'), 'utf8')
      assert(
        /ZIP_DENY/.test(tree),
        'shell-release 里没有 ZIP_DENY —— 整包不含清单这件事得继续是有意为之，而不是意外'
      )
    },
  },
]