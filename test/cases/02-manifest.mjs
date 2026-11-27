import { read, sha, assert } from '../lib.mjs'
import { MANIFEST_SCHEMA, listLocalShellFiles, isAllowedShellPath } from '../../tools/update/shell-update.mjs'

const manifest = () => JSON.parse(read('shell-version.json'))
const FORBIDDEN = ['app/', 'desktop/', 'runtime/node', 'runtime/pnpm', 'home/sessions/', 'home/storages/', 'home/.credentials', 'version.json']

export const cases = [
  {
    name: '清单 schema / tag / shellVersion 自洽',
    fn() {
      const m = manifest()
      assert(m.schemaVersion === MANIFEST_SCHEMA, 'schemaVersion 应为 ' + MANIFEST_SCHEMA + '，实际 ' + m.schemaVersion)
      assert(typeof m.shellVersion === 'string' && m.shellVersion.trim(), 'shellVersion 为空')
      assert(m.tag === 'v' + m.shellVersion, 'tag 应为 v<shellVersion>，实际 ' + m.tag)
      assert(m.channel === 'stable' || m.channel === 'beta', 'channel 异常：' + m.channel)
    },
  },
  {
    name: '清单 files == 磁盘上的壳文件集合（一个不多一个不少）',
    fn() {
      const m = manifest()
      const disk = listLocalShellFiles().slice().sort()
      const listed = Object.keys(m.files).slice().sort()
      const missing = disk.filter((f) => !listed.includes(f))
      const extra = listed.filter((f) => !disk.includes(f))
      assert(missing.length === 0 && extra.length === 0,
        (missing.length ? '清单缺 ' + missing.slice(0, 5).join(', ') : '') + (extra.length ? '；清单多 ' + extra.slice(0, 5).join(', ') : ''))
    },
  },
  {
    name: '清单里每个 sha256 与磁盘一致',
    fn() {
      const m = manifest()
      const bad = Object.keys(m.files).filter((rel) => sha(rel) !== String(m.files[rel]).toLowerCase())
      assert(bad.length === 0, '哈希不符：' + bad.slice(0, 5).join(', '))
    },
  },
  {
    name: '清单路径都在白名单内且不含禁止目录',
    fn() {
      const m = manifest()
      const bad = Object.keys(m.files).filter((rel) => !isAllowedShellPath(rel) || FORBIDDEN.some((p) => rel.toLowerCase().startsWith(p)))
      assert(bad.length === 0, '违规路径：' + bad.slice(0, 5).join(', '))
    },
  },
  {
    name: 'userOwned 是 files 的子集',
    fn() {
      const m = manifest()
      const files = new Set(Object.keys(m.files).map((x) => x.toLowerCase()))
      const bad = (m.userOwned || []).filter((rel) => !files.has(String(rel).toLowerCase()))
      assert(bad.length === 0, '不在 files 里：' + bad.join(', '))
    },
  },
  {
    name: 'notes 六小节都是数组，migrations 的脚本已随壳发布',
    fn() {
      const m = manifest()
      const keys = ['added', 'fixed', 'optimized', 'breaking', 'upgrade', 'rollback']
      const bad = keys.filter((k) => !Array.isArray(m.notes && m.notes[k]))
      assert(bad.length === 0, '缺小节：' + bad.join(', '))
      for (const mig of m.migrations || []) {
        assert(mig && typeof mig.id === 'string', 'migration 缺 id')
        assert(Object.prototype.hasOwnProperty.call(m.files, mig.script), 'migration 脚本不在 files 里：' + mig.script)
      }
    },
  },
  {
    name: 'RELEASE-NOTES 有当前版本的小节且六节齐全',
    fn() {
      const m = manifest()
      const text = read('RELEASE-NOTES.md')
      const head = '## v' + m.shellVersion
      const idx = text.indexOf(head)
      assert(idx >= 0, 'RELEASE-NOTES.md 里没有 ' + head)
      const section = text.slice(idx, text.indexOf('\n## v', idx + 1) > 0 ? text.indexOf('\n## v', idx + 1) : text.length)
      for (const t of ['新增', '修复', '优化', '破坏性变更', '升级会做什么', '如何回退']) {
        assert(section.includes('### ' + t), '缺少小节：### ' + t)
      }
    },
  },
]
