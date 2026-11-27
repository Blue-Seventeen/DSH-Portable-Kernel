import { ROOT, read, exists, assert } from '../lib.mjs'
import { checkTree, storeDirFromYaml } from '../../tools/profile/store-consistency.mjs'

export const cases = [
  {
    name: 'pnpm store 与 node_modules 记录一致（三个 profile）',
    fn() {
      if (!exists('home/profiles/node_modules/.modules.yaml')) return // 还没装插件：跳过
      const problems = checkTree(ROOT)
      assert(problems.length === 0, problems.map((p) => String(p.file).slice(String(p.file).indexOf('home')) + '：' + p.reason).join('；'))
    },
  },
  {
    name: '三份 pnpm-workspace.yaml 都写了 storeDir',
    fn() {
      for (const f of ['home/profiles/pnpm-workspace.yaml', 'home/profiles/web/pnpm-workspace.yaml', 'home/profiles/desktop/pnpm-workspace.yaml']) {
        assert(exists(f), f + ' 不存在（应由 fix-pnpm-state 生成）')
        assert(storeDirFromYaml(read(f)), f + ' 缺 storeDir')
      }
    },
  },
  {
    name: '机器配置文件不在壳清单里（防止升级覆盖/删除）',
    fn() {
      const m = JSON.parse(read('shell-version.json'))
      const bad = Object.keys(m.files).filter((rel) => /pnpm-workspace\.yaml$/i.test(rel))
      assert(bad.length === 0, '清单里不该有：' + bad.join(', '))
    },
  },
  {
    name: 'computeRemoved 永不删除机器配置（升级安全性）',
    fn() {
      return import('../../tools/update/shell-update.mjs').then((m) => {
        const installed = {
          present: true,
          files: {
            'home/profiles/pnpm-workspace.yaml': 'a',
            'home/profiles/web/pnpm-workspace.yaml': 'b',
            'tools/obsolete.mjs': 'c',
          },
          userOwned: [],
        }
        const removed = m.computeRemoved({ files: {}, userOwned: [] }, installed)
        assert(!removed.some((p) => /pnpm-workspace\.yaml$/i.test(p)), '机器配置被列入待删：' + removed.join(', '))
        assert(removed.includes('tools/obsolete.mjs'), '普通旧文件应仍可清理，实际 ' + JSON.stringify(removed))
      })
    },
  },
]
