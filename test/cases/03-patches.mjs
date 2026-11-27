import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, run, assert, tmpDir, jsonObject } from '../lib.mjs'

const code = (args) => run(args).code

export const cases = [
  {
    name: '补丁锚点自测（fs-local 两代形状 + pnpm 三种写法）',
    fn() {
      const r = run(['devtools/selftest-patches.mjs', '--quiet'])
      assert(r.code === 0, r.out.trim().split(/\r?\n/).slice(-3).join(' | '))
    },
  },
  {
    name: '附件库补丁锚点自测（两种 import 形态 + 不该改的负例）',
    fn() {
      const r = run(['tools/patch/patch-attachment.mjs', '--selftest'])
      assert(r.code === 0, r.out.trim().split(/\r?\n/).slice(-3).join(' | '))
    },
  },
  {
    name: 'store 一致性判定自测（10 个夹具）',
    fn() {
      const r = run(['devtools/selftest-store.mjs', '--quiet'])
      assert(r.code === 0, r.out.trim().slice(-300))
    },
  },
  {
    name: 'drain 语义自测（商城未装时自动跳过）',
    fn() {
      const r = run(['devtools/selftest-drain.mjs', '--quiet'])
      assert(r.code === 0, r.out.trim().slice(-300))
    },
  },
  {
    name: '三族补丁状态（patch-all --check 不得 failed）',
    fn() {
      const r = run(['tools/patch/patch-all.mjs', '--check', '--json'])
      assert(r.code === 0 || r.code === 4, '退出码 ' + r.code + '：' + r.out.trim().slice(-200))
      const j = jsonObject(r.out)
      assert(j, '拿不到 JSON：' + r.out.trim().slice(-200))
      const bad = (j.families || []).filter((f) => f.state === 'failed')
      assert(bad.length === 0, '失败族：' + bad.map((f) => f.family).join(', '))
    },
  },
  {
    name: '暂存引擎自测（队列/快照/回滚，临时根）',
    fn() {
      const dir = tmpDir('stage')
      try {
        const r = run(['tools/profile/plugin-shared.mjs', '--root', dir, 'stage-selftest', '--quiet'])
        assert(r.code === 0, r.out.trim().slice(-300))
      } finally {
        // 夹具必须自净：早先这条用例没清，跑一圈就在 tmp\ 里留一个 shell-test-stage-*。
        rmSync(dir, { recursive: true, force: true })
      }
    },
  },
  {
    name: '暂存自测跑在真实根上也不许改真实清单（2026-11-26 事故）',
    fn() {
      // 事故：发布前门禁里手跑了一次 `plugin-shared.mjs stage-selftest`（没带 --root），
      // 它按设计往「当前根」写夹具（name 改成 selftest-web、dependencies 清空），
      // 于是 prepare 把 home\profiles\*.json 的插件依赖清空一起提交了。
      // 现在自测自己先快照、跑完还原：这条用例盯的就是"跑完真实清单必须原样"。
      const snapOf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
      const targets = [
        join(ROOT, 'home', 'profiles', 'package.json'),
        join(ROOT, 'home', 'profiles', 'web', 'package.json'),
        join(ROOT, 'home', 'profiles', 'desktop', 'package.json'),
        join(ROOT, 'version.json'),
      ]
      const before = targets.map(snapOf)
      const r = run(['tools/profile/plugin-shared.mjs', 'stage-selftest', '--quiet'])
      const after = targets.map(snapOf)
      assert(r.code === 0, '自测本身失败：' + r.out.trim().slice(-300))
      targets.forEach((p, i) => {
        assert(before[i] === after[i], p.replace(ROOT, '.') + ' 被自测改动了（用户插件清单会被洗掉）')
      })
      // 顺带确认：真实清单里的插件依赖还在（不是被清成空的合法状态）
      const shared = JSON.parse(after[0] || '{}')
      assert(Object.keys(shared.dependencies || {}).length > 0, '共享清单的 dependencies 被清空了')
      assert(String(shared.name || '').startsWith('dsh-profile-'), '共享清单的 name 被改成了 ' + shared.name)
    },
  },
  {
    name: '暂存自测跑完不留垃圾（home\\plugin-stage 必须回到开跑前的样子）',
    fn() {
      // 同一个事故的另一半：自测会往 home\plugin-stage 写队列、坏队列改名、快照目录。
      // 清单还原了但这些垃圾留着，便携目录每跑一次自测就胖一圈。
      const stageDir = join(ROOT, 'home', 'plugin-stage')
      const listFiles = (dir) => {
        const acc = []
        const walk = (d) => {
          let ents = []
          try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
          for (const e of ents) {
            const full = join(d, e.name)
            if (e.isDirectory()) walk(full)
            else acc.push(full)
          }
        }
        walk(dir)
        return acc.sort()
      }
      const existedBefore = existsSync(stageDir)
      const before = existedBefore ? listFiles(stageDir) : []
      const r = run(['tools/profile/plugin-shared.mjs', 'stage-selftest', '--quiet'])
      assert(r.code === 0, '自测本身失败：' + r.out.trim().slice(-300))
      const existedAfter = existsSync(stageDir)
      if (!existedBefore) {
        assert(!existedAfter, '自测前没有 home\\plugin-stage，跑完却留下了（该整个删掉）')
        return
      }
      const after = listFiles(stageDir)
      const added = after.filter((f) => !before.includes(f))
      assert(added.length === 0, '自测往暂存目录留了 ' + added.length + ' 个新文件：' + added.slice(0, 3).map((f) => f.replace(ROOT, '.')).join(', '))
    },
  },
  {
    name: 'sync 检查不落盘（--check 后工作树仍干净）',
    fn() {
      const r = run(['tools/profile/plugin-shared.mjs', 'sync', '--check'])
      assert(r.code === 0 || r.code === 4, '退出码 ' + r.code + '：' + r.out.trim().slice(-200))
      assert(/无需改动|已一致/.test(r.out), 'sync --check 报未收敛：' + r.out.trim().slice(-200))
    },
  },
]
