#!/usr/bin/env node
/**
 * 壳的多角度校验（本地专用；不进 GitHub、不随发布，见 README.md）。
 *
 * 用例在 cases/*.mjs，每个都导出 `cases = [{ name, fn }]`；失败请 throw。
 * 不加参数跑全部；--list 只列；--filter <子串> 过滤；--json 给机器读。
 */
import { readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const filter = argv.includes('--filter') ? String(argv[argv.indexOf('--filter') + 1] || '') : ''
const listOnly = argv.includes('--list')
const asJson = argv.includes('--json')

const files = existsSync(join(TEST_DIR, 'cases'))
  ? readdirSync(join(TEST_DIR, 'cases')).filter((f) => f.endsWith('.mjs')).sort()
  : []

const groups = []
for (const file of files) {
  try {
    const mod = await import(pathToFileURL(join(TEST_DIR, 'cases', file)).href)
    groups.push({ file, cases: Array.isArray(mod.cases) ? mod.cases : [] })
  } catch (e) {
    groups.push({ file, loadError: e && e.message ? e.message : String(e), cases: [] })
  }
}

const results = []
if (listOnly) {
  for (const g of groups) for (const c of g.cases) console.log(g.file + '  ' + c.name)
  process.exit(0)
}

const timeoutOf = (fn) => 180000
for (const g of groups) {
  if (!asJson) console.log('\n[' + g.file + ']')
  if (g.loadError) {
    results.push({ group: g.file, name: '(加载用例文件)', ok: false, ms: 0, error: g.loadError })
    if (!asJson) console.error('  FAIL  加载失败：' + g.loadError)
    continue
  }
  for (const c of g.cases) {
    if (filter && !String(c.name).includes(filter) && !g.file.includes(filter)) continue
    const started = Date.now()
    let ok = true
    let error = ''
    try {
      await Promise.race([
        Promise.resolve().then(() => c.fn()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('超时（' + timeoutOf(c.fn) + 'ms）')), timeoutOf(c.fn))),
      ])
    } catch (e) {
      ok = false
      error = e && e.message ? e.message : String(e)
    }
    const ms = Date.now() - started
    results.push({ group: g.file, name: c.name, ok, ms, error })
    if (!asJson) console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + c.name + '  (' + ms + 'ms)' + (ok ? '' : '  ← ' + error))
  }
}

const failed = results.filter((r) => !r.ok)
if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, total: results.length, passed: results.length - failed.length, failed: failed.length, results }, null, 2))
} else {
  console.log('')
  if (failed.length) {
    console.log('结论：FAIL（' + failed.length + ' / ' + results.length + ' 项失败）')
    for (const f of failed) console.log('  - [' + f.group + '] ' + f.name + '：' + f.error)
  } else {
    console.log('结论：PASS（' + results.length + ' 项全过）')
  }
}
process.exit(failed.length === 0 ? 0 : 1)
