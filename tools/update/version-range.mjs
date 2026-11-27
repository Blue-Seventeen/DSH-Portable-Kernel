/**
 * 版本比较与区间判定（壳内多个工具共用的唯一实现）。
 *
 * 为什么独立成文件：update-check.mjs 会被测试单独拷进隔离目录运行（test/cases/18），
 * 它不能依赖 shell-update.mjs 那棵"CLI 全家桶"（一 import 就把整个自更新引擎拖进来，
 * 隔离目录里直接 MODULE_NOT_FOUND）。这里只放纯函数，零依赖、零副作用。
 *
 * 语义约定：只有"远端比本地新"才返回 true；本地更新（如装了预发布版）不算新。
 * 支持 prerelease（-rc.N / -alpha.N）比较：数字段按数值，非数字段按字典序。
 */

export const parseVer = (v) => {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '')
  const dash = s.indexOf('-')
  const core = dash === -1 ? s : s.slice(0, dash)
  const pre = dash === -1 ? '' : s.slice(dash + 1)
  return { nums: core.split('.').map((x) => parseInt(x, 10) || 0), pre: pre ? pre.split('.') : [] }
}

const cmpPre = (a, b) => {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x) ? Number(x) : null
    const ny = /^\d+$/.test(y) ? Number(y) : null
    if (nx !== null && ny !== null) { if (nx !== ny) return nx - ny }
    else { const c = String(x).localeCompare(String(y)); if (c) return c }
  }
  return 0
}

export const isNewer = (latest, cur) => {
  const a = parseVer(latest), b = parseVer(cur)
  const n = Math.max(a.nums.length, b.nums.length, 3)
  for (let i = 0; i < n; i++) {
    const x = a.nums[i] || 0, y = b.nums[i] || 0
    if (x !== y) return x > y
  }
  if (!a.pre.length && b.pre.length) return true
  if (a.pre.length && !b.pre.length) return false
  return cmpPre(a.pre, b.pre) > 0
}

const equalVer = (a, b) => {
  const x = parseVer(a), y = parseVer(b)
  const n = Math.max(x.nums.length, y.nums.length, 3)
  for (let i = 0; i < n; i++) if ((x.nums[i] || 0) !== (y.nums[i] || 0)) return false
  if (x.pre.length !== y.pre.length) return false
  return cmpPre(x.pre, y.pre) === 0
}
export { equalVer }

/**
 * 极简范围判定：支持 ">=x" ">x" "<=x" "<x" "=x"，条件之间用逗号或空格分隔（"与"语义）。
 * 解析不了返回 null（调用方自行兜底：null 按"通过"处理还是按失败处理由调用点决定）。
 *
 * 2026-11-12 事故：旧实现只按逗号切分，空格写法 ">=X <Y" 里的 "<Y" 混进版本号被 parseVer
 * 吞掉，上界静默失效（实测 satisfiesRange('0.3.0','>=0.2.1-rc.5 <0.3.0') => true）。
 * 逗号与空格必须等价——发版清单里两种写法都可能出现。
 */
export const satisfiesRange = (ver, range) => {
  const cur = String(ver || '').trim()
  if (!cur || !range) return null
  const conds = String(range).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
  for (const c of conds) {
    const m = /^(>=|<=|>|<|=)?\s*v?(.+)$/.exec(c)
    if (!m) return null
    const op = m[1] || '='
    const target = m[2].trim()
    if (op === '>=') { if (isNewer(target, cur) && !equalVer(target, cur)) return false }
    else if (op === '>') { if (!isNewer(cur, target)) return false }
    else if (op === '<=') { if (isNewer(cur, target)) return false }
    else if (op === '<') { if (!isNewer(target, cur)) return false }
    else if (!equalVer(cur, target)) return false
  }
  return true
}
