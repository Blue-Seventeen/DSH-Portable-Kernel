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
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, statSync, readdirSync, renameSync } from 'node:fs'
import { join, dirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

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
  // 改了 profile 清单（bundles/dependencies）就把 version.json 的计数一起刷新
  if (/(^|[\\/])profiles[\\/][^\\/]+[\\/]package\.json$/.test(file)) { try { syncBundleCounts() } catch { } }
}
const profileDir = (name) => join(profilesDir, name)
const profileManifestFile = (name) => join(profileDir(name), 'package.json')
// version.json 里的 bundlesWeb/bundlesDesktop 是"发布时刻"的快照，但插件增删会改两份 profile 的 bundles。
// 不跟着刷新的话，用户在商城装/卸插件之后 verify 会报"bundles 数量与 version.json 声明不一致"（v0.1.2 实测）。
const syncBundleCounts = () => {
  const vf = join(root, 'version.json')
  if (!existsSync(vf)) return
  try {
    const v = JSON.parse(readFileSync(vf, 'utf8'))
    const cnt = (name) => {
      const m = readProfile(name)
      return Array.isArray(m?.dsh?.profile?.bundles) ? m.dsh.profile.bundles.length : 0
    }
    const w = cnt('web'), d = cnt('desktop')
    if (w === v.bundlesWeb && d === v.bundlesDesktop) return
    v.bundlesWeb = w
    v.bundlesDesktop = d
    writeFileSync(vf, JSON.stringify(v, null, 2) + '\n')
  } catch { }
}


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
  let old = ''
  try { old = readFileSync(file, 'utf8') } catch { /* 没有就新建 */ }
  const eol = old.includes('\r\n') ? '\r\n' : '\n'
  const lines = old ? old.split(/\r?\n/) : []
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  if (!old) lines.push('packages:', "  - '.'")
  // 只补缺、不重排既有行：fix-pnpm-state.mjs 每次启动会把 storeDir / packageImportMethod
  // 追加在末尾（按卷能力决定值）。这里一旦重排，两个写入方就会互相"纠正"，
  // verify 的「sync 已收敛」每次都抖（0A 0A 0A / 顺序来回变）。
  const need = [
    ['nodeLinker', 'nodeLinker: hoisted'],
    ['autoInstallPeers', 'autoInstallPeers: false'],
  ]
  if (isProfile) need.push(['modulesDir', 'modulesDir: ../node_modules'])
  for (const [key, line] of need) {
    const re = new RegExp('^\\s*' + key + '\\s*:')
    const i = lines.findIndex((l) => re.test(l))
    if (i >= 0) {
      if (lines[i].trim() !== line) lines[i] = line
      continue
    }
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('')
    lines.push(line)
  }
  const text = lines.join(eol) + eol
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

/* ------------------------------------------------- 暂存安装（阶段 A / 阶段 B） */

/**
 * 为什么要分两段：插件树是 home\profiles\node_modules，全进程共用；只要有会话可能开回合，
 * 换文件就会让"老代码 + 新文件"混着跑（这是市场 drain 存在的理由）。
 * 所以把耗时的下载/解压/校验放到影子 home 里做（不碰 live），
 * 真正的落盘留到"没有 dsh 进程"的时候（启动器在 dsh web 之前调用 activate）。
 */
const stageRoot = join(root, 'home', 'plugin-stage')
const stageQueueFile = join(stageRoot, 'queue.json')
const stageLockFile = join(stageRoot, '.lock')
const stageLogsDir = join(stageRoot, 'logs')
const stageDoneDir = join(stageRoot, 'done')
const stageSnapDir = join(stageRoot, 'snapshots')
const shadowRoot = join(root, 'tmp', 'stage')
/** 影子 profile 要从 live 复制的文件（不含 node_modules：pnpm 会重建） */
const SHADOW_COPY = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'cordis.yml', 'cordis.patch.yml', 'compatibility.json']

