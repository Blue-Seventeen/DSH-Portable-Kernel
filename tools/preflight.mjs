import { readFileSync, existsSync, writeFileSync, unlinkSync, statfsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let oks = 0
let warns = 0
let problems = 0
const ok = (m) => { oks++; console.log('  [OK]   ' + m) }
const warn = (m) => { warns++; console.log('  [注意] ' + m) }
const bad = (m) => console.log('  [问题] ' + m)
const fail = (m) => { bad(m); problems++ }

// tmp\fs-profile.cmd 是 tools\fs-profile.ps1 探测本机卷后写下的 "set K=V" 片段。
// 第一次探测之前它不存在 —— 所以这里一律"缺失 = 未探测"，只提示、不算问题。
const readFsProfile = () => {
  const p = join(root, 'tmp', 'fs-profile.cmd')
  if (!existsSync(p)) return null
  let text = ''
  try { text = readFileSync(p, 'utf8') } catch { return null }
  const vars = {}
  for (const line of text.split(/\r?\n/)) {
    // 兼容 set "K=V" / set K=V / 行尾注释；其它行（setlocal 等）忽略
    const m = line.match(/^\s*set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$/i)
    if (m) vars[m[1].toUpperCase()] = m[2].trim()
  }
  return vars
}
const fsProfile = readFsProfile()
// 片段没生成时退回环境（env.cmd 会读同一份片段），两者都没有就是"未探测"
const profileName = () => (fsProfile && fsProfile.DSH_FS_PROFILE) || process.env.DSH_FS_PROFILE || ''

// 头部：一屏之内先看到"我是谁 / 什么版本 / 在哪 / 有没有更新"，细节留给下面的分区
const readShellInfo = () => {
  try {
    const mf = JSON.parse(readFileSync(join(root, 'shell-version.json'), 'utf8'))
    return { version: String(mf.shellVersion || ''), channel: String(mf.channel || 'stable'), tag: String(mf.tag || '') }
  } catch { return { version: '', channel: '', tag: '' } }
}
const shellInfo = readShellInfo()
/** 极简版本比较：返回 1 / 0 / -1（够用于 "远端是否比本地新"） */
const cmpVersion = (a, b) => {
  const norm = (v) => String(v).replace(/^v/i, '').split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  const A = norm(a)
  const B = norm(b)
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] === undefined ? 0 : A[i]
    const y = B[i] === undefined ? 0 : B[i]
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1
    if (typeof x === 'number') return 1
    if (typeof y === 'number') return -1
    return String(x) > String(y) ? 1 : -1
  }
  return 0
}
/**
 * 读"最近一次真查"的结论（缓存现在**只用于展示**，不再决定要不要提示更新：
 * 启动流程已经改成每次真查，缓存只负责让 [11] 能显示"上次检查的结果 + 多久以前"）。
 * 仍然要校验归属：缓存里的 local 必须等于当前安装版本，否则它描述的是上一版的事实。
 */
const readCheckCache = () => {
  try {
    const c = JSON.parse(readFileSync(join(root, 'tmp', 'shell-check.json'), 'utf8'))
    const s = c.summary || {}
    const at = Number(c.at || s.at || 0)
    const local = String(s.local || '')
    const remote = String(s.remote || '')
    const ageMs = at > 0 ? Date.now() - at : -1
    const usable = at > 0 && !!local && local === String(shellInfo.version || '')
    const changed = Number(s.changed || 0)
    return { ok: at > 0, ageMs, usable, status: String(s.status || ''), local, remote, changed }
  } catch { return { ok: false, ageMs: -1, usable: false, status: '', local: '', remote: '', changed: 0 } }
}
const checkCache = readCheckCache()
/** 上一次"真查失败"的记录（shell-update --quiet-fail 写的），用来区分"没查到"和"已是最新" */
const readCheckErr = () => {
  try {
    const e = JSON.parse(readFileSync(join(root, 'tmp', 'shell-check.err.json'), 'utf8'))
    const at = Number(e.at || 0)
    return { ok: at > 0, ageMs: at > 0 ? Date.now() - at : -1, error: String(e.error || '') }
  } catch { return { ok: false, ageMs: -1, error: '' } }
}
const checkErr = readCheckErr()
const agoText = (ms) => {
  if (!(ms >= 0)) return '时间未知'
  if (ms < 60000) return '刚刚'
  if (ms < 3600000) return Math.round(ms / 60000) + ' 分钟前'
  if (ms < 86400000) return Math.round(ms / 3600000) + ' 小时前'
  return Math.round(ms / 86400000) + ' 天前'
}
/** 头部只提示"刚查到的更新"（10 分钟内、且确实比本地新）；更旧的结论只在 [11] 里说明 */
const CACHE_BANNER_MS = 10 * 60 * 1000
const cacheNewer = checkCache.usable && checkCache.status === 'update-available' && cmpVersion(checkCache.remote, checkCache.local) > 0
const shellUpdate = (cacheNewer && checkCache.ageMs >= 0 && checkCache.ageMs <= CACHE_BANNER_MS) ? checkCache.remote : ''
const RULE = '─'.repeat(60)
console.log('')
console.log('  ' + RULE)
console.log('  DSH-Portable-Kernel · 便携版自检')
console.log('  壳版本  ' + (shellInfo.version || '（读不到 shell-version.json）') + (shellInfo.version ? '  (' + shellInfo.channel + ')' : '') + (shellUpdate ? '    →  ' + shellUpdate + ' 可更新' : ''))
console.log('  安装位置  ' + root)
console.log('  ' + RULE)

