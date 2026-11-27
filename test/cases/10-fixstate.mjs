import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run, assert, tmpDir } from '../lib.mjs'

/** 造一棵最小的 portable 树：home/profiles/{web,desktop} + 一个 .backup-* 目录 + 共享 node_modules */
const buildTree = () => {
  const root = tmpDir('fixstate')
  const profiles = join(root, 'home', 'profiles')
  for (const dir of [profiles, join(profiles, 'web'), join(profiles, 'desktop'), join(profiles, '.backup-20260101-000000'), join(profiles, 'node_modules')]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(profiles, 'package.json'), '{"name":"shared","private":true}\n', 'utf8')
  for (const p of ['web', 'desktop', '.backup-20260101-000000']) {
    writeFileSync(join(profiles, p, 'package.json'), '{"name":"' + p + '","private":true}\n', 'utf8')
    writeFileSync(join(profiles, p, 'pnpm-workspace.yaml'), "packages:\n  - '.'\n", 'utf8')
  }
  writeFileSync(join(profiles, 'node_modules', '.modules.yaml'), '{}\n', 'utf8')
  return { root, profiles }
}

export const cases = [
  {
    name: 'fix-state 只修 profile，不进 .backup-* 备份目录',
    fn() {
      const { root, profiles } = buildTree()
      try {
        const r = run(['tools/profile/fix-pnpm-state.mjs', '--root', root])
        assert(r.code === 0, '退出码 ' + r.code + '：' + r.out.trim().slice(-200))
        // 两个真 profile 都被写上了 storeDir
        for (const p of ['web', 'desktop']) {
          const y = readFileSync(join(profiles, p, 'pnpm-workspace.yaml'), 'utf8')
          assert(/storeDir:/.test(y), p + ' 没被修复')
        }
        // 备份目录必须原样不动
        const backupYaml = readFileSync(join(profiles, '.backup-20260101-000000', 'pnpm-workspace.yaml'), 'utf8')
        assert(backupYaml === "packages:\n  - '.'\n", '.backup-* 被改动了：' + JSON.stringify(backupYaml))
        assert(!/\[\.backup-/.test(r.out), '日志里不该出现 [.backup-*]：' + r.out.trim().slice(-200))
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
  {
    name: 'fix-state 会重建缺失的 pnpm-workspace.yaml（含 storeDir / modulesDir）',
    fn() {
      const { root, profiles } = buildTree()
      try {
        rmSync(join(profiles, 'web', 'pnpm-workspace.yaml'))
        const r = run(['tools/profile/fix-pnpm-state.mjs', '--root', root])
        assert(r.code === 0, '退出码 ' + r.code)
        const y = readFileSync(join(profiles, 'web', 'pnpm-workspace.yaml'), 'utf8')
        assert(/storeDir:/.test(y), '重建后缺 storeDir')
        assert(/modulesDir: \.\.\/node_modules/.test(y), '重建后缺 modulesDir')
        assert(/nodeLinker: hoisted/.test(y), '重建后缺 nodeLinker')
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
  {
    name: '没有 env.cmd 上下文时按 fs-profile.cmd 选导入方式（copy，不是 auto）',
    fn() {
      const root = tmpDir('fixstate-env')
      const profiles = join(root, 'home', 'profiles')
      for (const dir of [profiles, join(profiles, 'web'), join(profiles, 'node_modules'), join(root, 'tmp')]) mkdirSync(dir, { recursive: true })
      writeFileSync(join(profiles, 'package.json'), '{"name":"shared","private":true}\n', 'utf8')
      writeFileSync(join(profiles, 'web', 'package.json'), '{"name":"web","private":true}\n', 'utf8')
      writeFileSync(join(profiles, 'node_modules', '.modules.yaml'), '{}\n', 'utf8')
      writeFileSync(join(root, 'tmp', 'fs-profile.cmd'), 'set "DSH_PNPM_IMPORT_METHOD=copy"\n', 'utf8')
      const saved = process.env.DSH_PNPM_IMPORT_METHOD
      try {
        delete process.env.DSH_PNPM_IMPORT_METHOD
        const r = run(['tools/profile/fix-pnpm-state.mjs', '--root', root])
        assert(r.code === 0, '退出码 ' + r.code + '：' + r.out.trim().slice(-200))
        const y = readFileSync(join(profiles, 'web', 'pnpm-workspace.yaml'), 'utf8')
        assert(/packageImportMethod: 'copy'/.test(y), '没有 env 时应回退成 copy，实际：' + y.split(/\r?\n/).filter((l) => l.includes('packageImportMethod')).join(' '))
      } finally {
        if (saved === undefined) delete process.env.DSH_PNPM_IMPORT_METHOD
        else process.env.DSH_PNPM_IMPORT_METHOD = saved
        rmSync(root, { recursive: true, force: true })
      }
    },
  },
]
