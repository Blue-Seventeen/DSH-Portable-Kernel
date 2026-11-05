#!/usr/bin/env node
/**
 * 附件库"回到便携目录"：把 `cordis.patch.yml` 里的 dshHome 重定向去掉，并把旧附件搬回来。
 *
 * 背景：exFAT 不支持硬链接，附件库发布对象时用 link()。2026-11-03 的绕法是在桌面 profile 的
 * `cordis.patch.yml` 里把 `@deepseek-ai/dsh-attachment-local` 的 dshHome 指到 NTFS 的
 * `C:\Users\<用户>\.dsh`。代价：附件跑出便携目录、写死用户名、换机即失效。
 *
 * 现在 `tools\patch-attachment.mjs` 给附件库打了"link 失败回退 copy"的补丁，这个绕法可以撤了。
 * 本工具做三件事（都可单独跑）：
 *   1. --check：报告重定向是否还在、补丁是否已打、旧附件有多少
 *   2. --apply：去掉 patch.yml 里的那段（含注释），把旧附件复制回 home\attachments\v1
 *   3. --purge-old：确认搬完后删掉 C:\Users\<用户>\.dsh\attachments（默认不删）
 *
 * 用法：
 *   node tools\fix-attachment.mjs --check [--json]
 *   node tools\fix-attachment.mjs --apply [--json]
 *   node tools\fix-attachment.mjs --apply --purge-old
 *
 * 退出码：0 成功 / 1 失败 / 4 需要处理（没补丁就撤重定向会被拒）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, relative } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const _rootArg = process.argv.indexOf('--root')
const ROOT = _rootArg >= 0 ? resolve(process.argv[_rootArg + 1]) : dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const jsonMode = argv.includes('--json')
const doApply = argv.includes('--apply')
const purgeOld = argv.includes('--purge-old')

const PROFILES = ['desktop', 'web']
const patchFile = (p) => join(ROOT, 'home', 'profiles', p, 'cordis.patch.yml')
// 环境变量只给测试/演练用（真实场景永远是当前用户的 ~/.dsh）
const legacyDir = () => process.env.H3RX_LEGACY_ATTACHMENTS || join(homedir(), '.dsh', 'attachments', 'v1')
const targetDir = () => join(ROOT, 'home', 'attachments', 'v1')

// 需要删掉的那一段：从"附件存储修复"注释块开始，到 dshHome 那一行结束
const BLOCK_RE = /\n?#\s*---\s*附件存储修复[\s\S]*?dshHome:\s*['"][^'"]*['"]\s*\n?/g

const readMaybe = (f) => { try { return readFileSync(f, 'utf8') } catch { return null } }
const countFiles = (dir) => {
  if (!existsSync(dir)) return { files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else { files++; bytes += st.size }
    }
  }
  walk(dir)
  return { files, bytes }
}

/** 找出所有还带重定向的 profile 文件 */
const redirected = () => PROFILES.map(patchFile).filter((f) => {
  const t = readMaybe(f)
  return t !== null && /dshHome:\s*['"][^'"]*['"]/.test(t) && /attachment-local/.test(t)
})

const patchState = () => {
  const tool = join(ROOT, 'tools', 'patch-attachment.mjs')
  if (!existsSync(tool)) return 'missing-tool'
  // 没有桌面层（纯壳/演练目录）时只看 app 目录那份：否则会因 asar 不存在而永远判"未打全"
  const hasAsar = existsSync(join(ROOT, 'desktop', 'resources', 'app.asar'))
  const args = [tool, '--check', '--root', ROOT]
  if (!hasAsar) args.push('--app-only')
  const r = spawnSync(process.execPath, args, { stdio: 'ignore', windowsHide: true })
  return r.status === 0 ? 'applied' : 'not-patched'
}

const stripBlocks = () => {
  const touched = []
  for (const f of redirected()) {
    const t = readMaybe(f)
    if (t === null) continue
    const next = t.replace(BLOCK_RE, '\n')
    if (next !== t) {
      const bak = f + '.bak-h3rx-' + Date.now()
      try { copyFileSync(f, bak) } catch { }
      writeFileSync(f, next, 'utf8')
      touched.push(f)
    }
  }
  return touched
}