const stageNow = () => new Date().toISOString()
/** "pkg@1.2.3" / "@scope/pkg@^1.2.0" / "pkg" → 包名 */
const packageNameOf = (spec) => {
  const s = String(spec).trim()
  const at = s.lastIndexOf('@')
  return at <= 0 ? s : s.slice(0, at)
}
/** 规格里写的版本部分：pkg@1.2.3 → "1.2.3"；不带版本的 pkg → "" */
const exactOfSpec = (spec) => {
  const s = String(spec).trim()
  const at = s.lastIndexOf('@')
  return at <= 0 ? '' : s.slice(at + 1)
}
const stageNewId = () => {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + 'T'
    + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + randomBytes(3).toString('hex')
}

const emptyQueue = () => ({ schemaVersion: 1, operations: [] })
const readQueue = () => {
  if (!existsSync(stageQueueFile)) return emptyQueue()
  const q = readJson(stageQueueFile)
  if (!q || typeof q !== 'object' || !Array.isArray(q.operations)) throw new Error('队列文件结构不符')
  if (q.schemaVersion !== 1) throw new Error('队列是更新版本（schemaVersion ' + q.schemaVersion + '），本壳不认识')
  return q
}
/** 同目录临时文件 + rename：断电也不会留下半个 JSON */
const writeQueue = (q) => {
  if (dryRun || checkMode) return
  mkdirSync(stageRoot, { recursive: true })
  const tmp = stageQueueFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(q, null, 2) + '\n', 'utf8')
  try { if (existsSync(stageQueueFile)) copyFileSync(stageQueueFile, stageQueueFile + '.bak') } catch { /* 忽略 */ }
  renameSync(tmp, stageQueueFile)
}
/** 读队列但把坏文件改名保存：启动路径不能因为一个坏 JSON 起不来 */
const readQueueTolerant = () => {
  try { return { queue: readQueue() } }
  catch (e) {
    if (!existsSync(stageQueueFile)) return { queue: emptyQueue() }
    const bad = stageQueueFile + '.corrupt-' + Date.now()
    try { renameSync(stageQueueFile, bad) } catch { /* 改不了就放着 */ }
    console.error('  暂存队列读不动（' + e.message + '），已改名：' + bad.replace(root + '\\', ''))
    return { queue: emptyQueue(), broken: bad }
  }
}

const takeStageLock = () => {
  const stamp = String(process.pid) + ' ' + stageNow()
  const attempt = () => { writeFileSync(stageLockFile, stamp, { encoding: 'utf8', flag: 'wx' }) }
  try { mkdirSync(stageRoot, { recursive: true }); attempt(); return true }
  catch {
    try {
      if (Date.now() - statSync(stageLockFile).mtimeMs > 10 * 60 * 1000) { rmSync(stageLockFile, { force: true }); attempt(); return true }
    } catch { /* 抢占失败就放弃 */ }
    return false
  }
}
const dropStageLock = () => { try { rmSync(stageLockFile, { force: true }) } catch { /* 忽略 */ } }

/** 提交前要能整体回滚的那几份文件（清单 + 锁 + 发布计数） */
const snapshotTargets = () => [
  sharedManifestFile,
  profileManifestFile('web'),
  profileManifestFile('desktop'),
  join(root, 'version.json'),
  join(sharedDir, 'pnpm-lock.yaml'),
  join(profileDir('web'), 'pnpm-lock.yaml'),
  join(profileDir('desktop'), 'pnpm-lock.yaml'),
].filter((f) => existsSync(f))

const snapshotTo = (dir) => {
  mkdirSync(dir, { recursive: true })
  const map = {}
  for (const f of snapshotTargets()) {
    const name = f.slice(root.length + 1).replace(/[\\/]/g, '_')
    copyFileSync(f, join(dir, name))
    map[f] = name
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(map, void 0, 2) + '\n', 'utf8')
  return Object.keys(map).length
}
const restoreFrom = (dir) => {
  const map = readJson(join(dir, 'manifest.json'))
  let n = 0
  for (const [f, name] of Object.entries(map)) {
    const src = join(dir, name)
    if (!existsSync(src)) continue
    copyFileSync(src, f)
    n++
  }
  return n
}

