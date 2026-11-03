#!/usr/bin/env node
/**
 * 让浏览器模式（web）和桌面窗口（desktop）共用同一份插件，并且**插件市场直接管这一份**。
 *
 * 结构：两个模式各是一个 profile（home\profiles\web、home\profiles\desktop）。
 * 插件实体统一放在 home\profiles\node_modules（两个 profile 的共同上级），磁盘上只有一份；
 * dsh 解析 bundle 时是逐级向上查找的，所以两边都能解析到。
 *
 * 让市场也认这一份的关键：在每个 profile 的 pnpm-workspace.yaml 里写
 *   modulesDir: ../node_modules
 * 于是官方桌面端插件市场 / dshmarket 在任一模式里点安装、更新、卸载，pnpm 都直接作用在
 * 共享目录上——不用再手工搬。
 *
 * 三条必须守住的条件：
 *   1. 三份清单（共享根、web、desktop）的 dependencies 必须一致。三个项目共用一个
 *      node_modules，pnpm 每次安装都会剪掉"不属于本项目"的包；三边一样才不会互相误删。
 *      sync / add / remove 之后都会自动对齐（mirrorDeps）。
 *   2. lockfile 也统一：取最新那份复制给另外两处，避免版本打架。
 *   3. 只有声明 dsh.bundle 的包才写进 dsh.profile.bundles；普通依赖写进去会让 dsh 启动失败。
 *
 * 用法：
 *   node tools\plugin-shared.mjs list                 看共享集与两个 profile 的对照
 *   node tools\plugin-shared.mjs add <包名或规格>...   装到共享目录，两个模式一起启用
 *   node tools\plugin-shared.mjs remove <包名>...      两个模式一起停用并从共享目录卸载
 *   node tools\plugin-shared.mjs adopt <包名>...       收编老结构留下的本地副本
 *   node tools\plugin-shared.mjs sync [--prune]        对齐清单/依赖/lockfile（换机器、手工改过后用）
 * 通用开关：--dry-run 预演  --quiet 静默  --force 跳过"正在运行"检查  --root <便携根目录>
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const argOf = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : null
}
/** 去掉开关后的位置参数（子命令 + 包名） */
const positional = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--root' || a === '--store') { i++; continue }
  if (a.startsWith('--')) continue
  positional.push(a)
}

const dryRun = hasFlag('--dry-run')
// --check：只比对、不落盘。verify 用它做"sync 幂等"断言，避免门禁自己改文件（审计 F.5）。
let checkMode = false
const pending = []
const notePending = (f) => { pending.push(String(f).split(root + '\\').join('')) }
const quiet = hasFlag('--quiet')
const force = hasFlag('--force')
const pruneFlag = hasFlag('--prune')

const root = argOf('--root')
  ? pathResolve(argOf('--root'))
  : dirname(dirname(fileURLToPath(import.meta.url)))
const profilesDir = join(root, 'home', 'profiles')
const sharedDir = profilesDir
const sharedManifestFile = join(sharedDir, 'package.json')
const sharedWorkspaceFile = join(sharedDir, 'pnpm-workspace.yaml')
const pnpmCmd = join(root, 'runtime', 'pnpm', 'bin', 'pnpm.cmd')
const nodeExe = join(root, 'runtime', 'node', 'bin', 'node.exe')
// store 只认盘内路径（env.cmd 的 DSH_PNPM_STORE）：不再回退主机用户目录，
// 便携壳的定位就是"整包带走、不在宿主机器留任何东西"。
const storeRoot = argOf('--store') || process.env.DSH_PNPM_STORE || join(root, 'cache', 'pnpm-store')
/** 有独立插件集的 profile；新增模式时在这里加名字即可 */
const PROFILES = ['web', 'desktop']
const LABEL = { web: '浏览器模式', desktop: '桌面窗口' }

const say = (m) => console.log((quiet ? '' : '  ') + m)
const out = (m) => { if (!quiet) console.log(m) }
const die = (m) => {
  console.error('  ' + m)
  process.exit(1)
}

/* ------------------------------------------------------------------ 基础读写 */

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, value) => {
  const text = JSON.stringify(value, void 0, 2) + '\n'
  let old = null
  try { old = readFileSync(file, 'utf8') } catch { /* 首次创建时没有原文件 */ }
  // 内容一样就不写：不刷新 mtime、不产生 .bak。"同步一次"只应该在有真实变化时才动文件，
  // 否则在 U 盘/同步盘上等于每次启动都触发一次无意义的写入，也让"零改动"无法验证。
  if (checkMode) { if (old !== text) notePending(file); return }
  if (dryRun) return
  if (old === text) return
  try { copyFileSync(file, file + '.bak') } catch { /* 忽略 */ }
  writeFileSync(file, text, 'utf8')
}
const profileDir = (name) => join(profilesDir, name)
const profileManifestFile = (name) => join(profileDir(name), 'package.json')

/** 读 profile 清单；不存在返回 null（未初始化过的模式） */
const readProfile = (name) => {
  const f = profileManifestFile(name)
  return existsSync(f) ? readJson(f) : null
}
const bundlesOf = (manifest) => manifest?.dsh?.profile?.bundles ?? []
const depsOf = (manifest) => Object.keys(manifest?.dependencies ?? {})

/* ------------------------------------------------- 解析（复刻 dsh 的查找顺序） */

/**
 * 某 profile 能否解析到某个包，返回包目录或 undefined。
 * 与 dsh-app-boot 的 packageDirFromAnchor 同源：用 createRequire 的搜索路径，
 * 依次检查 <searchPath>\<name>\package.json。
 */
