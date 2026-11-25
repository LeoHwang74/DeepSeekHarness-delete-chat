import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DeleteSessionError,
  deleteSession,
  findSessionDirs,
  resolveDshHome,
  SESSION_ID_PATTERN,
} from '../lib/delete-session.js'

const SLOT = '--G-~6211~7684~6587~6863-workspace--'
const ID = 'session-3b5c854e-ba5e-4aba-aa7f-190fbebe8bf0'
const FIXED_DATE = new Date('2026-11-26T03:04:05.678Z')

/** 造一个最小的 DSH_HOME：一个会话目录 + 一份投影缓存 + 另一个占位会话。 */
async function fakeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delete-chat-'))
  const sessionDir = join(home, 'sessions', SLOT, ID)
  const otherDir = join(home, 'sessions', SLOT, 'session-keepme')
  await mkdir(sessionDir, { recursive: true })
  await mkdir(otherDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v1.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
  await writeFile(join(otherDir, 'session.v1.jsonl.zstd'), Buffer.alloc(0))
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(join(home, 'storages', 'session_projcache', 'sessions', `${ID}.json`), '{"title":"x"}')
  return home
}

/** 当前时间戳对应的回收站目录。 */
function trashTarget(home) {
  return join(home, 'session-trash', '2026-11-26T03-04-05-678Z', SLOT, ID)
}

test('id 形状只接受宿主生成的 session- 前缀', () => {
  assert.equal(SESSION_ID_PATTERN.test(ID), true)
  assert.equal(SESSION_ID_PATTERN.test('session-../../etc'), false)
  assert.equal(SESSION_ID_PATTERN.test('../../etc'), false)
  assert.equal(SESSION_ID_PATTERN.test('session-'), false)
})

test('默认模式把会话目录整块移入 session-trash，并清掉投影缓存', async () => {
  const home = await fakeHome()
  const result = await deleteSession({ home, sessionId: ID, now: FIXED_DATE })

  assert.equal(result.mode, 'trash')
  assert.equal(result.alreadyGone, false)
  assert.equal(result.removed.length, 1)
  assert.equal(result.removed[0].trashPath, trashTarget(home))
  assert.equal(result.cacheFiles.length, 1)

  await assert.rejects(stat(join(home, 'sessions', SLOT, ID)), { code: 'ENOENT' })
  assert.ok(await readFile(join(trashTarget(home), 'session.v1.jsonl.zstd')))
  await assert.rejects(stat(join(home, 'storages', 'session_projcache', 'sessions', `${ID}.json`)), { code: 'ENOENT' })

  // 同槽的另一个会话必须完好，槽目录因此不能被删掉。
  assert.ok(await stat(join(home, 'sessions', SLOT, 'session-keepme')))
  await rm(home, { recursive: true, force: true })
})

test('permanent 模式直接删除目录，不进回收站', async () => {
  const home = await fakeHome()
  const result = await deleteSession({ home, sessionId: ID, mode: 'permanent', now: FIXED_DATE })

  assert.equal(result.mode, 'permanent')
  assert.equal(result.removed[0].trashPath, undefined)
  await assert.rejects(stat(join(home, 'sessions', SLOT, ID)), { code: 'ENOENT' })
  await assert.rejects(stat(join(home, 'session-trash')), { code: 'ENOENT' })
  await rm(home, { recursive: true, force: true })
})

test('重复删除是幂等的：alreadyGone 为 true，不抛错', async () => {
  const home = await fakeHome()
  await deleteSession({ home, sessionId: ID, now: FIXED_DATE })
  const again = await deleteSession({ home, sessionId: ID, now: FIXED_DATE })
  assert.equal(again.alreadyGone, true)
  assert.deepEqual(again.removed, [])
  await rm(home, { recursive: true, force: true })
})

test('非法 id 在任何磁盘操作之前就被拒绝', async () => {
  const home = await fakeHome()
  await assert.rejects(deleteSession({ home, sessionId: '../escape' }), (error) => {
    assert.ok(error instanceof DeleteSessionError)
    assert.equal(error.kind, 'invalid')
    return true
  })
  await rm(home, { recursive: true, force: true })
})

test('home 下没有 sessions 目录时给出可操作的失败', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delete-chat-empty-'))
  await assert.rejects(findSessionDirs(home, ID), (error) => {
    assert.equal(error.kind, 'root')
    return true
  })
  await rm(home, { recursive: true, force: true })
})

test('显式配置优先于环境变量，环境变量优先于 ~/.dsh', () => {
  const original = process.env.DSH_HOME
  process.env.DSH_HOME = 'D:\\from-env'
  assert.equal(resolveDshHome('D:\\from-config'), 'D:\\from-config')
  assert.equal(resolveDshHome(undefined), 'D:\\from-env')
  if (original === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = original
})