/** 建影子 home：与 live 同形的清单/配置，node_modules 交给 pnpm 重建 */
const buildShadow = (id) => {
  const dir = join(shadowRoot, id)
  const home = join(dir, 'home')
  const profiles = join(home, 'profiles')
  mkdirSync(profiles, { recursive: true })
  for (const name of SHADOW_COPY) {
    const src = join(sharedDir, name)
    if (existsSync(src)) copyFileSync(src, join(profiles, name))
  }
  for (const p of PROFILES) {
    const target = join(profiles, p)
    mkdirSync(target, { recursive: true })
    for (const name of SHADOW_COPY) {
      const src = join(profileDir(p), name)
      if (existsSync(src)) copyFileSync(src, join(target, name))
    }
  }
  return { dir, home, profiles }
}

/** 在影子 home 里跑 dsh 自己的插件通道（DSH_HOME 一指，整条路径就换到影子） */
const shadowPluginAdd = (home, spec, logFile) => {
  const bin = join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) return { ok: false, text: '找不到 dsh（' + bin + '）' }
  const cmd = [quoteArg(nodeExe), quoteArg(bin), 'plugin', '--profile', 'web', 'add', quoteArg(spec)].join(' ')
  out('  > [影子] dsh plugin --profile web add ' + spec)
  if (dryRun) return { ok: true, text: '(dry-run)' }
  const r = spawnSync(cmd, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    timeout: 900000,
    windowsHide: true,
    env: { ...process.env, PATH: launcherPath(), DSH_HOME: home, npm_config_store_dir: storeRoot },
  })
  const text = ((r.stdout || '') + (r.stderr || '')).trim()
  try { mkdirSync(dirname(logFile), { recursive: true }); writeFileSync(logFile, text + '\n', 'utf8') } catch { /* 日志写不了不影响主流程 */ }
  return { ok: r.status === 0, text }
}

/** 只用组合配置校验一次（不启动插件）：能发现重复 entry id、坏 patch 行 */
const shadowDumpConfig = (home) => {
  const bin = join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) return { ok: false, skipped: true }
  if (dryRun) return { ok: true, skipped: true }
  const cmd = [quoteArg(nodeExe), quoteArg(bin), '--profile', 'web', '--dump-config'].join(' ')
  const r = spawnSync(cmd, {
    cwd: root, shell: true, encoding: 'utf8', timeout: 180000, windowsHide: true,
    env: { ...process.env, PATH: launcherPath(), DSH_HOME: home },
  })
  return { ok: r.status === 0, skipped: false, text: ((r.stdout || '') + (r.stderr || '')).trim().slice(-800) }
}

const shadowPackageDir = (shadow, name) => join(shadow.profiles, 'node_modules', name)

/** 影子里的安装结果检查：包在不在、是不是能启用的插件、跟当前 dsh 兼不兼容 */
const validateShadow = (shadow, name) => {
  const checks = { present: false, bundle: false, client: false, engines: 'missing', dumpConfig: 'skipped' }
  const pkgFile = join(shadowPackageDir(shadow, name), 'package.json')
  if (!existsSync(pkgFile)) return { checks, pkg: null }
  checks.present = true
  let pkg = null
  try { pkg = readJson(pkgFile) } catch { pkg = null }
  if (pkg) {
    checks.bundle = Boolean(pkg.dsh && pkg.dsh.bundle)
    checks.client = Boolean(pkg.dsh && pkg.dsh.client)
    const unmet = unmetRequirements(pkg)
    checks.engines = Object.keys(unmet).length ? JSON.stringify(unmet) : 'ok'
  }
  return { checks, pkg }
}

const stageLogFile = (id) => join(stageLogsDir, id + '.log')

const findStageOp = (q, pkg) => q.operations.find((o) => o.package === pkg && o.state !== 'done')

const pushStageOp = (op) => {
  const { queue } = readQueueTolerant()
  const same = findStageOp(queue, op.package)
  if (same) {
    same.spec = op.spec
    same.requested = op.requested
    same.exact = op.exact
    same.kind = op.kind
    same.checks = op.checks
    same.state = 'pending'
    same.attempts = 0
    same.lastError = null
    same.updatedAt = stageNow()
  } else {
    queue.operations.push(op)
  }
  writeQueue(queue)
  return queue.operations.length
}

const removeStageOp = (q, id) => {
  const i = q.operations.findIndex((o) => o.id === id)
  if (i >= 0) q.operations.splice(i, 1)
  return i >= 0
}

