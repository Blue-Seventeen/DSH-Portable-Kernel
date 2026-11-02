import { createWriteStream, existsSync, unlinkSync, renameSync, statSync } from 'node:fs'

const [url, dest] = process.argv.slice(2)
const part = dest + '.part'
const t0 = Date.now()
let lastPrint = 0
let lastBytes = 0
let lastTime = t0

const fmt = (n) => (n / 1048576).toFixed(1) + ' MB'

function progress(n, total) {
  const now = Date.now()
  if (now - lastPrint < 500 && n !== total) return
  lastPrint = now
  const dt = (now - lastTime) / 1000
  const speed = dt > 0 ? (n - lastBytes) / dt / 1048576 : 0
  lastBytes = n
  lastTime = now
  const pct = total ? ((n / total) * 100).toFixed(1) : '?'
  const eta = total && speed > 0.1 ? Math.max(0, Math.round((total - n) / 1048576 / speed)) + 's' : '--'
  const line = `  ${pct}%  ${fmt(n)}${total ? ' / ' + fmt(total) : ''}  ${speed.toFixed(1)} MB/s  剩余 ${eta}`
  if (process.stdout.isTTY) process.stdout.write('\r' + line + '   ')
  else process.stdout.write(line + '\n')
}

function cleanup() {
  try { if (existsSync(part)) unlinkSync(part) } catch {}
}

try {
  const ctrl = new AbortController()
  const res = await fetch(url, { signal: ctrl.signal })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const total = Number(res.headers.get('content-length')) || 0
  const out = createWriteStream(part)
  const reader = res.body.getReader()
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r))
    n += value.length
    progress(n, total)
  }
  await new Promise((r) => out.end(r))
  progress(n, total)
  if (process.stdout.isTTY) process.stdout.write('\n')
  if (total > 0 && n !== total) throw new Error(`incomplete: got ${n} of ${total} bytes`)
  const size = statSync(part).size
  if (size !== n) throw new Error('size mismatch after write')
  renameSync(part, dest)
  console.log(`  完成: ${fmt(size)}，用时 ${Math.round((Date.now() - t0) / 1000)} 秒`)
} catch (e) {
  cleanup()
  console.error('  下载失败: ' + e.message + '（已删除半成品文件）')
  process.exit(1)
}