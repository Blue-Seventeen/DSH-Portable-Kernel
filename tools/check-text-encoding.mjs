#!/usr/bin/env node
/**
 * 文本编码审计：检查"发布出去的文字"里有没有被转码的乱码。
 *
 * 背景（2026-11-05）：0.4.2 的说明提交信息被 Set-Content -Encoding ascii 写成替换问号，
 * 在 GitHub 历史里很难看。文件哈希检查发现不了这种问题，必须单独查。
 *
 * 检查项：
 *   1. 最近 N 条提交标题：不得含连续 3 个以上问号，不得含 U+FFFD
 *   2. 所有 tag 注释：同上
 *   3. 已跟踪的文本文件（md/json/mjs/ps1/cmd）：不得含 U+FFFD
 *
 * 用法：node tools\check-text-encoding.mjs [--json] [--limit 200]
 * 退出码：0 干净；1 发现问题；4 不是 git 仓库（跳过）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const argv = process.argv.slice(2)
const jsonMode = argv.includes('--json')
const limIdx = argv.indexOf('--limit')
const LIMIT = limIdx >= 0 ? Math.max(1, Number(argv[limIdx + 1]) || 200) : 200
// 用字符码拼正则，避免本文件自己出现"连续问号"字样
const Q = String.fromCharCode(63)
const BAD = new RegExp('\\' + Q + '{3,}|\\uFFFD')

if (!existsSync(join(ROOT, '.git'))) {
  if (jsonMode) process.stdout.write(JSON.stringify({ ok: true, skipped: 'not-a-git-repo' }) + '\n')
  else console.log('跳过：当前目录不是 git 仓库')
  process.exit(4)
}

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch { return '' }
}

const problems = []
// 默认只查"最近一个 v* tag 之后"的提交：历史旧账不重复报红；--all 才扫全量。
const allMode = argv.includes('--all')
let range = ''
if (!allMode) {
  const lastTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*']).trim()
  if (lastTag) range = lastTag + '..HEAD'
}

const logArgs = range ? ['log', range, '--pretty=format:%h %s'] : ['log', '-' + LIMIT, '--pretty=format:%h %s']
const log = git(logArgs)
for (const line of log.split('\n').filter(Boolean)) {
  const hash = line.split(' ')[0]
  const subject = line.slice(hash.length + 1)
  if (BAD.test(subject)) problems.push({ kind: 'commit', id: hash, text: subject })
}

const tags = git(['for-each-ref', 'refs/tags', '--format=%(refname:short) %(subject)'])
for (const line of tags.split('\n').filter(Boolean)) {
  const name = line.split(' ')[0]
  const subject = line.slice(name.length + 1)
  if (BAD.test(subject)) problems.push({ kind: 'tag', id: name, text: subject })
}

const tracked = git(['ls-files', '*.md', '*.json', '*.mjs', '*.ps1', '*.cmd']).split('\n').filter(Boolean)
for (const rel of tracked) {
  try {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    if (text.includes('\uFFFD')) problems.push({ kind: 'file', id: rel, text: '含 U+FFFD（不是合法 UTF-8）' })
  } catch { /* 读不了就跳过 */ }
}

if (jsonMode) {
  process.stdout.write(JSON.stringify({ ok: problems.length === 0, total: problems.length, problems }) + '\n')
} else if (problems.length === 0) {
  console.log('OK：提交信息 / tag 注释 / 文本文件 均无乱码（' + (range ? ('范围 ' + range) : LIMIT + ' 条提交') + '、' + tags.split('\n').filter(Boolean).length + ' 个 tag）')
} else {
  console.log('FAIL：发现 ' + problems.length + ' 处乱码')
  for (const p of problems) console.log('  [' + p.kind + '] ' + p.id + '：' + p.text)
}
process.exit(problems.length === 0 ? 0 : 1)
