import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, assert, run, tmpDir } from '../lib.mjs'

/**
 * 老客户端跨结构升级（2026-11-27 修）。
 *
 * 症结：0.5.x-0.7.x 的 shell-update 把"换装后自检"的路径写死成 tools\verify-shell.mjs。
 * 1.0.0 分组后自检搬到 tools\verify\verify-shell.mjs，老客户端换完装去跑那条旧路径时
 * 文件已经没了 → node 报 Cannot find module → 旧代码判定"自检不通过"→ 整份回滚。
 * 结果：**带清单的老壳永远升不到新结构**（真机 0.5.1 实测踩到）。
 *
 * 三层修法，这个用例守着它们别退化：
 *   1) 新结构保留 tools/verify-shell.mjs 做瘦转发（安全网不缺口）
 *   2) 自检脚本确实消失时，记"跳过"而不是回滚（别用"不许升级"惩罚用户）
 *   3) verifyCmd 按候选路径挑，不写死单一位置
 */

const SHA0 = '0'.repeat(64)

const mkSandbox = async (label) => {
  const mod = await import(pathToFileURL(join(ROOT, 'tools/update/shell-apply.mjs')).href)
  const dir = tmpDir(label)
  mkdirSync(join(dir, 'tools'), { recursive: true })
  const stage = join(dir, 'tmp', 'stage')
  mkdirSync(stage, { recursive: true })
  const bytes = 'patched-bytes\n'
  writeFileSync(join(stage, 'x.mjs'), bytes)
  const { createHash } = await import('node:crypto')
  const sha = createHash('sha256').update(Buffer.from(bytes)).digest('hex')
  return { mod, dir, stage, sha }
}

const applyWithVerify = async ({ mod, dir, stage, sha }, verifyCmd) => mod.applyUpdate({
  root: dir,
  stage,
  backupRoot: join(dir, 'cache'),
  journalPath: join(dir, 'tmp', 'shell-update-journal.json'),
  manifest: { shellVersion: '9.9.9', tag: 'v9.9.9', files: { 'x.mjs': sha } },
  installed: { present: true, shellVersion: '9.9.8', files: { 'x.mjs': SHA0 }, userOwned: [] },
  verify: verifyCmd,
  isAllowed: () => true,
  logger: () => {},
})