const finishStageOp = (op) => {
  try {
    mkdirSync(stageDoneDir, { recursive: true })
    writeFileSync(join(stageDoneDir, op.id + '.json'), JSON.stringify(op, void 0, 2) + '\n', 'utf8')
  } catch { /* 历史记录写不了不影响主流程 */ }
  // 完成记录只留最近 50 条
  try {
    const files = readdirSync(stageDoneDir).filter((n) => n.endsWith('.json')).sort()
    for (const f of files.slice(0, Math.max(0, files.length - 50))) rmSync(join(stageDoneDir, f), { force: true })
  } catch { /* 忽略 */ }
}

/** live 里是否**已声明**且是这个精确版本（用户在商城自己装了 / 重复提交）
 *  只看 installedVersion 不够：`ms` 这种传递依赖在 node_modules 里本来就能解析到，
 *  但清单里没声明 —— 那样跳过就不会写进 dependencies，下次 pnpm install 它就消失了。 */
const liveHasExact = (name, exact) => {
  if (!exact) return false
  let declared = null
  try { declared = (readJson(sharedManifestFile).dependencies || {})[name] || null } catch { declared = null }
  if (!declared) return false
  const v = installedVersion(name)
  if (!v) return false
  return String(v).replace(/^[\^~]/, '') === String(exact).replace(/^[\^~]/, '')
}

const cmdStage = (specs) => {
  if (!specs.length) die('用法：stage <包名或包名@版本> [...]（同名待启用项会被最新一次覆盖）')
  const id = stageNewId()
  const shadow = dryRun ? { dir: join(shadowRoot, id), home: join(shadowRoot, id, 'home'), profiles: join(shadowRoot, id, 'home', 'profiles') } : buildShadow(id)
  if (!dryRun) say('已在影子目录准备：' + shadow.dir.replace(root + '\\', ''))
  try {
    for (const spec of specs) {
      const name = packageNameOf(spec)
      if (!name) { console.error('  看不懂的规格：' + spec); continue }
      if (liveHasExact(name, exactOfSpec(spec))) { say(name + ' 已经是 ' + exactOfSpec(spec) + '，无需安装'); continue }
      out('  正在下载并校验 ' + spec + '（不碰 live 树）……')
      const r = shadowPluginAdd(shadow.home, spec, stageLogFile(id))
      if (!r.ok) {
        console.error('  暂存失败，live 插件树未改动：')
        if (r.text) console.error(r.text.split(/\r?\n/).slice(-25).map((l) => '    ' + l).join('\n'))
        if (/UNEXPECTED_(VIRTUAL_)?STORE/.test(r.text || '')) console.error('  → pnpm 记录过期：先跑 dsh-portable.cmd fix-state')
        if (/Ignored build scripts|allowBuilds/i.test(r.text || '')) console.error('  → 该包需要构建脚本批准：把它打印的 allowBuilds 键写进 home\\profiles\\pnpm-workspace.yaml 再重试')
        return 1
      }
      const v = validateShadow(shadow, name)
      if (!v.checks.present) {
        console.error('  暂存完成但找不到安装结果（' + name + '），live 未改动；详见 ' + stageLogFile(id).replace(root + '\\', ''))
        return 1
      }
      const dump = v.checks.bundle ? shadowDumpConfig(shadow.home) : { ok: true, skipped: true }
      v.checks.dumpConfig = dump.skipped ? 'skipped' : (dump.ok ? 'ok' : 'failed')
      const exact = v.pkg && v.pkg.version ? String(v.pkg.version) : exactOfSpec(spec)
      const created = stageNow()
      pushStageOp({
        id, kind: 'add', package: name, spec: name + '@' + exact, requested: spec, exact,
        createdAt: created, updatedAt: created, state: 'pending', attempts: 0, lastError: null,
        checks: v.checks, snapshot: 'home/plugin-stage/snapshots/' + id,
      })
      if (v.checks.engines !== 'ok') {
        console.error('  注意：' + name + ' 与当前 dsh ' + runtimeVersion() + ' 不兼容（' + v.checks.engines + '）——安装后启动时会被 dsh 跳过')
      }
      if (v.checks.dumpConfig === 'failed') console.error('  注意：影子 --dump-config 失败，组合配置可能有冲突（详见 ' + stageLogFile(id).replace(root + '\\', '') + '）')
      say('已暂存 ' + name + '@' + exact + '（' + (v.checks.bundle ? '插件' : '普通依赖') + '，校验 ' + JSON.stringify(v.checks) + '）')
    }
  } finally {
    if (!hasFlag('--keep') && existsSync(shadow.dir)) { try { rmSync(shadow.dir, { recursive: true, force: true }) } catch { /* 删不掉留着，tidy 会清 */ } }
  }
  const { queue } = readQueueTolerant()
  const pending = queue.operations.filter((o) => o.state !== 'done').length
  if (!pending) return 0
  if (!runningPortable().length) { say('当前没有 dsh 进程，直接提交……'); return cmdActivate() }
  say('共 ' + pending + ' 项待启用：退出程序后下次启动自动生效（plugin-stage-list 查看 / plugin-stage-discard 取消）')
  return 0
}