const resolveWith = (anchor, name) => {
  let searchPaths = []
  try {
    searchPaths = createRequire(anchor).resolve.paths(name) ?? []
  } catch {
    return undefined
  }
  for (const p of searchPaths) {
    const candidate = join(p, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** dsh 安装目录（内置 bundle 的来源，解析时排在 profile 之前） */
const installAnchor = join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')

/**
 * 版本兼容性判断——完全照 dsh 自己的规则（dsh-app-boot 的 evaluatePluginCompatibility）：
 * 插件写了 engines.dsh 就只看它，否则把每个 @deepseek-ai/dsh 或 @deepseek-ai/dsh-* 的
 * peerDependencies 与"当前 dsh 版本"比对，预发布版本也参与比较。
 * 不满足的插件启动时会被 dsh 跳过（skipping profile bundle），所以这里先在安装/登记前提示。
 */
const runtimeVersion = () => {
  try { return readJson(installAnchor).version } catch { return null }
}
const semverLib = () => {
  try { return createRequire(installAnchor)('semver') } catch { return null }
}
const unmetRequirements = (pkgJson) => {
  const rt = runtimeVersion()
  const semver = semverLib()
  if (!rt || !semver) return {}
  const ok = (range) => {
    if (typeof range !== 'string' || !range.trim()) return false
    if (['workspace:^', 'workspace:~', 'workspace:*'].includes(range)) return true
    try { return semver.satisfies(rt, range, { includePrerelease: true }) } catch { return false }
  }
  const engines = pkgJson.engines ?? {}
  if (Object.prototype.hasOwnProperty.call(engines, 'dsh')) {
    return ok(engines.dsh) ? {} : { 'engines.dsh': engines.dsh }
  }
  const unmet = {}
  for (const [dep, range] of Object.entries(pkgJson.peerDependencies ?? {})) {
    if (dep !== '@deepseek-ai/dsh' && !dep.startsWith('@deepseek-ai/dsh-')) continue
    if (!ok(range)) unmet[dep] = range
  }
  return unmet
}
/** 某个已安装插件的兼容性：{} 表示没问题 */
const compatOf = (dir) => {
  if (!dir) return {}
  try { return unmetRequirements(readJson(join(dir, 'package.json'))) } catch { return {} }
}

/** 按 dsh 的两段顺序解析：先安装目录，再 profile */
const resolveFrom = (name, profile) => {
  const fromInstall = resolveWith(installAnchor, name)
  if (fromInstall) return { dir: fromInstall, source: 'install' }
  const fromProfile = resolveWith(profileManifestFile(profile), name)
  return fromProfile ? { dir: fromProfile, source: 'profile' } : undefined
}

const norm = (p) => (p ? p.replace(/\//g, '\\').toLowerCase() : '')
/** 归类某个包在两个 profile 里的落点：install（内置）/ shared / local / outside / missing */
const classify = (name) => {
  const where = {}
  for (const p of PROFILES) {
    const hit = resolveFrom(name, p)
    if (!hit) { where[p] = { kind: 'missing' }; continue }
    const nd = norm(hit.dir)
    if (hit.source === 'install') where[p] = { kind: 'install', dir: hit.dir }
    else if (nd.startsWith(norm(join(sharedDir, 'node_modules')))) where[p] = { kind: 'shared', dir: hit.dir }
    else if (nd.startsWith(norm(join(profileDir(p), 'node_modules')))) where[p] = { kind: 'local', dir: hit.dir }
    else where[p] = { kind: 'outside', dir: hit.dir }
    try { where[p].version = readJson(join(hit.dir, 'package.json')).version } catch { /* 忽略 */ }
  }
  return where
}

/* --------------------------------------------------------------- 共享根脚手架 */

/**
 * 写一份 pnpm 配置。关键在 modulesDir：
 *   - profile 里写 `modulesDir: ../node_modules`，pnpm 就把包装进 home\profiles\node_modules，
 *     也就是两个模式共用的那一份。插件市场（官方桌面端 / dshmarket）走的是同一套 pnpm，
 *     所以从市场装、从市场卸，动的都是共享目录——不需要再手工 adopt。
 *   - 共享根自己不要再写 modulesDir（它的 node_modules 就是那个目录）。
 * storeDir 不在这里写：那是"这台机器上 pnpm 仓库放哪"的本机信息，
 * 由 fix-pnpm-state.mjs 在每次启动时对齐（三个文件一起改），sync 只负责结构
 * （nodeLinker / autoInstallPeers / modulesDir）。这样仓库里不会带上作者机的绝对路径
 * （比如 C:\Users\<某人>\AppData\...），换机器也不会因为 storeDir 不一致而互相覆盖。
 * 已经存在的 storeDir 行会原样保留，不删也不改（避免和 fix-pnpm-state 打架）。
 */
const writeWorkspace = (dir, isProfile) => {
  const file = join(dir, 'pnpm-workspace.yaml')
  const lines = [
    'packages:',
    "  - '.'",
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
  ]
  if (isProfile) lines.push('', 'modulesDir: ../node_modules')
  let old = ''
  try { old = readFileSync(file, 'utf8') } catch { /* 没有就新建 */ }
  // 保留原有的 storeDir 行（如果有），位置放在 autoInstallPeers 之后
  const kept = old.split('\n').filter((l) => /^\s*(storeDir|packageImportMethod)\s*:/.test(l))
  if (kept.length) lines.splice(5, 0, '', ...kept.map((l) => l.trimEnd()))
  const text = lines.join('\n') + '\n'
  const differs = old !== text
  // 注意：先比较再决定要不要真的写/记账，否则 --check 会把三份本来就一致的文件也报成"待改"
  if ((dryRun || checkMode) && differs) {
    say('[预演] 将改写 ' + file.replace(root + '\\', ''))
    if (checkMode) notePending(file)
  }
  if (dryRun || checkMode) return false
  if (!differs) return false
  writeFileSync(file, text, 'utf8')
  return true
}

const ensureScaffold = () => {
  if (!existsSync(sharedManifestFile)) {
    if (dryRun || checkMode) { say('[预演] 将创建 home\\profiles\\package.json'); if (checkMode) notePending(sharedManifestFile) }
    else {
      writeFileSync(
        sharedManifestFile,
        JSON.stringify({ name: 'dsh-profile-shared', private: true, dependencies: {} }, void 0, 2) + '\n',
        'utf8',
      )
      say('已创建共享插件清单：home\\profiles\\package.json')
    }
  }
  if (writeWorkspace(sharedDir, false)) say('已更新共享根 pnpm 配置（hoisted + 固定仓库）')
  for (const p of PROFILES) {
    if (!existsSync(profileDir(p))) continue
    if (writeWorkspace(profileDir(p), true)) say('[' + LABEL[p] + '] 已把安装目录指向共享目录（modulesDir）')
  }
  if (!existsSync(storeRoot) && !dryRun && !checkMode) {
    try { mkdirSync(storeRoot, { recursive: true }) } catch { /* 建不出来交给 pnpm 报错 */ }
  }
}

/**
 * 把三份清单的 dependencies 对齐成同一份，lockfile 也用最新的那一份统一。
 * 为什么必须一致：三个项目共用同一个 node_modules，pnpm 每次安装都会把"不属于本项目的包"
 * 剪掉。只要三边依赖一致，市场在任一模式里装/卸，另一边都不会被误删。
 *
 * 谁来当"正确的那一份"：传入 sourceFile 时以它为准（刚装/刚卸的那一侧）；
 * 不传时取三份里最新修改的那份（对应"在界面里装完，再跑 sync"的情况）。
 * 不能用并集：那样"卸载"会被另外两份的旧记录复活。
 */
const mirrorDeps = (sourceFile) => {
  const files = [sharedManifestFile, profileManifestFile('web'), profileManifestFile('desktop')]
    .filter((f) => existsSync(f))
  if (!files.length) return 0
  let src = sourceFile && files.includes(sourceFile) ? sourceFile : null
  if (!src) {
    src = files.map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t)[0].f
  }
  let truth = {}
  try { truth = readJson(src).dependencies ?? {} } catch { truth = {} }
  const sorted = Object.fromEntries(Object.keys(truth).sort().map((n) => [n, truth[n]]))
  let changed = 0
  for (const f of files) {
    const m = readJson(f)
    if (JSON.stringify(m.dependencies ?? {}) === JSON.stringify(sorted)) continue
    if (dryRun || checkMode) { say('[预演] 将对齐依赖：' + f.replace(root + '\\', '')); if (checkMode) notePending(f); changed++; continue }
    const next = { ...m }
    if (Object.keys(sorted).length) next.dependencies = sorted
    else delete next.dependencies
    writeJson(f, next)
    changed++
  }
  // lockfile：谁最新就用谁，复制给另外两处，避免 --frozen-lockfile 时三边版本打架
  const locks = files.map((f) => join(dirname(f), 'pnpm-lock.yaml')).filter((f) => existsSync(f))
  if (locks.length > 1) {
    const newest = locks.map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t)[0].f
    for (const f of locks) {
      if (f === newest) continue
      let same = false
      try { same = readFileSync(f, 'utf8') === readFileSync(newest, 'utf8') } catch { /* 读不了就当不同 */ }
      if (same) continue
      if (dryRun || checkMode) { say('[预演] 将统一 lockfile：' + f.replace(root + '\\', '')); if (checkMode) notePending(f); changed++; continue }
      copyFileSync(newest, f)
      changed++
    }
  }
  return changed
}

/** 把某个包从三份清单的 dependencies 里彻底去掉（包文件已经不存在时用） */
const depRemoveEverywhere = (name) => {
  let n = 0
  for (const f of [sharedManifestFile, profileManifestFile('web'), profileManifestFile('desktop')]) {
    if (!existsSync(f)) continue
    let j = null
    try { j = readJson(f) } catch { continue }
    if (!j.dependencies || !(name in j.dependencies)) continue
    if (dryRun || checkMode) { say('[预演] 将从依赖里移除 ' + name + '：' + f.replace(root + '\\', '')); if (checkMode) notePending(f); n++; continue }
    delete j.dependencies[name]
    if (!Object.keys(j.dependencies).length) delete j.dependencies
    writeJson(f, j)
    n++
  }
  return n
}

/** 删掉 writeJson 留下的同名 .bak（每次成功后都清一遍，免得目录里堆一堆） */
const cleanupBaks = () => {
  if (dryRun && !checkMode) return 0
  let n = 0
  const dirs = [sharedDir, profileDir('web'), profileDir('desktop')]
  for (const d of dirs) {
    if (!existsSync(d)) continue
    for (const name of ['package.json.bak', 'compatibility.json.bak', 'pnpm-workspace.yaml.bak']) {
      const f = join(d, name)
      if (!existsSync(f)) continue
      // .bak 是写清单时的临时产物，删它不算"状态不一致"，所以 --check 下不记待改（否则门禁会偶发红）
      if (checkMode) { say('[预演] 将删除临时备份 ' + f.replace(root + '\\', '')); n++; continue }
      try { rmSync(f, { force: true }); n++ } catch { /* 正在用就留着 */ }
    }
    // fix-state 改 pnpm 记录时也会留备份，一并清掉
    for (const rel of ['.modules.yaml.bak', '.pnpm-workspace-state-v1.json.bak']) {
      const f = join(d, 'node_modules', rel)
      if (!existsSync(f)) continue
      if (checkMode) { say('[预演] 将删除临时备份 ' + f.replace(root + '\\', '')); n++; continue }
      try { rmSync(f, { force: true }); n++ } catch { /* 同上 */ }
    }
  }
  return n
}

/** 用 dsh 自己的插件通道装/卸（和插件市场完全同一条代码路径），落在哪个 profile 都一样改共享目录 */
const dshPlugin = (profileName, args) => {
  const bin = join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) { console.error('  找不到 dsh（' + bin + '）'); return { ok: false } }
  const cmd = [quoteArg(nodeExe), quoteArg(bin), 'plugin', '--profile', profileName, ...args.map(quoteArg)].join(' ')
  out('  > dsh plugin --profile ' + profileName + ' ' + args.join(' '))
  if (dryRun) return { ok: true }
  const r = spawnSync(cmd, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    timeout: 900000,
    windowsHide: true,
    env: { ...process.env, PATH: launcherPath(), DSH_HOME: join(root, 'home') },
  })
  const text = ((r.stdout || '') + (r.stderr || '')).trim()
  if (r.status !== 0) {
    console.error('  dsh 插件操作失败（退出码 ' + r.status + '）：')
    if (text) console.error(text.split(/\r?\n/).slice(-25).map((l) => '    ' + l).join('\n'))
    if (/UNEXPECTED_(VIRTUAL_)?STORE/.test(text)) {
      console.error('  → 这是换机器/换目录后 pnpm 的路径记录过期。先运行：dsh-portable.cmd fix-state')
    }
    return { ok: false }
  }
  return { ok: true }
}


/* ------------------------------------------------------------------ 清单登记 */

/** 在某个 profile 的 bundles 末尾追加（已存在则跳过），返回是否有改动 */
const bundleAdd = (name, bundleName) => {
  const m = readProfile(name)
  if (!m) { say('[' + LABEL[name] + '] 还没有 profile，跳过登记'); return false }
  const list = bundlesOf(m)
  if (list.includes(bundleName)) return false
  m.dsh = m.dsh ?? {}
  m.dsh.profile = m.dsh.profile ?? {}
  m.dsh.profile.bundles = [...list, bundleName]
  writeJson(profileManifestFile(name), m)
  return true
}

const bundleRemove = (name, bundleName) => {
  const m = readProfile(name)
  if (!m) return false
  const list = bundlesOf(m)
  if (!list.includes(bundleName)) return false
  m.dsh.profile.bundles = list.filter((b) => b !== bundleName)
  writeJson(profileManifestFile(name), m)
  return true
}

/* ------------------------------------------------------- 停用状态（保留文件） */

/**
 * 停用 = 只把名字从两个 profile 的 bundles 里拿掉，文件留在共享根，随时能再启用。
 * 记录在共享清单的 dsh.profileShared.disabled 里，sync 会尊重它（不会又给加回去）。
 */
const disabledList = () => {
  if (!existsSync(sharedManifestFile)) return []
  try { return readJson(sharedManifestFile)?.dsh?.profileShared?.disabled ?? [] } catch { return [] }
}
const setDisabled = (name, off) => {
  const m = existsSync(sharedManifestFile)
    ? readJson(sharedManifestFile)
    : { name: 'dsh-profile-shared', private: true, dependencies: {} }
  m.dsh = m.dsh ?? {}
  m.dsh.profileShared = m.dsh.profileShared ?? {}
  const cur = new Set(m.dsh.profileShared.disabled ?? [])
  if (off) cur.add(name); else cur.delete(name)
  m.dsh.profileShared.disabled = [...cur]
  writeJson(sharedManifestFile, m)
}

/* ------------------------------------------------- 版本豁免（强行允许旧插件） */

/**
 * dsh 的"强行允许"就是 profile 目录里的 compatibility.json：
 *   { "<包名>@<版本>": ["<允许运行的 dsh 版本>", ...] }
 * 只认精确版本，而且每个 profile 各有一份——所以共享插件要豁免时，两个 profile 都得写。
 * 这本来就是你在桌面 profile 里用过的手法（那份文件还在），这里把它做成两个模式同步。
 */
const compatFile = (name) => join(profileDir(name), 'compatibility.json')
const readCompat = (name) => {
  const f = compatFile(name)
  if (!existsSync(f)) return {}
  try {
    const v = readJson(f)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}
const writeCompat = (name, value) => {
  const f = compatFile(name)
  const empty = Object.keys(value).length === 0
  const text = empty ? '' : JSON.stringify(value, void 0, 2) + '\n'
  let old = null
  try { old = readFileSync(f, 'utf8') } catch { /* 首次创建时没有原文件 */ }
  if (checkMode) {
    // 只记录"真的会改"的文件，避免 --check 永远报脏
    if (empty ? existsSync(f) : old !== text) notePending(f)
    return
  }
  if (dryRun) return
  if (empty) {
    if (existsSync(f)) { try { rmSync(f) } catch { /* 忽略 */ } }
    return
  }
  if (old === text) return // 内容没变：不重写、不刷新 mtime、不留 .bak
  try { copyFileSync(f, f + '.bak') } catch { /* 忽略 */ }
  writeFileSync(f, text, 'utf8')
}
/** 已安装插件的准确版本（共享根优先） */
const installedVersion = (n) => {
  const sharedPkg = join(sharedDir, 'node_modules', n, 'package.json')
  if (existsSync(sharedPkg)) {
    try { return readJson(sharedPkg).version } catch { return null }
  }
  const w = classify(n)
  const dir = (w.desktop && w.desktop.dir) || (w.web && w.web.dir)
  if (!dir) return null
  try { return readJson(join(dir, 'package.json')).version } catch { return null }
}
/**
 * 是否两个 profile 都有生效的豁免。
 *
 * 官方（dsh 0.2.1-rc.5）的规则是"列表里必须含**精确**版本号"：
 *   compatibility.json: … must contain a list of exact DSH versions; the record is ignored
 * 写 '*' 不会被当成通配，而是整条记录被丢弃、插件被静默跳过
 * （实测 stderr：skipping profile bundle "@huanlin/dsh-plugin-session-delete"…）。
 * 所以这里只认精确匹配；跨版本由 compat-heal 在启动前补写。
 */
const isExempted = (n) => {
  const v = installedVersion(n)
  const rt = runtimeVersion()
  if (!v || !rt) return false
  return PROFILES.every((p) => (readCompat(p)[n + '@' + v] ?? []).includes(rt))
}
/** 豁免记录与当前 dsh 版本不一致、或形状不被官方接受（给 doctor / 启动警告用） */
const compatDrift = () => {
  const rt = runtimeVersion()
  const out = []
  if (!rt) return out
  // 审计 F.8：原来只看 PROFILES[0]（web），desktop 单独漂移时看不见；两份都要查。
  for (const p of PROFILES) {
    const compat = readCompat(p)
    for (const key of Object.keys(compat)) {
      // key 形如 "@scope/name@1.2.3"（名字本身可能带 @，所以按最后一个 @ 切）
      const at = key.lastIndexOf('@')
      if (at <= 0) { out.push({ profile: p, name: key, version: '?', pinned: '?', now: rt, bad: '无法解析的键' }); continue }
      const name = key.slice(0, at)
      const v = key.slice(at + 1)
      const list = Array.isArray(compat[key]) ? compat[key] : []
      if (list.includes('*')) {
        out.push({ profile: p, name, version: v, pinned: list.join(','), now: rt, bad: '官方不认 "*"，整条记录会被忽略，插件会被跳过' })
        continue
      }
      if (!list.length || list.includes(rt)) continue
      out.push({ profile: p, name, version: v, pinned: list.join(','), now: rt })
    }
  }
  return out
}
/** 在两个 profile 同时写入/撤销豁免。官方只认精确版本号，所以固定写单元素 [当前 dsh] */
const grantAll = (n, on) => {
  const v = installedVersion(n)
  const rt = runtimeVersion()
  if (!v || !rt) { console.error('  无法确定 ' + n + ' 的版本，豁免未写入'); return false }
  const key = n + '@' + v
  for (const p of PROFILES) {
    const m = readCompat(p)
    if (on) m[key] = [rt]
    else delete m[key]
    writeCompat(p, m)
  }
  return true
}

/**
 * 把豁免文件规整成"官方认可的形状"：
 *   1. 已装插件 → 值固定为 [当前 dsh 版本]（旧版本号 / '*' / 多元素都会被改写）
 *   2. 包已卸载 或 插件版本已变（key 陈旧）→ 删除该键
 * 这是"不用通配也不丢插件"的正解：官方升级后，启动器先跑一次本命令，豁免就跟着走。
 */
const compatHeal = () => {
  const rt = runtimeVersion()
  const actions = []
  if (!rt) return { changed: 0, actions }
  for (const p of PROFILES) {
    const m = readCompat(p)
    let dirty = false
    for (const key of Object.keys(m)) {
      const at = key.lastIndexOf('@')
      if (at <= 0) { delete m[key]; dirty = true; actions.push(p + ': 删除无法解析的键 ' + key); continue }
      const name = key.slice(0, at)
      const pinVer = key.slice(at + 1)
      const v = installedVersion(name)
      if (!v) { delete m[key]; dirty = true; actions.push(p + ': 删除已卸载插件的豁免 ' + key); continue }
      if (v !== pinVer) { delete m[key]; dirty = true; actions.push(p + ': 删除旧插件版本键 ' + key + '（现装 ' + v + '）'); continue }
      const list = Array.isArray(m[key]) ? m[key] : []
      if (list.length === 1 && list[0] === rt) continue
      m[key] = [rt]
      dirty = true
      actions.push(p + ': ' + key + ' [' + (list.join(',') || '空') + '] → ["' + rt + '"]')
    }
    if (dirty) writeCompat(p, m)
  }
  if (actions.length) cleanupBaks()
  return { changed: actions.length, actions }
}

/* ------------------------------------------------------------------- 运行检查 */

/**
 * 便携版是否正在运行。运行中改写 profile 清单会让内存状态与磁盘不一致。
 * 排除自己与父进程（本脚本本身就在便携目录里）。
 */
const runningPortable = () => {
  try {
    const r = root.split("'").join("''")
    const script =
      "$r='" + r + "'; Get-CimInstance Win32_Process | " +
      'Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like ($r + "*")) } | ' +
      "ForEach-Object { '' + $_.ProcessId + '|' + $_.Name }"
    const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 25000,
      windowsHide: true,
    })
    const self = new Set([process.pid, process.ppid])
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const parts = s.split('|')
        return { pid: Number(parts[0]), name: parts[1] }
      })
      .filter((p) => p.pid && !self.has(p.pid))
  } catch {
    return []   // 探测失败不阻塞：宁可放行，也不让命令莫名失败
  }
}

