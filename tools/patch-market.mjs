#!/usr/bin/env node
/**
 * 给 dshmarket（插件市场）打“共享安装”补丁。
 *
 * 背景：便携版用 modulesDir 把插件装到 home\profiles\node_modules，而市场判断“装成功没有”
 * 用的是固定路径 <profile>\node_modules\<包名>（dshmarket/lib/install.js:854 等）。
 * 找不到就判定“没有 dsh manifest / 缺构建产物”，自己 pnpm remove 掉刚装好的包，
 * 最终报 MUTATION_FAILED。补丁让这些查找在“直接路径不存在”时向上找一级共享目录。
 * 市场自身代码里已有同类先例（hasLoadableEntry 的工作区根回退，#203）。
 *
 * 安全：老结构（各 profile 自己装）下直接路径一定存在，回退永不触发，行为不变。
 * 幂等：打过就跳过。升级 dshmarket 会覆盖 lib\*.js，启动器每次启动自动重打。
 *
 * 用法：node tools\patch-market.mjs [--check|--revert|--force] [--quiet]
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const revert = argv.includes('--revert')
const force = argv.includes('--force')
const quiet = argv.includes('--quiet')
const say = (m) => console.log((quiet ? '' : '  ') + m)
const MARKER = '/* [portable-shared] 共享安装回退（由 tools\\patch-market.mjs 生成，勿手改） */'

/* ------------------------------------------------ 第二族补丁：drain 占用语义 */
/**
 * dshmarket 1.73.6 的 drain（#411 的维护边界）在「排队等别的会话空闲」期间就把空闲
 * Agent 全部 claim 住了。claim = Agent.runMaintenance()，DSH 会把该会话之后收到的消息
 * 只放进 next-turn 队列（latch）而不开回合 —— 用户看到的就是「会话暂停」。
 *
 * 实测（2026-11-04）：12:23:42 入队的 dsh-skills-manager 安装一直等到 13:05；
 * 期间 cf3c85c6 在 12:32:08 收到的「你好」没有开回合；13:05:30.643 用户取消排队，
 * 同一秒 turn/start。等待期被占用的空闲会话 = 根因。
 *
 * 修法：维护占用只属于「提交边界」。等待期间一个都不占；全员空闲时再一次性 claim
 * （抢不到就回到等待）。改写文件期间仍然占住全部 Agent —— 那是 #199 的安全不变量。
 */
