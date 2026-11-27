import { read, exists, assert } from '../lib.mjs'

const deps = (rel) => {
  const j = JSON.parse(read(rel))
  return Object.entries(j.dependencies || {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + '@' + v).join(';')
}
const bundles = (rel) => {
  const j = JSON.parse(read(rel))
  return Array.isArray(j.dsh?.profile?.bundles) ? j.dsh.profile.bundles : []
}

export const cases = [
  {
    name: '三份 package.json 的 dependencies 逐字符一致',
    fn() {
      const a = deps('home/profiles/package.json')
      const b = deps('home/profiles/web/package.json')
      const c = deps('home/profiles/desktop/package.json')
      assert(a === b && b === c, '三份不一致：\nshared=' + a + '\nweb=' + b + '\ndesktop=' + c)
    },
  },
  {
    name: 'bundles 数量与 version.json 声明一致',
    fn() {
      const v = JSON.parse(read('version.json'))
      const w = bundles('home/profiles/web/package.json').length
      const d = bundles('home/profiles/desktop/package.json').length
      assert(w === v.bundlesWeb, 'web bundles ' + w + ' ≠ version.json ' + v.bundlesWeb)
      assert(d === v.bundlesDesktop, 'desktop bundles ' + d + ' ≠ version.json ' + v.bundlesDesktop)
    },
  },
  {
    name: '插件只有一份共享副本（web/desktop 下没有第二份 dshmarket）',
    fn() {
      assert(exists('home/profiles/node_modules/dshmarket'), '共享目录里没有 dshmarket')
      for (const p of ['web', 'desktop']) {
        assert(!exists('home/profiles/' + p + '/node_modules/dshmarket'), p + ' 下出现了第二份 dshmarket（应只留共享一份）')
      }
    },
  },
  {
    name: 'profile 下没有本地 node_modules（否则会出现第二份插件副本）',
    fn() {
      const bad = ['web', 'desktop'].filter((p) => exists('home/profiles/' + p + '/node_modules'))
      assert(bad.length === 0, '存在本地 node_modules：' + bad.join('、'))
    },
  },
  {
    name: '每个已装插件都能在共享目录里找到 package.json',
    fn() {
      const names = deps('home/profiles/package.json').split(';').filter(Boolean).map((x) => x.slice(0, x.lastIndexOf('@')))
      const missing = names.filter((n) => !exists('home/profiles/node_modules/' + n + '/package.json'))
      assert(missing.length === 0, '缺文件：' + missing.join(', '))
    },
  },
  {
    name: 'disabled 列表里的插件没有同时出现在 bundles 里',
    fn() {
      for (const p of ['web', 'desktop']) {
        const compat = exists('home/profiles/' + p + '/compatibility.json') ? JSON.parse(read('home/profiles/' + p + '/compatibility.json')) : {}
        const bs = bundles('home/profiles/' + p + '/package.json')
        const bad = bs.filter((b) => compat[b] === false)
        assert(bad.length === 0, p + ' 里被停用却仍在 bundles：' + bad.join(', '))
      }
    },
  },
]