const guard = (what) => {
  if (force) return
  const live = runningPortable()
  if (!live.length) return
  const list = live.slice(0, 5).map((p) => p.name + '(' + p.pid + ')').join(', ')
  die(
    '便携版正在运行（' + list + '），' + what + '会改写插件清单，请先关掉窗口再执行。\n' +
      '  确认要强行继续请加 --force。',
  )
}

/* ------------------------------------------------------------------ pnpm 调用 */

const quoteArg = (a) => (/[\s"]/.test(a) ? '"' + a.split('"').join('\\"') + '"' : a)
const launcherPath = () =>
  [join(root, 'runtime', 'node', 'bin'), join(root, 'runtime', 'pnpm', 'bin')].join(';') +
  ';' + (process.env.PATH || process.env.Path || '')

/** 在指定目录跑 pnpm；返回 { ok } */
const runPnpm = (cwd, args) => {
  const cmd = [quoteArg(pnpmCmd), ...args.map(quoteArg)].join(' ')
  out('  > pnpm ' + args.join(' '))
  if (dryRun) return { ok: true }
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: 600000,
    windowsHide: true,
    env: { ...process.env, PATH: launcherPath(), npm_config_store_dir: storeRoot },
  })
  const text = ((r.stdout || '') + (r.stderr || '')).trim()
  if (r.status !== 0) {
    console.error('  pnpm 失败（退出码 ' + r.status + '）：')
    if (text) console.error(text.split(/\r?\n/).map((l) => '    ' + l).join('\n'))
    if (/UNEXPECTED_(VIRTUAL_)?STORE/.test(text)) {
      console.error('  → 这是换机器/换目录后 pnpm 的路径记录过期。先运行：dsh-portable.cmd fix-state')
    }
    return { ok: false }
  }
  return { ok: true }
}

