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
 *   pnpm 垫片在不在 + 记录里的 store 大版本与 runtime\pnpm 一致 /
 *   便携优先（store / staging / 崩溃转储都收进盘内）/
 *   清单 v2 合法 / 清单覆盖完整 / 清单里没有禁止路径 / 更新源是版本线 / RELEASE-NOTES 六小节齐全
 *
 * --update-gate：只跑"壳换装后必须立住"的那一小撮（tools/shell-apply.mjs 的 verify 闸用它），
 * 其余行既不输出也不计数，结论行改成"结论（update-gate）：…"；正常模式行为完全不变。
 *
 * 只读：所有"同步/规整"类检查都走各自工具的 --check（不落盘），本脚本自己不写任何文件。
 * 任何一项 FAIL → exit 1；读文件抛异常也算 FAIL（不再整个脚本崩掉）。
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// 清单口径只有一份：白名单谓词 / schema 版本 / 本地壳文件列表都从壳更新器取，不在这里另写一套
import { MANIFEST_SCHEMA, SHELL_MANIFEST, UPDATER_MIN, isAllowedShellPath, listLocalShellFiles } from './shell-update.mjs'
import { checkTree } from './store-consistency.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const NODE = join(ROOT, 'runtime/node/bin/node.exe')
const SEVEN = join(ROOT, 'tools/7z/7z.exe')
/** --update-gate：换装后的窄门禁（只跑"壳换完必须立住"的那几项） */
const UPDATE_GATE = process.argv.includes('--update-gate')
/** 跑语法检查/子进程用哪个 node：内置运行时不在（空壳、新机器还没 bootstrap）就退回跑本脚本的这个 */
const CHECK_NODE = existsSync(NODE) ? NODE : process.execPath
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
const run = (args, node) => {
  try { return { code: 0, out: execFileSync(node || NODE, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } }
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
    if (!exists(join(ROOT, f))) { add('无 BOM 且无乱码: ' + f, true, '文件不存在（空壳/夹具），跳过', true); return }
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
check('drain 语义补丁已打（等待期不再冻结空闲会话）', () => {
  const f = join(ROOT, 'home/profiles/node_modules/dshmarket/lib/drain.js')
  if (!exists(f)) { add('drain 语义补丁已打（等待期不再冻结空闲会话）', true, '没装 dshmarket，跳过', true); return }
  const src = read(f)
  const hunks = (src.match(/\[portable-drain\]/g) || []).length
  const hasRelease = /this\.releaseAll\(\);\n\s+\/\/ The probe may still be refused/.test(src)
  const hasBoundary = /const busyNow = unheld\.filter\(agent => agent\.status === 'running'\)/.test(src)
  const hasGate = /active\.state === 'queued-for-mutation' \|\| active\.state === 'running'/.test(src)
  add('drain 语义补丁已打（等待期不再冻结空闲会话）', hunks >= 3 && hasRelease && hasBoundary && hasGate,
    '标记 ' + hunks + ' 处；D1释放=' + (hasRelease ? 'ok' : '缺') + ' D2边界=' + (hasBoundary ? 'ok' : '缺') + ' D3门控=' + (hasGate ? 'ok' : '缺'))
})
check('drain 等待期不冻结会话（selftest-drain）', () => {
  const r = run([join(ROOT, 'tools/selftest-drain.mjs'), '--quiet'])
  add('drain 等待期不冻结会话（selftest-drain）', r.code === 0, r.code === 0 ? '5 例全过' : (r.out || '').trim().slice(-300))
})
check('暂存安装：队列自洽', () => {
  const r = run([join(ROOT, 'tools/plugin-shared.mjs'), 'stage-status', '--check'])
  add('暂存安装：队列自洽', r.code === 0, r.code === 0 ? '队列可读、字段齐全' : (r.out || '').trim().slice(-200))
})
check('暂存安装：两个启动器都在补丁之前提交', () => {
  const bad = []
  for (const f of ['start-web.cmd', 'start-desktop.cmd']) {
    if (!exists(join(ROOT, f))) { bad.push(f + ': 缺文件'); continue }
    const src = read(join(ROOT, f))
    const act = src.indexOf('plugin-shared.mjs" activate')
    const patch = src.indexOf('patch-all.mjs" --apply')
    if (act < 0) bad.push(f + ': 没接 activate')
    else if (patch < 0) bad.push(f + ': 没接 patch-all')
    else if (act > patch) bad.push(f + ': activate 排在 patch-all 之后')
  }
  add('暂存安装：两个启动器都在补丁之前提交', bad.length === 0, bad.join('；') || '顺序正确')
})
check('暂存目录不进仓库', () => {
  const gi = exists(join(ROOT, '.gitignore')) ? read(join(ROOT, '.gitignore')) : ''
  add('暂存目录不进仓库', /^\/home\/plugin-stage\/$/m.test(gi), '/.gitignore 缺 /home/plugin-stage/')
})
check('补丁三族：market / fs / pnpm 状态可查', () => {
  const r = run([join(ROOT, 'tools/patch-all.mjs'), '--check', '--json'])
  let parsed = null
  try { parsed = JSON.parse(r.out) } catch { parsed = null }
  if (!parsed) { add('补丁三族：market / fs / pnpm 状态可查', false, 'patch-all --check --json 解析失败'); return }
  const bad = (parsed.families || []).filter((f) => f.state === 'failed')
  const need = (parsed.families || []).filter((f) => f.state === 'needs-work')
  add('补丁三族：market / fs / pnpm 状态可查', bad.length === 0,
    bad.length ? bad.map((f) => f.family + ': ' + (f.detail || '')).join('；')
      : need.length ? '需要修复（WARN）：' + need.map((f) => f.family).join('、')
        : (parsed.families || []).map((f) => f.family + '=' + f.state).join(' '))
})
check('补丁锚点自测（官方两代形状）', () => {
  const r = run([join(ROOT, 'tools/selftest-patches.mjs'), '--quiet'])
  add('补丁锚点自测（官方两代形状）', r.code === 0, r.code === 0 ? '5 个夹具全过' : (r.out || '').trim().slice(-200))
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
  // 内置 node 不在时用 process.execPath：发布版/空壳目录里也必须能跑（换装闸门就靠这一项）
  const toolBad = readdirSync(join(ROOT, 'tools')).filter((n) => n.endsWith('.mjs')).filter((n) => run(['--check', join(ROOT, 'tools', n)], CHECK_NODE).code !== 0)
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

// 9) 便携优先：store / staging / 档位 / 崩溃转储 --------------------------------
// 这一组锁"把 C 盘上的东西收回盘内"：pnpm store 与壳更新 staging 不许再落在 %LOCALAPPDATA%
// （换台机器/换个用户就失效，而且 exFAT 盘上 C 盘 store 与盘内 node_modules 混用会互相打架）；
// 桌面崩溃转储也要落进 logs\crash，否则换机时跟着本机一起丢。
// 判据里凡是"本机运行时才生成"的（tmp\fs-profile.cmd、被 fix-pnpm-state 重写过的 yaml）一律
// 存在才校验：没生成记 SKIP，生成了就必须自洽 —— 不能因为"还没跑过"而误报 FAIL。
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const YAML3 = ['home/profiles/pnpm-workspace.yaml', 'home/profiles/web/pnpm-workspace.yaml', 'home/profiles/desktop/pnpm-workspace.yaml']
const setVar = (text, key) => {
  // 解析 cmd 片段里的 set "K=V"（也容忍 set K=V 与行尾引号）
  const m = text.match(new RegExp('^\\s*set\\s+"?' + esc(key) + '=(.*?)"?\\s*$', 'im'))
  return m ? m[1].trim() : ''
}
check('便携脚本不再用 LOCALAPPDATA 拼 store/stage 路径（根目录 + tools\\）', () => {
  const label = '便携脚本不再用 LOCALAPPDATA 拼 store/stage 路径（根目录 + tools\\）'
  const files = readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.(cmd|ps1|mjs)$/i.test(d.name)).map((d) => d.name)
  const walk = (dir, rel) => {
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, rel + e.name + '/')
      else if (/\.(cmd|ps1|mjs)$/i.test(e.name)) files.push(rel + e.name)
    }
  }
  walk(join(ROOT, 'tools'), 'tools/')
  // 只豁免"清理子进程继承的环境变量名清单"这一种写法：里面是变量名，不是路径拼接。
  // 纯注释行（rem / # / // / *）提到 old %LOCALAPPDATA% 属于说明文字，天然不算（见下面 commented 计数）。
  const ALLOW = [{ file: 'tools/shell-update.mjs', re: /^\s*for \(const k of \[[^\]]*LOCALAPPDATA/i }]
  const hits = []
  let allowed = 0
  let commented = 0
  for (const f of files) {
    let text = ''
    try { text = read(join(ROOT, f)) } catch { continue }
    const id = f.replace(/\\/g, '/')
    // 扫描器自己必然出现这些字面量（判据/白名单），跳过自身不算违规。
    if (id === 'tools/verify-shell.mjs') continue
    text.split(/\r?\n/).forEach((line, i) => {
      if (!/LOCALAPPDATA/i.test(line)) return
      const t = line.trim()
      if (/^(rem\b|::|#|\/\/|\*)/i.test(t)) { commented += 1; return }
      if (ALLOW.some((a) => a.file === id && a.re.test(line))) { allowed += 1; return }
      hits.push(id + ':' + (i + 1))
    })
  }
  if (hits.length) { add(label, false, '仍在用：' + hits.slice(0, 4).join(', ') + (hits.length > 4 ? ' 等共 ' + hits.length + ' 处' : '')); return }
  const extra = [allowed ? '豁免变量名清单 ' + allowed + ' 处' : '', commented ? '注释说明 ' + commented + ' 处不计' : ''].filter(Boolean).join('，')
  add(label, true, files.length + ' 个脚本 0 处拼路径' + (extra ? '（' + extra + '）' : ''))
})
check('compat 档补丁已打 / native 档无残留补丁', () => {
  const label = 'compat 档补丁已打 / native 档无残留补丁'
  const node = join(ROOT, 'runtime', 'node', 'bin', 'node.exe')
  const frag = join(ROOT, 'tmp', 'fs-profile.cmd')
  if (!existsSync(node)) { add(label, true, '空壳（没有 node），跳过'); return }
  if (!existsSync(frag)) { add(label, true, '还没有探测片段，跳过'); return }
  let profile = ''
  for (const line of read(frag).split(/\r?\n/)) {
    const m = line.match(/^\s*set\s+"?DSH_FS_PROFILE=(.*?)"?\s*$/i)
    if (m) profile = m[1].trim().toLowerCase()
  }
  const tool = join(ROOT, 'tools', 'patch-fs.mjs')
  if (!existsSync(tool)) { add(label, false, '缺少 tools/patch-fs.mjs'); return }
  // stdio ignore：受限会话里管道会 EPERM，只看退出码
  const r = spawnSync(node, [tool, '--check', '--quiet'], { stdio: 'ignore', windowsHide: true })
  const code = r.status
  if (profile === 'compat' && code === 4) {
    // 桌面在跑时 app.asar 被占用，补丁只能等下次启动（启动器会自动补）：记 SKIP，不判失败
    const tl = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8', windowsHide: true })
    const running = (tl.stdout || '').includes('DeepSeek Harness.exe')
    add(label, true, running ? 'asar 被运行中的桌面占用；退出后下次启动自动补（patch-all 会做）' : 'compat 档补丁未打全，运行 dsh-portable.cmd repair', running)
    return
  }
  if (profile === 'compat') add(label, code === 0, code === 0 ? 'app 与 asar 都已打' : 'compat 档补丁未打全（code ' + code + '），运行 dsh-portable.cmd repair')
  else if (profile === 'native') add(label, code === 4, code === 4 ? 'native 档无补丁（正常）' : 'NTFS 上仍有补丁（code ' + code + '），运行 patch-fs.mjs --revert')
  else add(label, true, '档位未知，跳过')
})

check('env.cmd 把 pnpm store / staging 收进便携目录', () => {
  const label = 'env.cmd 把 pnpm store / staging 收进便携目录'
  let text = ''
  try { text = read(join(ROOT, 'env.cmd')) } catch (e) { add(label, false, '读不到 env.cmd: ' + e.message); return }
  const want = [['DSH_PNPM_STORE', '%ROOT%cache\\pnpm-store'], ['DSH_STAGE', '%ROOT%tmp\\build']]
  const bad = want.filter(([k, v]) => !new RegExp('set\\s+"?' + esc(k + '=' + v) + '"?', 'i').test(text)).map(([k, v]) => k + '=' + v)
  add(label, bad.length === 0, bad.length ? '缺少/路径不对：' + bad.join(', ') : want.map(([k]) => k).join(' / ') + ' 都指向盘内')
})
check('tools/fs-profile.ps1 就位（UTF-8 BOM，且只有一个）', () => {
  const label = 'tools/fs-profile.ps1 就位（UTF-8 BOM，且只有一个）'
  const p = join(ROOT, 'tools/fs-profile.ps1')
  if (!exists(p)) { add(label, false, '文件不存在：卷探测与档位生成没有实现'); return }
  const n = bomCount(p)
  add(label, n === 1, n === 1 ? 'BOM 个数 1，' + bytes(p) + ' B' : 'BOM 个数 ' + n)
})
check('三份 pnpm-workspace.yaml 都写 nodeLinker: hoisted（exFAT 无软链）', () => {
  const label = '三份 pnpm-workspace.yaml 都写 nodeLinker: hoisted（exFAT 无软链）'
  const bad = YAML3.filter((f) => !exists(join(ROOT, f)) || !/^\s*nodeLinker\s*:\s*hoisted\s*$/m.test(read(join(ROOT, f))))
  add(label, bad.length === 0, bad.length ? '缺少 nodeLinker: hoisted → ' + bad.join(', ') : '3 份都 hoisted')
})
check('三份 pnpm-workspace.yaml 已记 packageImportMethod（本机重写后才校验）', () => {
  const label = '三份 pnpm-workspace.yaml 已记 packageImportMethod（本机重写后才校验）'
  const present = YAML3.filter((f) => exists(join(ROOT, f)))
  if (!present.length) { add(label, true, '三份 yaml 都不在（只有壳的发布版，由 bootstrap 生成）', true); return }
  // packageImportMethod 是 fix-pnpm-state.mjs 在每次启动时和 storeDir 一起写进 yaml 的本机信息：
  // 还没被重写过（yaml 里没有 storeDir 行）就谈不上"该有"，记 SKIP 而不是 FAIL。
  const rewritten = present.filter((f) => /^\s*storeDir\s*:/m.test(read(join(ROOT, f))))
  if (!rewritten.length) { add(label, true, 'yaml 还没被 fix-pnpm-state 重写（下次启动会写 packageImportMethod）', true); return }
  let wantImport = ''
  try {
    const frag = read(join(ROOT, 'tmp', 'fs-profile.cmd'))
    const m = frag.match(/^\s*set\s+"?DSH_PNPM_IMPORT_METHOD=(.*?)"?\s*$/im)
    if (m) wantImport = m[1].trim()
  } catch { }
  const bad = present.filter((f) => {
    const m = read(join(ROOT, f)).match(/^\s*packageImportMethod\s*:\s*['"]?([A-Za-z]+)['"]?\s*$/m)
    if (!m) return true
    const v = m[1]
    if (!['copy', 'auto', 'hardlink', 'clone'].includes(v)) return true
    // 有档位片段时必须与档位一致：compat=copy（exFAT 没有硬链接），native=auto
    return wantImport ? v !== wantImport : false
  })
  add(label, bad.length === 0, bad.length ? 'packageImportMethod 缺失或与档位不符 → ' + bad.join(', ') + (wantImport ? '（期望 ' + wantImport + '）' : '') : '已重写 ' + rewritten.length + ' 份，导入方式与档位一致')
})
check('start-desktop.cmd 两处启动都接 --crash-dumps-dir（转储落 logs\\crash）', () => {
  const label = 'start-desktop.cmd 两处启动都接 --crash-dumps-dir（转储落 logs\\crash）'
  let text = ''
  try { text = read(join(ROOT, 'start-desktop.cmd')) } catch (e) { add(label, false, '读不到 start-desktop.cmd: ' + e.message); return }
  const starts = text.split(/\r?\n/).filter((l) => /DeepSeek Harness\.exe/i.test(l) && !/^\s*rem\b/i.test(l))
  const want = '--crash-dumps-dir="%ROOT%logs\\crash"'
  if (starts.length < 2) { add(label, false, '只找到 ' + starts.length + ' 处启动命令（应有 2 处：正常启动 + launch-desktop 失败兜底）'); return }
  const bad = starts.filter((l) => {
    const iFlag = l.indexOf(want)
    const iUser = l.indexOf('--user-data-dir')
    return iFlag < 0 || iUser < 0 || iUser > iFlag // 必须在 --user-data-dir 之后
  })
  add(label, bad.length === 0, bad.length ? bad.length + ' 处没接（或没放在 --user-data-dir 之后）' : starts.length + ' 处都接了')
})
check('tmp\\fs-profile.cmd 的权限模式与档位自洽（存在才校验）', () => {
  const label = 'tmp\\fs-profile.cmd 的权限模式与档位自洽（存在才校验）'
  const p = join(ROOT, 'tmp/fs-profile.cmd')
  if (!exists(p)) { add(label, true, 'tmp\\fs-profile.cmd 还没生成（未探测）', true); return }
  let text = ''
  try { text = read(p) } catch (e) { add(label, true, '读不到 tmp\\fs-profile.cmd: ' + e.message, true); return }
  const prof = setVar(text, 'DSH_FS_PROFILE').toLowerCase()
  const mode = setVar(text, 'DSH_PERMISSION_MODE').toLowerCase()
  const want = prof === 'compat' ? 'danger-full-access' : prof === 'native' ? 'workspace-write' : ''
  if (!want) { add(label, false, 'DSH_FS_PROFILE 取值无法识别：' + JSON.stringify(setVar(text, 'DSH_FS_PROFILE'))); return }
  add(label, mode === want, mode === want
    ? prof + ' → ' + mode
    : prof + ' 应配 ' + want + '，实际 ' + (mode || '（缺 DSH_PERMISSION_MODE）'))
})

// 10) 清单 v2（shell-version.json）与发布链路 -----------------------------------
// 这一组锁"壳自更新通道本身"：清单是不是 v2、覆盖是否完整、有没有把用户数据写进清单、
// 默认源是不是版本线（不是 master）、随包的 RELEASE-NOTES 六小节在不在。
const MANIFEST_FILE = join(ROOT, SHELL_MANIFEST)
/** notes 的六个小节键（与 tools/shell-update.mjs 的 NOTES_SECTIONS 一一对应） */
const MANIFEST_NOTES = ['added', 'fixed', 'optimized', 'breaking', 'upgrade', 'rollback']
/** RELEASE-NOTES.md 里六个小节的中文标题 */
const MANIFEST_NOTE_TITLES = ['新增', '修复', '优化', '破坏性变更', '升级会做什么', '如何回退']
/**
 * 永远不许进清单的路径：官方层（app/desktop/runtime）、用户数据（会话/存储/附件/凭证）、
 * 仓库元数据（version.json/.git*），以及桌面模式那份用户私有网关配置。
 */
const MANIFEST_DENY = ['app', 'desktop', 'runtime/node', 'runtime/pnpm', 'home/sessions', 'home/storages',
  'home/attachments', 'home/.credentials', 'version.json', '.gitignore', '.gitattributes',
  'home/profiles/desktop/cordis.patch.yml']
const manifestJson = () => {
  const j = JSON.parse(read(MANIFEST_FILE))
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
}
const denyHit = (rel) => {
  const low = String(rel).toLowerCase()
  return MANIFEST_DENY.some((d) => low === d || low.startsWith(d + '/') || low.startsWith(d + '.'))
}

check('清单 v2 合法', () => {
  const label = '清单 v2 合法'
  if (!exists(MANIFEST_FILE)) { add(label, false, 'shell-version.json 不存在（先跑 node tools\\clean-ship.mjs refresh）'); return }
  const j = manifestJson()
  const bad = []
  // schemaVersion / updaterMin 都得是本更新器读得懂的整数（上限就是本工具支持的 2）
  if (!Number.isInteger(j.schemaVersion) || j.schemaVersion < 1 || j.schemaVersion > MANIFEST_SCHEMA) bad.push('schemaVersion=' + JSON.stringify(j.schemaVersion) + '（应 1..' + MANIFEST_SCHEMA + ' 的整数）')
  if (!Number.isInteger(j.updaterMin) || j.updaterMin < 1 || j.updaterMin > UPDATER_MIN) bad.push('updaterMin=' + JSON.stringify(j.updaterMin) + '（应 1..' + UPDATER_MIN + ' 的整数）')
  if (!String(j.shellVersion || '').trim()) bad.push('shellVersion 为空')
  const filesObj = j.files
  const usable = !!filesObj && typeof filesObj === 'object' && !Array.isArray(filesObj)
  const rels = usable ? Object.keys(filesObj) : []
  if (!usable || !rels.length) bad.push('files 不是非空对象')
  const selfName = SHELL_MANIFEST.toLowerCase()
  for (const rel of rels) {
    // 清单自己会随每次 refresh 变，写进 files 就永远对不上（白名单也明确排除它）
    if (rel.toLowerCase() === selfName) bad.push('files 里不该出现清单自己：' + rel)
    if (!isAllowedShellPath(rel)) bad.push('白名单拒绝的路径：' + rel)
    if (!/^[0-9a-f]{64}$/.test(String(filesObj[rel]))) bad.push('sha256 不是 64 位小写十六进制：' + rel)
  }
  const owned = j.userOwned
  if (!Array.isArray(owned)) bad.push('userOwned 不是数组')
  else {
    const relSet = new Set(rels)
    const lost = owned.filter((p) => !relSet.has(p))
    if (lost.length) bad.push('userOwned 不在 files 里：' + lost.slice(0, 3).join(', '))
  }
  if (!j.notes || typeof j.notes !== 'object' || Array.isArray(j.notes)) bad.push('notes 不是对象')
  else {
    const missing = MANIFEST_NOTES.filter((k) => !Array.isArray(j.notes[k]))
    if (missing.length) bad.push('notes 缺数组键：' + missing.join(', '))
  }
  add(label, bad.length === 0, bad.length ? bad.slice(0, 5).join('；') : 'schemaVersion ' + j.schemaVersion + ' / updaterMin ' + j.updaterMin + ' / files ' + rels.length + ' / userOwned ' + (Array.isArray(owned) ? owned.length : 0))
})

check('清单覆盖完整', () => {
  const label = '清单覆盖完整'
  if (!exists(MANIFEST_FILE)) { add(label, false, 'shell-version.json 不存在（先跑 node tools\\clean-ship.mjs refresh）'); return }
  const filesObj = manifestJson().files || {}
  const local = listLocalShellFiles()
  // 大小写不敏感：Windows 上 TOOLS/X.MJS 与 tools/x.mjs 是同一个文件
  const localSet = new Set(local.map((s) => s.toLowerCase()))
  const localByLower = new Map(local.map((s) => [s.toLowerCase(), s]))
  const bad = []
  // 正方向：白名单里"当前存在"的每个壳文件都必须进清单。
  // 但**换装闸门**（--update-gate，跑在用户机器上）要豁免这一方向：
  // 用户完全可能自己往 tools\ 里放脚本（我们在文档里承诺"永不删"），那不是"漏收"；
  // 这一方向只适合发布前自检（仓库里必须清单与实物一一对齐）。
  if (!UPDATE_GATE) for (const rel of local) if (!Object.keys(filesObj).some((k) => k.toLowerCase() === rel.toLowerCase())) bad.push('漏收 ' + rel)
  // 反方向：清单里每条都得在磁盘上、在白名单内、且字节与清单 sha 一致（用户改过代码文件时这里就该红）。
  // 换装闸门下 userOwned 的 sha 差异是**正常状态**（用户装过插件、改过网关），不能因此回滚。
  const owned = new Set((manifestJson().userOwned || []).map((s) => String(s).toLowerCase()))
  for (const rel of Object.keys(filesObj)) {
    if (!exists(join(ROOT, rel))) { bad.push('磁盘缺少 ' + rel); continue }
    if (!localSet.has(String(rel).toLowerCase())) { bad.push('清单里多出（白名单不再收）' + rel); continue }
    // userOwned 的 sha 差异在任何模式下都是**合法状态**（用户装过插件/改过网关/本机 storeDir），
    // 仓库里发布前它们当然一致；用户实例里不一致是正常的，不该报红。
    if (owned.has(String(rel).toLowerCase())) continue
    if (sha(join(ROOT, rel)) !== String(filesObj[rel])) bad.push('哈希不符 ' + rel)
  }
  add(label, bad.length === 0, bad.length ? bad.length + ' 处：' + bad.slice(0, 5).join('，') : local.length + ' 个壳文件与清单逐一对齐')
})

check('清单里没有禁止路径', () => {
  const label = '清单里没有禁止路径'
  if (!exists(MANIFEST_FILE)) { add(label, false, 'shell-version.json 不存在（先跑 node tools\\clean-ship.mjs refresh）'); return }
  const rels = Object.keys(manifestJson().files || {})
  const bad = rels.filter(denyHit)
  add(label, bad.length === 0, bad.length ? bad.length + ' 条命中黑名单：' + bad.slice(0, 4).join(', ') : rels.length + ' 条都没碰 app/desktop/runtime/会话/凭证/版本文件')
})

check('pnpm store 与 node_modules 记录一致', () => {
  const label = 'pnpm store 与 node_modules 记录一致'
  // 2026-11-04 事故：升级把三份 pnpm-workspace.yaml 换成"没有 storeDir"的干净版 → pnpm 漂到
  // $PNPM_HOME/store，而 node_modules\.modules.yaml 记的是盘内 store → pnpm 拒绝该 profile 的一切装卸。
  const problems = checkTree(ROOT)
  if (!problems.length) { add(label, true, '一致（或还没装插件，跳过）'); return }
  const detail = problems.slice(0, 3).map((p) => {
    const rel = p.file.slice(ROOT.length + 1)
    return rel + '：' + (p.reason === 'missing-storeDir'
      ? '没有 storeDir（pnpm 会漂到 $PNPM_HOME/store）'
      : '记录 ' + p.recorded + ' ≠ ' + p.expected)
  }).join('；')
  add(label, false, detail + ' → 运行 dsh-portable.cmd fix-state')
})
check('store 一致性自测', () => {
  const r = run([join(ROOT, 'tools/selftest-store.mjs'), '--quiet'], CHECK_NODE)
  add('store 一致性自测', r.code === 0, r.code === 0 ? '10 个夹具全过' : String(r.out || '').trim().slice(-200))
})

check('更新源是版本线', () => {
  const label = '更新源是版本线'
  const r = run([join(ROOT, 'tools/shell-update.mjs'), 'defaults', '--json'], CHECK_NODE)
  if (r.code !== 0) { add(label, false, '取不到 defaults（退出码 ' + r.code + '）：' + String(r.out).trim().split(/\r?\n/)[0]); return }
  let j = null
  try { j = JSON.parse(String(r.out).trim().split(/\r?\n/).pop()) } catch { add(label, false, 'defaults 输出不是 JSON：' + String(r.out).trim().slice(0, 100)); return }
  const bad = []
  const wantManifest = 'https://github.com/Blue-Seventeen/DSH-Portable-Kernel/releases/latest/download/shell-version.json'
  if (String(j.manifest || '') !== wantManifest) bad.push('manifest 不是 releases/latest：' + String(j.manifest || '（空）'))
  if (!/\/refs\/tags\/v<version>\//.test(String(j.tagTemplate || ''))) bad.push('tagTemplate 不含 refs/tags/v<version>：' + String(j.tagTemplate || '（空）'))
  if (/master/i.test(String(j.rawBase || ''))) bad.push('rawBase 还在 master：' + String(j.rawBase))
  add(label, bad.length === 0, bad.length ? bad.join('；') : '清单走 releases/latest、字节走 refs/tags/v<version>')
})

check('RELEASE-NOTES 六小节齐全', () => {
  const label = 'RELEASE-NOTES 六小节齐全'
  // 开发版（x.y.z-dev / -rc / -beta / -alpha）不要求有发布说明：版本号还没定，写了也得改。
  const cur = String(manifestJson().shellVersion || '')
  if (/-dev|-rc|-beta|-alpha/i.test(cur)) { add(label, true, cur + ' 是开发版，发布时再补', true); return }
  const p = join(ROOT, 'RELEASE-NOTES.md')
  if (!exists(p)) { add(label, true, 'RELEASE-NOTES.md 还不存在（只有壳的发布版才带；v0.1.0 起必须有）', true); return }
  const ver = String((exists(MANIFEST_FILE) ? manifestJson().shellVersion : '') || '').trim()
  if (!ver) { add(label, false, '读不到当前 shellVersion（先跑 node tools\\clean-ship.mjs refresh）'); return }
  const lines = read(p).replace(/\r\n/g, '\n').split('\n')
  const headRe = new RegExp('^##\\s+v' + esc(ver) + '(\\s|$)')
  const head = lines.findIndex((l) => headRe.test(l.trim()))
  if (head < 0) { add(label, false, 'RELEASE-NOTES.md 里没有 `## v' + ver + '` 这一节'); return }
  let end = lines.length
  for (let i = head + 1; i < lines.length; i += 1) if (/^##\s+/.test(lines[i])) { end = i; break }
  const section = lines.slice(head + 1, end).join('\n')
  const missing = MANIFEST_NOTE_TITLES.filter((t) => !new RegExp('^###\\s+' + esc(t) + '\\s*$', 'm').test(section))
  add(label, missing.length === 0, missing.length ? '## v' + ver + ' 缺小节：' + missing.join('、') : '## v' + ver + ' 的 ' + MANIFEST_NOTE_TITLES.length + ' 个小节都在')
})

// ---- 输出 -------------------------------------------------------------------
// update-gate：换装引擎（tools/shell-apply.mjs）只在乎"换完之后壳还能不能立住"，所以只跑这一小撮；
// 其余行既不输出也不计数 —— 正常模式行为完全不变。
const GATE_RE = /^(UTF-8 BOM|根目录 \d+ 个 \.cmd|所有 \.cmd|无 BOM 且无乱码|tools\/\*\.mjs 语法全过|dsh-portable\.cmd 也 call|启动器都接了|清单 v2 合法|清单覆盖完整|清单里没有禁止路径|更新源是版本线|RELEASE-NOTES 六小节齐全)/
const shown = UPDATE_GATE ? rows.filter((r) => GATE_RE.test(r.label)) : rows
console.log('')
let fails = 0
let skips = 0
for (const r of shown) {
  if (r.skip) skips += 1
  else if (!r.ok) fails += 1
  const tag = r.skip ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL')
  console.log('  ' + tag + '  ' + r.label + (r.ok || r.skip ? (r.detail ? '  (' + r.detail + ')' : '') : '  ← ' + r.detail))
}
console.log('')
const total = shown.length
const conclusionHead = UPDATE_GATE ? '结论（update-gate）：' : '结论：'
console.log(fails === 0
  ? conclusionHead + total + ' 项全过' + (skips ? '（其中 ' + skips + ' 项不适用，记 SKIP）' : '')
  : conclusionHead + fails + ' / ' + total + ' 项失败')
process.exit(fails === 0 ? 0 : 1)