console.log('\n[01] 系统')
console.log('  系统: ' + (os.version?.() || os.type() + ' ' + os.release()))
console.log('  架构: ' + os.arch())
if (os.arch() === 'x64') ok('64 位系统'); else fail('需要 64 位 Windows（当前 ' + os.arch() + '）')

console.log('\n[02] 程序目录完整性')
for (const [name, probe, label] of [
  ['app', 'node_modules/@deepseek-ai/dsh/lib/bin.js', '引擎'],
  ['desktop', 'DeepSeek Harness.exe', '桌面窗口'],
  ['runtime', 'node/bin/node.exe', '便携 Node'],
  ['home', 'profiles', '你的档案'],
  ['tools', '7z/7z.exe', '解包工具'],
]) {
  if (existsSync(join(root, name, probe))) ok(`${label}（${name}）就位`)
  else fail(`${label}（${name}）缺失或不完整 —— 复制时可能没拷全`)
}

console.log('\n[03] 运行环境')
const vcDir = join(root, 'runtime', 'vcredist')
const vcFiles = ['msvcp140.dll', 'vcruntime140.dll']
const missingVc = vcFiles.filter((f) => !existsSync(join(vcDir, f)))
if (missingVc.length === 0) ok('已内置 VC++ 运行库（不需要系统另装）')
else warn('内置 VC 运行库不全：' + missingVc.join(', ') + '（若启动报缺少 DLL，安装 vc_redist.x64.exe）')

console.log('\n[04] 空间与可写性')
try {
  const st = statfsSync(root)
  const freeGB = (st.bavail * st.bsize) / 1073741824
  if (freeGB > 3) ok('剩余空间 ' + freeGB.toFixed(1) + ' GB')
  else warn('剩余空间只有 ' + freeGB.toFixed(1) + ' GB，更新时要下载约 276 MB 并解包约 1.1 GB')
} catch { warn('无法读取磁盘剩余空间') }
for (const d of ['tmp', 'home']) {
  const p = join(root, d, '.write-test')
  try { writeFileSync(p, 'x'); unlinkSync(p); ok(`${d} 可写入`) }
  catch { fail(`${d} 不可写入（U 盘写保护？或权限不足）`) }
}

// 4.1 卷格式与档位：compat = exFAT/FAT32（无软链/硬链接），native = NTFS
const prof = fsProfile || {}
const volFmt = prof.DSH_FS_FORMAT || '未知'
const volDrive = prof.DSH_FS_DRIVE || root.slice(0, 2)
if (prof.DSH_FS_PROFILE) {
  ok(`卷格式 ${volFmt}（${volDrive}），档位 ${prof.DSH_FS_PROFILE}（权限 ${prof.DSH_PERMISSION_MODE || '未声明'}，pnpm 导入 ${prof.DSH_PNPM_IMPORT_METHOD || '未声明'}）`)
  if (String(prof.DSH_FS_PROFILE).toLowerCase() === 'compat') {
    warn('compat 档：这个卷不支持软链接/硬链接，插件依赖改用 hoisted 布局 + copy 导入；同一份程序在这个卷上占用的空间会比 NTFS 大')
  }
} else {
  warn('卷格式与档位：未探测（tmp\\fs-profile.cmd 还没生成；运行 tools\\fs-profile.ps1 或下次启动会自动探测）')
}