/**
 * 动手前先对齐 pnpm 的路径记录。
 * 树被搬到别的机器/别的目录后，profile 的 .modules.yaml 里还写着旧路径，
 * pnpm 会直接拒绝（ERR_PNPM_UNEXPECTED_VIRTUAL_STORE / UNEXPECTED_STORE）。
 * fix-pnpm-state.mjs 就是干这个的，幂等且很快（有缓存）。
 */
const ensureState = () => {
  const script = join(root, 'tools', 'fix-pnpm-state.mjs')
  if (!existsSync(script) || dryRun) return
  spawnSync([quoteArg(nodeExe), quoteArg(script), '--quiet', '--root', quoteArg(root)].join(' '), {
    shell: true,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, PATH: launcherPath() },
  })
}

/* --------------------------------------------------------------------- 命令 */

const warnCompat = (n) => {
  const w = classify(n)
  const dir = (w.web && w.web.dir) || (w.desktop && w.desktop.dir)
  const unmet = compatOf(dir)
  if (Object.keys(unmet).length) {
    console.error('  注意：' + n + ' 与当前 dsh ' + runtimeVersion() + ' 不兼容（' + JSON.stringify(unmet) + '），')
    console.error('        dsh 启动时会主动跳过它，功能不生效。')
  }
}

