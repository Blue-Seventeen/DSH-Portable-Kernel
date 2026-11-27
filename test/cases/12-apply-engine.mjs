import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, tmpDir } from '../lib.mjs'
import { applyUpdate, rollbackUpdate } from '../../tools/update/shell-apply.mjs'

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

/** 造一棵最小可换装的树：tools/ 下两个文件 + 一份 v1 清单 */
const build = () => {
  const root = tmpDir('apply-engine')
  const stage = join(root, 'tmp', 'stage')
  mkdirSync(join(root, 'tools'), { recursive: true })
  mkdirSync(join(root, 'cache'), { recursive: true })
  mkdirSync(join(root, 'tmp'), { recursive: true })
  writeFileSync(join(root, 'tools', 'keep.mjs'), 'old keep\n', 'utf8')
  writeFileSync(join(root, 'tools', 'gone.mjs'), 'to be removed\n', 'utf8')
  writeFileSync(join(root, 'shell-version.json'), JSON.stringify({ schemaVersion: 2, shellVersion: '1.0.0', tag: 'v1.0.0', files: {}, userOwned: [] }), 'utf8')
  // 待换装的暂存内容
  mkdirSync(join(stage, 'tools'), { recursive: true })
  writeFileSync(join(stage, 'tools', 'keep.mjs'), 'new keep\n', 'utf8')
  writeFileSync(join(stage, 'tools', 'fresh.mjs'), 'brand new\n', 'utf8')
  return { root, stage }
}

const manifestFor = (root, stage) => {
  const to = sha(readFileSync(join(stage, 'tools', 'keep.mjs')))
  const add = sha(readFileSync(join(stage, 'tools', 'fresh.mjs')))
  const raw = Buffer.from(JSON.stringify({ schemaVersion: 2, shellVersion: '2.0.0', tag: 'v2.0.0', files: {}, userOwned: [] }))
  return { files: { 'tools/keep.mjs': to, 'tools/fresh.mjs': add }, userOwned: [], remove: ['tools/gone.mjs'], raw }
}

const opts = (root, stage, extra = {}) => ({
  root,
  stage,
  backupRoot: join(root, 'cache'),
  journalPath: join(root, 'tmp', 'shell-update-journal.json'),
  manifest: manifestFor(root, stage),
  migrations: [],
  verify: { cmd: null, enabled: false },
  isAllowed: (rel) => String(rel).toLowerCase().startsWith('tools/'),
  logger: () => {},
  ...extra,
})

export const cases = [
  {
    name: '换装引擎：写入新增/更新、删除清单里的文件、清 journal',
    async fn() {
      const { root, stage } = build()
      try {
        const res = await applyUpdate(opts(root, stage))
        assert(res.ok, '换装失败：' + (res.errors || []).join('；'))
        assert(readFileSync(join(root, 'tools', 'keep.mjs'), 'utf8') === 'new keep\n', 'keep.mjs 没被更新')
        assert(readFileSync(join(root, 'tools', 'fresh.mjs'), 'utf8') === 'brand new\n', 'fresh.mjs 没写入')
        assert(!existsSync(join(root, 'tools', 'gone.mjs')), 'gone.mjs 没被删除')
        assert(!existsSync(join(root, 'tmp', 'shell-update-journal.json')), 'journal 没清掉')
        assert(res.backup && existsSync(res.backup), '没有生成备份目录')
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
  {
    name: '换装引擎：dry-run 不落盘',
    async fn() {
      const { root, stage } = build()
      try {
        const res = await applyUpdate(opts(root, stage, { dryRun: true }))
        assert(res.ok, 'dry-run 失败：' + (res.errors || []).join('；'))
        assert(readFileSync(join(root, 'tools', 'keep.mjs'), 'utf8') === 'old keep\n', 'dry-run 竟然改了文件')
        assert(!existsSync(join(root, 'tools', 'fresh.mjs')), 'dry-run 竟然写了新文件')
        assert(existsSync(join(root, 'tools', 'gone.mjs')), 'dry-run 不该删文件（gone.mjs 不见了）')
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
  {
    name: '换装引擎：路径逃逸（../）被白名单挡下',
    async fn() {
      const { root, stage } = build()
      try {
        const bad = manifestFor(root, stage)
        bad.files['../evil.mjs'] = sha(Buffer.from('x'))
        const res = await applyUpdate(opts(root, stage, { manifest: bad }))
        assert(!res.ok, '路径逃逸居然成功了')
        assert((res.errors || []).length > 0, '没有给出错误原因')
        assert(!existsSync(join(root, '..', 'evil.mjs')), '真的写到了上层目录')
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
  {
    name: '回滚引擎：把上一版原样还原',
    async fn() {
      const { root, stage } = build()
      try {
        const applied = await applyUpdate(opts(root, stage))
        assert(applied.ok, '换装失败：' + (applied.errors || []).join('；'))
        const rb = await rollbackUpdate({
          root,
          backupRoot: join(root, 'cache'),
          journalPath: join(root, 'tmp', 'shell-update-journal.json'),
          verify: { cmd: null, enabled: false },
          isAllowed: (rel) => String(rel).toLowerCase().startsWith('tools/'),
          logger: () => {},
        })
        assert(rb.ok, '回滚失败：' + (rb.errors || []).join('；'))
        assert(readFileSync(join(root, 'tools', 'keep.mjs'), 'utf8') === 'old keep\n', 'keep.mjs 没还原')
        assert(readFileSync(join(root, 'tools', 'gone.mjs'), 'utf8') === 'to be removed\n', '被删的文件没还原')
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
]
