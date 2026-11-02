#!/usr/bin/env node
/**
 * 修复 profile 的 pnpm 状态记录，让它和本机解析出的 store 一致。
 *
 * 背景：便携版会被搬到另一台电脑。home\profiles\<名字>\node_modules\ 里记着原机器
 * 的绝对路径（storeDir / virtualStoreDir / projects 键）。换了用户名或换了位置后，
 * pnpm 的兼容性校验（ERR_PNPM_UNEXPECTED_STORE）会拒绝这个 profile 的所有安装与
 * 卸载——插件市场上点卸载就报这个错。
 *
 * 注意：store 目录名里的版本段（v10 / v11）取决于**执行安装的那个 pnpm**。
 * dsh 插件管理器内置的是 v10，而 runtime\pnpm 是另一套（v11），所以这里绝不能猜，
 * 必须问 dsh 自己的 pnpm（在一个临时 DSH_HOME 里问，避免在真实 profile 里留日志）。
 *
 * 做法（不重新下载任何包）：
 *   1. 问 dsh 内置 pnpm：--store-dir 指向便携仓库时它用哪个目录（含版本段）；
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
 *   node tools\fix-pnpm-state.mjs --quiet    静默（启动器用）
 *   node tools\fix-pnpm-state.mjs --store D:\somewhere   手动指定仓库根目录
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

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
const dshBin = join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const localAppData =
  process.env.LOCALAPPDATA || join(process.env.USERPROFILE || root, 'AppData', 'Local')
const storeRoot = argOf('--store') || join(localAppData, 'Hack3rX-Harness', 'pnpm-store')
const profilesDir = join(argOf('--root') ? join(argOf('--root'), 'home') : join(root, 'home'), 'profiles')

const samePath = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() ===
    b.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

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

const fixWorkspaceYaml = (profDir, name) => {
  const file = join(profDir, 'pnpm-workspace.yaml')
  if (!existsSync(file)) return false
  const raw = readFileSync(file, 'utf8')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  const want = `storeDir: '${storeRoot.replace(/'/g, "''")}'`
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
  const wantVirtual = join(profDir, 'node_modules', '.pnpm')
  let out = null
  try {
    const j = JSON.parse(raw)
    let dirty = false
    if (!samePath(j.storeDir, storePath)) {
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
    if (fixModulesYaml(nmDir, profDir, name, store.path)) changed++
    if (fixWorkspaceState(nmDir, profDir, name, t.tail)) changed++
    if (fixWorkspaceYaml(profDir, name)) changed++
  }
  if (!changed) {
    if (!quiet) console.log('  一切正常，无需修改')
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

ensureBom()
process.exit(main())