const warnResolve = (n, w) => {
  for (const p of PROFILES) {
    if (w[p].kind !== 'shared' && w[p].kind !== 'install') {
      console.error('  注意：' + LABEL[p] + ' 解析 ' + n + ' 时得到 ' + w[p].kind + '，请用 list 复查。')
    }
  }
}

const cmdList = () => {
  const shared = existsSync(sharedManifestFile) ? readJson(sharedManifestFile) : null
  const names = new Set(shared ? depsOf(shared) : [])
  for (const p of PROFILES) for (const b of bundlesOf(readProfile(p))) names.add(b)

  const dis = new Set(disabledList())
  const rows = [...names].sort().map((n) => {
    const w = classify(n)
    const dir = (w.web && w.web.dir) || (w.desktop && w.desktop.dir)
    return {
      n,
      kinds: PROFILES.map((p) => w[p].kind),
      versions: PROFILES.map((p) => w[p].version || ''),
      unmet: compatOf(dir),
      disabled: dis.has(n),
      exempted: Object.keys(compatOf(dir)).length ? isExempted(n) : false,
    }
  })
  const kindText = (r) => {
    if (r.kinds.every((k) => k === 'shared')) return '共享'
    if (r.kinds.every((k) => k === 'install')) return '内置（随 dsh 提供）'
    if (r.kinds.every((k) => k === 'missing')) return '悬空（文件不存在）'
    if (r.kinds.includes('shared')) return '共享（仅一边启用）'
    if (r.kinds.includes('local')) return '仅本地副本'
    return r.kinds.join('/')
  }
  const pad = (s, n) => (s.length >= n ? s + ' ' : s.padEnd(n))
  const tags = (r) => {
    const t = []
    if (r.disabled) t.push('已停用（文件保留）')
    if (Object.keys(r.unmet).length) {
      t.push(r.exempted
        ? '与 dsh ' + runtimeVersion() + ' 不兼容，但已豁免（强行允许，会照常加载）'
        : '与 dsh ' + runtimeVersion() + ' 不兼容，启动会被跳过')
    }
    return t.length ? '  ⚠ ' + t.join('；') : ''
  }
  const line = (r) => '  ' + pad(r.n, 52) + pad(r.versions.filter(Boolean)[0] || '-', 9) + kindText(r) + tags(r)

  const isShared = (r) => r.kinds.every((k) => k === 'shared')
  const isInbox = (r) => r.kinds.every((k) => k === 'install')
  out('共享插件（home\\profiles\\node_modules，两种模式共用一份）')
  const sharedRows = rows.filter(isShared)
  sharedRows.length ? sharedRows.forEach((r) => out(line(r))) : out('  （空）')
  out('')
  out('内置（随 dsh 安装提供，不需要也不该搬动）')
  const inboxRows = rows.filter(isInbox)
  inboxRows.length ? inboxRows.forEach((r) => out(line(r))) : out('  （空）')
  out('')
  out('其他')
  const otherRows = rows.filter((r) => !isShared(r) && !isInbox(r))
  otherRows.length ? otherRows.forEach((r) => out(line(r))) : out('  （空）')

  const dangling = rows.filter((r) => r.kinds.every((k) => k === 'missing'))
  const localOnly = rows.filter((r) => r.kinds.includes('local'))
  const incompatible = rows.filter((r) => Object.keys(r.unmet).length && !r.exempted)
  const exempted = rows.filter((r) => r.exempted)
  out('')
  if (dangling.length) {
    out('提示：' + dangling.length + ' 个悬空项（清单里有、文件找不到）会让启动时报 skipping，')
    out('      可执行 sync --prune 清掉。')
  }
  if (localOnly.length) out('提示：' + localOnly.length + ' 个插件只有本地副本，用 adopt 搬到共享根即可单副本。')
  if (incompatible.length) {
    out('提示：' + incompatible.length + ' 个插件与当前 dsh ' + runtimeVersion() + ' 不兼容（dsh 会主动跳过，功能不生效）：')
    out('      ' + incompatible.map((r) => r.n).join(', '))
    out('      要像旧环境那样强行允许，执行 allow <包名>（两个模式一起豁免）；或等插件出适配版本。')
  }
  if (exempted.length) {
    out('已豁免（两个模式都强行允许运行，有崩溃风险由你承担）：' + exempted.map((r) => r.n).join(', '))
  }
  if (!dangling.length && !localOnly.length && !incompatible.length) {
    out('状态正常：所有插件都只有一份共享副本。')
  }
  return 0
}

