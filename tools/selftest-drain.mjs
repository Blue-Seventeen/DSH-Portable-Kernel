#!/usr/bin/env node
/**
 * dshmarket drain 协调器的离线自测（假 Agent / 假 host，无 I/O、无网络、毫秒级）。
 *
 * 为什么需要它：tools\patch-market.mjs 给 dshmarket 打了「等待期不占用空闲 Agent」的
 * 语义补丁（[portable-drain]）。这个 bug 的表现是「商城排队时别的会话发消息不开回合」，
 * 只靠读代码或手工点很难回归。这里直接用假 Agent 驱动打过补丁的 DrainCoordinator，
 * 断言三条不变式：
 *   1) 等别人跑回合期间，空闲 Agent 不被 runMaintenance 占住（不会被 latch）；
 *   2) 全员空闲后才一次性 claim，executor 跑完全部释放；
 *   3) 等待期新建的 Agent 不被占用（它的第一句话要能正常开回合）。
 *
 * 用法：node tools\selftest-drain.mjs [--quiet]
 * 退出码：0 = 全过 / 未安装商城（跳过）/ 1 = 有断言失败。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const quiet = process.argv.includes('--quiet')
const say = (m) => { if (!quiet) console.log('  ' + m) }

const candidates = [
  join(root, 'home', 'profiles', 'node_modules', 'dshmarket'),
  join(root, 'home', 'profiles', 'desktop', 'node_modules', 'dshmarket'),
  join(root, 'home', 'profiles', 'web', 'node_modules', 'dshmarket'),
]
const marketDir = candidates.find((d) => existsSync(join(d, 'package.json')))
if (!marketDir) { say('未安装 dshmarket，跳过 drain 自测'); process.exit(0) }

const drainFile = join(marketDir, 'lib', 'drain.js')
if (!existsSync(drainFile)) { say('缺少 lib\\drain.js，跳过'); process.exit(0) }

const src = readFileSync(drainFile, 'utf8')
if (!src.includes('[portable-drain]')) {
  console.error('  drain 语义补丁没打上（先跑 dsh-portable.cmd fix-market），跳过语义断言')
  process.exit(1)
}

const { DrainCoordinator } = await import(pathToFileURL(drainFile).href)

/* ------------------------------------------------------------------ 假 Agent */

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** 复刻 DSH Agent 的维护语义：空闲才能被占；占用期间 whenIdle 不 resolve */
class FakeAgent {
  constructor(id, status = 'idle') {
    this.id = id
    this.status = status
    this.phase = 'idle'          // idle | running | maintenance
    this.holds = 0               // 当前是否被 drain 占着（0/1）
    this.maintenanceStarts = 0   // 历史上被占用过几次（用于断言“等待期不占”）
    this.idleWaiters = []
  }
  runMaintenance(task) {
    if (this.phase !== 'idle') throw new Error('agent "' + this.id + '" already has active work')
    this.phase = 'maintenance'
    this.holds += 1
    this.maintenanceStarts += 1
    const controller = new AbortController()
    let result
    try { result = Promise.resolve(task(controller.signal)) } catch (e) { result = Promise.reject(e) }
    return result.finally(() => {
      this.phase = this.status === 'running' ? 'running' : 'idle'
      this.holds -= 1
      this.flushIdle()
    })
  }
  whenIdle() {
    if (this.phase === 'idle') return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }
  flushIdle() {
    if (this.phase !== 'idle') return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const r of waiters) r()
  }
  startTurn() { this.status = 'running'; this.phase = 'running' }
  endTurn() { this.status = 'idle'; this.phase = 'idle'; this.flushIdle() }
}

const makeHost = (agents) => {
  const hooks = { created: null, disposed: null }
  return {
    hooks,
    list: () => agents.filter((a) => a.alive !== false),
    onCreated: (cb) => { hooks.created = cb; return () => { hooks.created = null } },
    onDisposed: (cb) => { hooks.disposed = cb; return () => { hooks.disposed = null } },
  }
}

const makeCoordinator = (host) => new DrainCoordinator({
  host,
  journal: { append() { } },
  bootId: 'selftest',
  now: () => Date.now(),
  log: () => { },
  abortMutation: () => { },
})

const request = (name, exec) => ({
  kind: 'install',
  name,
  captureIntent: async () => ({ name }),
  execute: exec ?? (async () => ({ status: 200, payload: { ok: true } })),
  onUpdate: () => { },
})

const waitFor = async (predicate, label, timeout = 2000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return true
    await tick(5)
  }
  throw new Error('等待超时：' + label)
}

/* -------------------------------------------------------------------- 断言 */

const results = []
const check = async (name, fn) => {
  try {
    await fn()
    results.push({ name, ok: true })
    say('OK   ' + name)
  } catch (e) {
    results.push({ name, ok: false, error: e && e.message ? e.message : String(e) })
    console.error('  FAIL ' + name + ' — ' + (e && e.message ? e.message : String(e)))
  }
}
const assert = (cond, message) => { if (!cond) throw new Error(message) }

