#!/usr/bin/env node
/**
 * 清空插件商城的"操作历史"（安装/卸载记录）。
 *
 * 为什么需要它：商城的通知面板读的是 `<profile>\.dsh-market\drain.ndjson`（`drainJournal.recent(10)`），
 * 界面上的"关闭此提示"只关当次显示，服务端没有删除入口 —— 所以重启后又会被原样读出来
 * （2026-11-04 用户实测：清理多次，重启依旧在）。
 *
 * 本工具直接整理这些文件：
 *   - `drain.ndjson`：删除**已结束**的记录（succeeded / failed / cancelled），保留仍在进行中的；
 *     可用 `--keep N` 保留最近 N 条已结束记录（默认 0 = 全清）。
 *   - `pending-rows.json`：把 `operations` 清空（这是"上次排队失败"那类行）。
 *   - `--all` 额外把 `log.ndjson` 截断（详细日志；默认不动，便于排障）。
 *
 * 用法：
 *   node tools\market-history.mjs --check            # 只统计，不写盘
 *   node tools\market-history.mjs                    # 清理（默认两个 profile 都清）
 *   node tools\market-history.mjs --all --keep 3     # 连日志一起清，保留最近 3 条已完成记录
 *   node tools\market-history.mjs --profile desktop  # 只清桌面模式
 *
 * 退出码：0 成功（含"本来就是空的"）；1 失败。
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootArg = process.argv.indexOf('--root')
// --root：清另一个便携实例的历史（默认 = 本脚本所在的那份）
const ROOT = rootArg >= 0 ? resolve(process.argv[rootArg + 1]) : dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet')
const checkOnly = argv.includes('--check')
const all = argv.includes('--all')
const keepArg = argv.indexOf('--keep')
const keep = keepArg >= 0 ? Math.max(0, Number(argv[keepArg + 1]) || 0) : 0
const profArg = argv.indexOf('--profile')
const profSel = profArg >= 0 ? String(argv[profArg + 1] || 'all').toLowerCase() : 'all'

const say = (m) => { if (!quiet) console.log('  ' + m) }
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

const profiles = (profSel === 'all' ? ['web', 'desktop'] : [profSel]).filter((p) => p === 'web' || p === 'desktop')
const dirFor = (p) => join(ROOT, 'home', 'profiles', p, '.dsh-market')

/** 读 JSONL：返回 [{ raw, json|null }]；解析不了的坏行原样保留（不擅自删证据） */
const readJsonl = (file) => {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  return text.split(/\r?\n/).filter((l) => l.trim()).map((raw) => {
    try { return { raw, json: JSON.parse(raw) } } catch { return { raw, json: null } }
  })
}

const rewrite = (file, lines) => {
  const text = lines.map((l) => l.raw).join('\n') + (lines.length ? '\n' : '')
  try { copyFileSync(file, file + '.bak-' + stamp()) } catch { /* 备份失败也继续，下面有原子写 */ }
  const tmp = file + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

let totalRemoved = 0
let failed = 0
for (const p of profiles) {
  const dir = dirFor(p)
  const drainFile = join(dir, 'drain.ndjson')
  const pendingFile = join(dir, 'pending-rows.json')
  const logFile = join(dir, 'log.ndjson')
  if (!existsSync(dir)) { say('[' + p + '] 没有 .dsh-market，跳过'); continue }

  // ---- drain.ndjson ----
  if (existsSync(drainFile)) {
    const lines = readJsonl(drainFile)
    const done = lines.filter((l) => l.json && TERMINAL.has(String(l.json.state || '')))
    const keepSet = new Set(done.slice(Math.max(0, done.length - keep)).map((l) => l.raw))
    const rest = lines.filter((l) => !done.includes(l) || keepSet.has(l.raw))
    const removed = done.length - keepSet.size
    if (checkOnly) {
      say('[' + p + '] drain.ndjson：共 ' + lines.length + ' 条，可清 ' + removed + ' 条（保留进行中 ' + (lines.length - done.length) + ' 条' + (keep ? '，另留最近 ' + keep + ' 条' : '') + '）')
    } else if (removed > 0) {
      rewrite(drainFile, rest)
      totalRemoved += removed
      say('[' + p + '] drain.ndjson：清掉 ' + removed + ' 条历史（剩 ' + rest.length + ' 条）')
    } else {
      say('[' + p + '] drain.ndjson：没有可清的记录')
    }
  }

  // ---- pending-rows.json（"上次排队失败"的行）----
  if (existsSync(pendingFile)) {
    let j = null
    try { j = JSON.parse(readFileSync(pendingFile, 'utf8')) } catch { j = null }
    const n = j && Array.isArray(j.operations) ? j.operations.length : 0
    if (checkOnly) {
      say('[' + p + '] pending-rows.json：' + n + ' 条待处理行')
    } else if (n > 0) {
      try { copyFileSync(pendingFile, pendingFile + '.bak-' + stamp()) } catch { /* 忽略 */ }
      writeFileSync(pendingFile, JSON.stringify({ version: 1, operations: [] }, null, 2) + '\n', 'utf8')
      totalRemoved += n
      say('[' + p + '] pending-rows.json：清掉 ' + n + ' 条')
    }
  }

  // ---- log.ndjson（--all 才动）----
  if (all && existsSync(logFile)) {
    if (checkOnly) say('[' + p + '] log.ndjson：' + (readJsonl(logFile).length) + ' 条（--all 会截断）')
    else {
      try { copyFileSync(logFile, logFile + '.bak-' + stamp()) } catch { /* 忽略 */ }
      writeFileSync(logFile, '', 'utf8')
      say('[' + p + '] log.ndjson：已清空')
    }
  }
}

if (checkOnly) { say('（--check：一个字节都没写）'); process.exit(0) }
if (totalRemoved > 0) say('完成：共清掉 ' + totalRemoved + ' 条；重启商城后不会再显示（备份为同名 .bak-<时间戳>）')
else say('完成：没有需要清理的记录')
process.exit(failed ? 1 : 0)
