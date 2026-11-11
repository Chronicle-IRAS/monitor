import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { startServer } from '../src/server.js'
import { createFakeFfmpeg, SPS } from './fake-ffmpeg.js'
import { connectWebSocket, getFreeTcpPort, getFreeUdpPort, readJson, waitFor } from './helpers.js'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

async function createApp(t, env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-api-'))
  const config = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    STREAM_HOST: '127.0.0.1',
    RECORD_DIR: path.join(dir, 'records'),
    DATA_DIR: path.join(dir, 'data'),
    UDP_PORT_MIN: '1024',
    UDP_PORT_MAX: '65535',
    HTTP_PORT_MIN: '1024',
    HTTP_PORT_MAX: '65535',
    LOG_LEVEL: 'error',
    FFMPEG_PATH: 'fake-ffmpeg',
    ...env,
  })
  const fake = createFakeFfmpeg()
  const app = await startServer(config, { spawn: fake.spawn, logger: silentLogger })
  t.after(async () => {
    await app.close()
    await fs.rm(dir, { recursive: true, force: true })
  })
  return { app, base: `http://127.0.0.1:${app.port}/api`, dir, fake }
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await readJson(response) }
}

test('节点生命周期、WebSocket/MJPEG 分发、系统指标与录像 API', async (t) => {
  const { app, base, dir } = await createApp(t)

  assert.deepEqual((await readJson(await fetch(`${base}/nodes`))), [])

  const udp = await getFreeUdpPort()
  const http = await getFreeTcpPort()
  const streamNode = { id: 'cam1', udp, http, streamType: 'ffmpeg', isRecord: true }

  const bad = await postJson(`${base}/nodes/start`, { ...streamNode, id: 'bad/id' })
  assert.equal(bad.status, 400)

  const started = await postJson(`${base}/nodes/start`, streamNode)
  assert.equal(started.status, 200)
  assert.equal(started.body.id, 'cam1')
  assert.equal(started.body.streamType, 'ffmpeg')

  const nodes = await readJson(await fetch(`${base}/nodes`))
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].udp, udp)

  const duplicate = await postJson(`${base}/nodes/start`, streamNode)
  assert.equal(duplicate.status, 409)

  const anotherUdp = await getFreeUdpPort()
  const portConflict = await postJson(`${base}/nodes/start`, {
    id: 'cam2',
    udp: anotherUdp,
    http,
    streamType: 'ffmpeg',
  })
  assert.equal(portConflict.status, 409)

  const portCheck = await readJson(
    await fetch(`${base}/ports/check?udp=${udp}&http=${http}`),
  )
  assert.deepEqual(portCheck, { udpUsed: true, httpUsed: true })

  // 等待伪 ffmpeg 产出关键帧，随后验证 WS 秒开缓存（SPS/PPS/IDR）
  await new Promise((resolve) => setTimeout(resolve, 150))
  const client = await connectWebSocket(http)
  const keyframe = await client.nextBinary()
  assert.ok(keyframe.subarray(0, SPS.length).equals(SPS), 'WebSocket 首包应为缓存的 SPS')
  assert.ok(keyframe.includes(Buffer.from([0x65])), 'WebSocket 首包应包含 IDR')
  client.close()

  const status = await readJson(await fetch(`${base}/system/status`))
  for (const key of ['cpuUsage', 'memUsage', 'memTotal', 'uptime', 'recordUsageMB', 'recordPercent', 'diskUsage', 'diskTotal']) {
    assert.ok(key in status, `缺少字段 ${key}`)
  }
  assert.equal(typeof status.cpuUsage, 'number')
  assert.equal(typeof status.recordUsageMB, 'number')
  assert.match(status.memTotal, /GB$/)

  const allPorts = await readJson(await fetch(`${base}/system/all-ports`))
  assert.ok(Array.isArray(allPorts.tcp))
  assert.ok(Array.isArray(allPorts.udp))
  assert.ok(allPorts.tcp.every((port) => Number.isInteger(port)))

  const mjpegUdp = await getFreeUdpPort()
  const mjpegHttp = await getFreeTcpPort()
  const mjpegStarted = await postJson(`${base}/nodes/start`, {
    id: 'cam-mjpeg',
    udp: mjpegUdp,
    http: mjpegHttp,
    streamType: 'mjpeg',
  })
  assert.equal(mjpegStarted.status, 200)

  const controller = new AbortController()
  const mjpegResponse = await fetch(`http://127.0.0.1:${mjpegHttp}/mjpeg`, {
    signal: controller.signal,
  })
  assert.equal(mjpegResponse.status, 200)
  assert.match(mjpegResponse.headers.get('content-type'), /multipart\/x-mixed-replace/)
  const { value } = await mjpegResponse.body.getReader().read()
  const chunk = Buffer.from(value)
  controller.abort()
  assert.ok(chunk.includes(Buffer.from('--frame')), 'MJPEG 响应应包含分隔符')
  assert.ok(chunk.includes(Buffer.from([0xff, 0xd8])), 'MJPEG 响应应包含 JPEG SOI')

  const stopped = await postJson(`${base}/nodes/stop`, { id: 'cam1' })
  assert.equal(stopped.status, 200)
  assert.equal((await readJson(await fetch(`${base}/nodes`))).length, 1)
  await waitFor(async () => {
    const check = await readJson(await fetch(`${base}/ports/check?udp=${udp}&http=${http}`))
    return check.udpUsed === false && check.httpUsed === false
  })

  const missing = await postJson(`${base}/nodes/stop`, { id: 'ghost' })
  assert.equal(missing.status, 404)

  // 前端表单只要求“必填”，中文/空格名称必须可用（路径与 URL 保留字符除外）
  const unicodeNode = await postJson(`${base}/nodes/start`, {
    id: '实验室 A1',
    udp,
    http,
    streamType: 'ffmpeg',
  })
  assert.equal(unicodeNode.status, 200)
  assert.equal(unicodeNode.body.id, '实验室 A1')

  const reset = await postJson(`${base}/nodes/reset`)
  assert.equal(reset.status, 200)
  assert.deepEqual(await readJson(await fetch(`${base}/nodes`)), [])
  await assert.rejects(fetch(`http://127.0.0.1:${mjpegHttp}/mjpeg`))

  // --- 录像 API ---
  const recordsDir = app.config.recordDir
  await fs.mkdir(path.join(recordsDir, 'dev1'), { recursive: true })
  await fs.mkdir(path.join(recordsDir, 'dev2'), { recursive: true })
  const videoBytes = Buffer.alloc(1024 * 1024 + 123, 7)
  await fs.writeFile(path.join(recordsDir, 'dev1', 'rec1.mp4'), videoBytes)
  await fs.writeFile(path.join(recordsDir, 'dev2', 'rec2.mp4'), Buffer.alloc(200 * 1024))

  const tree = await readJson(await fetch(`${base}/records`))
  const dev1 = tree.find((node) => node.deviceId === 'dev1')
  assert.ok(dev1)
  assert.equal(dev1.files.length, 1)
  assert.equal(dev1.files[0].filename, 'rec1.mp4')
  assert.equal(dev1.files[0].size, '1.0 MB')
  assert.match(dev1.files[0].time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

  const download = await fetch(`${base}/records/download/dev1/rec1.mp4`)
  assert.equal(download.status, 200)
  assert.match(download.headers.get('content-disposition'), /attachment/)
  assert.equal((await download.arrayBuffer()).byteLength, videoBytes.length)

  const traversal = await fetch(
    `${base}/records/download/dev1/${encodeURIComponent('../secret.mp4')}`,
  )
  assert.equal(traversal.status, 400)

  const deletedFile = await fetch(`${base}/records/dev1/rec1.mp4`, { method: 'DELETE' })
  assert.equal(deletedFile.status, 200)
  await assert.rejects(fs.stat(path.join(recordsDir, 'dev1', 'rec1.mp4')), /ENOENT/)

  await fs.writeFile(path.join(recordsDir, 'dev1', 'x.mp4'), Buffer.from('x'))
  await fs.writeFile(path.join(recordsDir, 'dev1', 'y.mp4'), Buffer.from('y'))
  const batch = await postJson(`${base}/records/batch-delete`, {
    deviceId: 'dev1',
    filenames: ['x.mp4', 'y.mp4'],
  })
  assert.equal(batch.status, 200)
  assert.equal(batch.body.deleted.length, 2)

  const deletedDevice = await fetch(`${base}/records/dev2`, { method: 'DELETE' })
  assert.equal(deletedDevice.status, 200)
  await assert.rejects(fs.stat(path.join(recordsDir, 'dev2')), /ENOENT/)
  assert.ok(dir.length > 0)
})

test('ADMIN_TOKEN 启用后写操作与录像读取需要令牌', async (t) => {
  const { app, base } = await createApp(t, { ADMIN_TOKEN: 's3cret' })

  const denied = await fetch(`${base}/nodes/reset`, { method: 'POST' })
  assert.equal(denied.status, 401)

  const allowed = await fetch(`${base}/nodes/reset`, {
    method: 'POST',
    headers: { 'x-admin-token': 's3cret' },
  })
  assert.equal(allowed.status, 200)

  assert.equal((await fetch(`${base}/records`)).status, 401)
  assert.equal((await fetch(`${base}/records?token=s3cret`)).status, 200)
  assert.equal((await fetch(`${base}/nodes`)).status, 200)

  await fs.mkdir(path.join(app.config.recordDir, 'dev1'), { recursive: true })
  await fs.writeFile(path.join(app.config.recordDir, 'dev1', 'v.mp4'), Buffer.from('video'))
  const download = await fetch(`${base}/records/download/dev1/v.mp4?token=s3cret`)
  assert.equal(download.status, 200)
  assert.equal(await download.text(), 'video')
})
