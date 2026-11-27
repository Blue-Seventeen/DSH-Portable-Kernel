import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, assert, copyShellRoot, run, tmpDir } from '../lib.mjs'

/**
 * 三条隐患的机械守卫（2026-11-27 清隐患时加）。
 *
 * ## 1. 补丁工具不能"假成功"（最危险的一条）
 *
 * `patch-fs` 会往 catch 体里插一句 `await rename(a, b)`。以前 a/b 是**写死的** `tempPath` /
 * `absolutePath`：上游一旦改参数名，工具照样报 `applied`、`node --check` 也过、`--check` 报
 * "已打上"，**运行期才 ReferenceError**。这种"假成功"比失配更糟——失配至少会被发现。
 *
 * 现在：从 `link*(a, b)` 调用里抓真实实参名；实参不是简单变量、或模块没导入 `rename`，
 * 一律判 `anchor-mismatch` 拒绝写入。
 *
 * ## 2. `requires.node` 不许是虚数
 *
 * 官方内核从 0.2.2-rc.1 起声明 `engines.node >= 24.9.0`，而我们的清单长期写 `>=24.0.0`——
 * 声称支持 24.0~24.8，而内核在那上面根本跑不起来。现在下界跟着内核走，且必须 ≤ 我们实际捆绑的运行时。
 *
 * ## 3. 联网测试必须有离线夹具
 *
 * `update-check` 的两个缓存用例原来真连网，一次抖动就会让门禁假红。
 */

/** 造一个隔离根：<dir>\tools\patch\patch-fs.mjs + <dir>\app\node_modules\@deepseek-ai\dsh-fs-local\lib\index.js */
const makeFsRoot = (indexJs) => {
  const dir = tmpDir('patch-harden')
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(dirname(join(dir, 'tools', 'patch', 'patch-fs.mjs')), { recursive: true })
  copyFileSync(join(ROOT, 'tools', 'patch', 'patch-fs.mjs'), join(dir, 'tools', 'patch', 'patch-fs.mjs'))
  mkdirSync(dirname(join(dir, 'tools', 'lib', 'asar-lite.mjs')), { recursive: true })
  copyFileSync(join(ROOT, 'tools', 'lib', 'asar-lite.mjs'), join(dir, 'tools', 'lib', 'asar-lite.mjs'))
  copyShellRoot(dir)
  const lib = join(dir, 'app', 'node_modules', '@deepseek-ai', 'dsh-fs-local', 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'index.js'), indexJs, 'utf8')
  return { dir, target: join(lib, 'index.js') }
}

const UPSTREAM = (p1, p2, importLine) => [
  importLine,
  'async function writeFileAtomic(' + p1 + ', ' + p2 + ', options) {',
  '  if (options.createIfAbsent) try {',
  '    await linkFile(' + p1 + ', ' + p2 + ');',
  '  } catch (error) {',
  '    await throwGuardedCreateFailure(error, ' + p2 + ');',
  '  }',
  '}',
].join('\n')

const { satisfiesRange } = await import(pathToFileURL(join(ROOT, 'tools', 'update', 'version-range.mjs')).href)

const GOOD_IMPORT = 'import { rename, link as linkFile } from "node:fs/promises";'

