import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, assert } from '../lib.mjs'

/**
 * 静态 lint：tools/*.mjs 里用到的常见内置函数，必须"要么 import 过、要么本文件定义过"。
 *
 * 为什么需要它：`shell-update.mjs` 的 `snooze --clear` 曾调用未 import 的 `unlinkSync`，
 * 外面又套着 `try { … } catch { /* 本来就没有 *\/ }` —— ReferenceError 被静默吞掉，
 * 命令打印"已恢复"但文件还在。这类 bug 语法检查查不出来，只能靠静态比对。
 */
const NAMES = [
  'existsSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync',
  'copyFileSync', 'readdirSync', 'statSync', 'lstatSync', 'chmodSync', 'realpathSync', 'mkdtempSync',
  'createHash', 'createReadStream', 'createWriteStream',
  'join', 'resolve', 'dirname', 'basename', 'extname', 'relative', 'isAbsolute', 'normalize',
  'fileURLToPath', 'pathToFileURL', 'homedir', 'tmpdir', 'execFileSync', 'execSync', 'spawnSync', 'spawn',
]

/** 从 import 块（允许跨行）里收集所有被导入的名字 */
const importedNames = (text) => {
  const names = new Set()
  for (const m of text.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = m[1]
    for (const n of clause.matchAll(/\{([\s\S]*?)\}/g)) {
      for (const part of n[1].split(',')) {
        const id = part.trim().split(/\s+as\s+/)[0].trim()
        if (/^[A-Za-z_$][\w$]*$/.test(id)) names.add(id)
      }
    }
    const def = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(,|$)/)
    if (def) names.add(def[1])
  }
  return names
}

/** 本文件自己定义/解构过这个名字吗（const X / function X / const { X } = await import(...)） */
const locallyDefined = (text, fn) => {
  if (new RegExp('(?:^|[\\s;{}])(?:const|let|var|function)\\s+' + fn + '\\b').test(text)) return true
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([\s\S]*?)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const id = part.trim().split(/\s+as\s+/)[0].trim()
      if (id === fn) return true
    }
  }
  return false
}

const callsBare = (text, fn) => new RegExp('(^|[^\\w.$])' + fn + '\\s*\\(').test(text)

export const cases = [
  {
    name: 'tools/*.mjs 没有"用了但没导入/没定义"的内置函数（防 catch 吞 ReferenceError）',
    fn() {
      const problems = []
      for (const name of readdirSync(join(ROOT, 'tools')).filter((n) => n.endsWith('.mjs'))) {
        const text = readFileSync(join(ROOT, 'tools', name), 'utf8')
        const imported = importedNames(text)
        for (const fn of NAMES) {
          if (!callsBare(text, fn)) continue
          if (imported.has(fn) || locallyDefined(text, fn)) continue
          problems.push(name + ' 用了 ' + fn + ' 但没导入/定义')
        }
      }
      assert(problems.length === 0, problems.slice(0, 8).join('; '))
    },
  },
  {
    name: '危险 fs 调用（rm/unlink/rename/copy）都真在 node:fs 的 import 里',
    fn() {
      const risky = ['unlinkSync', 'rmSync', 'renameSync', 'copyFileSync']
      const problems = []
      for (const name of readdirSync(join(ROOT, 'tools')).filter((n) => n.endsWith('.mjs'))) {
        const text = readFileSync(join(ROOT, 'tools', name), 'utf8')
        const imported = importedNames(text)
        for (const fn of risky) {
          if (!callsBare(text, fn)) continue
          if (imported.has(fn) || locallyDefined(text, fn)) continue
          problems.push(name + ' 调用 ' + fn + ' 但没有导入/定义')
        }
      }
      assert(problems.length === 0, problems.join('; '))
    },
  },
]