const DRAIN_MARKER = '/* [portable-drain]'
/** 三段锚点替换：原文 → 新文（都是 dshmarket 1.73.6 的逐字原文，升级后失配要重建） */
const DRAIN_HUNKS = [
  {
    id: 'D1',
    from: [
      '            const unheld = afterClaims.filter(agent => !this.holds.has(agent.id));',
      '            if (unheld.length === 0 && request.forceDeferred !== true) {',
      '                return await this.runInline(operation);',
      '            }',
    ],
    to: [
      '            const unheld = afterClaims.filter(agent => !this.holds.has(agent.id));',
      '            if (unheld.length === 0 && request.forceDeferred !== true) {',
      '                return await this.runInline(operation);',
      '            }',
      '            ' + DRAIN_MARKER + ' 推迟执行的请求还要等别的会话空闲；等待期间不能攥着空闲 Agent',
      '               的维护占用 —— 占用会让它们的 inbox 只入队、不开回合（用户看到的就是',
      '               “会话暂停”）。占用只属于提交边界：drainAgents 全员空闲那一遍。 */',
      '            this.releaseAll();',
    ],
  },
  {
    id: 'D2',
    from: [
      '            let claimed = 0;',
      '            for (const agent of unheld) {',
      '                if (operation.cancelRequested || this.disposeRequested)',
      '                    break;',
      '                if (this.claim(agent))',
      '                    claimed += 1;',
      '            }',
      '            const current = this.liveAgents();',
      '            if (current === null)',
      '                return false;',
      '            const remaining = current.filter(agent => !this.holds.has(agent.id));',
      '            this.setWait(operation, remaining);',
      '            if (remaining.length === 0)',
      '                return true;',
      '            const waitingForTurn = remaining.some(agent => agent.status === \'running\');',
      '            const activity = this.waitForActivity();',
      '            try {',
      '                await Promise.race([',
      '                    Promise.all(remaining.map(agent => agent.whenIdle().catch(() => undefined))),',
      '                    activity.promise,',
      '                ]);',
      '            }',
      '            finally {',
      '                activity.dispose();',
      '            }',
      '            // A claim can fail without the Agent being busy (another maintenance',
      '            // task owns it). `whenIdle` then stays pending, so this yield only',
      '            // matters for a host that reports idle while refusing the claim. A',
      '            // turn that just ended retries immediately.',
      '            if (claimed === 0 && !waitingForTurn)',
      '                await new Promise(resolve => setTimeout(resolve, 25));',
    ],
    to: [
      '            ' + DRAIN_MARKER + ' 只在「全员都空闲」的提交边界上 claim。等待期间一个都不占：',
      '               占用会 latch 新消息，用户看到的就是别的会话被商城排队操作冻住。 */',
      '            const busyNow = unheld.filter(agent => agent.status === \'running\');',
      '            if (busyNow.length > 0) {',
      '                const activity = this.waitForActivity();',
      '                try {',
      '                    await Promise.race([',
      '                        Promise.all(busyNow.map(agent => agent.whenIdle().catch(() => undefined))),',
      '                        activity.promise,',
      '                    ]);',
      '                }',
      '                finally {',
      '                    activity.dispose();',
      '                }',
      '                continue;',
      '            }',
      '            let claimed = 0;',
      '            for (const agent of unheld) {',
      '                if (operation.cancelRequested || this.disposeRequested)',
      '                    break;',
      '                if (this.claim(agent))',
      '                    claimed += 1;',
      '            }',
      '            const current = this.liveAgents();',
      '            if (current === null)',
      '                return false;',
      '            const remaining = current.filter(agent => !this.holds.has(agent.id));',
      '            this.setWait(operation, remaining);',
      '            if (remaining.length === 0)',
      '                return true;',
      '            ' + DRAIN_MARKER + ' 抢不到只可能是另一个维护任务占着它（它的 whenIdle 要等',
      '               那边结束才 resolve），让一次行，避免热转。 */',
      '            if (claimed === 0)',
      '                await new Promise(resolve => setTimeout(resolve, 25));',
    ],
  },
  {
    id: 'D3',
    from: [
      '        const active = this.active;',
      '        if (active !== null && !active.settled) {',
      '            const claimed = this.claim(drainable);',
    ],
    to: [
      '        const active = this.active;',
      '        ' + DRAIN_MARKER + ' 等待期新建的会话要能正常开第一回合：只有进入提交/改写',
      '           阶段才在它开回合前占用它。 */',
      '        if (active !== null && !active.settled',
      '            && (active.state === \'queued-for-mutation\' || active.state === \'running\' || active.state === \'verifying\')) {',
      '            const claimed = this.claim(drainable);',
    ],
  },
]
const lines = (arr) => arr.join('\n')
/** 幂等套用：已含新文的跳过；找不到原文的记为「失配」（市场升级改版时会这样） */
const drainPatch = (text) => {
  let out = text
  const applied = []
  const missing = []
  for (const h of DRAIN_HUNKS) {
    const from = lines(h.from)
    const to = lines(h.to)
    if (out.includes(to)) { applied.push(h.id); continue }
    if (!out.includes(from)) { missing.push(h.id); continue }
    out = out.replace(from, to)
    applied.push(h.id)
  }
  return { text: out, applied, missing }
}

/**
 * 失败时除了打印，还写一行到 logs\patch-market.err。
 * 启动器是用 --quiet 静默调用的：补丁没打上时黑框一闪而过没人看见，
 * 等到"市场装插件失败"才暴露就太晚了，所以留一份可查的记录。
 */