const cmdStageRemove = (names) => {
  if (!names.length) die('用法：stage-remove <包名> [...]')
  let queued = 0
  for (const n of names) {
    const v = installedVersion(n)
    if (!v && !sharedHas(n)) { say(n + ' 没有安装，跳过'); continue }
    const created = stageNow()
    pushStageOp({
      id: stageNewId(), kind: 'remove', package: n, spec: n, requested: n, exact: v || '',
      createdAt: created, updatedAt: created, state: 'pending', attempts: 0, lastError: null,
      checks: {}, snapshot: '',
    })
    queued++
  }
  if (!queued) return 0
  if (!runningPortable().length) { say('当前没有 dsh 进程，直接提交……'); return cmdActivate() }
  say('已暂存 ' + queued + ' 项卸载：退出程序后下次启动自动生效')
  return 0
}

const cmdStageList = () => {
  const { queue } = readQueueTolerant()
  if (hasFlag('--json')) { console.log(JSON.stringify(queue, void 0, 2)); return 0 }
  const ops = queue.operations.filter((o) => o.state !== 'done')
  if (!ops.length) { say('没有暂存的插件操作'); return 0 }
  say('暂存队列（' + ops.length + ' 项，退出程序后下次启动自动生效）：')
  for (const o of ops) {
    const ver = o.kind === 'add' ? (o.exact || '?') : (o.exact || '已装')
    console.log('  ' + o.id + '  ' + o.kind.padEnd(6) + '  ' + o.package + '@' + ver
      + '  [' + o.state + (o.attempts ? ' ×' + o.attempts : '') + ']' + (o.lastError ? '  ' + o.lastError : ''))
  }
  return 0
}

/** 给 verify / doctor 用：只校验队列自身是否自洽，不落盘 */
const cmdStageStatus = () => {
  let queue
  try { queue = readQueue() }
  catch (e) { console.error('  暂存队列不可用：' + e.message); return 1 }
  const bad = queue.operations.filter((o) => !o.id || !o.kind || !o.package || !o.state)
  const stuck = queue.operations.filter((o) => o.state === 'applying')
  if (hasFlag('--json')) { console.log(JSON.stringify({ total: queue.operations.length, bad: bad.length, stuck: stuck.length }, void 0, 2)); return bad.length ? 1 : 0 }
  if (bad.length) { console.error('  队列里有 ' + bad.length + ' 条缺字段的记录'); return 1 }
  say('暂存队列自洽：' + queue.operations.length + ' 项' + (stuck.length ? '（其中 ' + stuck.length + ' 项上次提交中断，下次启动会先回滚再重试）' : ''))
  return 0
}