// 4.2 字节放大率：exFAT 的簇很大（实测本卷 128 KB），几万个小文件（node_modules）按整簇占用，
// 逻辑字节数会比真实占用小一截 —— U 盘容量/复制时间要按"实际占用"算，所以这里显式量一次。
// 只统计 app / desktop / home；最多给 1.5s，超时就用 ">" 标明是下界（大目录不可能全走完）。
try {
  const st = statfsSync(root)
  const cluster = Number(st.bsize) || 4096
  const GiB = (n) => (n / 1073741824).toFixed(1) + ' GB'
  const usedGB = ((st.blocks - st.bfree) * st.bsize) / 1073741824
  const totalGB = (st.blocks * st.bsize) / 1073741824
  const deadline = Date.now() + 1500
  let logical = 0
  let allocated = 0
  let files = 0
  let timedOut = false
  const stack = ['app', 'desktop', 'home'].map((d) => join(root, d)).filter((d) => existsSync(d))
  while (stack.length) {
    if (Date.now() > deadline) { timedOut = true; break }
    const dir = stack.pop()
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { stack.push(p); continue }
      if (!e.isFile()) continue // 软链/其它一律不计
      let s
      try { s = statSync(p) } catch { continue }
      logical += s.size
      // Windows 上 Node 的 blocks 是"按簇取整后的 512 字节块数"，正好等于真实占用；
      // 拿不到 blocks 时退回按簇取整估算。
      allocated += s.blocks ? s.blocks * 512 : Math.ceil(s.size / cluster) * cluster
      files += 1
    }
  }
  const pre = timedOut ? '>' : ''
  const tail = timedOut ? '，1.5s 没走完所以是下界' : ''
  const ampf = logical > 0 ? allocated / logical : 0
  const head = `卷 ${totalGB.toFixed(1)} GB，已用 ${usedGB.toFixed(1)} GB；app+desktop+home 逻辑 ${pre}${GiB(logical)}，按簇占用 ${pre}${GiB(allocated)}（${files} 个文件，簇 ${Math.round(cluster / 1024)} KB）`
  if (logical <= 0) warn('无法统计 app/desktop/home 的逻辑字节数（目录还没就位？）')
  else if (ampf > 1.5) warn(`字节放大 ${pre}${ampf.toFixed(1)}×（实际/逻辑，即 逻辑/实际 ≈ ${(1 / ampf).toFixed(2)}）：${head}${tail} —— exFAT 大簇把每个小文件按整簇占用，复制到 U 盘/换机时要按"按簇占用"估容量`)
  else ok(`字节放大 ${pre}${ampf.toFixed(2)}×（实际/逻辑）：${head}${tail}`)
} catch (e) { warn('无法计算字节放大率：' + (e && e.message ? e.message : e)) }

console.log('\n[05] 路径长度')
// 长路径支持要读注册表，进程环境变量里没有这个信息
let longPaths = false
try {
  const out = execFileSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
  longPaths = /LongPathsEnabled\s+REG_DWORD\s+0x1/i.test(out)
} catch { longPaths = false }
if (longPaths) ok('系统已启用长路径支持')
const rootLen = root.length
// 实测（0.2.1-rc.5，2026-11）：desktop 目录里最长相对路径约 180 字符、app 约 150，
// 所以真正可用的余量不是 60，而是 ~185；超过这条线，解包/更新就会在 MAX_PATH 上失败。
const need = 185
const budget = 260 - rootLen
if (longPaths) ok(`当前根路径 ${rootLen} 字符（系统已开长路径支持，不受 260 限制）`)
else if (budget >= need) ok(`当前根路径 ${rootLen} 字符，余量充足（还剩 ${budget}）`)
else warn(`当前根路径 ${rootLen} 字符偏长：官方程序解包后最长路径约 180 字符，Windows 上限 260，只剩 ${budget}。建议挪到更短的目录（例如 X:\Hack3rX-Harness），或开启系统长路径支持（注册表 LongPathsEnabled=1）`)

