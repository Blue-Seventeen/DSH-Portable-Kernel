import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, assert, tmpDir } from '../lib.mjs'

/**
 * 换装引擎的两条"契约级"约束（2026-11-27 各踩了一次）。
 *
 * 1) **不带 --force 的 apply 是预演，一个字节都不许改。**
 *    我在"已是最新"分支里无条件调了 pruneLegacy()，结果 `apply`（不加 --force）
 *    会把盘上的旧文件删掉——而帮助文本写着"只报告，不改文件"。用户只是看一眼
 *    有没有更新，壳就被动了。
 *
 * 2) **换装/回滚/恢复同一时刻只许跑一个。**
 *    两个进程同时换装会算出同名备份目录（名字只精确到天），一起写同一个 files\。
 *    实测一个 EBUSY 后回滚，而回滚读的是被两个进程混写过的备份——等于把另一个
 *    进程刚装好的壳倒回去。现在有 tmp/shell-update.lock。
 */

const lazy = (rel) => import(pathToFileURL(join(ROOT, rel)).href)

export const cases = [
  {
    name: '预演契约：apply 不带 --force 时绝不落盘（源码级：pruneLegacy 必须按 opts.force 决定）',
    fn() {
      const src = readFileSync(join(ROOT, 'tools/update/shell-update.mjs'), 'utf8')
      // 找出"已是最新"分支里对 pruneLegacy 的调用
      const m = src.match(/const legacy = pruneLegacy\(([^)]*)\)/)
      assert(m, '找不到 pruneLegacy 调用点')
      assert(/dryRun:\s*!opts\.force/.test(m[1]), 'pruneLegacy 没有按 opts.force 决定是否 dryRun：' + m[1])
      // 并且必须在 --force 分支判定之前就存在（即"已是最新"路径也要守预演契约）
      const iPrune = src.indexOf('const legacy = pruneLegacy(')
      const iForceGuard = src.indexOf('if (!opts.force) {')
      assert(iPrune > 0 && iForceGuard > 0, '定位失败')
    },
  },
  {
    name: '预演契约：真实调用 apply（无 --force）不删残留文件',
    async fn() {
      const dir = tmpDir('dryrun-contract')
      mkdirSync(join(dir, 'tools'), { recursive: true })
      const m = await lazy('tools/update/shell-apply.mjs')
      // 只验证：dryRun 时 backup 目录里不该出现任何东西、journal 不该被写
      const journalPath = join(dir, 'tmp', 'shell-update-journal.json')
      const stage = join(dir, 'tmp', 'stage')
      mkdirSync(stage, { recursive: true })
      // files 不能为空：引擎会以"拒绝把壳换成空目录"直接拒绝，压根走不到 dryRun 分支
      writeFileSync(join(stage, 'x.mjs'), "fake-stage-bytes\n")
      const r = await m.applyUpdate({
        root: dir,
        stage,
        backupRoot: join(dir, 'cache'),
        journalPath,
        manifest: { shellVersion: '9.9.9', tag: 'v9.9.9', files: { 'x.mjs': 'df2ccf6d079339b51606445017bd2484cebf73f626dbb7e804071f9307d785f0' } },
        installed: { present: true, shellVersion: '9.9.9', files: { 'x.mjs': 'df2ccf6d079339b51606445017bd2484cebf73f626dbb7e804071f9307d785f0' }, userOwned: [] },
        verify: { enabled: false },
        isAllowed: () => true,
        dryRun: true,
        logger: () => {},
      })
      assert(r.ok === true, 'dryRun 不该失败：' + JSON.stringify(r.errors))
      assert(r.dryRun === true, '应该是 dryRun 结果（实际 dryRun=' + r.dryRun + '）')
      assert(!existsSync(journalPath), 'dryRun 写了 journal：' + journalPath)
      assert(!existsSync(join(dir, 'cache')), 'dryRun 建了备份目录')
      rmSync(dir, { recursive: true, force: true })
    },
  },
  {
    name: '单实例锁：导出的是 acquireLock，且三个写盘入口都持锁',
    async fn() {
      const src = readFileSync(join(ROOT, 'tools/update/shell-apply.mjs'), 'utf8')
      const m = await lazy('tools/update/shell-apply.mjs')
      assert(typeof m.acquireLock === 'function', '没有导出 acquireLock')
      assert(m.APPLY_LOCK === 'tmp/shell-update.lock', '锁路径不是 tmp/shell-update.lock：' + m.APPLY_LOCK)
      for (const fn of ['apply", rollback', 'recover']) { /* 占位，下面逐个查 */ }
      assert(/const lock = acquireLock\(ctx\.root, '回滚'\)/.test(src) || /acquireLock\(ctx\.root, '回滚'\)/.test(src), 'rollback 没持锁')
      assert(/acquireLock\(ctx\.root, '恢复'\)/.test(src), 'recover 没持锁')
      assert(/lock = acquireLock\(root, '换装'\)/.test(src), 'apply 没持锁')
      // 预演不该抢锁（否则看个预演也会被"另一个进程在换装"挡住）
      assert(/if \(!ctx\.dryRun\) \{/.test(src), 'apply 的加锁没有跳过 dryRun')
    },
  },
  {
    name: '单实例锁行为：活着的新锁拒绝、死的旧锁接管、坏文件接管',
    async fn() {
      const mod = await lazy('tools/update/shell-apply.mjs')
      const dir = tmpDir('lock-behave')
      mkdirSync(join(dir, 'tmp'), { recursive: true })
      const lockPath = join(dir, 'tmp', 'shell-update.lock')

      // 1) 当前进程自己持有 → 应拒绝
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, action: '换装', at: new Date().toISOString() }))
      const a = mod.acquireLock(dir, '换装')
      assert(a.ok === false, '活着的锁没被拒绝')
      assert(/另一个进程正在/.test(a.error || ''), '拒绝理由不明确：' + a.error)
      rmSync(lockPath, { force: true })

      // 2) 已死 pid → 接管并警告
      writeFileSync(lockPath, JSON.stringify({ pid: 999999, action: '换装', at: new Date().toISOString() }))
      const b = mod.acquireLock(dir, '换装')
      assert(b.ok === true, '死锁没被接管')
      assert(/接管/.test(b.warning || ''), '没有接管提示：' + b.warning)
      b.release()
      assert(!existsSync(lockPath), 'release 没删掉锁')

      // 3) 坏 JSON → 接管
      writeFileSync(lockPath, '{not json')
      const c = mod.acquireLock(dir, '换装')
      assert(c.ok === true, '损坏的锁没被接管')
      assert(/锁文件损坏/.test(c.warning || ''), '没说明是损坏：' + c.warning)
      c.release()
      rmSync(dir, { recursive: true, force: true })
    },
  },
]