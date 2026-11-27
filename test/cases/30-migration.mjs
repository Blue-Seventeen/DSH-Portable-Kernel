import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, assert, run, tmpDir } from '../lib.mjs'

/**
 * 大版本迁移声明（v0.7.3 引入，为 1.0.0 的结构重排铺路）。
 *
 * 背景：1.0.0 把 tools/ 按职责分组、合并入口，路径全变。旧客户端的路径白名单会
 * 把整份新清单拒掉（`whitelist-violation`），所以"逐文件替换"这条路在大版本上根本走不通。
 * 解法是在清单里挂一个 migration 指针，让升级模块下载一次性迁移脚本、校验哈希、执行，
 * 脚本负责备份/还原/自删。
 *
 * 这里守两件事：
 *   1. 声明校验必须从严（不可信主机、坏哈希、非脚本入口一律当没写）
 *   2. 没有 migration 字段时，行为必须与旧版完全一致（不许影响普通升级）
 */

const mod = await import(pathToFileURL(join(ROOT, 'tools', 'update', 'shell-update.mjs')).href)
const f = mod.normalizeMigrationForTest

const GOOD = {
  url: 'https://github.com/Blue-Seventeen/DSH-Portable-Kernel/releases/download/v1.0.0/upgrade-to-1.0.0.cmd',
  sha256: 'a'.repeat(64),
  entry: 'upgrade-to-1.0.0.cmd',
}