const cmdAdd = (specs) => {
  if (!specs.length) die('用法：add <包名或包名@版本> [...]')
  guard('安装插件')
  ensureScaffold()
  ensureState()
  const before = depsOf(readJson(sharedManifestFile))
  // 走 dsh 自己的插件通道（和插件市场同一条路径）：它会解析规格、跑 pnpm、判定兼容性，
  // pnpm 再按 modulesDir 把包装进共享目录。装完把依赖和 lockfile 对齐到另一侧。
  const r = dshPlugin('web', ['add', ...specs])
  if (!r.ok) die('安装失败，清单未改动。')
  mirrorDeps(profileManifestFile('web'))
  const added = depsOf(readJson(sharedManifestFile)).filter((n) => !before.includes(n))
  if (!added.length) { say('没有新增依赖，可能已经存在（已顺带对齐两侧清单）。'); return 0 }
  for (const n of added) {
    // 只有声明了 dsh.bundle 的包才是"能启用的插件"；普通依赖写进 bundles 会让 dsh 启动失败
    const w = classify(n)
    const dir = (w.web && w.web.dir) || (w.desktop && w.desktop.dir)
    let isBundle = false
    try { isBundle = Boolean(readJson(join(dir, 'package.json'))?.dsh?.bundle) } catch { /* 读不到就按普通依赖处理 */ }
    if (!isBundle) {
      say(n + ' 是普通依赖（没有 dsh.bundle），已装进共享目录但不会作为插件启用')
      continue
    }
    const changed = PROFILES.filter((p) => bundleAdd(p, n))
    say('已登记 ' + n + ' 到：' + (changed.map((p) => LABEL[p]).join('、') || '（本来就有）'))
    warnResolve(n, w)
    warnCompat(n)
  }
  say('完成：' + added.length + ' 个插件已共享安装。两个模式重启后生效。')
  return 0
}

