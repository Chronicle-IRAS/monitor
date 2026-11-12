import test from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  JPEG_UDP_EOF,
  JPEG_UDP_MAX_PAYLOAD,
  JpegFrameAssembler,
  JpegUdpReceiver,
} from '../src/jpeg-udp.js'
import { buildJpegRecorderArgs } from '../src/recorder.js'
import { loadConfig } from '../src/config.js'
import { startServer } from '../src/server.js'
import { createFakeFfmpeg } from './fake-ffmpeg.js'
import { getFreeTcpPort, getFreeUdpPort, readJson, waitFor } from './helpers.js'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

// 真实 1x1 JPEG（SOI ... EOI），在 SOI 后插入 COM 段把帧撑到多分片，
// 保证测试覆盖硬件 1400 字节分片与 4 字节大端偏移量，而不是标准 MJPEG 流。
const BASE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
)
const COM_FILLER = Buffer.alloc(4000, 0x5a)
const COM_SEGMENT = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), COM_FILLER])
COM_SEGMENT.writeUInt16BE(2 + COM_FILLER.length, 2)
export const HARDWARE_JPEG = Buffer.concat([
  BASE_JPEG.subarray(0, 2),
  COM_SEGMENT,
  BASE_JPEG.subarray(2),
])
const OFFSET_ONE_PACKET = 1400

/** 完全按 CAM-WEB src/main.c send_frame() 生成数据报。 */
export function hardwarePackets(jpeg, { chunkSize = JPEG_UDP_MAX_PAYLOAD, eof = true } = {}) {
  const packets = []
  for (let offset = 0; offset < jpeg.length; offset += chunkSize) {
    const chunk = jpeg.subarray(offset, Math.min(offset + chunkSize, jpeg.length))
    const packet = Buffer.alloc(4 + chunk.length)
    packet.writeUInt32BE(offset, 0)
    chunk.copy(packet, 4)
    packets.push(packet)
  }
  if (eof) packets.push(Buffer.from([0xff, 0xff, 0xff, 0xff]))
  return packets
}

function feed(assembler, packets, now = Date.now()) {
  const frames = []
  let dropped = 0
  for (const packet of packets) {
    const result = assembler.ingest(packet, now)
    if (result.frame) frames.push(result.frame)
    if (result.dropped) dropped += 1
  }
  return { frames, dropped }
}

async function sendPackets(port, packets, { order } = {}) {
  const socket = dgram.createSocket('udp4')
  try {
    const ordered = order ? order(packets) : packets
    for (const packet of ordered) {
      await new Promise((resolve, reject) => {
        socket.send(packet, port, '127.0.0.1', (error) => (error ? reject(error) : resolve()))
      })
    }
  } finally {
    socket.close()
  }
}

test('硬件数据报：4 字节大端偏移 + 1400 字节载荷 + 0xFFFFFFFF 帧结束', () => {
  const packets = hardwarePackets(HARDWARE_JPEG)
  assert.ok(HARDWARE_JPEG.length > JPEG_UDP_MAX_PAYLOAD * 2, '测试帧必须跨多个分片')
  assert.equal(packets.length, Math.ceil(HARDWARE_JPEG.length / 1400) + 1)

  assert.equal(packets[0].readUInt32BE(0), 0)
  assert.ok(packets[0].subarray(4, 6).equals(Buffer.from([0xff, 0xd8])))
  assert.equal(packets[1].readUInt32BE(0), OFFSET_ONE_PACKET)
  assert.ok(packets[1].length <= 4 + JPEG_UDP_MAX_PAYLOAD)
  assert.equal(packets.at(-1).readUInt32BE(0), JPEG_UDP_EOF)
  assert.ok(packets.at(-1).equals(Buffer.from([0xff, 0xff, 0xff, 0xff])))
})

test('重组：顺序分片完整还原 JPEG', () => {
  const assembler = new JpegFrameAssembler()
  const { frames, dropped } = feed(assembler, hardwarePackets(HARDWARE_JPEG))
  assert.equal(dropped, 0)
  assert.equal(frames.length, 1)
  assert.ok(frames[0].equals(HARDWARE_JPEG))
  assert.equal(assembler.pendingBytes, 0)
})

