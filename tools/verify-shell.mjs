/**
 * 便携壳自断言（dsh-portable.cmd verify）。
 *
 * 存在的理由：外部 audit 脚本曾在"补丁只打了一半"时仍报 PASS，因为判据写错了；
 * 更糟的是本脚本以前把"豁免写对了"交给 plugin-shared 自己判（自证循环），
 * 结果官方 loader 其实把 '*' 整条忽略、插件被静默跳过，而这里显示 PASS。
 * 现在判据尽量对齐官方规则和真实行为：
 *   编码不变式 / 三份依赖一致 / bundles 数量 / 豁免必须是精确版本（无 '*'）/
 *   compat-heal 已收敛 / 市场补丁 55 字面 / sync --check 只读且已一致 /
 *   结构下限 + asar 精确字节 / 7z 真跑一次 / tools 语法 / 启动器接线 / 共享插件清单 /
 *   pnpm 垫片在不在 + 记录里的 store 大版本与 runtime\pnpm 一致
 *
 * 只读：所有"同步/规整"类检查都走各自工具的 --check（不落盘），本脚本自己不写任何文件。
 * 任何一项 FAIL → exit 1；读文件抛异常也算 FAIL（不再整个脚本崩掉）。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const NODE = join(ROOT, 'runtime/node/bin/node.exe')
const SEVEN = join(ROOT, 'tools/7z/7z.exe')
const rows = []
/** skip=true 记 SKIP：这一项在当前这份目录里不适用（比如只有壳的发布版没有 runtime\pnpm），不算失败 */
const add = (label, ok, detail, skip) => rows.push({ label, ok: !!ok, detail: detail || '', skip: !!skip })
/** 单项检查：任何异常都记成 FAIL 行，而不是让整个脚本抛栈退出（审计 F.6） */
const check = (label, fn) => {
  try { fn() } catch (e) { add(label, false, '异常: ' + (e && e.message ? e.message : String(e))) }
}
const read = (p) => readFileSync(p, 'utf8')
const exists = (p) => existsSync(p)
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const bytes = (p) => (exists(p) ? statSync(p).size : 0)
const countFiles = (p) => {
  try {
    const st = statSync(p)
    if (st.isFile()) return 1
    let n = 0
    for (const d of readdirSync(p, { withFileTypes: true })) n += countFiles(join(p, d.name))
    return n
  } catch { return 0 }
}
const run = (args) => {
  try { return { code: 0, out: execFileSync(NODE, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } }
  catch (e) { return { code: e.status === undefined ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') } }
}

// 1) 编码不变式 ---------------------------------------------------------------
const bom = (p) => { try { const b = readFileSync(p); return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf } catch { return false } }
// 只判"开头是不是 BOM"不够：曾经用 .NET GetString 读回再写，结果 BOM 被当成字符保留、
// 又加了一个 BOM，文件变成 "EF BB BF EF BB BF [CmdletBinding()]"，PowerShell 直接语法错。
// 所以这里同时断言"连续 BOM 只有一个"。
const bomCount = (p) => {
  try {
    const b = readFileSync(p)
    let n = 0
    let i = 0
    while (i + 2 < b.length && b[i] === 0xef && b[i + 1] === 0xbb && b[i + 2] === 0xbf) { n += 1; i += 3 }
    return n
  } catch { return 0 }
}
for (const f of ['dsh-portable.ps1', 'tools/say.ps1']) {
  check('UTF-8 BOM（且只有一个）: ' + f, () => add('UTF-8 BOM（且只有一个）: ' + f, bomCount(join(ROOT, f)) === 1, 'BOM 个数 ' + bomCount(join(ROOT, f))))
}
const cmds = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.cmd')).map((d) => d.name)
check('根目录 ' + cmds.length + ' 个 .cmd 纯 ASCII', () => {
  const nonAscii = cmds.filter((n) => readFileSync(join(ROOT, n)).some((x) => x > 127))
  add('根目录 ' + cmds.length + ' 个 .cmd 纯 ASCII', nonAscii.length === 0, nonAscii.join(', '))
})
check('所有 .cmd 用 CRLF 行尾', () => {
  // LF-only 行尾会让 cmd.exe 的 goto 找不到标签（实测报 "cannot find the batch label"），必须 CRLF
  const lfOnly = cmds.filter((n) => /(^|[^\r])\n/.test(readFileSync(join(ROOT, n), 'utf8')))
  add('所有 .cmd 用 CRLF 行尾', lfOnly.length === 0, lfOnly.join(', '))
})
for (const f of ['README.md', 'version.json']) {
  check('无 BOM 且无乱码: ' + f, () => {
    const b = readFileSync(join(ROOT, f))
    const text = b.toString('utf8')
    // 真 UTF-8：解码再编码必须字节相同；再加一道"连续拉丁补充字符"启发式抓典型 GBK 乱码
    const roundTrip = Buffer.from(text, 'utf8').equals(b)
    const mojibake = /[\u00c0-\u00ff]{4,}/.test(text)
    add('无 BOM 且无乱码: ' + f, !(b[0] === 0xef) && !text.includes('\uFFFD') && roundTrip && !mojibake,
      ['U+FFFD', '往返', '乱码串'].filter((k, i) => [text.includes('\uFFFD'), !roundTrip, mojibake][i]).join(',') || '')
  })
}

// 2) 插件清单一致性 -----------------------------------------------------------
const pj = (p) => JSON.parse(read(join(ROOT, p)))
check('三份 package.json 依赖逐字符一致', () => {
  const deps = (p) => Object.entries(pj(p).dependencies || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '@' + v).join(';')
  const dShared = deps('home/profiles/package.json')
  add('三份 package.json 依赖逐字符一致', dShared === deps('home/profiles/web/package.json') && dShared === deps('home/profiles/desktop/package.json'), dShared.split(';').length + ' 项')
})
check('bundles 数量与 version.json 声明一致', () => {
  // 期望值来自 version.json：完整版 7/14，发布版（只留壳+主题+商城）5/12
  const bundles = (p) => pj(p).dsh?.profile?.bundles || []
  const bw = bundles('home/profiles/web/package.json')
  const bd = bundles('home/profiles/desktop/package.json')
  const v = exists(join(ROOT, 'version.json')) ? JSON.parse(read(join(ROOT, 'version.json'))) : {}
  const wantW = Number(v.bundlesWeb || 7)
  const wantD = Number(v.bundlesDesktop || 14)
  add('bundles: web=' + wantW + ' / desktop=' + wantD + '（version.json 声明）', bw.length === wantW && bd.length === wantD, 'web=' + bw.length + ' desktop=' + bd.length)
  add('两边都含 dshmarket（商城必备）', bw.includes('dshmarket') && bd.includes('dshmarket'))
  const skins = (a) => a.filter((n) => /skin/.test(n)).sort().join()
  add('两个模式的主题集合一致', skins(bw) === skins(bd), bw.filter((n) => /skin/.test(n)).length + ' 个主题')
})
check('豁免格式符合官方规则（精确版本、无通配）', () => {
  const files = ['home/profiles/web/compatibility.json', 'home/profiles/desktop/compatibility.json']
  const bad = []
  for (const f of files) {
    const p = join(ROOT, f)
    if (!exists(p)) continue
    const m = JSON.parse(read(p))
    for (const [k, val] of Object.entries(m)) {
      if (!Array.isArray(val) || !val.length) { bad.push(f + ':' + k + ' 不是非空数组'); continue }
      for (const x of val) {
        // 官方 loader 只认精确版本号；'*' 会让整条记录被忽略、插件被静默跳过
        if (typeof x !== 'string' || !/^\d+\.\d+\.\d+/.test(x)) bad.push(f + ':' + k + ' → ' + JSON.stringify(x))
      }
    }
  }
  add('豁免格式符合官方规则（精确版本、无通配）', bad.length === 0, bad.slice(0, 3).join('; '))
})
check('豁免无需再修（compat-heal --check）', () => {
  const r = run([join(ROOT, 'tools/plugin-shared.mjs'), 'compat-heal', '--check'])
  add('豁免无需再修（compat-heal --check）', r.code === 0, r.out.trim())
})
check('豁免与当前 dsh 版本匹配（两份 profile 都查）', () => {
  const r = run([join(ROOT, 'tools/plugin-shared.mjs'), 'compat'])
  add('豁免与当前 dsh 版本匹配（两份 profile 都查）', r.code === 0, r.out.trim())
})
check('两份 compatibility.json 相同', () => {
  const a = join(ROOT, 'home/profiles/web/compatibility.json')
  const b = join(ROOT, 'home/profiles/desktop/compatibility.json')
  if (!exists(a) && !exists(b)) { add('两份 compatibility.json 相同', true, '两份都不存在（无豁免）'); return }
  add('两份 compatibility.json 相同', exists(a) && exists(b) && sha(a) === sha(b))
})

// 3) 市场补丁 ----------------------------------------------------------------
check('补丁状态: --check 报"已打"且 exit 0', () => {
  const patch = run([join(ROOT, 'tools/patch-market.mjs'), '--check'])
  add('补丁状态: --check 报"已打"且 exit 0', patch.code === 0 && /补丁：已打/.test(patch.out) && !/不完整/.test(patch.out), patch.out.trim())
})
check('补丁字面 55 处 = 54 调用点 + 1 定义（逐文件）', () => {
  const libDir = join(ROOT, 'home/profiles/node_modules/dshmarket/lib')
  const expect = { 'check.js': 6, 'hot.js': 3, 'install.js': 7, 'patch.js': 4, 'profile.js': 11, 'routes.js': 15, 'themes.js': 2, 'updates.js': 1, 'verify.js': 6 }
  let totalSites = 0
  const badFiles = []
  for (const [f, want] of Object.entries(expect)) {
    const n = (read(join(libDir, f)).match(/profilePackageDir\(/g) || []).length
    totalSites += n
    if (n !== want) badFiles.push(f + '=' + n + '(应 ' + want + ')')
  }
  add('补丁字面 55 处 = 54 调用点 + 1 定义（逐文件）', totalSites === 55 && badFiles.length === 0, badFiles.length ? badFiles.join(', ') : totalSites + ' 处字面')
})
check('dshmarket lib 语法正常', () => {
  const libDir = join(ROOT, 'home/profiles/node_modules/dshmarket/lib')
  const allJs = readdirSync(libDir).filter((n) => n.endsWith('.js'))
  const syntaxBad = allJs.filter((n) => run(['--check', join(libDir, n)]).code !== 0)
  add('dshmarket lib ' + allJs.length + ' 个文件语法正常', syntaxBad.length === 0, syntaxBad.join(', '))
})
check('无补丁错误日志 logs/patch-market.err', () => {
  add('无补丁错误日志 logs/patch-market.err', !exists(join(ROOT, 'logs/patch-market.err')) || bytes(join(ROOT, 'logs/patch-market.err')) === 0)
})

// 4) sync 已经收敛（只读方式判定） -------------------------------------------
check('sync 已收敛且本检查不落盘', () => {
  const watched = [
    'home/profiles/package.json', 'home/profiles/web/package.json', 'home/profiles/desktop/package.json',
    'home/profiles/web/compatibility.json', 'home/profiles/desktop/compatibility.json',
    'home/profiles/pnpm-workspace.yaml', 'home/profiles/web/pnpm-workspace.yaml', 'home/profiles/desktop/pnpm-workspace.yaml',
  ].filter((p) => exists(join(ROOT, p)))
  const snap = () => watched.map((p) => sha(join(ROOT, p)) + ':' + statSync(join(ROOT, p)).mtimeMs).join('|')
  const before = snap()
  const r = run([join(ROOT, 'tools/plugin-shared.mjs'), 'sync', '--check'])
  const after = snap()
  const unchanged = before === after
  add('sync 已收敛且本检查不落盘', r.code === 0 && unchanged,
    (r.code === 0 ? watched.length + ' 个文件一致' : r.out.trim()) + (unchanged ? '' : '；⚠ 检查过程改动了文件'))
})

// 5) 结构与体积 --------------------------------------------------------------
check('必需文件齐全', () => {
  const need = ['dsh-portable.ps1', 'dsh-portable.cmd', 'start-web.cmd', 'start-desktop.cmd', 'env.cmd', 'check-update.cmd', 'version.json',
    'tools/patch-market.mjs', 'tools/plugin-shared.mjs', 'tools/fix-pnpm-state.mjs', 'tools/mask-log.mjs', 'tools/clean-ship.mjs',
    'tools/verify-shell.mjs', 'tools/say.ps1', 'tools/7z/7z.exe', 'tools/7z/7z.dll', 'runtime/node/bin/node.exe',
    'app/node_modules/@deepseek-ai/dsh/lib/bin.js', 'desktop/DeepSeek Harness.exe', 'desktop/resources/app.asar']
  const missing = need.filter((p) => !exists(join(ROOT, p)))
  add('必需文件齐全（' + need.length + ' 项）', missing.length === 0, missing.join(', '))
})
check('app.asar 字节与出厂快照一致（±1%）', () => {
  const v = exists(join(ROOT, 'version.json')) ? JSON.parse(read(join(ROOT, 'version.json'))) : {}
  const asarNow = bytes(join(ROOT, 'desktop/resources/app.asar'))
  const asarSnap = Number(v.desktopAsarBytes || 0)
  if (asarSnap > 0) add('app.asar 字节与出厂快照一致（±1%）', Math.abs(asarNow - asarSnap) / asarSnap <= 0.01, asarNow + ' vs ' + asarSnap)
  else add('app.asar 体积合理（无快照，退回下限 170MB）', asarNow > 170 * 1024 * 1024, asarNow + ' B')
})
check('app.asar.unpacked 文件数 ≥ 1400', () => {
  const n = countFiles(join(ROOT, 'desktop/resources/app.asar.unpacked'))
  add('app.asar.unpacked 文件数 ≥ 1400', n >= 1400, String(n))
})
check('desktop/ 文件数 ≥ 7000', () => {
  const n = countFiles(join(ROOT, 'desktop'))
  add('desktop/ 文件数 ≥ 7000', n >= 7000, String(n))
})
check('version.json 的桌面计数与实物一致（±2%）', () => {
  const v = JSON.parse(read(join(ROOT, 'version.json')))
  const real = countFiles(join(ROOT, 'desktop'))
  const snap = Number(v.desktopFiles || 0)
  if (!snap) { add('version.json 的桌面计数与实物一致（±2%）', false, '缺少 desktopFiles'); return }
  const dev = Math.abs(real - snap) / snap
  add('version.json 的桌面计数与实物一致（±2%）', dev <= 0.02, real + ' vs ' + snap)
})
check('内置 node 可跑（runtime\\node\\bin\\node.exe）', () => {
  const r = run(['-v'])
  add('内置 node 可跑（runtime\\node\\bin\\node.exe）', r.code === 0 && /^v\d+\./.test(r.out.trim()), r.out.trim())
})
check('7z 链完整（真跑一次 7z i）', () => {
  if (!exists(SEVEN) || !exists(join(ROOT, 'tools/7z/7z.dll'))) { add('7z 链完整（真跑一次 7z i）', false, '缺少 exe 或 7z.dll'); return }
  let out = ''
  try { out = execFileSync(SEVEN, ['i'], { encoding: 'utf8', timeout: 20000 }) } catch (e) { out = String((e && e.stdout) || '') }
  add('7z 链完整（真跑一次 7z i）', /7-Zip/i.test(out), (out.split('\n')[1] || '').trim())
})
check('解包不硬依赖系统 tar（1703 这类老机器能自举）', () => {
  // 事故背景：Win10 1703 不自带 tar.exe（1803 才有），旧实现里 Bootstrap-Pnpm 直接 throw，
  // 于是 node 装完就卡死、app 与插件全装不上。这里锁住"探测 + 回退"这条链不再被改回去。
  const text = read(join(ROOT, 'dsh-portable.ps1'))
  const need = ['Invoke-Native', 'Resolve-Tar', 'Resolve-SevenZip', 'Get-UnpackerChain', 'Expand-WithSevenZip', 'Expand-ArchiveLike']
  const missing = need.filter((n) => !text.includes('function ' + n))
  const hardTar = /缺少系统 tar\.exe/.test(text)
  const detail = missing.length ? '缺少 ' + missing.join(', ') : (hardTar ? '仍写着"缺少系统 tar.exe"硬断言' : '系统 tar → 随包 7z → Expand-Archive 三级回退就位')
  add('解包不硬依赖系统 tar（1703 这类老机器能自举）', missing.length === 0 && !hardTar, detail)
})

// 6) tools 语法与启动器接线 ---------------------------------------------------
check('tools/*.mjs 语法全过', () => {
  const toolBad = readdirSync(join(ROOT, 'tools')).filter((n) => n.endsWith('.mjs')).filter((n) => run(['--check', join(ROOT, 'tools', n)]).code !== 0)
  add('tools/*.mjs 语法全过', toolBad.length === 0, toolBad.join(', '))
})
check('dsh-portable.cmd 也 call env.cmd（两条入口环境一致）', () => {
  const text = read(join(ROOT, 'dsh-portable.cmd'))
  add('dsh-portable.cmd 也 call env.cmd（两条入口环境一致）', /call\s+"%ROOT%env\.cmd"/i.test(text))
})
check('启动器都接了 compat-heal（升级后豁免自动跟上）', () => {
  const bad = ['start-web.cmd', 'start-desktop.cmd'].filter((f) => !/compat-heal/.test(read(join(ROOT, f))))
  add('启动器都接了 compat-heal（升级后豁免自动跟上）', bad.length === 0, bad.join(', '))
})

// 7) 共享插件 ----------------------------------------------------------------
check('共享插件目录存在（至少 dshmarket）', () => {
  const sharedDir = join(ROOT, 'home/profiles/node_modules')
  const ok = exists(join(sharedDir, 'dshmarket', 'package.json'))
  add('共享插件目录存在（至少 dshmarket）', ok)
})
check('插件只有一份共享副本（web/desktop 下都没有第二份 dshmarket）', () => {
  const dup = ['web', 'desktop'].filter((m) => exists(join(ROOT, 'home/profiles/' + m + '/node_modules/dshmarket/package.json')))
  add('插件只有一份共享副本（web/desktop 下都没有第二份 dshmarket）', dup.length === 0, dup.join(', '))
})

// 8) pnpm 垫片与 store 大版本 --------------------------------------------------
// 事故背景：runtime\pnpm\bin 里没有 pnpm.cmd（Windows 只认 .cmd/.exe），于是 env.cmd 把
// runtime\pnpm\bin 置顶到 PATH 是空转；`dsh plugin …` 拿到的是机器上的全局 pnpm（实测
// 10.33.0），.modules.yaml 就按 v10 记录；而 runtime\pnpm 是 11.28.5，之后任何写操作都
// 报 ERR_PNPM_UNEXPECTED_STORE，插件装/卸全废。这两项把"垫片在不在"和"记录对不对"钉住。
const PNPM_DIR = join(ROOT, 'runtime/pnpm')
const PNPM_SHIM = join(PNPM_DIR, 'bin/pnpm.cmd')
const MODULES_YAML = join(ROOT, 'home/profiles/node_modules/.modules.yaml')
const runtimeMajor = () => {
  try { return String(JSON.parse(read(join(PNPM_DIR, 'package.json'))).version || '').split('.')[0] } catch { return '' }
}
const storeMajor = (p) => {
  const m = String(p || '').replace(/[\\/]+$/, '').match(/[\\/]v(\d+)$/)
  return m ? m[1] : ''
}
check('pnpm 垫片就位（runtime\\pnpm\\bin\\pnpm.cmd → pnpm.mjs，纯 ASCII + CRLF）', () => {
  const label = 'pnpm 垫片就位（runtime\\pnpm\\bin\\pnpm.cmd → pnpm.mjs，纯 ASCII + CRLF）'
  if (!exists(PNPM_DIR)) { add(label, true, '没有 runtime/pnpm（只有壳的发布版）', true); return }
  if (!exists(PNPM_SHIM)) { add(label, false, '文件不存在：dsh 会用 PATH 上的全局 pnpm'); return }
  const buf = readFileSync(PNPM_SHIM)
  const text = buf.toString('ascii')
  const ascii = !buf.some((x) => x > 127) // BOM / 中文会让 cmd.exe 解析失败
  const crlf = !/(^|[^\r])\n/.test(text) // LF-only 行尾会让 cmd 报找不到标签
  const points = text.includes('pnpm.mjs')
  const bad = [points ? '' : '未指向 pnpm.mjs', ascii ? '' : '非纯 ASCII', crlf ? '' : '不是 CRLF 行尾'].filter(Boolean)
  add(label, bad.length === 0, bad.length ? bad.join(', ') : buf.length + ' B')
})
check('pnpm 记录的 store 大版本与 runtime\\pnpm 一致', () => {
  const label = 'pnpm 记录的 store 大版本与 runtime\\pnpm 一致'
  const want = runtimeMajor()
  if (!want) { add(label, true, '没有 runtime/pnpm（只有壳的发布版）', true); return }
  if (!exists(MODULES_YAML)) { add(label, true, '还没装插件（无 .modules.yaml）', true); return }
  const j = JSON.parse(read(MODULES_YAML))
  const got = storeMajor(j.storeDir) || String(j.packageManager || '').replace(/^pnpm@/, '').split('.')[0]
  if (!got) { add(label, false, '.modules.yaml 里没有 storeDir / packageManager'); return }
  add(label, got === want, got === want ? 'v' + want : 'v' + got + ' -> v' + want + '（需 dsh-portable.cmd plugin-repair）')
})

// ---- 输出 -------------------------------------------------------------------
console.log('')
let fails = 0
let skips = 0
for (const r of rows) {
  if (r.skip) skips += 1
  else if (!r.ok) fails += 1
  const tag = r.skip ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL')
  console.log('  ' + tag + '  ' + r.label + (r.ok || r.skip ? (r.detail ? '  (' + r.detail + ')' : '') : '  ← ' + r.detail))
}
console.log('')
console.log(fails === 0
  ? '结论：' + rows.length + ' 项全过' + (skips ? '（其中 ' + skips + ' 项不适用，记 SKIP）' : '')
  : '结论：' + fails + ' / ' + rows.length + ' 项失败')
process.exit(fails === 0 ? 0 : 1)
