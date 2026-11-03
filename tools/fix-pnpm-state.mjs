#!/usr/bin/env node
/**
 * 修复 profile 的 pnpm 状态记录，让它和本机解析出的 store 一致。
 *
 * 背景：便携版会被搬到另一台电脑。home\profiles\<名字>\node_modules\ 里记着原机器
 * 的绝对路径（storeDir / virtualStoreDir / projects 键）。换了用户名或换了位置后，
 * pnpm 的兼容性校验（ERR_PNPM_UNEXPECTED_STORE）会拒绝这个 profile 的所有安装与
 * 卸载——插件市场上点卸载就报这个错。
 *
 * 注意：store 目录名里的版本段（v10 / v11）取决于**真正执行安装的那个 pnpm**。
 * dsh 本身不带 pnpm：`dsh plugin …` 是从 PATH 上取第一个 pnpm 来跑的，而 runtime\pnpm
 * 是 11.28.5（也就是 v11）。所以决定版本的是 PATH 第一位那个 pnpm——runtime\pnpm\bin
 * 里必须有 pnpm.cmd 垫片（见 ensurePnpmShim），否则机器上装的全局 pnpm（实测常见
 * 10.33.0）会抢先生效，记录就写成 v10，之后任何 v11 的写操作都报
 * ERR_PNPM_UNEXPECTED_STORE。这一点绝不能猜，必须问那个会真正被执行的 pnpm
 * （在临时 DSH_HOME 里问，避免在真实 profile 里留日志）。
 *
 * 做法（不重新下载任何包）：
 *   1. 问会真正执行的那个 pnpm：--store-dir 指向便携仓库时它用哪个目录（含版本段）；
 *   2. 把 .modules.yaml 的 storeDir / virtualStoreDir 改成当前机器上的实际值；
 *   3. 把 .pnpm-workspace-state-v1.json 里指向旧 home 的 projects 键改成当前路径；
 *   4. 在各 profile 的 pnpm-workspace.yaml 顶层写 storeDir，让桌面端插件市场内部的
 *      pnpm 也解析到同一个仓库（npm_config_store_dir 环境变量 pnpm 并不认）。
 *
 * 幂等：已经是正确值时什么都不做，也不产生备份。
 *
 * 用法：
 *   node tools\fix-pnpm-state.mjs            修复
 *   node tools\fix-pnpm-state.mjs --dry-run  只看要改什么
 *   node tools\fix-pnpm-state.mjs --check-store  只读体检：记录里的 store 大版本是否等于 runtime\pnpm
 *                                            （只打印一行 STORE OK v11 / STORE MISMATCH v10->v11，
 *                                              退出码 0 / 3；与 --quiet 同时传也照样输出，启动器要靠这行）
 *   node tools\fix-pnpm-state.mjs --quiet    静默（启动器用）
 *   node tools\fix-pnpm-state.mjs --store D:\somewhere   手动指定仓库根目录
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const quiet = argv.includes('--quiet')
const argOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : null
}
const say = (msg) => console.log((quiet ? '' : '  ') + msg)

const node = join(root, 'runtime', 'node', 'bin', 'node.exe')
const runtimePnpm = join(root, 'runtime', 'pnpm')
const dshBin = join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
// store 必须留在便携目录内（外置 store 已废弃）。env.cmd 导出 DSH_PNPM_STORE；
// 单独运行时按盘内默认值兜底，保证任何入口都不会再往主机用户目录写。
const storeRoot =
  argOf('--store') || process.env.DSH_PNPM_STORE || join(root, 'cache', 'pnpm-store')
// exFAT 没有硬链接/软链：compat 档用 copy 导入；NTFS 用 pnpm 默认（auto）。
const importMethod = process.env.DSH_PNPM_IMPORT_METHOD || 'auto'
const profilesDir = join(argOf('--root') ? join(argOf('--root'), 'home') : join(root, 'home'), 'profiles')

const samePath = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() ===
    b.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** '11.28.5' -> '11'（版本串的大版本号） */
const versionMajor = (v) => {
  const m = String(v || '').match(/^v?(\d+)/)
  return m ? m[1] : ''
}

