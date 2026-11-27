import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assert, tmpDir } from '../lib.mjs'
import { countProfileBundles, localDshVersion, refreshVersionSnapshot } from '../../tools/update/shell-update.mjs'

/**
 * version.json 里"会随升级漂移"的字段必须由脚本算，不能靠人跟。
 *
 * 背景：clean-ship refresh 只在发版流程（shell-release prepare）里跑，
 * 用户升级走的是 shell-update apply，从不跑它 —— 于是用户机器上的 version.json
 * 永远停在出厂值，verify 随后误报"与出厂快照不一致"，想修就得手工改 JSON。
 * 这里把 refreshVersionSnapshot()（升级收尾用的轻量版）的行为固定下来。
 */

const put = (dir, rel, content) => {
  const f = join(dir, rel)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8')
}

const readVersion = (dir) => JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8'))

/** 造一个隔离的壳根：version.json + 官方包 + desktop asar + 两份 profile */
const makeRoot = ({ version, appPkg, installedDsh, webBundles, desktopBundles, asarBytes }) => {
  const dir = tmpDir('snapshot')
  mkdirSync(dir, { recursive: true })
  if (version !== undefined) put(dir, 'version.json', version)
  if (appPkg !== undefined) put(dir, 'app/package.json', appPkg)
  if (installedDsh !== undefined) put(dir, 'app/node_modules/@deepseek-ai/dsh/package.json', { name: '@deepseek-ai/dsh', version: installedDsh })
  if (webBundles !== undefined) put(dir, 'home/profiles/web/package.json', { dsh: { profile: { bundles: webBundles } } })
  if (desktopBundles !== undefined) put(dir, 'home/profiles/desktop/package.json', { dsh: { profile: { bundles: desktopBundles } } })
  if (asarBytes !== undefined) {
    const f = join(dir, 'desktop/resources/app.asar')
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, Buffer.alloc(asarBytes))
  }
  return dir
}

const withRoot = (opts, fn) => {
  const dir = makeRoot(opts)
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const b = (...n) => n.map((x) => 'bundle-' + x)

export const cases = [
  {
    name: 'snapshot：一次刷新修好 dshVersion / bundles / asar 字节',
    fn() {
      withRoot({
        version: { dshVersion: '0.1.0', bundlesWeb: 1, bundlesDesktop: 1, desktopAsarBytes: 10 },
        installedDsh: '2.5.0',
        webBundles: b(1, 2, 3),
        desktopBundles: b(1, 2, 3, 4, 5),
        asarBytes: 4096,
      }, (dir) => {
        const r = refreshVersionSnapshot(dir)
        assert(r.ok, '刷新应成功')
        for (const k of ['dshVersion', 'bundlesWeb', 'bundlesDesktop', 'desktopAsarBytes']) {
          assert(r.changed.includes(k), '应修正 ' + k + '，实际 changed=' + JSON.stringify(r.changed))
        }
        const v = readVersion(dir)
        assert(v.dshVersion === '2.5.0', 'dshVersion 应为 2.5.0，实际 ' + v.dshVersion)
        assert(v.bundlesWeb === 3, 'bundlesWeb 应为 3，实际 ' + v.bundlesWeb)
        assert(v.bundlesDesktop === 5, 'bundlesDesktop 应为 5，实际 ' + v.bundlesDesktop)
        assert(v.desktopAsarBytes === 4096, 'desktopAsarBytes 应为 4096，实际 ' + v.desktopAsarBytes)
      })
    },
  },
  {
    name: 'snapshot：值已经对齐时不重复写（幂等）',
    fn() {
      withRoot({
        version: { dshVersion: '2.5.0', bundlesWeb: 2, bundlesDesktop: 3, desktopAsarBytes: 512, desktopAsarSizeMB: 0 },
        installedDsh: '2.5.0',
        webBundles: b(1, 2),
        desktopBundles: b(1, 2, 3),
        asarBytes: 512,
      }, (dir) => {
        const r = refreshVersionSnapshot(dir)
        assert(r.ok, '刷新应成功')
        assert(r.changed.length === 0, '值已对齐时不该有改动，实际 ' + JSON.stringify(r.changed))
      })
    },
  },
  {
    name: 'snapshot：dshVersion 优先取已装官方包，其次 package.json 兜底',
    fn() {
      // 官方包存在 → 用它（升级后 app/package.json 只剩 dependencies，没有 version）
      withRoot({
        version: {},
        appPkg: { dependencies: { '@deepseek-ai/dsh': '1.0.0' } },
        installedDsh: '9.9.9',
      }, (dir) => {
        assert(localDshVersion(dir) === '9.9.9', '应优先用已装官方包版本')
      })
      // 官方包缺失 → 退到 app/package.json
      withRoot({ version: {}, appPkg: { version: '1.0.0' } }, (dir) => {
        assert(localDshVersion(dir) === '1.0.0', '应退到 app/package.json 的 version')
      })
      // 两者都没有 → 空串，不抛异常
      withRoot({ version: {}, appPkg: { dependencies: {} } }, (dir) => {
        assert(localDshVersion(dir) === '', '都缺时应返回空串')
      })
    },
  },
  {
    name: 'snapshot：profile 缺失时返回 null，且不覆盖已有计数',
    fn() {
      withRoot({
        version: { bundlesWeb: 1, bundlesDesktop: 7 },
        webBundles: b(1, 2),     // 只有 web，没有 desktop
      }, (dir) => {
        assert(countProfileBundles('desktop', dir) === null, '缺失的 profile 应返回 null')
        const r = refreshVersionSnapshot(dir)
        assert(r.ok, '刷新应成功')
        const v = readVersion(dir)
        assert(v.bundlesWeb === 2, 'bundlesWeb 应更新为 2，实际 ' + v.bundlesWeb)
        assert(v.bundlesDesktop === 7, 'desktop profile 缺失时不该覆盖原值，实际 ' + v.bundlesDesktop)
      })
    },
  },
  {
    name: 'snapshot：version.json 不存在时明确失败但不抛异常',
    fn() {
      withRoot({ installedDsh: '1.0.0' }, (dir) => {
        const r = refreshVersionSnapshot(dir)
        assert(r.ok === false, '没有 version.json 应返回 ok=false')
        assert(Array.isArray(r.changed), 'changed 应始终是数组')
      })
    },
  },
]
