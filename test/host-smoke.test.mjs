import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { purgeRecycled } from './purge-bin.mjs'
import { apply, inject as declaredInject, name as pluginName } from '../index.js'

const SLOT = '--G-~6211~7684~6587~6863-workspace--'
const ID = 'session-9bd8a45d-a883-4919-8b4f-150449bf9da0'

/**
 * 用最小的 Cordis 形状装配插件：effect 立即执行并登记 disposer，connection 收集路由。
 * 默认配置成 trash，避免测试真的往系统回收站里塞临时目录；回收站路径另有专门的用例。
 * @param {{ home: string, live?: string[], config?: Record<string, unknown> }} options 装配参数。
 */
function mount({ home, live = [], config = { mode: 'trash' } }) {
  const routes = []
  const ctx = {
    sessions: { get: (id) => (live.includes(id) ? { id } : undefined) },
    connection: { fetch: { register: (route) => { routes.push(route); return () => {} } } },
    logger: { warn: () => {} },
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    get: () => undefined,
  }
  apply(ctx, { home, ...config })
  return routes
}

/** 造一个能被真实删除的会话目录。 */
async function fakeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delete-chat-host-'))
  await mkdir(join(home, 'sessions', SLOT, ID), { recursive: true })
  await writeFile(join(home, 'sessions', SLOT, ID, 'session.v1.jsonl.zstd'), 'x')
  return home
}

/** 发一次删除请求。 */
async function callDelete(route, body) {
  const response = await route.fetch(new Request('http://host/api/x-dsh-delete-chat/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  return { status: response.status, body: await response.json() }
}

test('插件声明 name 与硬依赖', () => {
  assert.equal(pluginName, 'delete-chat')
  assert.deepEqual([...declaredInject], ['connection', 'sessions'])
})

test('apply 注册删除与诊断两条浏览器端点', async () => {
  const home = await fakeHome()
  const routes = mount({ home })
  assert.deepEqual(routes.map(route => route.path), ['/api/x-dsh-delete-chat/delete', '/api/x-dsh-delete-chat/status'])
  assert.deepEqual(routes.map(route => route.methods), [['POST'], ['GET']])
  // 精确路由必须在共享 /api 通道下：connection 用 endpointFromPath('/api', path) 校验，
  // 前缀写错会让整个宿主半边 apply 失败（浏览器只剩 404），这里锁住这条约束。
  for (const route of routes) assert.match(route.path, /^\/api\/[A-Za-z0-9_$.-]+(\/[A-Za-z0-9_$.-]+)*$/)
  await rm(home, { recursive: true, force: true })
})

test('正常删除：200 + ok，目录进回收站', async () => {
  const home = await fakeHome()
  const [route] = mount({ home })
  const result = await callDelete(route, { sessionId: ID })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.alreadyGone, false)
  assert.ok(result.body.removed[0].trashPath.includes('session-trash'))
  await assert.rejects(stat(join(home, 'sessions', SLOT, ID)), { code: 'ENOENT' })
  await rm(home, { recursive: true, force: true })
})

test('存活会话被拒绝：409 + kind=live，磁盘一点没动', async () => {
  const home = await fakeHome()
  const [route] = mount({ home, live: [ID] })
  const result = await callDelete(route, { sessionId: ID })
  assert.equal(result.status, 409)
  assert.equal(result.body.kind, 'live')
  assert.ok(await stat(join(home, 'sessions', SLOT, ID)))
  await rm(home, { recursive: true, force: true })
})

test('非法请求体与非法 id 都是 400', async () => {
  const home = await fakeHome()
  const [route] = mount({ home })
  assert.equal((await callDelete(route, 'not json')).status, 400)
  assert.equal((await callDelete(route, { sessionId: '../x' })).status, 400)
  await rm(home, { recursive: true, force: true })
})

test('已不存在的会话不算失败，交给界面刷新', async () => {
  const home = await fakeHome()
  const [route] = mount({ home })
  await callDelete(route, { sessionId: ID })
  const again = await callDelete(route, { sessionId: ID })
  assert.equal(again.status, 200)
  assert.equal(again.body.ok, true)
  assert.equal(again.body.alreadyGone, true)
  await rm(home, { recursive: true, force: true })
})

test('配置成 permanent 时走永久删除', async () => {
  const home = await fakeHome()
  const [route] = mount({ home, config: { mode: 'permanent' } })
  const result = await callDelete(route, { sessionId: ID })
  assert.equal(result.body.mode, 'permanent')
  await assert.rejects(stat(join(home, 'session-trash')), { code: 'ENOENT' })
  await rm(home, { recursive: true, force: true })
})

test('recycle 模式把会话目录交给系统回收站', { skip: process.platform !== 'win32' }, async () => {
  const home = await fakeHome()
  // 每次运行都用新 id：回收站里不会和真实会话或上次运行的残留撞名。
  const id = `session-${randomUUID()}`
  await mkdir(join(home, 'sessions', SLOT, id), { recursive: true })
  await writeFile(join(home, 'sessions', SLOT, id, 'session.v1.jsonl.zstd'), 'x')
  try {
    const [route] = mount({ home, config: { mode: 'recycle' } })
    const result = await callDelete(route, { sessionId: id })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.mode, 'recycle')
    await assert.rejects(stat(join(home, 'sessions', SLOT, id)), { code: 'ENOENT' })
  } finally {
    await purgeRecycled(id)
    await rm(home, { recursive: true, force: true })
  }
})

test('诊断端点报告 home、模式与目标位置', async () => {
  const home = await fakeHome()
  const routes = mount({ home })
  const status = routes[1]
  const response = await status.fetch(new Request(`http://host/api/x-dsh-delete-chat/status?sessionId=${ID}`))
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.mode, 'trash')
  assert.equal(body.live, false)
  assert.equal(body.locations.length, 1)
  await rm(home, { recursive: true, force: true })
})
