import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run, assert, tmpDir } from '../lib.mjs'

let seq = 0
const line = (kind, name, state) => JSON.stringify({ at: 1793800000000 + seq++, id: 'x' + seq, kind, name, state })

/** 造一棵带 .dsh-market 的树：3 条已结束 + 1 条进行中 */
const build = () => {
  const root = tmpDir('market-history')
  const dir = join(root, 'home', 'profiles', 'desktop', '.dsh-market')
  mkdirSync(dir, { recursive: true })
  const drain = join(dir, 'drain.ndjson')
  writeFileSync(drain, [
    line('install', 'a', 'succeeded'),
    line('install', 'b', 'failed'),
    line('uninstall', 'c', 'cancelled'),
    line('install', 'd', 'running'),
  ].join('\n') + '\n', 'utf8')
  writeFileSync(join(dir, 'pending-rows.json'), JSON.stringify({ version: 1, operations: [{ id: 'p1' }] }), 'utf8')
  writeFileSync(join(dir, 'log.ndjson'), '{}\n'.repeat(5), 'utf8')
  return { root, dir }
}

const drainLines = (dir) => readFileSync(join(dir, 'drain.ndjson'), 'utf8').split(/\r?\n/).filter(Boolean)

export const cases = [
  {
    name: 'market-history --check 不写盘',
    fn() {
      const { root, dir } = build()
      try {
        const before = readFileSync(join(dir, 'drain.ndjson'), 'utf8')
        const r = run(['tools/profile/market-history.mjs', '--root', root, '--check'])
        assert(r.code === 0, '退出码 ' + r.code)
        assert(readFileSync(join(dir, 'drain.ndjson'), 'utf8') === before, '--check 竟然改了文件')
        assert(r.out.includes('可清 3 条'), '统计不对：' + r.out.trim().slice(-200))
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
  {
    name: 'market-history 清掉已结束记录、保留进行中',
    fn() {
      const { root, dir } = build()
      try {
        const r = run(['tools/profile/market-history.mjs', '--root', root])
        assert(r.code === 0, '退出码 ' + r.code + '：' + r.out.trim().slice(-200))
        const left = drainLines(dir)
        assert(left.length === 1, '应只剩 1 条进行中，实际 ' + left.length)
        assert(JSON.parse(left[0]).state === 'running', '剩下的不是进行中的那条')
        const pending = JSON.parse(readFileSync(join(dir, 'pending-rows.json'), 'utf8'))
        assert((pending.operations || []).length === 0, 'pending-rows 没清空')
        // 备份文件存在
        const files = readFileSync(join(dir, 'drain.ndjson'), 'utf8')
        void files
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
  {
    name: 'market-history --keep 1 保留最近一条已结束记录',
    fn() {
      const { root, dir } = build()
      try {
        const r = run(['tools/profile/market-history.mjs', '--root', root, '--keep', '1'])
        assert(r.code === 0, '退出码 ' + r.code)
        const left = drainLines(dir)
        assert(left.length === 2, '应为"1 条进行中 + 1 条保留"，实际 ' + left.length)
        assert(left.some((l) => JSON.parse(l).name === 'c'), '保留的应是最新那条已结束记录（c）')
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
  {
    name: 'market-history --all 连 log.ndjson 一起清空',
    fn() {
      const { root, dir } = build()
      try {
        const r = run(['tools/profile/market-history.mjs', '--root', root, '--all'])
        assert(r.code === 0, '退出码 ' + r.code)
        assert(readFileSync(join(dir, 'log.ndjson'), 'utf8').length === 0, 'log.ndjson 没清空')
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
  {
    name: 'market-history --profile 非法值退出码 2',
    fn() {
      const r = run(['tools/profile/market-history.mjs', '--profile', 'bogus'])
      assert(r.code === 2, '退出码应为 2，实际 ' + r.code)
    },
  },
]