const cmdRemove = (names) => {
  if (!names.length) die('用法：remove <包名> [...]')
  guard('卸载插件')
  ensureScaffold()
  ensureState()
  for (const n of names) {
    const changed = PROFILES.filter((p) => bundleRemove(p, n))
    if (changed.length) say('已从 ' + changed.map((p) => LABEL[p]).join('、') + ' 移除 ' + n)
  }
  const r = dshPlugin('web', ['remove', ...names])
  if (!r.ok) die('卸载失败；清单已先停用，文件可能还在，可再执行一次。')
  mirrorDeps(profileManifestFile('web'))
  for (const n of names) {
    const w = classify(n)
    for (const p of PROFILES) {
      if (w[p].kind === 'local') {
        say('注意：' + LABEL[p] + ' 里还有一份旧副本（' + w[p].dir + '），执行 adopt ' + n + ' 可清掉。')
      }
    }
  }
  say('完成：' + names.length + ' 个插件已从两个模式移除。')
  return 0
}

/** 共享根里是否已经真的有这个包（不能靠 classify：本地副本会先命中） */
const sharedHas = (name) => existsSync(join(sharedDir, 'node_modules', name, 'package.json'))

/**
 * 收编"旧模型留下的本地副本"：确认共享目录里有同一个包之后，把 profile 里那份删掉。
 * 新模型下市场已经直接装进共享目录，正常用不到这条；只有从老结构升级时才会遇到。
 */
const cmdAdopt = (names) => {
  if (!names.length) die('用法：adopt <包名> [...]')
  guard('搬迁插件')
  ensureScaffold()
  ensureState()
  let done = 0
  for (const n of names) {
    if (!sharedHas(n)) {
      const dep = readProfile('desktop')?.dependencies?.[n]
      const spec = dep ? n + '@' + String(dep).replace(/^[\^~]/, '') : n
      const add = dshPlugin('web', ['add', spec])
      if (!add.ok) { console.error('  跳过 ' + n + '：装进共享目录失败，本地副本保持原样。'); continue }
      mirrorDeps(profileManifestFile('web'))
    }
    if (!sharedHas(n)) {
      console.error('  跳过 ' + n + '：共享目录里没有这个包，保持原样。')
      continue
    }
    let removed = 0
    for (const p of PROFILES) {
      const localDir = join(profileDir(p), 'node_modules', n)
      if (!existsSync(localDir)) continue
      if (dryRun) { say('[预演] 将删除 ' + LABEL[p] + ' 的本地副本'); removed++; continue }
      try { rmSync(localDir, { recursive: true, force: true }); removed++ } catch {
        say('注意：删除 ' + LABEL[p] + ' 的本地副本失败（可能该模式正在运行），关掉窗口后重试。')
      }
    }
    for (const p of PROFILES) bundleAdd(p, n)
    mirrorDeps()
    const finalKind = classify(n)
    if (PROFILES.every((p) => finalKind[p].kind === 'shared')) {
      say('已收编 ' + n + '：现在只有一份（共享目录），两个模式都可用' + (removed ? '' : '（本来就只有一份）'))
      done++
    } else {
      warnResolve(n, finalKind)
    }
  }
  say('完成：收编 ' + done + ' 个。两个模式重启后生效。')
  return 0
}

const cmdSync = () => {
  // 先把配置和依赖对齐：pnpm 共用同一个 node_modules，三边依赖不一致时会互相剪枝
  ensureScaffold()
  const mirrored = mirrorDeps()
  cleanupBaks()
  if (mirrored) say('已对齐依赖/lockfile ' + mirrored + ' 处（三份清单现在一致，市场在任一模式里装卸都不会误删另一侧）')
  const shared = existsSync(sharedManifestFile) ? readJson(sharedManifestFile) : null
  const all = new Set(shared ? depsOf(shared) : [])
  for (const p of PROFILES) for (const b of bundlesOf(readProfile(p))) all.add(b)
  let changed = 0
  const localOnly = []
  const dangling = []
  const incompatible = []
  const exempted = []
  const disabled = new Set(disabledList())
  for (const n of all) {
    const w = classify(n)
    if (PROFILES.every((p) => w[p].kind === 'install')) continue   // 内置 bundle，不归本工具管
    if (disabled.has(n)) {
      for (const p of PROFILES) {
        if (bundleRemove(p, n)) { changed++; say('已从 ' + LABEL[p] + ' 移除已停用的 ' + n) }
      }
      continue
    }
    if (PROFILES.every((p) => w[p].kind === 'missing')) { dangling.push(n); continue }
    const dir = (w.web && w.web.dir) || (w.desktop && w.desktop.dir)
    if (Object.keys(compatOf(dir)).length) {
      // 不兼容：只有已经豁免（强行允许）过的才往另一边推，顺带把两边的豁免文件补齐
      if (!isExempted(n)) { incompatible.push(n); continue }
      grantAll(n, true)
      exempted.push(n)
    }
    if (!PROFILES.every((p) => w[p].kind === 'shared')) {
      if (PROFILES.some((p) => w[p].kind === 'local')) localOnly.push(n)
      continue
    }
    // 只有声明 dsh.bundle 的包才能进 bundles（普通依赖写进去会让 dsh 启动失败）
    let isBundle = false
    try { isBundle = Boolean(readJson(join(w.web.dir, 'package.json'))?.dsh?.bundle) } catch { /* 读不到就当普通依赖 */ }
    if (!isBundle) continue
    for (const p of PROFILES) {
      if (bundleAdd(p, n)) { changed++; say('已为 ' + LABEL[p] + ' 登记 ' + n) }
    }
  }
  if (pruneFlag) {
    for (const n of dangling) {
      for (const p of PROFILES) {
        if (bundleRemove(p, n)) { changed++; say('已从 ' + LABEL[p] + ' 移除悬空项 ' + n) }
      }
      // 文件都没了，依赖记录也要一起清，否则下次安装会被下载回来
      const dropped = depRemoveEverywhere(n)
      if (dropped) { changed++; say('已从依赖清单里清掉 ' + n + '（' + dropped + ' 处）') }
    }
  }
  if (!quiet) {
    if (localOnly.length) say('只有本地副本（要单副本请执行 adopt）：' + localOnly.join(', '))
    if (dangling.length && !pruneFlag) say('悬空项（加 --prune 清理）：' + dangling.join(', '))
    if (incompatible.length) say('与当前 dsh 不兼容、保持原样（会被跳过）：' + incompatible.join(', '))
    if (exempted.length) say('已豁免、两边都启用：' + exempted.join(', '))
    say(changed ? '已对齐 ' + changed + ' 处' : '两个模式的插件清单已一致')
  }
  cleanupBaks()
  if (checkMode) {
    if (pending.length) { say('--check：以下文件需要改动（未落盘）：' + pending.join(', ')); return 1 }
    say('--check：已一致，无需改动')
  }
  return 0
}

