import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, assert, tmpDir } from '../lib.mjs'

/**
 * 「兼容性活声明」（compat.json）的回归测试。
 *
 * 用户 2026-11-27 定的架构：
 *   - 壳代码 = 版本化制品（发版才有新代码）
 *   - 兼容面 = 一个不进版本号的 JSON，随时改、随时推，用户联网自动拉
 * 官方发个 rc 而我们打补丁的文件没动时，**只改这个 JSON**，不发新壳、不重装。
 *
 * 三条必须守住：
 *   1. **只许放宽**：远端只能把区间撑大，绝不允许把用户已经能用的内核判成不支持；
 *   2. **拿不到就跳过**：无网/超时/坏 JSON/schema 太新 → 退回本壳清单，绝不卡住；
 *   3. **接入面完整**：内核更新判定、壳更新警告、体检三处都得认它，否则等于没接。
 */

const mod = await import(pathToFileURL(join(ROOT, 'tools', 'update', 'compat-live.mjs')).href)

const mkRoot = (manifestRange, cacheObj) => {
  const dir = tmpDir('compat')
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  writeFileSync(join(dir, 'shell-version.json'), JSON.stringify({
    schemaVersion: 2, shellVersion: '0.7.0', requires: { dsh: manifestRange },
  }), 'utf8')
  if (cacheObj !== undefined) {
    writeFileSync(join(dir, 'tmp', 'compat.json'), typeof cacheObj === 'string' ? cacheObj : JSON.stringify(cacheObj), 'utf8')
  }
  return dir
}

const compatOf = (range, extra) => Object.assign({ schemaVersion: 1, dsh: { range } }, extra || {})

