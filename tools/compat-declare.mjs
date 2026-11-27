/**
 * 维护"兼容性活声明"（compat.json）——放开壳支持的内核版本，**不发新壳**。
 *
 * 典型流程（官方发了新 rc，而我们打补丁的文件没动）：
 *
 *   node tools\compat-declare.mjs --check
 *       # 看 npm 上最新内核，比当前的声明；告诉你差了哪些版本
 *   node tools\compat-declare.mjs --verify 0.2.2-rc.6
 *       # 只下两个被打补丁的包，比对 lib/index.js 的哈希；一致才算"核实通过"
 *   node tools\compat-declare.mjs --allow 0.2.2-rc.6
 *       # 把该版本加进 verified 并推进上界（--verify 没过会拒绝）
 *   node tools\compat-declare.mjs --push
 *       # 提交并推送 compat.json（用户下次联网就生效，不用重装壳）
 *
 * 为什么只改这个文件就够：壳的职责（便携化/启动）与内核版本无关，真正绑内核的只有三族补丁；
 * 补丁锚点只要没被上游动过，放开上界就是安全的。--verify 就是在替你确认这一点。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSimpleRange, unionRange, validateCompat } from './compat-live.mjs'
import { satisfiesRange } from './version-range.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FILE = join(ROOT, 'compat.json')
const REG = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh'

const say = (s) => console.log(s)
const read = () => JSON.parse(readFileSync(FILE, 'utf8'))
const write = (o) => writeFileSync(FILE, JSON.stringify(o, null, 2) + '\n', 'utf8')
const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : '' }

const cmpVer = (a, b) => {
  const split = (v) => String(v).trim().split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  const x = split(a), y = split(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i], q = y[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = typeof p === 'number', qn = typeof q === 'number'
    if (pn && qn) { if (p !== q) return p < q ? -1 : 1; continue }
    if (pn !== qn) return pn ? 1 : -1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

const npmLatest = async () => {
  const r = await fetch(REG, { headers: { accept: 'application/vnd.npm.install-v1+json' } })
  if (!r.ok) throw new Error('registry HTTP ' + r.status)
  const j = await r.json()
  const tags = j['dist-tags'] || {}
  return { latest: tags.latest || '', next: tags.next || '', all: Object.keys(j.versions || {}) }
}

/** 下载某个包某版本，返回 lib/index.js 的 sha256 前 16 位；拿不到返回 null */
const fetchPatched = async (pkg, version) => {
  const name = pkg.split('/')[1]
  const url = 'https://registry.npmjs.org/@deepseek-ai%2F' + name + '/-/' + name + '-' + version + '.tgz'
  const tmp = join(ROOT, 'tmp', 'compat-verify', name + '-' + version)
  const tgz = join(tmp, 'pkg.tgz')
  try {
    execFileSync(process.execPath, ['-e', '1'], { stdio: 'ignore' }) // 只用来快速验证 node 可用
    if (!existsSync(tgz)) {
      const r = await fetch(url)
      if (!r.ok) return null
      const fs = await import('node:fs')
      fs.mkdirSync(tmp, { recursive: true })
      fs.writeFileSync(tgz, Buffer.from(await r.arrayBuffer()))
    }
    const out = join(tmp, 'package')
    if (!existsSync(out)) execFileSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: 'ignore' })
    const f = join(out, 'lib', 'index.js')
    if (!existsSync(f)) return null
    return createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16)
  } catch { return null }
}