/** '...\pnpm-store\v11' -> '11'（pnpm 总会把自己的大版本追加成 store 路径最后一段） */
// store 是否真的有内容。注意：pnpm 的 store path 探测会顺手建一个空的 index.db（8 KB），
// 所以不能只看文件是否存在，否则"空 store"会被当成"有内容"，把记录改成空库。
const storeHasContent = (p) => {
  try {
    const idx = [join(p, 'v11', 'index.db'), join(p, 'index.db')].find((f) => existsSync(f))
    if (idx) {
      try { if (statSync(idx).size > 65536) return true } catch { }
    }
    const files = join(p, 'files')
    if (!existsSync(files)) return false
    let found = false
    const walk = (dir, depth) => {
      if (found || depth > 3) return
      let ents = []
      try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        if (found) return
        const q = join(dir, e.name)
        if (e.isDirectory()) walk(q, depth + 1)
        else if (e.isFile()) { found = true; return }
      }
    }
    walk(files, 0)
    return found
  } catch { return false }
}
let storeMigrateWarned = false
const storeMajor = (p) => {
  const m = String(p || '').replace(/[\\/]+$/, '').match(/[\\/]v(\d+)$/)
  return m ? m[1] : ''
}

/** runtime\pnpm 自己的版本（这个壳装的 pnpm），没有就返回 ''（只有壳的发布版） */
const runtimePnpmMajor = () => {
  try { return versionMajor(JSON.parse(readFileSync(join(runtimePnpm, 'package.json'), 'utf8')).version) } catch { return '' }
}

/** 从 .modules.yaml 取 storeDir：JSON 优先，解析失败退回文本匹配（文件可能被写坏） */
const recordedStoreDir = (raw) => {
  try { return JSON.parse(raw).storeDir || '' } catch {
    const m = raw.match(/"storeDir"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (!m) return ''
    try { return JSON.parse('"' + m[1] + '"') } catch { return m[1] }
  }
}

/** 从 .modules.yaml 取 packageManager 的版本（'pnpm@11.28.5' -> '11.28.5'） */
const recordedPnpm = (raw) => {
  try { return String(JSON.parse(raw).packageManager || '').replace(/^pnpm@/, '') } catch {
    const m = raw.match(/"packageManager"\s*:\s*"pnpm@([^"]+)"/)
    return m ? m[1] : ''
  }
}

/**
 * 和启动器看到的环境保持一致：把便携目录里的 node、pnpm 放在 PATH 最前面。
 * dsh 本身不带 pnpm，它从 PATH 上找——所以结果取决于 PATH 上第一个 pnpm 是哪个版本。
 * 不固定这一点，同一台机器会因为从哪个 shell 运行而在 v10 / v11 之间来回跳。
 */
const launcherPath = () => {
  const parts = [join(root, 'runtime', 'node', 'bin'), join(root, 'runtime', 'pnpm', 'bin')]
  const sep = ';'
  const rest = (process.env.PATH || process.env.Path || '')
  return parts.join(sep) + sep + rest
}

/**
 * runtime\pnpm\bin 里只有 pnpm.mjs，没有 pnpm.cmd——而 Windows 只认 .cmd/.exe。
 * 于是 env.cmd 把 runtime\pnpm\bin 置顶到 PATH 是空转，`dsh plugin …` 找到的是机器上的
 * 全局 pnpm（实测 10.33.0），写出来的 .modules.yaml 就是 v10，和 runtime 的 11.28.5 打架。
 * 这里把垫片补回来：纯 ASCII + CRLF，内容固定指向同目录的 .mjs。
 * 只在缺失或内容不符时写；--dry-run 只报告不写。没有 runtime\pnpm（只有壳）直接跳过。
 */
const ensurePnpmShim = () => {
  if (!existsSync(runtimePnpm)) {
    if (!quiet) say('没有 runtime\\pnpm（只有壳的状态），跳过 pnpm 垫片')
    return 0
  }
  let fixed = 0
  for (const [file, target] of [['pnpm.cmd', 'pnpm.mjs'], ['pnpx.cmd', 'pnpx.mjs']]) {
    if (!existsSync(join(runtimePnpm, 'bin', target))) continue // 目标脚本不在，垫片只会报错
    const full = join(runtimePnpm, 'bin', file)
    // 字节要固定：cmd.exe 读到 BOM 或 LF-only 行会解析失败，所以这里用显式 \r\n 和 ascii
    const want = Buffer.from(
      '@echo off\r\n"%~dp0..\\..\\node\\bin\\node.exe" "%~dp0' + target + '" %*\r\n',
      'ascii',
    )
    let have = null
    try { have = readFileSync(full) } catch { have = null }
    if (have && have.equals(want)) continue
    fixed += 1
    const what = file + (have ? ' 内容不符' : ' 缺失') + '，' + (dryRun ? '将补回' : '已补回') + '垫片（指向 ' + target + '）'
    if (!quiet) say(what)
    if (dryRun) continue
    try { writeFileSync(full, want) } catch (e) { if (!quiet) say(file + ' 写入失败: ' + e.message) }
  }
  return fixed
}