console.log('\n[06] 网络')
const probe = async (name, url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) })
    if (r.ok) ok(`${name} 可访问`); else warn(`${name} 返回 HTTP ${r.status}`)
  } catch { warn(`${name} 连不上（离线也能用，只是装插件和更新会失败）`) }
}
await probe('插件源 npmjs', 'https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest')
await probe('更新源 deepseek', 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml')

console.log('\n[07] 便携模式确认')
if (!process.env.DSH_HOME) {
  warn('没有检测到 DSH_HOME —— 直接从 exe 双击会用到 C 盘默认目录，请始终用 start-web.cmd / start-desktop.cmd 启动')
} else if (process.env.DSH_HOME.toLowerCase().startsWith(root.toLowerCase())) {
  ok('便携模式生效：DSH_HOME = ' + process.env.DSH_HOME)
} else {
  warn('DSH_HOME 指向别处：' + process.env.DSH_HOME + '（说明有别的程序设置了它，或你不是通过本目录的启动器运行的）')
}
if (existsSync(join(root, 'home', '.credentials.yaml'))) {
  ok('已带登录凭据（换机后一般无需重新登录）')
  warn('凭据是明文存在 home\\.credentials.yaml 里的：U 盘丢失 = 密钥泄露，请妥善保管')
} else warn('没有找到登录凭据文件，首次可能要登录')

console.log('\n[08] 数据文件')
try {
  const sdir = join(root, 'home', 'storages')
  const bomFiles = []
  for (const f of readdirSync(sdir)) {
    if (!f.endsWith('.json')) continue
    const buf = readFileSync(join(sdir, f))
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[ 2] === 0xbf) bomFiles.push(f)
  }
  if (bomFiles.length) warn('这些数据文件带了 BOM，DSH 会拒绝加载：' + bomFiles.join(', ') + '（运行 dsh-portable.cmd repair 可修）')
  else ok('数据文件格式正常（无 BOM）')
} catch (e) { if (e && e.code === 'ENOENT') ok('还没有数据文件（首次运行时会自动创建）'); else warn('数据文件检查跳过：' + e.message) }
console.log('\n[09] 换机相关')
// 9.1 当前盘是否支持“来自其他计算机”标记（只有 NTFS 支持这种附加数据流）
let ntfs = false
try {
  const probe = join(root, 'tmp', 'ads-probe.txt')
  writeFileSync(probe, 'x')
  writeFileSync(probe + ':Zone.Identifier', 'x')
  ntfs = true
  try { unlinkSync(probe + ':Zone.Identifier') } catch { }
  try { unlinkSync(probe) } catch { }
} catch {
  try { unlinkSync(join(root, 'tmp', 'ads-probe.txt')) } catch { }
}
if (!ntfs) {
  ok('当前盘 ' + root.slice(0, 2) + ' 不支持“来自其他计算机”标记，不会被 SmartScreen 拦（档位 ' + (profileName() || '未探测') + '）')
} else {
  let stamp = null
  try { stamp = JSON.parse(readFileSync(join(root, 'tmp', 'motw.json'), 'utf8')) } catch { }
  if (stamp && stamp.blocked === 0) {
    ok('可执行文件已无“来自其他计算机”标记（上次检查 ' + new Date(stamp.at).toLocaleString() + '，共 ' + stamp.scanned + ' 个；档位 ' + (profileName() || '未探测') + '）')
  } else {
    warn('可能有文件带“来自其他计算机”标记（启动会被 SmartScreen 拦）：运行 dsh-portable.cmd unblock 清除（档位 ' + (profileName() || '未探测') + '）')
  }
}
// 9.2 插件目录里的 pnpm 记录是否还指向旧机器
let storeInfo = null
try { storeInfo = JSON.parse(readFileSync(join(root, 'tmp', 'pnpm-store-path.json'), 'utf8')) } catch { }
const mismatched = []
const relocated = []
const rootLower = root.toLowerCase().replace(/\\+$/, '')
try {
  const pdir = join(root, 'home', 'profiles')
  for (const name of readdirSync(pdir)) {
    const mf = join(pdir, name, 'node_modules', '.modules.yaml')
    if (!existsSync(mf)) continue
    const j = JSON.parse(readFileSync(mf, 'utf8'))
    // 没有缓存也能判断搬家：记录里的虚拟仓库必须落在当前便携目录内
    const vs = String(j.virtualStoreDir || '').toLowerCase()
    if (vs && !vs.startsWith(rootLower)) relocated.push(name)
    if (storeInfo && j.storeDir && j.storeDir.toLowerCase() !== String(storeInfo.path).toLowerCase()) mismatched.push(name)
  }
} catch { }
if (mismatched.length) {
  warn('插件目录的 pnpm 记录还是旧机器的路径：' + mismatched.join(', ') + '（下次启动会自动修正，也可运行 dsh-portable.cmd fix-state）')
} else if (relocated.length) {
  warn('插件目录的 pnpm 记录还指向搬运前的位置：' + relocated.join(', ') + '（首次启动会自动修正，也可运行 dsh-portable.cmd fix-state）')
} else if (storeInfo) {
  ok('插件目录的 pnpm 记录与本机一致（' + storeInfo.path + '）')
} else {
  ok('插件目录的 pnpm 记录尚未在本机校验（首次启动会自动探测并写入）')
}