/* ---- 用例 1：等别人跑回合时，空闲 Agent 不许被占（这就是“会话暂停”的根因） ---- */
await check('等待期不占用空闲 Agent', async () => {
  const idle = new FakeAgent('A')
  const busy = new FakeAgent('B', 'running')
  busy.startTurn()
  const agents = [idle, busy]
  const host = makeHost(agents)
  const coord = makeCoordinator(host)

  // executor 挂住不返回：占用窗口才稳定可见（真实场景是几十秒的 pnpm）
  let releaseExec
  const execGate = new Promise((r) => { releaseExec = r })
  let execEntered = false
  const began = await coord.begin(request('selftest-1', async () => {
    execEntered = true
    await execGate
    return { status: 200, payload: { ok: true } }
  }))
  assert(began.mode === 'deferred', '应进入 deferred，实际 ' + began.mode)
  await tick(80)

  // 关键断言：还在等 B 跑回合，A 绝不能被占住（否则 A 的新消息只会入队）
  assert(!execEntered, 'B 还在跑回合，executor 不该开始')
  assert(idle.holds === 0, '空闲 Agent 被占住了（holds=' + idle.holds + '）→ 它的消息会被 latch')
  assert(busy.status === 'running', '忙的 Agent 不该被影响')

  // B 跑完 → 全员空闲 → 才进入提交边界
  busy.endTurn()
  await waitFor(() => idle.holds === 1 && busy.holds === 1, '全员空闲后应同时被占用')
  assert(execEntered, '进入边界的同步 claim 之后应开始执行')
  releaseExec()
  await coord.whenSettled(began.operation.operationId)
  await tick(30)
  assert(idle.holds === 0 && busy.holds === 0, '收尾后必须全部释放')
  coord.dispose()
})

/* ---- 用例 2：executor 真的跑过、状态是 succeeded ---- */
await check('边界上一次性 claim 并跑完 executor', async () => {
  const a = new FakeAgent('A')
  const host = makeHost([a])
  const coord = makeCoordinator(host)
  let ran = 0
  const began = await coord.begin(request('selftest-2', async () => { ran += 1; return { status: 200, payload: { ok: true } } }))
  assert(began.mode === 'inline' || began.mode === 'deferred', '模式异常：' + began.mode)
  await waitFor(() => ran === 1, 'executor 应执行一次')
  const id = began.operation ? began.operation.operationId : undefined
  if (id) await coord.whenSettled(id)
  await tick(30)
  assert(a.holds === 0, '结束后不应残留占用')
  coord.dispose()
})

/* ---- 用例 3：等待期新建的 Agent 不被占用（新会话要能正常开第一回合） ---- */
await check('等待期新建 Agent 不被占用', async () => {
  const idle = new FakeAgent('A')
  const busy = new FakeAgent('B', 'running')
  busy.startTurn()
  const agents = [idle, busy]
  const host = makeHost(agents)
  const coord = makeCoordinator(host)
  const began = await coord.begin(request('selftest-3'))
  assert(began.mode === 'deferred', '应进入 deferred')

  const fresh = new FakeAgent('C')
  agents.push(fresh)
  host.hooks.created?.(fresh)
  await tick(60)
  assert(fresh.maintenanceStarts === 0, '等待期新建的 Agent 被占用了 → 它的第一句话会被 latch')

  coord.cancel(began.operation.operationId)
  await tick(60)
  assert(idle.holds === 0 && fresh.holds === 0, '取消后不许残留占用')
  coord.dispose()
})

/* ---- 用例 4：取消排队不残留任何占用 ---- */
await check('取消排队后无残留占用', async () => {
  const idle = new FakeAgent('A')
  const busy = new FakeAgent('B', 'running')
  busy.startTurn()
  const host = makeHost([idle, busy])
  const coord = makeCoordinator(host)
  const began = await coord.begin(request('selftest-4'))
  assert(began.mode === 'deferred', '应进入 deferred')
  await tick(40)
  const cancelled = coord.cancel(began.operation.operationId)
  assert(cancelled === true, 'cancel 应返回 true')
  await waitFor(() => began.operation && coord.get(began.operation.operationId)?.state === 'cancelled', '应看到 cancelled', 1500)
  await tick(40)
  assert(idle.holds === 0 && busy.holds === 0, '取消后仍有占用：' + idle.holds + '/' + busy.holds)
  coord.dispose()
})

/* ---- 用例 5：两个都空闲时走 inline，行为与原来一致 ---- */
await check('全员空闲时仍走 inline', async () => {
  const a = new FakeAgent('A')
  const b = new FakeAgent('B')
  const host = makeHost([a, b])
  const coord = makeCoordinator(host)
  let ran = 0
  const began = await coord.begin(request('selftest-5', async () => { ran += 1; return { status: 200, payload: { ok: true } } }))
  assert(began.mode === 'inline', '全员空闲应走 inline，实际 ' + began.mode)
  assert(ran === 1, 'executor 应执行一次')
  await tick(30)
  assert(a.holds === 0 && b.holds === 0, 'inline 结束后不应残留占用')
  coord.dispose()
})

/* ------------------------------------------------------------------- 结果 */
const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.error('  drain 自测失败 ' + failed.length + '/' + results.length + '：' + failed.map((f) => f.name).join('、'))
  process.exit(1)
}
say('drain 自测通过：' + results.length + '/' + results.length)
process.exit(0)
