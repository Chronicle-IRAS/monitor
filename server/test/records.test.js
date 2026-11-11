import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RecordStore } from '../src/records.js'

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }

async function createStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-records-'))
  const store = new RecordStore({ config: { recordDir: dir, recordPoolMb: 1 }, log: silentLog })
  await store.ensureRoot()
  return { dir, store }
}

test('录像树：按设备分组、新文件在前、大小与时间格式兼容前端', async (t) => {
  const { dir, store } = await createStore()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  await fs.mkdir(path.join(dir, 'dev1'))
  await fs.writeFile(path.join(dir, 'dev1', 'a.mp4'), Buffer.alloc(1024 * 1024))
  await new Promise((resolve) => setTimeout(resolve, 20))
  await fs.writeFile(path.join(dir, 'dev1', 'b.mp4'), Buffer.alloc(512 * 1024))

  const tree = await store.tree()
  assert.equal(tree.length, 1)
  assert.equal(tree[0].deviceId, 'dev1')
  assert.deepEqual(
    tree[0].files.map((file) => file.filename),
    ['b.mp4', 'a.mp4'],
  )
  assert.equal(tree[0].files[0].size, '0.5 MB')
  assert.equal(tree[0].files[1].size, '1.0 MB')
  assert.match(tree[0].files[0].time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})

test('录像池：超出上限时按最旧优先删除并保护正在写入的分段', async (t) => {
  const { dir, store } = await createStore()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const files = [
    ['dev1', 'old.mp4'],
    ['dev1', 'mid.mp4'],
    ['dev2', 'new.mp4'],
  ]
  const now = Date.now()
  for (let i = 0; i < files.length; i++) {
    const [device, name] = files[i]
    await fs.mkdir(path.join(dir, device), { recursive: true })
    const target = path.join(dir, device, name)
    await fs.writeFile(target, Buffer.alloc(600 * 1024))
    const seconds = now / 1000 - (180 - i * 60)
    await fs.utimes(target, seconds, seconds)
  }

  const result = await store.enforcePool({ now, protectMs: 0 })
  assert.equal(result.removed, 2)
  assert.equal((await store.usageBytes()), 600 * 1024)
  await assert.rejects(fs.stat(path.join(dir, 'dev1', 'old.mp4')), /ENOENT/)
  await assert.rejects(fs.stat(path.join(dir, 'dev1', 'mid.mp4')), /ENOENT/)
  assert.ok((await fs.stat(path.join(dir, 'dev2', 'new.mp4'))).isFile())

  const protectedResult = await store.enforcePool({ now, protectMs: 24 * 3600 * 1000 })
  assert.equal(protectedResult.removed, 0)
})

test('录像删除与路径校验', async (t) => {
  const { dir, store } = await createStore()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  await fs.mkdir(path.join(dir, 'dev1'))
  await fs.writeFile(path.join(dir, 'dev1', 'a.mp4'), Buffer.from('abc'))
  await fs.writeFile(path.join(dir, 'dev1', 'b.mp4'), Buffer.from('abc'))

  await assert.rejects(store.fileInfo('dev1', '../secret.mp4'), /非法/)
  await assert.rejects(store.fileInfo('..', 'a.mp4'), /非法/)
  await assert.rejects(store.fileInfo('dev1', 'missing.mp4'), (error) => error.status === 404)

  const batch = await store.deleteFiles('dev1', ['a.mp4', 'missing.mp4'])
  assert.deepEqual(batch.deleted, ['a.mp4'])
  assert.equal(batch.failed.length, 1)

  await store.deleteDevice('dev1')
  await assert.rejects(fs.stat(path.join(dir, 'dev1')), /ENOENT/)
  await assert.rejects(store.deleteDevice('dev1'), (error) => error.status === 404)
})