/**
 * 记录里的 store 大版本和探测到的 store 大版本冲突时置位（v10 vs v11）。
 * 这种情况绝不能靠改记录糊过去——包确实在另一个 store 里，改了就是撒谎。
 */
let storeMajorBlocked = false

/**
 * --check-store：只读体检。比的是 .modules.yaml 记录的大版本与 runtime\pnpm 的大版本。
 * 无论有没有 --quiet 都会输出"MISMATCH"那一行（启动器用 `--check-store --quiet`，只有它值得打扰用户）；
 * 一致/跳过的情况只在非 --quiet 时打印，免得每次启动都刷一行 STORE OK。
 * 绝不写盘：不补垫片、不写 .bak、不刷新 tmp 缓存、不补 BOM。退出码：一致 0，不一致 3。
 */
const checkStore = () => {
  // 正常情况别出声：启动器每次启动都会调它，--quiet 下只有"真的不一致"才值得让用户看见。
  const note = (m) => { if (!quiet) console.log(m) }
  const want = runtimePnpmMajor()
  if (!want) {
    note('STORE SKIP：这个目录没有 runtime\\pnpm（只有壳的状态），无法判断')
    return 0
  }
  const modulesYaml = join(profilesDir, 'node_modules', '.modules.yaml')
  if (!existsSync(modulesYaml)) {
    note('STORE SKIP：还没有 home\\profiles\\node_modules\\.modules.yaml（未装插件）')
    return 0
  }
  const raw = readFileSync(modulesYaml, 'utf8')
  const storeDir = recordedStoreDir(raw)
  const got = storeMajor(storeDir) || versionMajor(recordedPnpm(raw))
  if (!got) {
    note('STORE SKIP：.modules.yaml 里既没有 storeDir 也没有 packageManager')
    return 0
  }
  if (got === want) {
    note('STORE OK v' + want)
    return 0
  }
  console.log('STORE MISMATCH v' + got + '->v' + want)
  return 3
}

/** 用临时 DSH_HOME 问 dsh 内置 pnpm：这个仓库在本机对应哪个目录 */
const probeStore = () => {
  if (!existsSync(dshBin)) return null
  const probeHome = join(root, 'tmp', 'dsh-store-probe')
  try {
    rmSync(probeHome, { recursive: true, force: true })
    mkdirSync(join(probeHome, 'profiles', 'probe'), { recursive: true })
    writeFileSync(
      join(probeHome, 'profiles', 'probe', 'package.json'),
      '{"name":"dsh-store-probe","private":true}\n',
      'utf8',
    )
    const out = execFileSync(
      node,
      [dshBin, 'plugin', '--profile', 'probe', 'store', 'path', '--store-dir', storeRoot],
      {
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, DSH_HOME: probeHome, DSH_AGENTS_HOME: join(probeHome, 'agents'), PATH: launcherPath() },
      },
    )
    const last = out
      .trim()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .pop()
    if (last && /[\\/]/.test(last)) return last
  } catch {
    /* 探测失败就走兜底 */
  } finally {
    try {
      rmSync(probeHome, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结果 */
    }
  }
  return null
}

/**
 * 缓存格式版本：解析方式一变就必须加 1，否则旧工具留下的缓存会被当成有效值继续用。
 * （开发过程中踩过两次：一次用错 pnpm 探测得到 v11，一次没固定 PATH 导致同一仓库在 v10/v11 之间跳。）
 */
