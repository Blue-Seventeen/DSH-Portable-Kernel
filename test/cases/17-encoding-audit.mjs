import { run, assert } from '../lib.mjs'

export const cases = [
  {
    name: '提交信息 / tag 文本编码审计（默认范围应为干净）',
    fn() {
      const r = run(['devtools/check-text-encoding.mjs'])
      assert(r.code === 0, '审计报红：' + r.out.trim().slice(-300))
    },
  },
  {
    name: '编码审计能抓到历史乱码（--all 必须报红并点名 755bbb2）',
    fn() {
      const r = run(['devtools/check-text-encoding.mjs', '--all'])
      assert(r.code === 1, '应报红，实际 ' + r.code + '：' + r.out.trim().slice(-200))
      assert(r.out.includes('755bbb2'), '应点名已知坏提交 755bbb2：' + r.out.trim().slice(-200))
    },
  },
]