export const cases = [
  {
    name: '补丁加固：上游改了形参名，插入的回退分支必须跟着改名（不许写死 tempPath/absolutePath）',
    fn() {
      const { dir, target } = makeFsRoot(UPSTREAM('tmpPath', 'finalPath', GOOD_IMPORT))
      try {
        run([join(dir, 'tools', 'patch', 'patch-fs.mjs'), '--apply'])
        const out = readFileSync(target, 'utf8')
        assert(out.includes('h3rx-fs-patch'), '补丁没打上（夹具结构应该能命中）')
        assert(
          /rename\(tmpPath,\s*finalPath\)/.test(out),
          '插入的 rename() 没用源码里的真实形参名 —— 上游改名后会在运行期 ReferenceError'
        )
        assert(!/rename\(tempPath/.test(out), '插入的代码里还写死着 tempPath')
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
  },
  {
    name: '补丁加固：link 的实参不是简单变量时，拒绝写入（不许产出运行期必炸的补丁）',
    fn() {
      const src = [
        GOOD_IMPORT,
        'async function writeFileAtomic(a, b, options) {',
        '  if (options.createIfAbsent) try {',
        '    await linkFile(join(base, a), b);',
        '  } catch (error) {',
        '    await throwGuardedCreateFailure(error, b);',
        '  }',
        '}',
      ].join('\n')
      const { dir, target } = makeFsRoot(src)
      try {
        const r = run([join(dir, 'tools', 'patch', 'patch-fs.mjs'), '--apply'])
        assert(r.code !== 0, '应当判失配并返回非 0，实际 ' + r.code)
        assert(!readFileSync(target, 'utf8').includes('h3rx-fs-patch'), '明明无法安全插入，却还是把补丁写进去了')
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
  },
  {
    name: '补丁加固：模块没导入 rename 时拒绝写入（语法检查过得去，运行期才会炸）',
    fn() {
      const src = UPSTREAM('tmpPath', 'finalPath', 'import { writeFile, link as linkFile } from "node:fs/promises";')
      const { dir, target } = makeFsRoot(src)
      try {
        const r = run([join(dir, 'tools', 'patch', 'patch-fs.mjs'), '--apply'])
        assert(r.code !== 0, '应当判失配并返回非 0，实际 ' + r.code)
        assert(!readFileSync(target, 'utf8').includes('h3rx-fs-patch'), 'rename 不在作用域却还是打了补丁')
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
  },
  {
    name: '补丁加固：附件补丁的 shim 依赖三个导入名（link / readFile / writeFile），缺一不可',
    fn() {
      const src = readFileSync(join(ROOT, 'tools', 'patch', 'patch-attachment.mjs'), 'utf8')
      assert(/const hasShimDeps = /.test(src), '找不到 hasShimDeps：附件补丁又只检查 link 了')
      assert(/names\.includes\('readFile'\)/.test(src), '没检查 readFile 是否在同一个 import 子句里')
      assert(/names\.includes\('writeFile'\)/.test(src), '没检查 writeFile 是否在同一个 import 子句里')
      assert(/if \(!m \|\| !hasShimDeps\(text\)\) return null/.test(src), 'siteApply 没用 hasShimDeps 把关')
    },
  },
  {
    name: '补丁加固：patch-fs 必须校验 rename 绑定与实参形态（源码级）',
    fn() {
      const src = readFileSync(join(ROOT, 'tools', 'patch', 'patch-fs.mjs'), 'utf8')
      assert(/const hasRenameBinding = /.test(src), '找不到 hasRenameBinding：rename 是否可用没人管')
      assert(/from: args\[0\], to: args\[1\]/.test(src), '没从 link 调用里捕获实参名')
      assert(/rename\(' \+ site\.from \+ ', ' \+ site\.to \+ '\)/.test(src), '插入语句仍在写死变量名')
      assert(/adaptReason = 'scope'/.test(src), '失配时没有区分"结构没找到"和"要插入的标识符不可信"')
    },
  },
  {
    name: 'node 下界：清单声明必须 ≤ 我们实际捆绑的运行时，且不许低于内核要求',
    fn() {
      const ver = JSON.parse(readFileSync(join(ROOT, 'version.json'), 'utf8'))
      const man = JSON.parse(readFileSync(join(ROOT, 'shell-version.json'), 'utf8'))
      const floor = man.requires && man.requires.node
      assert(typeof floor === 'string' && floor.trim(), '清单没声明 requires.node')
      const shipped = String(ver.nodeVersion || '').replace(/^\^?/, '')
      assert(shipped, 'version.json 没有 nodeVersion，无法核对（这是出厂运行时的记录）')
      assert(
        satisfiesRange(shipped, floor) === true,
        '我们捆绑的运行时 ' + shipped + ' 不满足自己声明的 ' + floor + ' —— 新装的用户一启动就会被自己挡住'
      )
      // 官方内核从 0.2.2-rc.1 起要求 node >= 24.9.0；下界低于它就是"声称支持跑不起来的环境"
      const m = /^>=\s*(\d+\.\d+\.\d+)/.exec(floor)
      assert(m, 'requires.node 下界格式不认识：' + floor)
      const [maj, min] = m[1].split('.').map(Number)
      assert(
        maj > 24 || (maj === 24 && min >= 9),
        'requires.node 下界 ' + m[1] + ' 低于内核要求的 24.9.0（官方 engines）'
      )
    },
  },
  {
    name: '联网测试：update-check 必须有离线夹具通道（否则门禁会因网络抖动假红）',
    fn() {
      const uc = readFileSync(join(ROOT, 'tools', 'update', 'update-check.mjs'), 'utf8')
      assert(/process\.env\.DSH_UPDATE_FIXTURE/.test(uc), 'update-check 没有离线夹具开关')
      const t18 = readFileSync(join(ROOT, 'test', 'cases', '18-update-check.mjs'), 'utf8')
      assert(/DSH_UPDATE_FIXTURE/.test(t18), '测试 18 仍然真连网')
      assert(/DSH_COMPAT_FILE/.test(t18), '测试 18 没关掉兼容声明的网络拉取')
    },
  },
]

async function importRangeModule() {
  const { pathToFileURL } = await import('node:url')
  return import(pathToFileURL(join(ROOT, 'tools', 'update', 'version-range.mjs')).href)
}