const CACHE_SCHEMA = 3
const resolveStore = () => {
  const cacheFile = join(root, 'tmp', 'pnpm-store-path.json')
  const refresh = argv.includes('--refresh')
  let dshVersion = ''
  try { dshVersion = JSON.parse(readFileSync(join(root, 'app', 'package.json'), 'utf8')).version || '' } catch { }
  if (!refresh) {
    try {
      const c = JSON.parse(readFileSync(cacheFile, 'utf8'))
      const fresh = c.path && Date.now() - c.at < 24 * 3600 * 1000
      const sameTarget = samePath(c.storeRoot, storeRoot) && c.dshVersion === dshVersion
      if (c.schema === CACHE_SCHEMA && fresh && sameTarget) return c
    } catch {
      /* 缓存缺失或损坏就重新解析 */
    }
  }
  const path = probeStore()
  if (!path) return { storeRoot, path: null, at: Date.now() }
  const info = { schema: CACHE_SCHEMA, dshVersion, storeRoot, path, at: Date.now() }
  try {
    mkdirSync(join(root, 'tmp'), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(info), 'utf8')
  } catch {
    /* 缓存写不进去无所谓 */
  }
  return info
}


const safeWrite = (file, text) => {
  if (dryRun) return
  try {
    // 固定名字的备份：重复修正不会在便携目录里堆出一堆 .bak-时间戳 文件
    copyFileSync(file, file + '.bak')
  } catch {
    /* 备份失败就继续 */
  }
  writeFileSync(file, text, 'utf8')
}

const fixWorkspaceYaml = (profDir, name, storePath) => {
  const file = join(profDir, 'pnpm-workspace.yaml')
  if (!existsSync(file)) return false
  const raw = readFileSync(file, 'utf8')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  const want = `storeDir: '${storePath.replace(/'/g, "''")}'`
  let dirty = false
  const idx = lines.findIndex((l) => /^\s*storeDir\s*:/.test(l))
  if (idx >= 0) {
    if (lines[idx].trim() !== want.trim()) { lines[idx] = want; dirty = true }
  } else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    lines.push('', want)
    dirty = true
  }
  // profile 必须把安装目录指到共享目录（home\profiles\node_modules）：
  // 这样插件市场/`dsh plugin` 装的东西才不会又落到 profile 自己的 node_modules 里变成第二份。
  // 导入方式跟卷能力走：exFAT 只能 copy（没有硬链接），NTFS 用默认 auto。
  const wantImport = `packageImportMethod: '${importMethod.replace(/'/g, "''")}'`
  const ii = lines.findIndex((l) => /^\s*packageImportMethod\s*:/.test(l))
  if (ii >= 0) {
    if (lines[ii].trim() !== wantImport.trim()) { lines[ii] = wantImport; dirty = true }
  } else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    lines.push(wantImport)
    dirty = true
  }
  if (profDir !== profilesDir) {
    const wantMod = 'modulesDir: ../node_modules'
    const mi = lines.findIndex((l) => /^\s*modulesDir\s*:/.test(l))
    if (mi >= 0) {
      if (lines[mi].trim() !== wantMod) { lines[mi] = wantMod; dirty = true }
    } else {
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
      lines.push('', wantMod)
      dirty = true
    }
  }
  if (!dirty) return false
  safeWrite(file, lines.join(eol) + eol)
  say(`[${name}] pnpm-workspace.yaml 已对齐（storeDir / modulesDir）`)
  return true
}

