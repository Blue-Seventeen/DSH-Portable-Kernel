import { readFileSync, existsSync, writeFileSync, unlinkSync, statfsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const ok = (m) => console.log('  [OK]   ' + m)
const warn = (m) => console.log('  [注意] ' + m)
const bad = (m) => console.log('  [问题] ' + m)
let problems = 0
const fail = (m) => { bad(m); problems++ }

console.log('\n=== Hack3rX-Harness 便携版 环境自检 ===\n')

console.log('[1] 系统')
console.log('  位置: ' + root)
console.log('  系统: ' + (os.version?.() || os.type() + ' ' + os.release()))
console.log('  架构: ' + os.arch())
if (os.arch() === 'x64') ok('64 位系统'); else fail('需要 64 位 Windows（当前 ' + os.arch() + '）')

console.log('\n[2] 程序目录完整性')
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

console.log('\n[3] 运行环境')
const vcDir = join(root, 'runtime', 'vcredist')
const vcFiles = ['msvcp140.dll', 'vcruntime140.dll']
const missingVc = vcFiles.filter((f) => !existsSync(join(vcDir, f)))
if (missingVc.length === 0) ok('已内置 VC++ 运行库（不需要系统另装）')
else warn('内置 VC 运行库不全：' + missingVc.join(', ') + '（若启动报缺少 DLL，安装 vc_redist.x64.exe）')

console.log('\n[4] 空间与可写性')
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

console.log('\n[5] 路径长度')
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

console.log('\n[6] 网络')
const probe = async (name, url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) })
    if (r.ok) ok(`${name} 可访问`); else warn(`${name} 返回 HTTP ${r.status}`)
  } catch { warn(`${name} 连不上（离线也能用，只是装插件和更新会失败）`) }
}
await probe('插件源 npmjs', 'https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest')
await probe('更新源 deepseek', 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml')

console.log('\n[7] 便携模式确认')
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

console.log('\n[8] 数据文件')
try {
  const sdir = join(root, 'home', 'storages')
  const bomFiles = []
  for (const f of readdirSync(sdir)) {
    if (!f.endsWith('.json')) continue
    const buf = readFileSync(join(sdir, f))
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bomFiles.push(f)
  }
  if (bomFiles.length) warn('这些数据文件带了 BOM，DSH 会拒绝加载：' + bomFiles.join(', ') + '（运行 dsh-portable.cmd repair 可修）')
  else ok('数据文件格式正常（无 BOM）')
} catch (e) { if (e && e.code === 'ENOENT') ok('还没有数据文件（首次运行时会自动创建）'); else warn('数据文件检查跳过：' + e.message) }
console.log('\n[9] 换机相关')
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
  ok('当前盘 ' + root.slice(0, 2) + ' 不支持“来自其他计算机”标记，不会被 SmartScreen 拦')
} else {
  let stamp = null
  try { stamp = JSON.parse(readFileSync(join(root, 'tmp', 'motw.json'), 'utf8')) } catch { }
  if (stamp && stamp.blocked === 0) {
    ok('可执行文件已无“来自其他计算机”标记（上次检查 ' + new Date(stamp.at).toLocaleString() + '，共 ' + stamp.scanned + ' 个）')
  } else {
    warn('可能有文件带“来自其他计算机”标记（启动会被 SmartScreen 拦）：运行 dsh-portable.cmd unblock 清除')
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

console.log('\n=== ' + (problems === 0 ? '自检通过，可以开始使用' : `发现 ${problems} 个需要处理的问题`) + ' ===\n')
process.exit(problems === 0 ? 0 : 1)
