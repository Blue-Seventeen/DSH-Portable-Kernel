import { read, run, exists, assert, jsonOfLastLine } from '../lib.mjs'

export const cases = [
  {
    name: 'plugin-shared 命令面包含 stage/activate/stage-selftest',
    fn() {
      const r = run(['tools/profile/plugin-shared.mjs'])
      for (const k of ['stage', 'stage-remove', 'stage-list', 'stage-discard', 'activate', 'stage-selftest']) {
        assert(r.out.includes(k), '用法里没有 ' + k)
      }
    },
  },
  {
    name: 'market-history 可运行（--check 不写盘）',
    fn() {
      const r = run(['tools/profile/market-history.mjs', '--check'])
      assert(r.code === 0, '退出码 ' + r.code + '：' + r.out.trim().slice(-200))
      assert(/--check|跳过|可清|待处理/.test(r.out), '输出不像 --check：' + r.out.trim().slice(-200))
    },
  },
  {
    name: 'shell-update defaults 指向新仓库的版本线',
    fn() {
      const r = run(['tools/update/shell-update.mjs', 'defaults', '--json'])
      assert(r.code === 0, '退出码 ' + r.code)
      const j = jsonOfLastLine(r.out)
      assert(j && typeof j.manifest === 'string', '拿不到 defaults JSON')
      assert(j.manifest.includes('DSH-Portable-Kernel'), 'manifest 不含新仓库名：' + j.manifest)
      assert(!/master/i.test(j.rawBase || ''), 'rawBase 还在 master：' + j.rawBase)
      assert(/refs\/tags\/v<version>/.test(j.tagTemplate || ''), 'tagTemplate 形状不对：' + j.tagTemplate)
    },
  },
  {
    name: 'dsh-portable.ps1 的动作表包含新命令',
    fn() {
      const t = read('dsh-portable.ps1')
      for (const a of ['plugin-stage', 'plugin-activate', 'market-history', 'fix-market']) {
        assert(t.includes("'" + a + "'"), 'ValidateSet 里没有 ' + a)
      }
    },
  },
  {
    name: 'dsh-portable.cmd 也 call env.cmd（两条入口环境一致）',
    fn() {
      assert(/call\s+"%ROOT%env\.cmd"/i.test(read('dsh-portable.cmd')), 'dsh-portable.cmd 没有 call env.cmd')
    },
  },
  {
    name: '两个启动器都接了 activate 与 patch-all（顺序正确）',
    fn() {
      for (const f of ['start-web.cmd', 'start-desktop.cmd']) {
        const t = read(f)
        const act = t.indexOf('plugin-shared.mjs" activate')
        const pat = t.indexOf('patch-all.mjs" --apply')
        assert(act >= 0, f + ' 没接 activate')
        assert(pat >= 0, f + ' 没接 patch-all')
        assert(act < pat, f + ' 的 activate 应在 patch-all 之前')
      }
    },
  },
  {
    name: 'verify-shell 支持 --update-gate 且只读',
    fn() {
      assert(exists('tools/verify/verify-shell.mjs'), '缺 tools/verify/verify-shell.mjs')
      const t = read('tools/verify/verify-shell.mjs')
      assert(t.includes('--update-gate'), 'verify-shell 不支持 --update-gate')
    },
  },
]