const fixModulesYaml = (nmDir, profDir, name, storePath) => {
  const file = join(nmDir, '.modules.yaml')
  if (!existsSync(file)) return false
  const raw = readFileSync(file, 'utf8')
  // 护栏：记录里的 store 大版本（v10/v11）和探测到的 store 大版本不一样时，绝不能把
  // storeDir 改写成探测值——包的文件确实在另一个 store 里，改记录只是让 pnpm 以为找得到，
  // 下一次安装/卸载直接炸在内容层。宁可原样留着，交给 plugin-repair 重装。
  const from = storeMajor(recordedStoreDir(raw))
  const to = storeMajor(storePath)
  if (from && to && from !== to) {
    if (!storeMajorBlocked) {
      storeMajorBlocked = true
      say(`STORE 大版本不一致（v${from} -> v${to}）：请运行 dsh-portable.cmd plugin-repair`)
    }
    return false
  }
  const wantVirtual = join(profDir, 'node_modules', '.pnpm')
  let out = null
  try {
    const j = JSON.parse(raw)
    let dirty = false
    if (!samePath(j.storeDir, storePath)) {
      // 盘内 store 还空着、旧 store 有内容：绝不能把记录改成新路径，否则 pnpm 以为包都在新 store，
      // 下一次装/卸插件直接炸在内容层。先把旧 store 搬进来（migrate-store）或重装（plugin-repair）。
      if (!storeHasContent(storePath)) {
        if (!storeMigrateWarned) {
          storeMigrateWarned = true
          say('STORE 位置已改到便携目录内，但盘内 store 还是空的：先运行 dsh-portable.cmd migrate-store（搬旧 store）或 plugin-repair（重装），本次不改 .modules.yaml')
        }
        return false
      }
      say(`[${name}] .modules.yaml storeDir: ${j.storeDir} -> ${storePath}`)
      j.storeDir = storePath
      dirty = true
    }
    if (!samePath(j.virtualStoreDir, wantVirtual)) {
      say(`[${name}] .modules.yaml virtualStoreDir: ${j.virtualStoreDir} -> ${wantVirtual}`)
      j.virtualStoreDir = wantVirtual
      dirty = true
    }
    if (dirty) out = JSON.stringify(j, null, 2) + '\n'
  } catch {
    const lines = raw.split(/\r?\n/)
    let dirty = false
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*"storeDir"\s*:/.test(lines[i]) && !samePath(lines[i], storePath)) {
        say(`[${name}] .modules.yaml storeDir（文本替换）-> ${storePath}`)
        lines[i] = `  "storeDir": ${JSON.stringify(storePath)},`
        dirty = true
      } else if (/^\s*"virtualStoreDir"\s*:/.test(lines[i]) && !samePath(lines[i], wantVirtual)) {
        say(`[${name}] .modules.yaml virtualStoreDir（文本替换）-> ${wantVirtual}`)
        lines[i] = `  "virtualStoreDir": ${JSON.stringify(wantVirtual)},`
        dirty = true
      }
    }
    if (dirty) out = lines.join('\n')
  }
  if (!out) return false
  safeWrite(file, out)
  return true
}