const cmdStageDiscard = (ids) => {
  const { queue } = readQueueTolerant()
  if (!queue.operations.length) { say('队列是空的'); return 0 }
  const all = ids.includes('all')
  let n = 0
  for (const id of all ? queue.operations.map((o) => o.id) : ids) {
    if (removeStageOp(queue, id)) {
      n++
      try { rmSync(join(stageSnapDir, id), { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  }
  writeQueue(queue)
  say('已丢弃 ' + n + ' 项；live 插件树没有改动')
  return 0
}

/** 提交队列：只在没有 dsh 进程时真正改文件；失败按快照回滚，绝不阻断启动 */
const cmdActivate = () => {
  const { queue, broken } = readQueueTolerant()
  const ops = queue.operations.filter((o) => o.state !== 'done')
  if (!ops.length) { if (!quiet && !checkMode) say('没有需要提交的暂存项'); return 0 }
  const live = runningPortable()
  if (live.length) {
    const who = live.slice(0, 3).map((p) => p.name + '(' + p.pid + ')').join(', ')
    say('有 ' + ops.length + ' 项暂存插件，等程序退出后才提交（当前在跑：' + who + '）')
    return 0
  }
  if (checkMode) { say('有 ' + ops.length + ' 项待提交（--check 不落盘）'); return 0 }
  if (!takeStageLock()) { say('另一个暂存操作正在进行，本次跳过'); return 0 }
  let failed = 0
  let applied = 0
  try {
    ensureScaffold()
    ensureState()
    for (const op of ops.slice()) {
      const snap = join(stageSnapDir, op.id)
      // 上次提交到一半被杀：先按快照回滚再重试这一条
      if (op.state === 'applying') {
        if (existsSync(join(snap, 'manifest.json'))) {
          try { restoreFrom(snap); say('已回滚上次中断的提交：' + op.package) } catch { /* 快照不全就继续尝试提交 */ }
        }
      }
      try { snapshotTo(snap) } catch (e) {
        console.error('  快照写入失败，跳过 ' + op.package + '：' + e.message)
        failed++
        op.state = 'failed'
        op.lastError = 'snapshot failed'
        writeQueue(queue)
        continue
      }
      op.state = 'applying'
      op.attempts = (op.attempts || 0) + 1
      writeQueue(queue)
      let r = { ok: true }
      if (op.kind === 'add') {
        if (liveHasExact(op.package, op.exact)) {
          say(op.package + '@' + op.exact + ' 已由其他途径装好，跳过')
        } else {
          say('提交 ' + op.package + '@' + op.exact + ' ……')
          r = applyAdd([op.spec], { preferOffline: true })
        }
      } else {
        say('提交卸载 ' + op.package + ' ……')
        r = applyRemove([op.package])
      }
      if (r.ok) {
        applied++
        op.state = 'done'
        op.lastError = null
        op.updatedAt = stageNow()
        finishStageOp(op)
        removeStageOp(queue, op.id)
        try { rmSync(snap, { recursive: true, force: true }) } catch { /* 忽略 */ }
      } else {
        failed++
        try { restoreFrom(snap) } catch { /* 快照坏了就只能靠下一次安装覆盖 */ }
        op.state = 'failed'
        op.lastError = 'apply failed'
        op.updatedAt = stageNow()
        console.error('  提交失败，已回滚清单：' + op.package + '（详见 ' + stageLogFile(op.id).replace(root + '\\', '') + '）')
      }
      writeQueue(queue)
    }
    // 树可能被 pnpm 重写：补丁 + 豁免 + 备份清理必须补一遍
    try { const h = compatHeal(); if (h.changed) say('已同步版本豁免 ' + h.changed + ' 处') } catch { /* 忽略 */ }
    const pm = join(root, 'tools', 'patch-market.mjs')
    if (existsSync(pm)) spawnSync([quoteArg(nodeExe), quoteArg(pm), '--apply', '--quiet'].join(' '), {
      shell: true, encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, PATH: launcherPath() },
    })
    cleanupBaks()
  } finally {
    dropStageLock()
  }
  if (applied) say('已提交 ' + applied + ' 项暂存插件，重启 dsh 后生效')
  if (failed) {
    console.error('  有 ' + failed + ' 项没能提交（已回滚清单，插件树未被破坏）：plugin-stage-list 查看原因后可重试')
    return hasFlag('--strict') ? 1 : 0
  }
  return 0
}

/** 无网络、无 pnpm 的密封自测：只验队列/快照这些纯逻辑 */
const cmdStageSelftest = () => {
  const results = []
  const check = (name, fn) => {
    try { fn(); results.push({ name, ok: true }); console.log('  OK   ' + name) }
    catch (e) { results.push({ name, ok: false }); console.error('  FAIL ' + name + ' — ' + e.message) }
  }
  const assert = (cond, m) => { if (!cond) throw new Error(m) }
  mkdirSync(profilesDir, { recursive: true })
  // 造一份最小清单
  for (const p of PROFILES) {
    mkdirSync(profileDir(p), { recursive: true })
    writeFileSync(profileManifestFile(p), JSON.stringify({
      name: 'selftest-' + p, private: true, dependencies: {},
      dsh: { profile: { bundles: ['dshmarket'] } },
    }, void 0, 2) + '\n', 'utf8')
  }
  writeFileSync(sharedManifestFile, JSON.stringify({ name: 'dsh-profile-shared', private: true, dependencies: {} }, void 0, 2) + '\n', 'utf8')
  writeFileSync(join(root, 'version.json'), JSON.stringify({ bundlesWeb: 1, bundlesDesktop: 1 }, void 0, 2) + '\n', 'utf8')

  check('空队列可读', () => { const q = readQueue(); assert(Array.isArray(q.operations) && !q.operations.length, '空队列不对') })
  check('写入后可读回', () => {
    const q = readQueue()
    q.operations.push({ id: 'x1', kind: 'add', package: 'p', spec: 'p@1.0.0', exact: '1.0.0', state: 'pending' })
    writeQueue(q)
    const back = readQueue()
    assert(back.operations.length === 1 && back.operations[0].package === 'p', '读回不一致')
  })
  check('同名覆盖而不是堆积', () => {
    pushStageOp({ id: 'x2', kind: 'add', package: 'p', spec: 'p@2.0.0', exact: '2.0.0', state: 'pending' })
    const q = readQueue()
    assert(q.operations.filter((o) => o.package === 'p').length === 1, '出现重复条目')
    assert(q.operations.find((o) => o.package === 'p').exact === '2.0.0', '没有覆盖成新版本')
  })
  check('快照 → 改动 → 恢复回原样', () => {
    const snap = join(stageSnapDir, 'selftest')
    rmSync(snap, { recursive: true, force: true })
    snapshotTo(snap)
    const target = profileManifestFile('web')
    const original = readFileSync(target, 'utf8')
    writeFileSync(target, '{"broken":true}\n', 'utf8')
    restoreFrom(snap)
    assert(readFileSync(target, 'utf8') === original, '恢复后内容不一致')
  })
  check('坏队列被改名而不是抛异常', () => {
    writeFileSync(stageQueueFile, '{ this is not json', 'utf8')
    const r = readQueueTolerant()
    assert(r.queue && Array.isArray(r.queue.operations), '坏队列没有兜底')
    assert(Boolean(r.broken), '坏文件没有改名保存')
  })
  check('丢弃后队列清空', () => {
    writeQueue({ schemaVersion: 1, operations: [{ id: 'y1', kind: 'add', package: 'q', spec: 'q@1', exact: '1', state: 'pending' }] })
    cmdStageDiscard(['all'])
    assert(readQueue().operations.length === 0, '丢弃后仍有残留')
  })
  const bad = results.filter((r) => !r.ok)
  if (bad.length) { console.error('  暂存自测失败 ' + bad.length + '/' + results.length); return 1 }
  say('暂存自测通过：' + results.length + '/' + results.length)
  return 0
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
  const r = applyAdd(specs)
  if (!r.ok) die('安装失败，清单未改动。')
  if (!r.added.length) { say('没有新增依赖，可能已经存在（已顺带对齐两侧清单）。'); return 0 }
  say('完成：' + r.added.length + ' 个插件已共享安装。两个模式重启后生效。')
  return 0
}

/**
 * 装进共享根并登记为插件（不检查运行状态、不跑 ensure*，调用方负责）。
 * 抽出来给 cmdAdd 和暂存提交（activate）共用，保证两条路径行为一致。
 */
const applyAdd = (specs, opts = {}) => {
  const before = depsOf(readJson(sharedManifestFile))
  // 走 dsh 自己的插件通道（和插件市场同一条路径）：它会解析规格、跑 pnpm、判定兼容性，
  // pnpm 再按 modulesDir 把包装进共享目录。装完把依赖和 lockfile 对齐到另一侧。
  // --prefer-offline：暂存提交时 store 已热，别再走一遍网络元数据。
  const args = ['add', ...specs]
  if (opts.preferOffline) args.push('--prefer-offline')
  const r = dshPlugin('web', args)
  if (!r.ok) return { ok: false, added: [] }
  mirrorDeps(profileManifestFile('web'))
  const added = depsOf(readJson(sharedManifestFile)).filter((n) => !before.includes(n))
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
  return { ok: true, added }
}

const cmdRemove = (names) => {
  if (!names.length) die('用法：remove <包名> [...]')
  guard('卸载插件')
  ensureScaffold()
  ensureState()
  const r = applyRemove(names)
  if (!r.ok) die('卸载失败；清单已先停用，文件可能还在，可再执行一次。')
  say('完成：' + names.length + ' 个插件已从两个模式移除。')
  return 0
}

/** 从两个 profile 停用并从共享根卸掉（不检查运行状态，调用方负责） */
const applyRemove = (names) => {
  for (const n of names) {
    const changed = PROFILES.filter((p) => bundleRemove(p, n))
    if (changed.length) say('已从 ' + changed.map((p) => LABEL[p]).join('、') + ' 移除 ' + n)
  }
  const r = dshPlugin('web', ['remove', ...names])
  if (!r.ok) return { ok: false }
  mirrorDeps(profileManifestFile('web'))
  for (const n of names) {
    const w = classify(n)
    for (const p of PROFILES) {
      if (w[p].kind === 'local') {
        say('注意：' + LABEL[p] + ' 里还有一份旧副本（' + w[p].dir + '），执行 adopt ' + n + ' 可清掉。')
      }
    }
  }
  return { ok: true }
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
  const localHint = []
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
    if (PROFILES.every((p) => w[p].kind === 'missing')) {
      // 保护：文件可能还躺在某个 profile 自己的 node_modules 里（历史遗留/刚被手工搬动）。
      // 这种情况下 prune 只提示、不删——删了就等于把用户已装的插件丢掉（2026-11-04 事故）。
      const localCopy = PROFILES.find((p) => existsSync(join(profileDir(p), 'node_modules', n, 'package.json')))
      if (localCopy) { localHint.push(n + '（' + profileDir(localCopy) + '\\node_modules）'); continue }
      dangling.push(n)
      continue
    }
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
      const stillOnDisk = PROFILES.some((p) => existsSync(join(profileDir(p), 'node_modules', n, 'package.json')))
      if (stillOnDisk) { localHint.push(n); continue }
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
    if (localHint.length) say('仍存在本地副本、prune 跳过（先用 adopt 收编再清理）：' + localHint.join('，'))
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
  if (!existsSync(profilesDir) && command !== 'stage-selftest') die('找不到 home\\profiles，这不是便携版目录？')
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
    case 'stage': return cmdStage(rest)
    case 'stage-remove': return cmdStageRemove(rest)
    case 'stage-list': return cmdStageList()
    case 'stage-status': return cmdStageStatus()
    case 'stage-discard': return cmdStageDiscard(rest)
    case 'stage-selftest': return cmdStageSelftest()
    case 'activate': return cmdActivate()
    default:
      console.log('用法：plugin-shared.mjs <list|add|remove|adopt|disable|enable|allow|revoke|sync|stage|activate> [...]')
      console.log('  list                看共享集与两个模式的对照')
      console.log('  add <规格>...        装进共享根，两个模式一起启用')
      console.log('  remove <包名>...     两个模式一起卸掉并删文件')
      console.log('  stage <规格>...      后台暂存安装：下载/校验在影子目录做，退出程序后下次启动自动启用')
      console.log('  stage-remove <包名>...  暂存卸载（同上，退出后生效）')
      console.log('  stage-list          看暂存队列')
      console.log('  stage-discard <id|all>  丢弃暂存项，不碰 live 插件树')
      console.log('  activate            提交暂存队列（两个启动器自动调用；没有 dsh 进程时才改文件）')
      console.log('  stage-selftest      暂存引擎自测（密封、不联网；给 test/ 与排障用）')
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