const fail = (m) => {
  console.error('  ' + m)
  // --check 是只读模式：不能写日志，否则 doctor（内部调 --check）就不是只读的了。
  if (argv.includes('--check')) return
  try {
    const dir = join(root, 'logs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'patch-market.err')
    if (existsSync(file) && readFileSync(file, 'utf8').length > 65536) writeFileSync(file, '', 'utf8')
    // 新建/被清空时先写 BOM：记事本和 Windows PowerShell 5.1 看到无 BOM 的 UTF-8 会显示乱码
    const fresh = !existsSync(file) || readFileSync(file, 'utf8').length === 0
    writeFileSync(file, (fresh ? '\uFEFF' : '') + '[' + new Date().toISOString() + '] ' + m + '\n', { encoding: 'utf8', flag: 'a' })
  } catch { /* 日志写不了不影响主流程 */ }
}

const helper = () => [
  '',
  MARKER,
  '/**',
  ' * 取某个包在磁盘上的目录。',
  ' * 正常是 <profileDir>\\node_modules\\<name>；便携版用 modulesDir 把包装在同级共享目录',
  ' * （home\\profiles\\node_modules）时，向上找一级，让市场的“装后校验”也能认出它。',
  ' */',
  'export function profilePackageDir(profileDirectory, name) {',
  "    const direct = join(profileDirectory, 'node_modules', name);",
  '    if (existsSync(direct))',
  '        return direct;',
  "    const shared = join(dirname(profileDirectory), 'node_modules', name);",
  '    return existsSync(shared) ? shared : direct;',
  '}',
  '',
].join('\n')

const candidates = [
  join(root, 'home', 'profiles', 'node_modules', 'dshmarket'),
  join(root, 'home', 'profiles', 'desktop', 'node_modules', 'dshmarket'),
  join(root, 'home', 'profiles', 'web', 'node_modules', 'dshmarket'),
]
const marketDir = candidates.find((d) => existsSync(join(d, 'package.json')))
const marketVersion = marketDir ? JSON.parse(readFileSync(join(marketDir, 'package.json'), 'utf8')).version : 'unknown'
// 按版本保存一份“打补丁前”的原件：重复打/强制重打都只写一次，绝不拿打完的文件覆盖原件。
// 升级 dshmarket 后版本号变化 → 新目录 → 重新留一份纯净备份。
const backupRoot = join(root, 'cache', 'market-pristine-' + marketVersion)
const backupOf = (file) => join(backupRoot, file.slice(marketDir.length + 1).replace(/[\\/]/g, '_'))
const manifestFile = join(backupRoot, 'manifest.json')
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
const readManifest = () => {
  try { return JSON.parse(readFileSync(manifestFile, 'utf8')) } catch { return { version: marketVersion, files: {} } }
}
const writeManifest = (m) => { try { mkdirSync(dirname(manifestFile), { recursive: true }); writeFileSync(manifestFile, JSON.stringify(m, null, 2) + '\n', 'utf8') } catch { } }
const keepOriginal = (file) => {
  const to = backupOf(file)
  const rel = file.slice(marketDir.length + 1).replace(/\\/g, '/')
  if (!existsSync(to)) {
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(file, to)
  }
  // manifest 记住"扁平备份名 → 原始相对路径 + 哈希"：
  // ① 扁平化会把 lib\foo_bar.js 和 lib\foo\bar.js 撞成同一个名字，靠清单才能还原回正确位置；
  // ② 还原前校验哈希，避免拿被改过的备份覆盖当前版本。
  const m = readManifest()
  if (!m.files) m.files = {}
  if (!m.files[rel]) {
    m.files[rel] = { backup: rel.replace(/[\\/]/g, '_'), sha256: sha256(to), bytes: statSync(to).size }
    writeManifest(m)
  }
}
const listJs = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? listJs(join(dir, d.name)) : d.name.endsWith('.js') ? [join(dir, d.name)] : [])

/** 首参可以是标识符、成员表达式，或一层函数调用（profileDir(profile, explicitDir) 这类） */
const DIR = '([A-Za-z_$][\\w$.]*(?:\\((?:[^()]|\\([^()]*\\))*\\))?)'