test('重组：乱序到达仍按偏移量还原', () => {
  const packets = hardwarePackets(HARDWARE_JPEG)
  const assembler = new JpegFrameAssembler()
  const { frames } = feed(assembler, [...packets.slice(0, -1).reverse(), packets.at(-1)])
  assert.equal(frames.length, 1)
  assert.ok(frames[0].equals(HARDWARE_JPEG))
})

test('重组：重复数据报不产生重复帧', () => {
  const packets = hardwarePackets(HARDWARE_JPEG)
  const duplicated = packets.flatMap((packet) => [packet, packet])
  const assembler = new JpegFrameAssembler()
  const { frames } = feed(assembler, duplicated)
  assert.equal(frames.length, 1, '重复数据报不能产出第二帧')
  assert.ok(frames[0].equals(HARDWARE_JPEG))
})

test('丢包：中间分片缺失时整帧丢弃，下一帧重新同步', () => {
  const packets = hardwarePackets(HARDWARE_JPEG)
  const missing = [packets[0], packets[1], ...packets.slice(3)]
  const assembler = new JpegFrameAssembler()
  const first = feed(assembler, missing)
  assert.equal(first.frames.length, 0)
  assert.equal(first.dropped, 1)

  const second = feed(assembler, hardwarePackets(HARDWARE_JPEG))
  assert.equal(second.frames.length, 1)
  assert.ok(second.frames[0].equals(HARDWARE_JPEG))
})

test('丢包：首分片缺失时不产出半个帧，下一帧重新同步', () => {
  const packets = hardwarePackets(HARDWARE_JPEG)
  const assembler = new JpegFrameAssembler()
  const first = feed(assembler, packets.slice(1))
  assert.equal(first.frames.length, 0)
  assert.equal(first.dropped, 1)

  const second = feed(assembler, hardwarePackets(HARDWARE_JPEG))
  assert.equal(second.frames.length, 1)
  assert.ok(second.frames[0].equals(HARDWARE_JPEG))
})

test('丢包：EOF 丢失时由连续数据末尾的 EOI 立即完成', () => {
  const assembler = new JpegFrameAssembler({ frameTimeoutMs: 1000 })
  const now = 1_000_000
  const packets = hardwarePackets(HARDWARE_JPEG, { eof: false })
  const first = feed(assembler, packets, now)
  assert.equal(first.frames.length, 1, '完整数据末尾即 EOI，无需等待 EOF')
  assert.ok(first.frames[0].equals(HARDWARE_JPEG))
  assert.equal(assembler.pendingBytes, 0)

  // 迟到的 EOF 属于已完成的帧，不能产生重复帧或错误丢弃。
  const lateEof = assembler.ingest(Buffer.from([0xff, 0xff, 0xff, 0xff]), now + 10)
  assert.equal(lateEof.frame, null)
  assert.equal(lateEof.dropped, false)
})

test('超时：残缺帧被清理且不污染下一帧', () => {
  const assembler = new JpegFrameAssembler({ frameTimeoutMs: 100 })
  const packets = hardwarePackets(HARDWARE_JPEG)
  feed(assembler, [packets[0], packets[1]], 1000)
  const swept = assembler.sweep(1200)
  assert.equal(swept.frame, null)
  assert.equal(swept.dropped, true)
  assert.equal(assembler.pendingBytes, 0)

  const next = feed(assembler, hardwarePackets(HARDWARE_JPEG), 1300)
  assert.equal(next.frames.length, 1)
})

test('噪声：非 SOI 帧头、过短数据报与超大偏移被忽略', () => {
  const assembler = new JpegFrameAssembler({ maxFrameBytes: 2000, frameTimeoutMs: 100 })
  const noise = Buffer.concat([Buffer.alloc(4), Buffer.from('Verify')])
  assert.equal(assembler.ingest(noise).frame, null)
  assert.equal(assembler.ingest(Buffer.from([0xff])).dropped, false)
  assert.equal(assembler.ingest(Buffer.from([0, 0, 0, 0, 1])).dropped, false)

  const oversize = Buffer.alloc(4 + 10)
  oversize.writeUInt32BE(5000, 0)
  assert.equal(assembler.ingest(oversize).dropped, true)
  assert.equal(assembler.pendingBytes, 0)
})

