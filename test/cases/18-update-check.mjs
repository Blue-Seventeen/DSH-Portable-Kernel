import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ROOT, assert, copyShellRoot, run, tmpDir } from '../lib.mjs'

/**
 * 真实事故回归：tools\update\update-check.mjs 曾经有两处让版本号恒为空，
 * 表现是启动时反复提示"有新版本"，装完再问一遍。
 *
 *   1. asar 内容起点写成 `16 + jsonLen`，漏掉 JSON 段 4 字节对齐的 padding。
 *      新版 desktop 的 app.asar 带 3 字节 padding，整体读歪 → 版本解析失败。
 *   2. app\package.json 是 pnpm 生成的（只有 dependencies，没有 version），
 *      没回退到 app\node_modules\@deepseek-ai\dsh\package.json → app 恒为空。
 *
 * 这两条都是"读不到就当没有"，日志上只表现为 `installed: app=? desktop=?`，
 * 不看代码根本发现不了，所以必须固化成用例。
 */

/** 拼一个最小合法 asar；header 的 JSON 段按 4 字节对齐，padding 必须算进 headerSize */
const buildAsarWithPad = (pkg, wantPad) => {
  for (let extra = 0; extra < 8; extra++) {
    const files = { 'package.json': null }
    // 加一个零长条目微调 header JSON 的长度，凑出想要的 padding
    if (extra) files['d'.repeat(extra) + 'x'] = { size: 0, offset: '0' }
    const body = Buffer.from(JSON.stringify(pkg), 'utf8')
    files['package.json'] = { size: body.length, offset: '0' }
    const json = Buffer.from(JSON.stringify({ files }), 'utf8')
    const pad = (4 - (json.length % 4)) % 4
    if (pad !== wantPad) continue
    const header = Buffer.alloc(16)
    header.writeUInt32LE(4, 0)
    header.writeUInt32LE(json.length + pad + 8, 4)
    header.writeUInt32LE(json.length + pad + 4, 8)
    header.writeUInt32LE(json.length, 12)
    return { buf: Buffer.concat([header, json, Buffer.alloc(pad), body]), pad }
  }
  throw new Error('凑不出 pad=' + wantPad + ' 的 asar')
}

const DESKTOP_VER = '0.2.2-rc.2'

/** 造一个隔离的壳根目录：<dir>\tools\update\update-check.mjs + app\ + desktop\ */
const makeRoot = ({ appPkg, installedDsh, asarPad }) => {
  const dir = tmpDir('update-check')
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(dirname(join(dir, 'tools', 'update', 'update-check.mjs')), { recursive: true })
  copyFileSync(join(ROOT, 'tools', 'update', 'update-check.mjs'), join(dir, 'tools', 'update', 'update-check.mjs'))
  // update-check 依赖 version-range.mjs（零依赖纯函数）：一起拷，别把 CLI 全家桶拖进来
  mkdirSync(dirname(join(dir, 'tools', 'update', 'version-range.mjs')), { recursive: true })
  copyFileSync(join(ROOT, 'tools', 'update', 'version-range.mjs'), join(dir, 'tools', 'update', 'version-range.mjs'))
  // 2026-11-27 起 update-check 还依赖 compat-live.mjs（兼容性活声明）：同样零依赖纯模块，一起拷。
  mkdirSync(dirname(join(dir, 'tools', 'update', 'compat-live.mjs')), { recursive: true })
  copyFileSync(join(ROOT, 'tools', 'update', 'compat-live.mjs'), join(dir, 'tools', 'update', 'compat-live.mjs'))
  copyShellRoot(dir)
  mkdirSync(join(dir, 'app'), { recursive: true })
  writeFileSync(join(dir, 'app', 'package.json'), JSON.stringify(appPkg), 'utf8')
  if (installedDsh) {
    const d = join(dir, 'app', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: installedDsh }), 'utf8')
  }
  if (asarPad !== undefined) {
    const r = join(dir, 'desktop', 'resources')
    mkdirSync(r, { recursive: true })
    const { buf } = buildAsarWithPad({ name: '@deepseek-ai/dsh-desktop', version: DESKTOP_VER }, asarPad)
    writeFileSync(join(r, 'app.asar'), buf)
  }
  return dir
}