/** 只改“取包目录”的写法；首参是字符串字面量、包名是作用域（@scope/…）的一律不动 */
const transformOnce = (text, counter) => {
  text = text.replace(
    new RegExp('join\\(\\s*' + DIR + "\\s*,\\s*'node_modules'\\s*,\\s*([A-Za-z_$][\\w$.]*)\\s*,\\s*('[^']*')\\s*\\)", 'g'),
    (m, dir, name, file) => {
      if (name.startsWith('@')) return m
      counter.n++
      return 'join(profilePackageDir(' + dir + ', ' + name + '), ' + file + ')'
    },
  )
  text = text.replace(
    new RegExp('join\\(\\s*' + DIR + "\\s*,\\s*'node_modules'\\s*,\\s*([A-Za-z_$][\\w$.]*)\\s*\\)", 'g'),
    (m, dir, name) => {
      if (dir === 'node_modules' || name.startsWith('@')) return m
      counter.n++
      return 'profilePackageDir(' + dir + ', ' + name + ')'
    },
  )
  // 第三种形状（hot.js:67）：join(dir, 'node_modules', ...name.split('/'))
  // 数组展开没法直接套 profilePackageDir(dir, name)，但两者语义等价于"包目录根"，所以映射成一层调用。
  text = text.replace(
    new RegExp('join\\(\\s*' + DIR + "\\s*,\\s*'node_modules'\\s*,\\s*\\.\\.\\.\\s*([A-Za-z_$][\\w$.]*)\\.split\\(\\s*'/'\\s*\\)\\s*\\)", 'g'),
    (m, dir, name) => {
      if (name.startsWith('@')) return m
      counter.n++
      return 'profilePackageDir(' + dir + ', ' + name + ')'
    },
  )
  return text
}

/**
 * 对整份文件做替换，但跳过 helper 自身函数体：否则 helper 里的 join(...) 会被改成调用自己，无限递归。
 */
const transform = (text) => {
  const counter = { n: 0 }
  const at = text.indexOf('/* [portable-shared]')
  if (at < 0) return { text: transformOnce(text, counter), changed: counter.n }
  const endAt = text.indexOf('\n}\n', at)
  const cut = endAt < 0 ? text.length : endAt + 3
  const head = transformOnce(text.slice(0, at), counter)
  const tail = transformOnce(text.slice(cut), counter)
  return { text: head + text.slice(at, cut) + tail, changed: counter.n }
}

const ensureImport = (text) => {
  const imports = text.split('\n').filter((l) => /^import /.test(l)).join('\n')
  if (/\bprofilePackageDir\b/.test(imports)) return text
  const line = text.match(/^import \{[^}]*\} from '\.\/profile\.js';?$/m)
  if (line) return text.replace(line[0], line[0].replace('import {', 'import { profilePackageDir,'))
  const at = text.indexOf('import ')
  return at < 0 ? text : text.slice(0, at) + "import { profilePackageDir } from './profile.js';\n" + text.slice(at)
}

/**
 * 扫一遍 lib，算出"还剩多少处没打"（只在内存里算，不写盘）。
 * 为什么要这样判：只看 profile.js 里的 marker 会漏判 —— 某次写盘中途中止、或市场自更新只覆盖了
 * 部分文件后，profile.js 有 marker 而别的文件还是原文，脚本就会说"补丁已在，无需改动"，
 * 结果那几条路径（安装后校验、卸载清理、热加载…）照样失效，且没人发现。
 */
const scanPending = () => {
  const libDir = join(marketDir, 'lib')
  const pending = []
  for (const file of listJs(libDir)) {
    const src = readFileSync(file, 'utf8')
    if (!src.includes("'node_modules'") && !src.includes('profilePackageDir')) continue
    const r = transform(src)
    if (r.changed > 0) pending.push({ file, changed: r.changed })
  }
  return pending
}

/** 打完补丁后仍然"改不动"的 'node_modules' 字面量（只作信息，不阻断）：下次市场升级新增写法时能立刻看见 */
const scanUncovered = () => {
  const libDir = join(marketDir, 'lib')
  const out = []
  for (const file of listJs(libDir)) {
    const src = readFileSync(file, 'utf8')
    if (!src.includes("'node_modules'")) continue
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("'node_modules'")) continue
      if (transform(lines[i]).changed > 0) continue
      out.push({ file: file.slice(marketDir.length + 1), line: i + 1 })
    }
  }
  return out
}