const fixWorkspaceState = (nmDir, profDir, name, tailOverride) => {
  const file = join(nmDir, '.pnpm-workspace-state-v1.json')
  if (!existsSync(file)) return false
  let j
  try {
    j = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
  const projects = j.projects
  if (!projects || typeof projects !== 'object') return false
  const tail = (tailOverride ?? `\\profiles\\${name}`).toLowerCase()
  let dirty = false
  for (const key of Object.keys(projects)) {
    if (!samePath(key, profDir) && key.toLowerCase().endsWith(tail)) {
      say(`[${name}] workspace-state projects: ${key} -> ${profDir}`)
      projects[profDir] = projects[key]
      delete projects[key]
      dirty = true
    }
  }
  if (!dirty) return false
  safeWrite(file, JSON.stringify(j, null, 2) + '\n')
  return true
}

const main = () => {
  // 先补 PATH 垫片，再谈别的：没有它，"用哪个 pnpm"这件事本身就不确定，
  // 下面探测出来的 store 大版本会随机器上装的全局 pnpm 变来变去。
  const shims = ensurePnpmShim()
  if (!existsSync(profilesDir)) {
    if (!quiet) console.log('没有 home\\profiles，跳过')
    return 0
  }
  // 目标：各 profile 的 node_modules，加上共享插件根（home\profiles 本身就是个 pnpm 工程，
  // 里面装着两个模式共用的插件——它同样会记录原机器的绝对路径，换机后一样要修）
  const entries = []
  if (existsSync(join(profilesDir, 'node_modules', '.modules.yaml'))) {
    entries.push({ name: '共享根', dir: profilesDir, tail: '\\profiles' })
  }
  for (const n of readdirSync(profilesDir)) {
    if (n === 'node_modules') continue
    // 只挑"看起来是 profile"的目录：有 pnpm-workspace.yaml 或 package.json 都算。
    // 原来要求必须已存在 node_modules，于是 desktop 这种"已配置但还没装依赖"的 profile
    // 永远修不到，换机后它的 storeDir/workspace 里还留着原机器路径。
    const dir = join(profilesDir, n)
    let isProfile = false
    try { isProfile = statSync(dir).isDirectory() } catch { isProfile = false }
    if (!isProfile) continue
    if (!existsSync(join(dir, 'pnpm-workspace.yaml')) && !existsSync(join(dir, 'package.json'))) continue
    entries.push({ name: n, dir, tail: null })
  }
  const targets = entries
  if (!targets.length) {
    if (!quiet) console.log('pnpm 状态检查：没有已安装依赖的 profile，跳过')
    return 0
  }
  const store = resolveStore()
  // 旧版把 store 放在宿主用户目录；盘内 store 还空着而旧 store 有内容时，继续沿用旧路径，
  // 直到用户跑 migrate-store —— 否则 yaml 被改到空 store、记录还指着旧 store，pnpm 必报
  // ERR_PNPM_UNEXPECTED_STORE，插件装/卸全废。
  const legacyStore = join(homedir(), 'AppData', 'Local', 'Hack3rX-Harness', 'pnpm-store')
  const useLegacy = !storeHasContent(storeRoot) && storeHasContent(legacyStore)
  const effective = useLegacy ? legacyStore : storeRoot
  if (useLegacy) say('盘内 store 还是空的，暂时继续用旧 store（运行 dsh-portable.cmd migrate-store 搬进来）：' + legacyStore)
  // pnpm 记录的 storeDir 永远带 \vN 段；这里按"基路径 + 运行时大版本"拼，探测失败也能对齐
  const wantMajor = runtimePnpmMajor()
  const modulesPath = wantMajor ? join(effective, 'v' + wantMajor) : (store.path || effective)
  if (!quiet) {
    console.log('pnpm 状态检查')
    console.log('  便携仓库: ' + storeRoot)
    console.log('  pnpm 实际使用: ' + (store.path || '(无法确定)'))
    if (dryRun) console.log('  （预演模式：只报告，不写文件）')
  }
  if (!store.path) {
    say('无法从 dsh 内置 pnpm 得到 store 路径，本次跳过（不影响启动；如插件装不上请回报）')
    return 1
  }
  let changed = 0
  for (const t of targets) {
    const name = t.name
    const profDir = t.dir
    const nmDir = join(profDir, 'node_modules')
    if (fixModulesYaml(nmDir, profDir, name, modulesPath)) changed++
    if (fixWorkspaceState(nmDir, profDir, name, t.tail)) changed++
    if (fixWorkspaceYaml(profDir, name, effective)) changed++
  }
  if (!changed) {
    // 大版本冲突时护栏已经把"该怎么修"打印出来了，这里不能再报"一切正常"
    if (!quiet && !storeMajorBlocked) console.log(shims ? '  垫片已补齐，pnpm 记录无需修改' : '  一切正常，无需修改')
    return 0
  }
  say(dryRun ? `预演：将修改 ${changed} 处` : `已修正 ${changed} 处（原文件已备份为同名 .bak）`)
  return 0
}

/**
 * PowerShell 5.1 用系统 ANSI 代码页解析不带 BOM 的 .ps1：中文全变乱码、整份脚本语法失败
 * （表现是 dsh-portable.cmd 一跑就报一堆 Unexpected token）。编辑器保存时很容易丢 BOM，
 * 所以每次启动顺手校验一次，缺了就补回来。
 */
function ensureBom () {
  // 覆盖所有"由 PowerShell 5.1 执行、且内容含中文"的脚本。原来只修 dsh-portable.ps1，
  // 于是 tools\say.ps1 丢 BOM 时所有中文提示会变成 8 处语法错误，而且永远不会自愈。
  let fixed = 0
  for (const rel of ['dsh-portable.ps1', 'tools\\say.ps1']) {
    const ps1 = join(root, rel)
    if (!existsSync(ps1)) continue
    const buf = readFileSync(ps1)
    if (buf.length > 2 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) continue
    writeFileSync(ps1, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]))
    say(rel + ' 缺少 UTF-8 BOM（PowerShell 5.1 会读成乱码），已补回')
    fixed += 1
  }
  return fixed
}

// --check-store 是纯只读模式（启动器每次启动都会跑）：连补 BOM、补垫片、刷新缓存都不做，
// 只回答"记录里的 store 大版本对不对"。
if (argv.includes('--check-store')) process.exit(checkStore())

// --dry-run 也必须是"只看不改"：ensureBom 以前在模块顶层无条件执行，于是只要哪个 .ps1 丢了
// BOM，连 --dry-run 都会写盘（实测把 dsh-portable.ps1 改了），"dry-run 后 git status 干净"
// 这条验收就永远不成立。
if (!dryRun) ensureBom()
process.exit(main())