// 这两个用例只关心"缓存何时作废"，不该被真实网络抖动影响（曾经偶发变红）。
// 用离线夹具把"远端最新版本"钉死；兼容声明也指向不存在的文件 → 立刻跳过、不联网。
let fixtureFile = ''
const fixture = () => {
  if (!fixtureFile) {
    const dir = tmpDir('update-check-fixture')
    mkdirSync(dir, { recursive: true })
    fixtureFile = join(dir, 'remote.json')
    writeFileSync(fixtureFile, JSON.stringify({ app: '0.2.2-rc.5', desktop: '0.2.2-rc.2' }), 'utf8')
    // 运行器没有 teardown 钩子，就挂在进程退出上自净：
    // 早先这里不清，跑一圈就在 tmp\ 里留一个 shell-test-update-check-fixture-*。
    process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  }
  return fixtureFile
}
const check = (dir) => {
  process.env.DSH_UPDATE_FIXTURE = fixture()
  process.env.DSH_COMPAT_FILE = join(dir, 'no-such-compat.json')
  try {
    return run([join(dir, 'tools', 'update', 'update-check.mjs'), '--verbose']).out
  } finally {
    delete process.env.DSH_UPDATE_FIXTURE
    delete process.env.DSH_COMPAT_FILE
  }
}