/** 递归复制旧附件（真实布局是 v1/objects/<两位>/<哈希> + v1/tmp，不是平铺文件） */
const copyBack = () => {
  const src = legacyDir()
  if (!existsSync(src)) return { copied: 0, skipped: 0 }
  mkdirSync(targetDir(), { recursive: true })
  let copied = 0
  let skipped = 0
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const from = join(dir, name)
      const rel = relative(src, from)
      // tmp 是暂存目录（半成品/锁文件），不搬
      if (rel.split(/[\\/]/)[0] === 'tmp') continue
      const to = join(targetDir(), rel)
      if (statSync(from).isDirectory()) {
        mkdirSync(to, { recursive: true })
        walk(from)
        continue
      }
      if (existsSync(to)) { skipped++; continue }
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      copied++
    }
  }
  walk(src)
  return { copied, skipped }
}

const state = () => {
  const legacy = countFiles(legacyDir())
  return {
    redirected: redirected().map((f) => f.slice(ROOT.length + 1)),
    patch: patchState(),
    legacy,
    target: countFiles(targetDir()),
  }
}

const st = state()
if (jsonMode) {
  process.stdout.write(JSON.stringify({ ok: true, ...st }) + '\n')
  if (doApply) {
    const touched = st.redirected.length && st.patch === 'applied' ? stripBlocks() : []
    const moved = st.patch === 'applied' ? copyBack() : { copied: 0, skipped: 0 }
    process.stdout.write(JSON.stringify({ ok: true, applied: true, stripped: touched.length, ...moved }) + '\n')
  }
  process.exit(0)
}

console.log('附件库状态')
console.log('  重定向：' + (st.redirected.length ? st.redirected.join('、') : '无'))
console.log('  补丁  ：' + st.patch)
console.log('  旧附件：' + st.legacy.files + ' 个 / ' + (st.legacy.bytes / 1048576).toFixed(1) + ' MB（' + legacyDir() + '）')
console.log('  便携目录：' + st.target.files + ' 个 / ' + (st.target.bytes / 1048576).toFixed(1) + ' MB')

if (!doApply) {
  if (st.redirected.length) console.log('\n运行 node tools\\fix-attachment.mjs --apply 撤掉重定向并把附件搬回来')
  process.exit(0)
}
if (!st.redirected.length && st.legacy.files === 0) { console.log('\n没有需要处理的（重定向已撤、旧目录已空）'); process.exit(0) }
if (st.patch !== 'applied') {
  console.error('\n拒绝执行：附件库补丁还没打（' + st.patch + '）。先运行 dsh-portable.cmd repair 或 tools\\patch-attachment.mjs --apply')
  process.exit(4)
}
const touched = stripBlocks()
const moved = copyBack()
console.log('\n已撤掉重定向：' + touched.length + ' 个文件')
console.log('已复制回便携目录：' + moved.copied + ' 个（跳过已存在 ' + moved.skipped + ' 个）')
if (purgeOld) {
  try {
    // 递归删（含 objects/<两位>/ 子目录）。安全断言：必须是 .../attachments/v1 结尾
    // （测试用 H3RX_LEGACY_ATTACHMENTS 覆盖时放宽，但仍要求有足够深度、不是盘根）
    const victim = legacyDir();
    const norm = String(victim).replace(/\\/g, '/').replace(/\/+$/, '');
    const standard = /\/attachments\/v1$/i.test(norm);
    const depthOk = norm.split('/').filter(Boolean).length >= 3;
    const notDrive = !/^[a-z]:$/i.test(norm);
    if (!depthOk || !notDrive || (!standard && !process.env.H3RX_LEGACY_ATTACHMENTS)) {
      throw new Error('拒绝删除非标准路径: ' + victim);
    }
    rmSync(victim, { recursive: true, force: true });
    console.log('已删除旧目录：' + legacyDir())
  } catch (e) { console.warn('删旧目录失败（可手动删）：' + String(e.message || e)) }
} else if (st.legacy.files) {
  console.log('旧目录仍在：' + legacyDir() + '（确认无误后可加 --purge-old 删除，或手动删）')
}