const main = async () => {
  const cur = read()
  const v = validateCompat(cur, { localShell: '99.99.99' })
  if (!v.ok) { say('compat.json 自身不合法：' + v.error); return 1 }

  if (flag('--check') || argv.length === 0) {
    const { latest, next, all } = await npmLatest()
    const r = parseSimpleRange(cur.dsh.range)
    say('  当前声明 : ' + cur.dsh.range)
    say('  npm latest: ' + latest + '   next: ' + next)
    const missing = [...new Set([latest, next])].filter((x) => x && !satisfiesRange(x, cur.dsh.range))
    if (!missing.length) { say('  => 已覆盖最新内核，无需改动'); return 0 }
    say('  => 未覆盖：' + missing.join(', '))
    for (const m of missing) {
      const known = cur.dsh.verified.includes(m)
      say('     ' + m + (known ? '（已验证过，只是上界没推）' : '（未验证：先跑 --verify ' + m + '）'))
    }
    say('  下一步：node tools\\compat-declare.mjs --verify ' + missing[0])
    return 2
  }

  if (flag('--verify')) {
    const target = val('--verify')
    if (!target) { say('用法：--verify <版本>'); return 2 }
    const pkgs = Object.keys(cur.patchedFiles || {})
    if (!pkgs.length) { say('compat.json 里没有 patchedFiles，无法核实'); return 2 }
    let allSame = true
    for (const p of pkgs) {
      const want = String(cur.patchedFiles[p] || '').slice(0, 16)
      const got = await fetchPatched(p, target)
      const same = got && got === want
      if (!same) allSame = false
      say('  ' + (same ? 'OK  ' : 'DIFF') + ' ' + p + '  ' + target + '  ' + (got || '(取不到)') + (same ? '' : '  ← 期望 ' + want))
    }
    if (!allSame) {
      say('')
      say('  结论：该版本改动了我们打补丁的文件 —— 不能只改声明，必须适配补丁并重发壳。')
      return 3
    }
    say('')
    say('  结论：补丁锚点未受影响，可以安全放开到 ' + target + '。')
    say('  下一步：node tools\\compat-declare.mjs --allow ' + target)
    return 0
  }

  if (flag('--allow')) {
    const target = val('--allow')
    if (!target) { say('用法：--allow <版本>'); return 2 }
    const pkgs = Object.keys(cur.patchedFiles || {})
    for (const p of pkgs) {
      const want = String(cur.patchedFiles[p] || '').slice(0, 16)
      const got = await fetchPatched(p, target)
      if (got !== want) {
        say('  拒绝：' + p + ' 在 ' + target + ' 上与我们记录的不一致（' + (got || '取不到') + '）。')
        say('  先适配补丁并重发壳，别只改声明。')
        return 3
      }
    }
    const verified = [...new Set([...(cur.dsh.verified || []), target])].sort(cmpVer)
    const r = parseSimpleRange(cur.dsh.range)
    const ceil = !r.ceil || cmpVer(target, r.ceil) > 0 ? target : r.ceil
    const floor = r.floor || verified[0]
    cur.dsh.verified = verified
    cur.dsh.range = '>=' + floor + ',<=' + ceil
    cur.updatedAt = new Date().toISOString()
    cur.dsh.note = '已核实 ' + target + '：补丁目标文件与该版一致（' + pkgs.map((p) => p.split('/')[1]).join(', ') + '）。'
    write(cur)
    say('  已更新 compat.json：')
    say('    range    : ' + cur.dsh.range)
    say('    verified : ' + verified.join(', '))
    say('  下一步：node tools\\compat-declare.mjs --push')
    return 0
  }

  if (flag('--push')) {
    const rel = 'compat.json'
    try {
      execFileSync('git', ['add', rel], { cwd: ROOT, stdio: 'inherit' })
      execFileSync('git', ['-c', 'user.name=Blue-Seventeen', '-c', 'user.email=Blue-Seventeen@users.noreply.github.com',
        'commit', '-m', 'chore(compat): 放开内核适配面到 ' + cur.dsh.range, '--', rel], { cwd: ROOT, stdio: 'inherit' })
      execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: ROOT, stdio: 'inherit' })
      say('  已推送。用户下次联网拉取即生效，无需重装壳。')
      return 0
    } catch (e) {
      say('  提交/推送失败：' + ((e && e.message) || e))
      say('  可以手动：git add compat.json && git commit -m "chore(compat): ..." && git push')
      return 1
    }
  }

  say('用法：')
  say('  node tools\\compat-declare.mjs --check')
  say('  node tools\\compat-declare.mjs --verify <版本>')
  say('  node tools\\compat-declare.mjs --allow <版本>')
  say('  node tools\\compat-declare.mjs --push')
  return 2
}

process.exitCode = await main()