const withRoot = (opts, fn) => {
  const dir = makeRoot(opts)
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

export const cases = [
  {
    name: 'update-check：asar 带 padding 时也能读出版本（真实事故）',
    fn() {
      withRoot({ appPkg: { version: '0.2.2-rc.1' }, asarPad: 3 }, (dir) => {
        const out = check(dir)
        assert(out.includes('desktop=' + DESKTOP_VER), '带 padding 的 asar 没读出版本，实际输出：' + out.trim())
        assert(!out.includes('desktop=?'), 'desktop 版本仍是未知')
      })
    },
  },
  {
    name: 'update-check：asar 无 padding 时照旧能读（不能只修新格式）',
    fn() {
      withRoot({ appPkg: { version: '0.2.2-rc.1' }, asarPad: 0 }, (dir) => {
        const out = check(dir)
        assert(out.includes('desktop=' + DESKTOP_VER), '无 padding 的 asar 反而读不出，实际输出：' + out.trim())
      })
    },
  },
  {
    name: 'update-check：app\\package.json 没有 version 时回退到已装官方包',
    fn() {
      // 升级后的真实形状：只剩 dependencies
      withRoot({ appPkg: { dependencies: { '@deepseek-ai/dsh': '0.2.2-rc.1' } }, installedDsh: '0.2.2-rc.1' }, (dir) => {
        const out = check(dir)
        assert(out.includes('app=0.2.2-rc.1'), '没回退到官方包，实际输出：' + out.trim())
        assert(!out.includes('app=?'), 'app 版本仍是未知')
      })
    },
  },
  {
    name: 'update-check：缓存里本地版本对不上就不再复用旧结论',
    fn() {
      withRoot({ appPkg: { version: '0.2.2-rc.1' }, installedDsh: '0.2.2-rc.1', asarPad: 3 }, (dir) => {
        const stamp = join(dir, 'tmp', 'update-check.json')
        const fakeOut = 'UPD desktop 0.0.1 -> 9.9.9'
        // 夹具根没有 shell-version.json → 区间为空、未冻结 → shape 是 '|'（见 update-check 的 shape 定义）
        const write = (local) => {
          mkdirSync(join(dir, 'tmp'), { recursive: true })
          writeFileSync(stamp, JSON.stringify({ ts: Date.now(), out: fakeOut, done: { app: true, desktop: true }, local, shape: '|' }), 'utf8')
        }
        // 本地版本与缓存一致 → 命中，直接吐缓存里的结论
        write({ app: '0.2.2-rc.1', desktop: DESKTOP_VER })
        assert(check(dir).includes(fakeOut), '本地版本一致时应该走缓存')
        // 本地版本变了（典型：刚升级完）→ 必须作废重查，不能把旧结论再报一遍
        write({ app: '0.2.1-rc.5', desktop: '0.2.1-rc.5' })
        const out = check(dir)
        assert(!out.includes(fakeOut), '本地版本变了还在复用旧缓存结论（升级后会反复问要不要更新）')
        assert(out.includes('desktop=' + DESKTOP_VER), '重查时没正常识别本地版本：' + out.trim())
      })
    },
  },
  {
    name: 'update-check：旧版写的无 shape 缓存一律作废（宁可多查一次）',
    fn() {
      // 老版本缓存里没有 shape 字段，无法判断它是哪个适配区间下得出的结论。
      // 保守做法：直接作废（换壳后多一次网络检查，代价远小于"换壳还提示内核出界"）。
      withRoot({ appPkg: { version: '0.2.2-rc.1' }, installedDsh: '0.2.2-rc.1', asarPad: 3 }, (dir) => {
        const stamp = join(dir, 'tmp', 'update-check.json')
        const fakeOut = 'UPD legacy 旧结论（不该再出现）'
        mkdirSync(join(dir, 'tmp'), { recursive: true })
        writeFileSync(stamp, JSON.stringify({
          ts: Date.now(), out: fakeOut, done: { app: true, desktop: true },
          local: { app: '0.2.2-rc.1', desktop: DESKTOP_VER },
        }), 'utf8')
        assert(!check(dir).includes(fakeOut), '无 shape 的旧缓存仍被回放')
      })
    },
  },
  {
    name: 'update-check：壳换了适配区间后，旧的内核结论缓存必须立刻作废',
    fn() {
      // 2026-11-26 复测发现：缓存身份原来只有 {app, desktop}。
      // 换壳会改 shell-version.json 的 requires.dsh（放宽/收紧），或让 frozen.json 生效——
      // 这时内核版本没变，旧结论却被 6 小时 TTL 原样回放：用户刚换到"支持新内核"的壳，
      // 启动还是看到"内核出界"。所以缓存身份必须带上 区间 + 冻结状态。
      withRoot({ appPkg: { version: '0.2.2-rc.1' }, installedDsh: '0.2.2-rc.1', asarPad: 3 }, (dir) => {
        const setRange = (dsh) => {
          writeFileSync(join(dir, 'shell-version.json'), JSON.stringify({
            schemaVersion: 2, updaterMin: 2, shellVersion: '0.6.0', requires: { dsh, node: '>=24.0.0' },
          }), 'utf8')
        }
        const stamp = join(dir, 'tmp', 'update-check.json')
        const fakeOut = 'KERN 旧区间得出的结论（不该再出现）'
        const writeCache = (shape) => {
          mkdirSync(join(dir, 'tmp'), { recursive: true })
          writeFileSync(stamp, JSON.stringify({
            ts: Date.now(), out: fakeOut, done: { app: true, desktop: true },
            local: { app: '0.2.2-rc.1', desktop: DESKTOP_VER }, shape,
          }), 'utf8')
        }
        // 区间与缓存一致 → 命中缓存（证明缓存机制本身在用）
        setRange('>=0.2.1-rc.5,<0.2.2-rc.2')
        writeCache('>=0.2.1-rc.5,<0.2.2-rc.2|')
        assert(check(dir).includes(fakeOut), '区间一致时应该走缓存')

        // 换壳把区间放宽 → 旧结论必须作废
        setRange('>=0.2.1-rc.5')
        assert(!check(dir).includes(fakeOut), '壳换了适配区间还在回放旧内核结论（换壳后仍提示内核出界）')

        // 冻结状态变化 → 同样必须作废（frozen.json 会让内核提示全静默）
        setRange('>=0.2.1-rc.5,<0.2.2-rc.2')
        writeCache('>=0.2.1-rc.5,<0.2.2-rc.2|0.2.2-rc.1')
        assert(!check(dir).includes(fakeOut), 'frozen.json 状态变了仍在回放旧结论')
      })
    },
  },
  {
    name: 'update-check：asar 缺失或损坏时不抛异常，回退到标记文件',
    fn() {
      withRoot({ appPkg: { version: '1.0.0' } }, (dir) => {
        const out = check(dir)
        assert(out.includes('installed:'), 'asar 缺失时脚本崩了：' + out.trim())
        assert(out.includes('desktop=?'), 'asar 缺失时应报未知，实际：' + out.trim())
        // 补一个壳自己写的标记文件，应当被采纳
        mkdirSync(join(dir, 'desktop'), { recursive: true })
        writeFileSync(join(dir, 'desktop', 'version.dsh'), '3.3.3\n', 'utf8')
        assert(check(dir).includes('desktop=3.3.3'), '标记文件没被采纳')
      })
    },
  },
]
