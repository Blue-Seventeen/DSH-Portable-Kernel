import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ROOT, assert, copyShellRoot, run, tmpDir } from '../lib.mjs'

const FIXTURE_LIB = `import { chmod, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
export async function publish(a, b) { await link(a, b); }
`

const BLOCK = `
# --- 附件存储修复（2026-11-03）---
# 原因：exFAT 不支持硬链接
- id: attachment-local
  name: '@deepseek-ai/dsh-attachment-local'
  config:
    dshHome: 'C:\\Users\\someone\\.dsh'
`

/** 造一个可跑的最小实例：app 里的附件库文件 + desktop profile 的 patch.yml + 旧附件目录 */
const build = (withPatchTool = true) => {
  const root = tmpDir('fix-att')
  const pkg = join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh-attachment-local', 'lib')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'index.js'), FIXTURE_LIB, 'utf8')
  mkdirSync(join(root, 'home', 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(root, 'home', 'profiles', 'desktop', 'cordis.patch.yml'), '[]\n' + BLOCK, 'utf8')
  if (withPatchTool) {
    mkdirSync(join(root, 'tools'), { recursive: true })
    mkdirSync(dirname(join(root, 'tools', 'patch', 'patch-attachment.mjs')), { recursive: true })
  copyFileSync(join(ROOT, 'tools', 'patch', 'patch-attachment.mjs'), join(root, 'tools', 'patch', 'patch-attachment.mjs'))
    mkdirSync(dirname(join(root, 'tools', 'lib', 'asar-lite.mjs')), { recursive: true })
  copyFileSync(join(ROOT, 'tools', 'lib', 'asar-lite.mjs'), join(root, 'tools', 'lib', 'asar-lite.mjs'))
  copyShellRoot(root)
  }
  // 真实布局：v1/objects/<两位>/<hash> + v1/tmp（暂存，不应搬）
  const legacy = join(root, 'legacy', 'v1')
  mkdirSync(join(legacy, 'objects', 'aa'), { recursive: true })
  mkdirSync(join(legacy, 'objects', 'bb'), { recursive: true })
  mkdirSync(join(legacy, 'tmp'), { recursive: true })
  writeFileSync(join(legacy, 'objects', 'aa', 'aaa'), 'one', 'utf8')
  writeFileSync(join(legacy, 'objects', 'bb', 'bbb'), 'two', 'utf8')
  writeFileSync(join(legacy, 'tmp', 'half'), 'staging', 'utf8')
  return { root, legacy, patchYml: join(root, 'home', 'profiles', 'desktop', 'cordis.patch.yml') }
}

const withEnv = (legacy, fn) => {
  const saved = process.env.H3RX_LEGACY_ATTACHMENTS
  process.env.H3RX_LEGACY_ATTACHMENTS = legacy
  try { fn() } finally {
    if (saved === undefined) delete process.env.H3RX_LEGACY_ATTACHMENTS
    else process.env.H3RX_LEGACY_ATTACHMENTS = saved
  }
}

export const cases = [
  {
    name: 'fix-attachment：没补丁时拒绝撤重定向（退出码 4）',
    fn() {
      const { root, legacy } = build(false)
      try {
        withEnv(legacy, () => {
          const r = run(['tools/patch/fix-attachment.mjs', '--root', root, '--apply'])
          assert(r.code === 4, '应以 4 拒绝，实际 ' + r.code + '：' + r.out.trim().slice(-200))
          assert(readFileSync(join(root, 'home', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8').includes('dshHome'), '重定向被误删了')
        })
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
  {
    name: 'fix-attachment：补丁就绪后撤重定向 + 旧附件搬回 + --purge-old 删旧目录',
    fn() {
      const { root, legacy, patchYml } = build(true)
      try {
        const ap = run(['tools/patch/patch-attachment.mjs', '--root', root, '--apply', '--app-only'])
        assert(ap.code === 2 || ap.code === 0, '打补丁失败：' + ap.out.trim().slice(-200))
        withEnv(legacy, () => {
          const check = run(['tools/patch/fix-attachment.mjs', '--root', root, '--check'])
          assert(check.code === 0, '--check 退出码 ' + check.code)
          assert(check.out.includes('applied'), '--check 没看到补丁已打：' + check.out.trim().slice(-200))
          const applied = run(['tools/patch/fix-attachment.mjs', '--root', root, '--apply'])
          assert(applied.code === 0, '--apply 退出码 ' + applied.code + '：' + applied.out.trim().slice(-200))
          const yml = readFileSync(patchYml, 'utf8')
          assert(!yml.includes('dshHome'), '重定向没撤掉：' + yml.slice(-120))
          assert(!yml.includes('attachment-local'), '注释块没清干净')
          const target = join(root, 'home', 'attachments', 'v1')
          const a = join(target, 'objects', 'aa', 'aaa')
          const b = join(target, 'objects', 'bb', 'bbb')
          assert(existsSync(a) && existsSync(b), '嵌套附件没搬回（objects/<两位>/<hash>）')
          assert(readFileSync(a, 'utf8') === 'one' && readFileSync(b, 'utf8') === 'two', '附件内容不符')
          assert(!existsSync(join(target, 'tmp')), 'tmp 暂存目录不该被搬')
          const purged = run(['tools/patch/fix-attachment.mjs', '--root', root, '--apply', '--purge-old'])
          assert(purged.code === 0, 'purge 退出码 ' + purged.code)
          assert(!existsSync(join(legacy, 'objects', 'aa', 'aaa')), '旧目录文件没删')
          assert(!existsSync(legacy), '旧附件根目录没删干净')
        })
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
]