const main = () => {
  if (!marketDir) { fail('没找到 dshmarket（插件市场没装？）'); return 1 }
  const version = JSON.parse(readFileSync(join(marketDir, 'package.json'), 'utf8')).version
  const profileJs = join(marketDir, 'lib', 'profile.js')
  if (!existsSync(profileJs)) { fail('没找到 lib\\profile.js，放弃（未改任何文件）'); return 1 }
  const pending = scanPending()
  const complete = pending.length === 0
  // drain 语义补丁：与路径补丁互相独立，各自报告
  const drainFile = join(marketDir, 'lib', 'drain.js')
  const drainSrc = existsSync(drainFile) ? readFileSync(drainFile, 'utf8') : null
  const drained = drainSrc === null ? { text: null, applied: [], missing: ['no-drain.js'] } : drainPatch(drainSrc)
  const drainComplete = drainSrc !== null && drained.missing.length === 0 && drained.text === drainSrc
  const drainText = drainSrc === null
    ? 'drain 语义补丁：缺 lib\\drain.js'
    : drainComplete
      ? 'drain 语义补丁：已打 ' + DRAIN_HUNKS.length + '/' + DRAIN_HUNKS.length
      : drained.missing.length
        ? 'drain 语义补丁：锚点失配（' + drained.missing.join(',') + '）'
        : 'drain 语义补丁：未打（可套用 ' + drained.applied.length + '/' + DRAIN_HUNKS.length + '）'

  if (checkOnly) {
    const unc = scanUncovered()
    const uncText = unc.map((u) => u.file + ':' + u.line).join(', ')
    const tail = unc.length ? ('；另有 ' + unc.length + ' 处未覆盖的 node_modules 引用（' + uncText + '）') : ''
    const sitesNow = () => listJs(join(marketDir, 'lib')).reduce((a, f) => a + (readFileSync(f, 'utf8').match(/profilePackageDir\(/g) || []).length, 0)
    if (complete && drainComplete) { say('dshmarket ' + version + '，补丁：已打（字面 ' + sitesNow() + ' 处 = 1 定义 + ' + (sitesNow() - 1) + ' 调用点）；' + drainText + tail); return 0 }
    if (complete) { say('dshmarket ' + version + '，补丁：已打；' + drainText); return 1 }
    const left = pending.reduce((a, b) => a + b.changed, 0)
    say('dshmarket ' + version + '，补丁：不完整，还剩 ' + left + ' 处（' + pending.map((p) => p.file.slice(marketDir.length + 1)).join(', ') + '）；' + drainText)
    // 退出码必须有鉴别力：只看文本的门禁（含 doctor 的提示）才不会被"半打"骗过去
    return 1
  }
  if (revert) {
    if (!existsSync(backupRoot)) { fail('没有 ' + marketVersion + ' 的纯净备份'); return 1 }
    const m = readManifest()
    const entries = Object.entries(m.files || {})
    const bad = []
    let n = 0
    if (entries.length) {
      // 有清单：按"相对路径 + 哈希"还原，扁平名歧义和"备份被改过"都能挡住
      for (const [rel, info] of entries) {
        const src = join(backupRoot, info.backup)
        if (!existsSync(src)) { bad.push(rel + '(备份文件缺失)'); continue }
        if (sha256(src) !== info.sha256) { bad.push(rel + '(备份哈希不符)'); continue }
        copyFileSync(src, join(marketDir, rel))
        n++
      }
    } else {
      // 老备份没有清单：退回按扁平名推断（下划线→反斜杠），并且事后要重跑 --check
      for (const f of readdirSync(backupRoot)) {
        if (f === 'manifest.json') continue
        copyFileSync(join(backupRoot, f), join(marketDir, f.replace(/_/g, '\\')))
        n++
      }
    }
    if (bad.length) { fail('还原不完整：' + bad.join(', ')); return 1 }
    const left = scanPending()
    say('已用 cache\\market-pristine-' + marketVersion + ' 还原 ' + n + ' 个文件（含 lib\\drain.js 的语义补丁，若已打过）')
    say('  还原后仍有 ' + left.reduce((a, b) => a + b.changed, 0) + ' 处是原文（预期：现在跑 fix-market 会重新打上）')
    return 0
  }
  if (complete && drainComplete && !force) { if (!quiet) say('dshmarket ' + version + '：补丁已在，无需改动（' + drainText + '）'); return 0 }

  mkdirSync(backupRoot, { recursive: true })
  // 关键顺序：先对原文做替换，再插入 helper —— 否则 helper 自己的函数体会被改写，导致无限递归
  let text = readFileSync(profileJs, 'utf8')
  const profileWasPristine = !text.includes(MARKER)
  if (!profileWasPristine) { if (!quiet) say('profile.js 已有 helper，仅补齐调用点') }
  const r0 = transform(text)
  text = r0.text
  if (!text.includes(MARKER)) {
    const anchor = text.match(/^import .*from 'node:path';$/m)
    if (!anchor) { fail('profile.js 结构不符（找不到 node:path 引入），放弃；市场可能升级改版了，请跑 dsh-portable.cmd repair 并反馈'); return 1 }
    text = text.replace(anchor[0], anchor[0] + '\n' + helper())
  }
  // 只有本来就是原文时才留备份；否则会拿"已打补丁的文件"当纯净原件，以后 --revert 就还原不回去了
  if (profileWasPristine) keepOriginal(profileJs)
  writeFileSync(profileJs, text, 'utf8')
  if (!quiet) say('已改 lib\\profile.js（' + r0.changed + ' 处）')

  const libDir = join(marketDir, 'lib')
  let files = 0, sites = r0.changed
  const touched = [profileJs]
  for (const file of listJs(libDir)) {
    if (file === profileJs) continue
    const src = readFileSync(file, 'utf8')
    const r = transform(src)
    if (!r.changed) continue
    if (!src.includes('profilePackageDir(')) keepOriginal(file)
    writeFileSync(file, ensureImport(r.text), 'utf8')
    touched.push(file)
    files++; sites += r.changed
    if (!quiet) say('已改 lib\\' + file.slice(libDir.length + 1) + '（' + r.changed + ' 处）')
  }

  // 只对改动过的文件做语法自检（全量自检要多花 8 秒；这里 9 个文件约 1 秒）
  const bad = []
  for (const file of touched) {
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }) } catch { bad.push(file) }
  }
  if (bad.length) {
    fail('语法自检失败，已还原：' + bad.map((f) => f.slice(marketDir.length + 1)).join(', '))
    if (existsSync(backupRoot)) for (const f of readdirSync(backupRoot)) copyFileSync(join(backupRoot, f), join(marketDir, f.replace(/_/g, '\\')))
    return 1
  }
  // 收尾复核：补丁必须"一处不剩"，否则宁可还原并报错，也不留半打状态
  const left = scanPending()
  if (left.length) {
    fail('补丁没覆盖全部调用点，残留 ' + left.reduce((a, b) => a + b.changed, 0) + ' 处：' + left.map((p) => p.file.slice(marketDir.length + 1)).join(', ') + '（已还原成原文）')
    if (existsSync(backupRoot)) for (const f of readdirSync(backupRoot)) copyFileSync(join(backupRoot, f), join(marketDir, f.replace(/_/g, '\\')))
    return 1
  }
  // drain 语义补丁：与路径补丁分开写，失配时只回滚 drain.js（路径补丁继续有效）
  let drainSites = 0
  if (!drainComplete && drainSrc !== null) {
    if (drained.missing.length) {
      fail('drain.js 结构不符（锚点失配：' + drained.missing.join(',') + '），未改 lib\\drain.js。市场升级改版后需要重建这三段；'
        + '在此期间商城排队仍会冻结空闲会话（其它补丁不受影响）')
      return 1
    }
    keepOriginal(drainFile)
    writeFileSync(drainFile, drained.text, 'utf8')
    try { execFileSync(process.execPath, ['--check', drainFile], { stdio: 'pipe' }) } catch {
      try { copyFileSync(backupOf(drainFile), drainFile) } catch { /* 备份不可用时保持原样，下面的 fail 会提醒 */ }
      fail('drain 语义补丁语法自检失败，已还原 lib\\drain.js')
      return 1
    }
    drainSites = drained.applied.length
    if (!quiet) say('已改 lib\\drain.js（' + drainSites + ' 处语义：等待期不再占用空闲 Agent）')
  }
  const sitesFinal = listJs(libDir).reduce((a, f) => a + (readFileSync(f, 'utf8').match(/profilePackageDir\(/g) || []).length, 0)
  say('补丁完成：dshmarket ' + version + '，' + (files + 1) + ' 个文件、字面 ' + sitesFinal + ' 处（1 定义 + ' + (sitesFinal - 1) + ' 调用点）；'
    + (drainComplete ? drainText : 'drain 语义补丁：已打 ' + DRAIN_HUNKS.length + '/' + DRAIN_HUNKS.length)
    + '（原件备份 cache\\market-pristine-' + marketVersion + '）')
  return 0
}
try {
  process.exit(main())
} catch (e) {
  fail('补丁过程异常：' + (e && e.message ? e.message : String(e)))
  process.exit(1)
}