console.log('\n[10] 工具链（缺系统工具不算问题）')
// 10.1 解包：系统 tar 有就用、没有就用随包 7z。两者都没有才是真问题（复制没拷全）
const sysRoot = process.env.SystemRoot || 'C:\\Windows'
const hasSysTar = existsSync(join(sysRoot, 'System32', 'tar.exe'))
const has7z = existsSync(join(root, 'tools', '7z', '7z.exe')) && existsSync(join(root, 'tools', '7z', '7z.dll'))
if (has7z && hasSysTar) ok('解包工具齐全（系统 tar + 随包 7z 都在，按 tar → 7z 顺序用）')
else if (has7z) ok('系统没有 tar.exe（Win10 1703 及更早就是这样），改用随包 7z 解包，不影响使用')
else fail('随包 7z 不完整（tools\\7z\\7z.exe 或 7z.dll）—— 复制时可能没拷全')
// 10.2 搬运工具：只在升级/暂存时用，缺了会退化成慢速复制
if (existsSync(join(sysRoot, 'System32', 'robocopy.exe'))) ok('系统 robocopy 就位（大目录搬运用）')
else warn('没有 robocopy.exe：升级时的大目录搬运会失败（Windows 组件被裁剪？）')
// 10.3 下载兜底：主用 .NET 下载；连不上时若有系统 curl 会自动改用它
if (existsSync(join(sysRoot, 'System32', 'curl.exe'))) ok('系统 curl 就位（主下载失败时自动兜底）')
else ok('没有系统 curl：主下载失败时不会兜底（不影响正常运行）')

// 壳版本与更新状态：只读（不写盘；真正的检查由启动流程里的 shell-update check 负责，跑在本文件之前）
console.log('\n[11] 壳版本与更新')
if (shellInfo.version) {
  console.log('  当前版本  ' + shellInfo.version + '  (' + shellInfo.channel + ')')
  const ago = agoText(checkCache.ageMs)
  const latestKnown = (checkCache.ok && checkCache.usable && checkCache.remote) ? checkCache.remote : ''
  console.log('  最新版本  ' + (latestKnown || '未知（本次没查到）'))
  const errAgo = agoText(checkErr.ageMs)
  const errNewer = checkErr.ok && (!checkCache.ok || checkErr.ageMs < checkCache.ageMs)
  if (errNewer) {
    // 本次检查失败：直接说清楚，而不是假装"已是最新"
    warn('本次检查失败：' + (checkErr.error || '未知原因').slice(0, 80) + '（' + errAgo + '）；上次成功：' + (checkCache.ok ? ago : '无'))
  } else if (!checkCache.ok) ok('还没检查过更新（每次启动都会真查一次）')
  else if (!checkCache.usable) ok('上次检查是 ' + ago + '，当时版本 ' + (checkCache.local || '?') + '；下次启动会重查')
  else if (checkCache.status === 'update-available' && cacheNewer) {
    if (shellUpdate) warn('有可用更新：' + shellUpdate + '（当前 ' + checkCache.local + '；启动时可选择更新，不想看到可执行 shell-update snooze）')
    else ok('上次检查是 ' + ago + '，当时发现 ' + checkCache.remote + ' 可更新；本次启动会重查')
  }
  else if (checkCache.status === 'blocked') warn('有 ' + checkCache.remote + '，但被兼容性挡下（运行 shell-update check 看原因）')
  else if (checkCache.status === 'update-available' && checkCache.remote === checkCache.local) ok('版本相同（' + checkCache.local + '），但本地有 ' + checkCache.changed + ' 处改动；要还原成发布版就跑 shell-update apply --force')
  else if (checkCache.status === 'local-newer') ok('本地比远端新（本地 ' + checkCache.local + ' / 远端 ' + checkCache.remote + '）')
  else if (checkCache.status === 'up-to-date') ok('已是最新（检查于' + ago + '）')
  else ok('更新检查状态未知（' + (checkCache.status || '空') + '），下次启动会重查')
} else {
  warn('读不到 shell-version.json（壳清单缺失：这个目录可能不是完整的壳）')
}
console.log('\n=== ' + (problems === 0 ? '自检通过，可以开始使用' : `发现 ${problems} 个需要处理的问题`) + ' ===')
console.log('  结果：OK ' + oks + ' · 注意 ' + warns + ' · 问题 ' + problems + '\n')
process.exit(problems === 0 ? 0 : 1)