test('真实 UDP：按硬件数据报发送，乱序也产出完整帧并统计超时来源', async (t) => {
  const port = await getFreeUdpPort()
  const receiver = new JpegUdpReceiver({
    node: { id: 'udp-receiver', udp: port },
    config: { udpBindHost: '127.0.0.1' },
    log: silentLogger,
    frameTimeoutMs: 200,
    sourceIdleMs: 300,
  })
  const frames = []
  receiver.on('frame', (frame) => frames.push(frame))
  await receiver.start()
  t.after(() => receiver.stop())
  assert.equal(receiver.running, true)

  const packets = hardwarePackets(HARDWARE_JPEG)
  await sendPackets(port, packets, {
    order: (list) => [...list.slice(0, -1).reverse(), list.at(-1)],
  })
  await waitFor(() => frames.length > 0)
  assert.ok(frames[0].equals(HARDWARE_JPEG))
  assert.equal(receiver.stats.frames, 1)
  assert.ok(receiver.stats.packets >= packets.length)
  assert.equal(receiver.stats.sources, 1)

  // 残缺帧（缺中间分片）：不应产出，超时后计为丢弃。
  await sendPackets(port, [packets[0], packets[1], ...packets.slice(3)])
  await waitFor(() => receiver.stats.dropped >= 1)
  assert.equal(receiver.stats.frames, 1)

  // 没有 EOF 的残帧：超时清理，不产出半帧。
  await sendPackets(port, [packets[0], packets[1]])
  await waitFor(() => receiver.stats.timeouts >= 1, 3000)
  assert.equal(receiver.stats.frames, 1)

  const stopped = receiver.stop()
  await stopped
  assert.equal(receiver.running, false)
})

async function createApp(t, env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-jpeg-'))
  const config = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    STREAM_HOST: '127.0.0.1',
    UDP_BIND_HOST: '127.0.0.1',
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
  return { app, fake, base: `http://127.0.0.1:${app.port}/api` }
}

async function readUntil(reader, needle, timeout = 3000) {
  const chunks = []
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) chunks.push(Buffer.from(value))
    const all = Buffer.concat(chunks)
    if (all.includes(needle)) return all
  }
  return Buffer.concat(chunks)
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await readJson(response) }
}

test('API：jpeg-udp 节点不启动 ffmpeg，/mjpeg 原样分发重组帧', async (t) => {
  const { app, fake, base } = await createApp(t)
  const udp = await getFreeUdpPort()
  const http = await getFreeTcpPort()

  const started = await postJson(`${base}/nodes/start`, {
    id: 'cam-jpeg',
    udp,
    http,
    streamType: 'jpeg-udp',
    isRecord: false,
  })
  assert.equal(started.status, 200)
  assert.equal(started.body.streamType, 'jpeg-udp')
  assert.equal(started.body.status, 'online')
  assert.equal(fake.children.length, 0, '实时 MJPEG 分发不应启动 ffmpeg')

  await sendPackets(udp, hardwarePackets(HARDWARE_JPEG))
  await waitFor(async () => {
    const nodes = await readJson(await fetch(`${base}/nodes`))
    return nodes[0]?.rxFrames >= 1
  })

  const nodes = await readJson(await fetch(`${base}/nodes`))
  assert.equal(nodes[0].rxFrames, 1)
  assert.ok(nodes[0].rxPackets >= 4)
  assert.ok(nodes[0].lastFrameAt > 0)
  assert.equal(nodes[0].status, 'online')

  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${http}/mjpeg`, { signal: controller.signal })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /multipart\/x-mixed-replace/)
  const chunk = Buffer.from(await readUntil(response.body.getReader(), HARDWARE_JPEG))
  controller.abort()
  assert.ok(chunk.includes(Buffer.from('--frame')))
  assert.ok(chunk.includes(Buffer.from('Content-Type: image/jpeg')))
  assert.ok(chunk.includes(HARDWARE_JPEG), 'MJPEG 必须包含硬件重组出的完整 JPEG')

  const status = await readJson(await fetch(`http://127.0.0.1:${http}/status`))
  assert.equal(status.streamType, 'jpeg-udp')
  assert.equal(status.rx.frames, 1)
  assert.equal(app.nodes.list()[0].udp, udp)
})