export const cases = [
  {
    name: '迁移声明：可信主机 + 64 位 sha256 + 脚本入口才接受',
    fn() {
      const m = f(GOOD)
      assert(m && m.entry === GOOD.entry, '合法声明应被接受')
      assert(m.sha256 === GOOD.sha256, 'sha256 应原样保留')
      assert(typeof m.note === 'string', 'note 缺省应为空串')
    },
  },
  {
    name: '迁移声明：不可信主机一律拒绝（防止清单被指向任意下载源）',
    fn() {
      for (const host of ['https://evil.example.com/', 'http://github.com/', 'ftp://github.com/']) {
        const m = f(Object.assign({}, GOOD, { url: host + 'x.cmd' }))
        assert(m === null, '不该接受来源：' + host)
      }
    },
  },
  {
    name: '迁移声明：sha256 格式不对就拒绝（宁可不升级，也不执行未校验的脚本）',
    fn() {
      // 大小写不敏感是有意的（hex 本身忽略大小写），其余一律拒绝
      assert(f(Object.assign({}, GOOD, { sha256: 'A'.repeat(64) })) !== null, '大写 sha256 应被规范化接受')
      for (const sha of ['', 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
        const m = f(Object.assign({}, GOOD, { sha256: sha }))
        assert(m === null, '不该接受 sha256：' + JSON.stringify(sha))
      }
    },
  },
  {
    name: '迁移声明：入口只能是 .cmd/.bat/.ps1（不许 .exe 或带路径）',
    fn() {
      for (const entry of ['x.exe', 'x.js', '../../x.cmd', 'sub/x.cmd', '']) {
        const m = f(Object.assign({}, GOOD, { entry }))
        assert(m === null, '不该接受入口：' + JSON.stringify(entry))
      }
      for (const entry of ['a.cmd', 'b.bat', 'c.ps1']) {
        assert(f(Object.assign({}, GOOD, { entry })) !== null, '应接受入口：' + entry)
      }
    },
  },
  {
    name: '迁移声明：缺失或非法结构时视为没写（不许影响普通升级路径）',
    fn() {
      for (const raw of [undefined, null, 0, 'x', [], {}]) {
        assert(f(raw) === null, '不该接受：' + JSON.stringify(raw))
      }
      const src = readFileSync(join(ROOT, 'tools', 'update', 'shell-update.mjs'), 'utf8')
      assert(/if \(m\.migration\) return await runMigrationApply/.test(src), 'runApply 没有迁移分流')
      assert(/if \(got !== mig\.sha256\)/.test(src), '执行前没有校验哈希')
      assert(/migration-integrity/.test(src), '校验失败没有专门的错误码')
    },
  },
  {
    name: '迁移预演：清单带 migration 时 apply（不加 --force）只报告 MIGRATE，不落地任何文件',
    fn() {
      const dir = tmpDir('migration-dry')
      mkdirSync(dir, { recursive: true })
      const mf = join(dir, 'manifest.json')
      // 只声明迁移与版本，files 用当前清单的副本（避免触发别的校验）
      const cur = JSON.parse(readFileSync(join(ROOT, 'shell-version.json'), 'utf8'))
      writeFileSync(mf, JSON.stringify({
        schemaVersion: 2, updaterMin: 2, channel: 'stable', shellVersion: '9.9.9', tag: 'v9.9.9',
        files: cur.files, userOwned: cur.userOwned,
        migration: GOOD,
      }), 'utf8')
      const before = readFileSync(join(ROOT, 'shell-version.json'), 'utf8')
      try {
        const r = run([join(ROOT, 'tools', 'update', 'shell-update.mjs'), 'apply', '--manifest', mf])
        assert(r.code === 0, '预演应退出 0，实际 ' + r.code + '：' + (r.out || '').slice(0, 200))
        assert(/MIGRATE/.test(r.out), '预演没有给出 MIGRATE 提示：' + (r.out || '').slice(0, 200))
        assert(/9\.9\.9/.test(r.out), '预演没说是升到哪一版')
        assert(readFileSync(join(ROOT, 'shell-version.json'), 'utf8') === before, '预演不许改动本地清单')
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
  },

  {
    name: '化石清单：只删字节与旧版一致的旧文件，用户改过的绝不动',
    fn() {
      const m = mod.LEGACY_SHELL_FILES
      assert(m && typeof m === 'object', '没有导出 LEGACY_SHELL_FILES')
      assert(Object.keys(m).length > 0, '化石清单是空的，等于没有兜底能力')
      for (const rel of Object.keys(m)) {
        assert(/^[a-z0-9][a-z0-9._/-]*$/i.test(rel), '化石清单里有非法路径：' + rel)
        assert(!rel.startsWith('devtools/'), '化石清单不该包含 devtools：' + rel)
        assert(/^[a-f0-9]{64}$/.test(m[rel]), '化石清单哈希格式不对：' + rel)
      }
      const src = readFileSync(join(ROOT, 'tools', 'update', 'shell-update.mjs'), 'utf8')
      assert(/if \(!installed\.present\)/.test(src), 'computeRemoved 没有无清单分支')
      assert(/sha256File\(join\(ROOT, rel\)\) === sha/.test(src), '无清单分支没有先校验哈希就删')
      assert(/export const pruneLegacy/.test(src), '没有 pruneLegacy（已是最新时的自愈清理）')
    },
  },

  {
    name: '发布说明解析：水平分隔线不许混进 notes（1.0.1 出过一次 "---" 条目）',
    fn() {
      const rel = pathToFileURL(join(ROOT, 'devtools', 'shell-release.mjs')).href
      // 动态加载：devtools 不进壳，但测试在自己的工作区里跑，路径是有的
      return import(rel).then((m) => {
        const text = readFileSync(join(ROOT, 'RELEASE-NOTES.md'), 'utf8')
        const r = m.parseNotes(text, '1.0.1')
        assert(r.found, '解析不到 v1.0.1 小节')
        for (const k of Object.keys(r.notes)) {
          for (const item of r.notes[k]) {
            assert(item !== '---', k + ' 里又出现了分隔线条目')
            assert(!/^[-*_]{3,}$/.test(item), k + ' 里有分隔线残留：' + item)
          }
        }
        for (const sec of ['added', 'fixed', 'optimized', 'breaking', 'upgrade', 'rollback']) {
          assert(Array.isArray(r.notes[sec]), 'notes 缺小节：' + sec)
        }
      })
    },
  },
]