export const cases = [
  {
    name: '兼容转发桩：tools/verify-shell.mjs 存在、在清单里、是瘦转发',
    fn() {
      const stubAbs = join(ROOT, 'tools', 'verify-shell.mjs')
      assert(existsSync(stubAbs), '缺少兼容转发桩 tools/verify-shell.mjs')
      const src = readFileSync(stubAbs, 'utf8')
      // 必须是转发，不许自己实现检查（两份逻辑会漂移）
      assert(/verify['"],\s*['"]verify-shell\.mjs|'verify',\s*'verify-shell\.mjs'/.test(src), '桩没有指向 tools/verify/verify-shell.mjs')
      assert(/spawnSync/.test(src), '桩没有 spawnSync：它应该转发而不是 import 后自跑')
      assert(/process\.exit\(/.test(src), '桩没有透传退出码')
      // 运行期输出必须 ASCII（老壳控制台代码页不确定）
      for (const line of src.split('\n')) {
        if (!/process\.(stdout|stderr)\.write/.test(line)) continue
        assert(!/[^\x00-\x7F]/.test(line), '桩打印了非 ASCII：' + line.trim())
      }
      // 必须在清单里，否则老客户端换装时会被删掉、自检照样找不到
      const mf = JSON.parse(readFileSync(join(ROOT, 'shell-version.json'), 'utf8'))
      assert('tools/verify-shell.mjs' in mf.files, '清单里没有桩：老客户端换装会被当成待删文件')
    },
  },
  {
    name: '兼容转发桩：参数与退出码都原样透传（用假自检验证，不跑真自检）',
    fn() {
      // 不跑真自检：verify 一次要十几秒，而且这里要验的是"转发"而不是"检查能力"。
      // 造一个假自检：打印收到的参数、按固定码退出，看桩有没有原样透传。
      const dir = tmpDir('stub-forward')
      // 桩按 <自己所在目录>/verify/verify-shell.mjs 定位真身，所以假自检必须放在桩的旁边
      const stubDir = join(dir, 'tools')
      mkdirSync(join(stubDir, 'verify'), { recursive: true })
      writeFileSync(join(stubDir, 'verify', 'verify-shell.mjs'),
        'process.stdout.write("ARGS=" + JSON.stringify(process.argv.slice(2)) + "\\n")\nprocess.exit(7)\n', 'utf8')
      writeFileSync(join(stubDir, 'stub.mjs'), readFileSync(join(ROOT, 'tools', 'verify-shell.mjs')))
      // 桩按 <自己目录>/verify/verify-shell.mjs 定位真身
      const r = run([join(stubDir, 'stub.mjs'), '--update-gate', '--json'])
      assert(r.code === 7, '退出码没有透传：期望 7，实际 ' + r.code)
      assert(/ARGS=\["--update-gate","--json"\]/.test(r.out || ''), '参数没有原样透传：' + (r.out || '').trim().slice(0, 120))
      rmSync(dir, { recursive: true, force: true })
    },
  },
  {
    name: '自检脚本消失时：记为跳过并继续，绝不回滚（老客户端升级死结的核心）',
    async fn() {
      const sb = await mkSandbox('verify-vanished')
      const r = await applyWithVerify(sb, {
        enabled: true,
        cmd: [process.execPath, join(sb.dir, 'tools', 'gone-verify.mjs'), '--update-gate'],
        quiet: true,
      })
      assert(r.ok === true, '自检脚本不存在时不该判失败：' + JSON.stringify(r.errors))
      assert(r.rolledBack === false, '自检脚本不存在时不该回滚（回滚 = 老客户端永远升不动）')
      assert(r.verify && r.verify.skipped === true, 'verify 应标成 skipped：' + JSON.stringify(r.verify))
      assert(r.verify.reason === 'verify-script-missing', 'verify.reason 应说明是脚本缺失')
      assert(existsSync(join(sb.dir, 'x.mjs')), '换装结果应该真的落盘了')
      assert(/跳过自检/.test((r.warnings || []).join(' ')), '没有给出"跳过自检"的提示')
      rmSync(sb.dir, { recursive: true, force: true })
    },
  },
  {
    name: '自检真失败时：仍然必须回滚（跳过逻辑不许把安全网拆了）',
    async fn() {
      const sb = await mkSandbox('verify-realfail')
      const failScript = join(sb.dir, 'tools', 'always-fail.mjs')
      writeFileSync(failScript, 'process.exit(3)\n', 'utf8')
      const r = await applyWithVerify(sb, {
        enabled: true,
        cmd: [process.execPath, failScript, '--update-gate'],
        quiet: true,
      })
      assert(r.ok === false, '自检真失败时必须判失败')
      assert(r.rolledBack === true, '自检真失败时必须回滚')
      assert(r.verify && r.verify.ran === true, '真失败时 verify.ran 应为 true（区分于脚本缺失）')
      assert(!existsSync(join(sb.dir, 'x.mjs')), '回滚后新增文件应该被撤掉')
      rmSync(sb.dir, { recursive: true, force: true })
    },
  },
  {
    name: 'verifyCmd 按候选路径挑，不写死单一路径',
    fn() {
      const src = readFileSync(join(ROOT, 'tools/update/shell-update.mjs'), 'utf8')
      const m = src.match(/const verifyCmd = \(opts\) => \{([\s\S]*?)\n\}/)
      assert(m, '找不到 verifyCmd')
      assert(/candidates/.test(m[1]), 'verifyCmd 没有候选路径列表')
      assert(/find\(\(x\) => existsSync\(x\)\)/.test(m[1]), 'verifyCmd 没有挑第一个存在的候选')
      assert(m[1].includes("'verify', 'verify-shell.mjs'"), '候选里没有扁平兼容路径')
    },
  },

  {
    name: '自检脚本在、但它依赖的模块缺失（壳真坏）→ 必须回滚，不许当跳过',
    async fn() {
      // 这是初版跳过逻辑的漏洞：用 /Cannot find module/ 一刀切，于是
      // "verify-shell.mjs 在、但它 import 的东西被删了"也会被放过，换装照样提交。
      // 判定必须精确到"缺的就是自检脚本本身"。
      const sb = await mkSandbox('verify-dep-missing')
      const vp = join(sb.dir, 'tools', 'verify', 'verify-shell.mjs')
      mkdirSync(join(sb.dir, 'tools', 'verify'), { recursive: true })
      writeFileSync(vp, 'import "../lib/gone-dep.mjs"\nprocess.exit(0)\n', 'utf8')
      const r = await applyWithVerify(sb, {
        enabled: true,
        cmd: [process.execPath, vp, '--update-gate'],
        quiet: true,
      })
      assert(r.ok === false, '自检依赖缺失时必须判失败（这是真坏，不是路径失效）')
      assert(r.rolledBack === true, '自检依赖缺失时必须回滚')
      assert(!(r.verify && r.verify.skipped), '不许标成 skipped：' + JSON.stringify(r.verify))
      assert(r.verify && r.verify.ran === true, '真的跑起来了，ran 应为 true')
      assert(!existsSync(join(sb.dir, 'x.mjs')), '回滚后新增文件应被撤掉')
      rmSync(sb.dir, { recursive: true, force: true })
    },
  },

  {
    name: '自定义自检命令不许被路径重解析劫持（只接管 verify*.mjs）',
    async fn() {
      // resolveVerifyCmd 只该在"命令指向自检脚本、但那个脚本不见了"时换路径。
      // 初版无条件替换候选，把 `node -e "process.exit(3)"` 换成了夹具里的 verify-shell，
      // 退出码从 3 变成 1 —— selftest 用例 E 当场变红（2026-11-27）。
      const sb = await mkSandbox('no-hijack')
      // 故意在夹具里放一份"看起来像自检"的脚本，制造劫持机会
      mkdirSync(join(sb.dir, 'tools', 'verify'), { recursive: true })
      writeFileSync(join(sb.dir, 'tools', 'verify', 'verify-shell.mjs'), 'process.exit(9)\n', 'utf8')
      const r = await applyWithVerify(sb, {
        enabled: true,
        cmd: [process.execPath, '-e', 'process.exit(3)'],
        quiet: true,
      })
      assert(r.verify, '没有 verify 结果')
      assert(r.verify.code === 3, '自定义自检命令被劫持了：期望 3，实际 ' + r.verify.code)
      assert(r.rolledBack === true, '自检失败（3）仍须回滚')
      rmSync(sb.dir, { recursive: true, force: true })
    },
  },
]