test('录制：isRecord 开启后仅在首帧到达时按需启动 ffmpeg 并原样写入 JPEG', async (t) => {
  const { app, fake, base } = await createApp(t)
  const udp = await getFreeUdpPort()
  const http = await getFreeTcpPort()

  const started = await postJson(`${base}/nodes/start`, {
    id: 'cam-record',
    udp,
    http,
    streamType: 'jpeg-udp',
    isRecord: true,
  })
  assert.equal(started.status, 200)
  assert.equal(fake.children.length, 0, '没有帧时不应保留空转 ffmpeg')

  await sendPackets(udp, hardwarePackets(HARDWARE_JPEG))
  await waitFor(() => fake.children.length === 1)

  const child = fake.children[0]
  assert.equal(child.command, 'fake-ffmpeg')
  assert.ok(child.args.includes('-f'))
  assert.ok(child.args.includes('mjpeg'))
  assert.ok(child.args.includes('pipe:0'))
  assert.ok(child.args.includes('libx264'))
  assert.ok(child.args.includes('movflags=+frag_keyframe+empty_moov+default_base_moof'))
  assert.ok(
    child.args.some((arg) => arg.includes(path.join('records', 'cam-record'))),
    '录像输出必须按设备 ID 分目录',
  )

  await waitFor(() => Buffer.concat(child.stdinChunks).length >= HARDWARE_JPEG.length)
  const written = Buffer.concat(child.stdinChunks)
  assert.ok(written.subarray(0, HARDWARE_JPEG.length).equals(HARDWARE_JPEG))

  const stopped = await postJson(`${base}/nodes/stop`, { id: 'cam-record' })
  assert.equal(stopped.status, 200)
  await waitFor(() => child.stdinEnded === true)
  assert.equal(app.nodes.list().length, 0)
})

test('节点持久化：jpeg-udp 类型在重启后恢复并重新监听', async (t) => {
  const { app, base } = await createApp(t)
  const udp = await getFreeUdpPort()
  const http = await getFreeTcpPort()

  const started = await postJson(`${base}/nodes/start`, {
    id: 'cam-persist',
    udp,
    http,
    streamType: 'jpeg-udp',
    isRecord: false,
  })
  assert.equal(started.status, 200)

  await app.nodes.shutdown()
  const saved = JSON.parse(await fs.readFile(app.config.stateFile, 'utf8'))
  assert.deepEqual(saved, [
    { id: 'cam-persist', udp, http, streamType: 'jpeg-udp', isRecord: false },
  ])

  await app.nodes.init()
  const restored = app.nodes.list()
  assert.equal(restored.length, 1)
  assert.equal(restored[0].streamType, 'jpeg-udp')
  assert.equal(restored[0].status, 'online')

  await sendPackets(udp, hardwarePackets(HARDWARE_JPEG))
  await waitFor(() => app.nodes.list()[0].rxFrames >= 1)
  await app.nodes.reset()
})

test('录制 ffmpeg 参数使用硬件 JPEG 解复用器与 MP4 分段', () => {
  const args = buildJpegRecorderArgs(
    { id: 'cam' },
    {
      recordDir: '/records',
      segmentSeconds: 60,
      jpegRecordFps: 15,
    },
  )
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-i')), [
    '-f',
    'mjpeg',
    '-use_wallclock_as_timestamps',
    '1',
  ])
  assert.ok(args.includes('pipe:0'))
  assert.ok(args.includes('libx264'))
  assert.ok(args.includes('-segment_time'))
  assert.ok(args.includes('movflags=+frag_keyframe+empty_moov+default_base_moof'))
  assert.match(args.at(-1), /cam_[0-9a-f]{8}_%Y%m%d_%H%M%S\.mp4$/)
})