export const cases = [
  {
    name: '活声明：远端只能放宽区间，绝不允许收紧（收紧就等于把用户能用的内核判死）',
    fn() {
      const wider = mod.unionRange('>=0.2.1-rc.5,<=0.2.2-rc.2', '>=0.2.1-rc.5,<=0.2.2-rc.5')
      assert(wider.range === '>=0.2.1-rc.5,<=0.2.2-rc.5', '远端上界更高时应当采用远端：' + wider.range)
      const narrower = mod.unionRange('>=0.2.1-rc.5,<=0.2.2-rc.5', '>=0.2.1-rc.5,<=0.2.2-rc.2')
      assert(narrower.range === '>=0.2.1-rc.5,<=0.2.2-rc.5', '远端上界更低时不许收紧：' + narrower.range)
      const lowerFloor = mod.unionRange('>=0.2.1-rc.5,<=0.2.2-rc.5', '>=0.2.0,<=0.2.2-rc.5')
      assert(lowerFloor.range === '>=0.2.0,<=0.2.2-rc.5', '远端下界更低时可以放宽：' + lowerFloor.range)
      const higherFloor = mod.unionRange('>=0.2.1-rc.5,<=0.2.2-rc.5', '>=0.2.2-rc.3,<=0.2.2-rc.5')
      assert(higherFloor.range === '>=0.2.1-rc.5,<=0.2.2-rc.5', '远端下界更高时不许收紧：' + higherFloor.range)
      const garbage = mod.unionRange('>=0.2.1-rc.5,<=0.2.2-rc.2', '这不是区间')
      assert(garbage.range === '>=0.2.1-rc.5,<=0.2.2-rc.2', '远端解析不了时必须退回清单：' + garbage.range)
    },
  },
  {
    name: '活声明：坏数据一律拒绝（schema 太新 / 没上界 / 壳太旧 / 写法不支持）',
    fn() {
      const bad = [
        [{ schemaVersion: 2, dsh: { range: '>=0.2.1-rc.5,<=0.2.2-rc.5' } }, 'schema-too-new'],
        [{ schemaVersion: 1, dsh: { range: '>=0.2.1-rc.5' } }, 'no-ceiling'],
        [{ schemaVersion: 1, minShell: '9.9.9', dsh: { range: '>=0.2.1-rc.5,<=0.2.2-rc.5' } }, 'shell-too-old'],
        [{ schemaVersion: 1, dsh: { range: '>=0.2.1-rc.5 || >=0.2.2-rc.1' } }, 'unparseable-range'],
        [{ schemaVersion: 1 }, 'no-range'],
      ]
      for (const [obj, want] of bad) {
        const v = mod.validateCompat(obj, { localShell: '0.7.0' })
        assert(v.ok === false, '这份声明应当被拒绝：' + JSON.stringify(obj))
        assert(v.error === want, '拒绝原因应为 ' + want + '，实际 ' + v.error)
      }
    },
  },
  {
    name: '活声明：有缓存且更宽 → 生效区间来自远端；缓存放坏会退回清单',
    fn() {
      const dir = mkRoot('>=0.2.1-rc.5,<=0.2.2-rc.2', compatOf('>=0.2.1-rc.5,<=0.2.2-rc.5'))
      try {
        const e = mod.effectiveDshRangeSync(dir)
        assert(e.source === 'compat', '应当判定来源为远端声明，实际 ' + e.source)
        assert(e.range === '>=0.2.1-rc.5,<=0.2.2-rc.5', '生效区间应为 rc.5，实际 ' + e.range)
        assert(e.manifestRange === '>=0.2.1-rc.5,<=0.2.2-rc.2', '清单原值应保真：' + e.manifestRange)
      } finally { rmSync(dir, { recursive: true, force: true }) }

      const dir2 = mkRoot('>=0.2.1-rc.5,<=0.2.2-rc.2', '{ 这不是 json ')
      try {
        const e = mod.effectiveDshRangeSync(dir2)
        assert(e.source === 'manifest', '坏 JSON 必须退回清单，实际 ' + e.source)
        assert(e.range === '>=0.2.1-rc.5,<=0.2.2-rc.2', '坏 JSON 不该改变区间：' + e.range)
      } finally { rmSync(dir2, { recursive: true, force: true }) }
    },
  },
  {
    name: '活声明：三处接入面齐全（内核更新 / 壳更新警告 / 体检）',
    fn() {
      const uc = readFileSync(join(ROOT, 'tools', 'update', 'update-check.mjs'), 'utf8')
      assert(/from '\.\/compat-live\.mjs'/.test(uc), 'update-check.mjs 没接兼容声明 —— 内核更新判定仍只看清单')
      assert(/effectiveDshRangeSync\(root\)/.test(uc), 'update-check.mjs 没用 effectiveDshRangeSync 算区间')
      assert(/refreshCompat\(\{ root \}\)/.test(uc), 'update-check.mjs 没在联网时刷新兼容声明')

      const su = readFileSync(join(ROOT, 'tools', 'update', 'shell-update.mjs'), 'utf8')
      assert(/effectiveDshRangeSync\(ROOT\)/.test(su), 'shell-update.mjs 没认兼容声明 —— 远端放宽后仍会警告"补丁可能没适配"')
      assert(/coveredByLive/.test(su), 'shell-update.mjs 没有"已被远端声明覆盖"的抑制逻辑')

      const ps1 = readFileSync(join(ROOT, 'dsh-portable.ps1'), 'utf8')
      assert(/compat-live\.mjs"\) --one-line/.test(ps1), '体检没显示生效的内核区间（用户无法判断壳支持到哪）')
      assert(/dsh-range :/.test(ps1), '体检没有 dsh-range 这一行')
    },
  },
  {
    name: '活声明：仓库里的 compat.json 必须合法，且不得比本壳清单更窄',
    fn() {
      const raw = JSON.parse(readFileSync(join(ROOT, 'compat.json'), 'utf8'))
      // 结构校验用宽松的壳版本：这个用例跑在"还没 prepare 出新版本号"的工作区里，
      // 拿当前版本号去比 minShell 会误红（minShell 指的是第一个支持本机制的版本）。
      const v = mod.validateCompat(raw, { localShell: '99.99.99' })
      assert(String(raw.minShell) === '0.7.0', 'minShell 应写成第一个支持活声明机制的壳版本 0.7.0，实际 ' + raw.minShell)
      assert(v.ok, 'compat.json 不合法：' + (v.error || ''))
      const manifest = JSON.parse(readFileSync(join(ROOT, 'shell-version.json'), 'utf8'))
      const u = mod.unionRange(manifest.requires.dsh, v.data.range)
      assert(
        u.range === v.data.range,
        'compat.json 比本壳清单更窄（清单 ' + manifest.requires.dsh + ' / 声明 ' + v.data.range + '）——' +
        '声明只能放宽不能收紧，否则等于替用户降级'
      )
      assert(Array.isArray(raw.patchedFiles) === false && Object.keys(raw.patchedFiles || {}).length > 0,
        'compat.json 缺 patchedFiles：--verify 就无法核对"上游有没有动我们打补丁的文件"')
    },
  },
]