/** 停用：从两个模式的清单里摘掉，文件保留（不下载、不删除），随时可 enable 回来 */
const cmdDisable = (names, off) => {
  if (!names.length) die('用法：' + (off ? 'disable' : 'enable') + ' <包名> [...]')
  guard(off ? '停用插件' : '启用插件')
  let n0 = 0
  for (const n of names) {
    if (!off && !sharedHas(n)) {
      console.error('  ' + n + ' 不在共享根里，先 add 安装它。')
      continue
    }
    const changed = PROFILES.filter((p) => (off ? bundleRemove(p, n) : bundleAdd(p, n)))
    setDisabled(n, off)
    // 启用时若版本不满足，自动补上"强行允许"（沿用旧环境的 compatibility.json 手法），
    // 否则 dsh 会在启动时把它跳过，等于启用了但没生效。
    if (!off && !isExempted(n)) {
      const w = classify(n)
      const unmet = compatOf((w.web && w.web.dir) || (w.desktop && w.desktop.dir))
      if (Object.keys(unmet).length && grantAll(n, true)) {
        say('  它与当前 dsh ' + runtimeVersion() + ' 版本不符，已同时写入版本豁免（compatibility.json），两个模式都会加载它')
      }
    }
    say((off ? '已停用 ' : '已启用 ') + n + '（' + (changed.map((p) => LABEL[p]).join('、') || '清单本来就是这个状态') + '）')
    n0++
  }
  say('完成：' + n0 + ' 个。重启对应模式生效。')
  return 0
}

/** 强行允许 / 撤销强行允许：只动 compatibility.json，两个 profile 一起 */
const cmdAllow = (names, on) => {
  if (!names.length) die('用法：' + (on ? 'allow' : 'revoke') + ' <包名> [...]')
  guard('改写版本豁免')
  for (const n of names) {
    const v = installedVersion(n)
    if (!v) { console.error('  ' + n + ' 没装（找不到它的 package.json），先 add 或 adopt。'); continue }
    if (!grantAll(n, on)) continue
    say((on ? '已豁免 ' : '已撤销豁免 ') + n + '@' + v + ' 在 dsh ' + runtimeVersion() + ' 上运行（两个模式各写一份 compatibility.json）')
  }
  say(on ? '提醒：强行允许＝跳过版本检查，插件可能崩溃或写坏数据，风险自负。' : '完成。')
  return 0
}

/* --------------------------------------------------------------------- 入口 */

const main = () => {
  const command = positional[0]
  const rest = positional.slice(1)
  if (!existsSync(profilesDir)) die('找不到 home\\profiles，这不是便携版目录？')
  if (hasFlag('--check')) checkMode = true
  if (hasFlag('--wildcard')) {
    console.error('官方 dsh 只接受"精确版本号列表"；写 "*" 会被整条忽略并静默跳过插件，--wildcard 已移除。')
    console.error('跨版本请在启动前跑 compat-heal（启动器已自动调用），或 plugin-allow <包名> 写当前版本。')
    return 1
  }
  switch (command) {
    case 'list': return cmdList()
    case 'add': return cmdAdd(rest)
    case 'remove': return cmdRemove(rest)
    case 'adopt': return cmdAdopt(rest)
    case 'sync': return cmdSync()
    case 'compat': {
      // 给 doctor / 启动检查用：豁免 pin 与当前 dsh 版本不一致时提示"升级后插件会被静默跳过"
      const drift = compatDrift()
      if (!drift.length) { console.log('豁免与当前版本一致'); return 0 }
      for (const d of drift) {
        console.log('[' + d.profile + '] ' + (d.bad ? d.bad : '豁免版本不符') + '：' + d.name + '@' + d.version + ' 只允许 ' + d.pinned + '，当前 dsh ' + d.now + ' → 插件会被静默跳过；可跑 compat-heal 或 plugin-allow ' + d.name)
      }
      return 1
    }
    case 'compat-heal': {
      // 启动器每次启动都跑（幂等）：官方升级后把豁免补成新版本号，插件不会静默消失
      const r = compatHeal()
      const quiet = hasFlag('--quiet')
      if (!quiet) {
        for (const a of r.actions) console.log((checkMode ? '[待改] ' : '已修 ') + a)
        if (!r.changed) console.log('豁免无需改动')
      }
      return checkMode && r.changed ? 1 : 0
    }
    case 'disable': return cmdDisable(rest, true)
    case 'enable': return cmdDisable(rest, false)
    case 'allow': return cmdAllow(rest, true)
    case 'revoke': return cmdAllow(rest, false)
    default:
      console.log('用法：plugin-shared.mjs <list|add|remove|adopt|disable|enable|allow|revoke|sync> [...]')
      console.log('  list                看共享集与两个模式的对照')
      console.log('  add <规格>...        装进共享根，两个模式一起启用')
      console.log('  remove <包名>...     两个模式一起卸掉并删文件')
      console.log('  disable <包名>...    两个模式一起停用，文件留着（可 enable 回来）')
      console.log('  enable <包名>...     重新启用已停用的插件（版本不符会自动写豁免）')
      console.log('  allow <包名>...      强行允许版本不符的插件（写精确版本号，两个模式一起）')
      console.log('  compat-heal [--check] 把豁免规整成官方认可的精确版本（启动器每次启动自动调用）')
      console.log('  revoke <包名>...     撤销强行允许')
      console.log('  adopt <包名>...      把只有本地副本的插件搬到共享根')
      console.log('  sync [--prune]      只对齐清单')
      console.log('  compat              检查豁免 pin 与当前 dsh 版本是否一致')
      return command ? 1 : 0
  }
}

process.exit(main())
