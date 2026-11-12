import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'

/**
 * CAM-WEB (FTDBWLZ/CAM-WEB) ESP32-S3 摄像头的真实 UDP 视频协议：
 *
 *   数据报 = 4 字节大端序 JPEG 字节偏移量 + 最多 1400 字节 JPEG 数据
 *   帧结束 = 仅 4 字节 0xFFFFFFFF 的数据报
 *
 * 协议没有帧号、总长度或设备 ID，因此每个节点必须独占一个 UDP 端口，
 * 且重组状态按来源地址（IP:端口）隔离。
 */
export const JPEG_UDP_STREAM_TYPE = 'jpeg-udp'
export const JPEG_UDP_HEADER_BYTES = 4
export const JPEG_UDP_MAX_PAYLOAD = 1400
export const JPEG_UDP_EOF = 0xffffffff

const DEFAULT_INITIAL_FRAME_BYTES = 64 * 1024
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024
const DEFAULT_FRAME_TIMEOUT_MS = 2000
const DEFAULT_SOURCE_IDLE_MS = 30_000
const DEFAULT_MAX_SOURCES = 64
const DEFAULT_SWEEP_MS = 250

function startsWithSoi(payload) {
  return payload.length >= 2 && payload[0] === 0xff && payload[1] === 0xd8
}

function endsWithEoi(buffer, end) {
  return end >= 2 && buffer[end - 2] === 0xff && buffer[end - 1] === 0xd9
}

/**
 * 单来源的 JPEG 分片重组器。
 * - offset 是帧内绝对字节偏移，可直接定位写入，天然支持乱序与重复包；
 * - 只有 [0, contiguousEnd) 完全连续且以 EOI 结尾时才产出帧；
 * - 丢包造成的空洞无法修补，整帧丢弃并在下一帧 offset=0 时重新同步；
 * - EOF 丢失时可由连续数据末尾的 EOI 判定完成，超时则清理。
 */
export class JpegFrameAssembler {
  constructor({
    frameTimeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    initialFrameBytes = DEFAULT_INITIAL_FRAME_BYTES,
  } = {}) {
    this.frameTimeoutMs = frameTimeoutMs
    this.maxFrameBytes = Math.max(JPEG_UDP_HEADER_BYTES + 2, maxFrameBytes)
    this.initialFrameBytes = Math.min(this.maxFrameBytes, Math.max(1024, initialFrameBytes))
    this.#reset(0)
  }

  get lastActivityAt() {
    return this.lastAt
  }

  get pendingBytes() {
    return this.maxEnd
  }

  /** 连续前缀长度；只有从 offset 0 开始的连续区间才算数。 */
  get contiguousEnd() {
    const first = this.ranges[0]
    return first && first.start === 0 ? first.end : 0
  }

  /**
   * 处理一个 UDP 数据报。
   * @returns {{ frame: Buffer | null, dropped: boolean }}
   */
  ingest(packet, now = Date.now()) {
    if (!Buffer.isBuffer(packet) || packet.length < JPEG_UDP_HEADER_BYTES) {
      return { frame: null, dropped: false }
    }

    const offset = packet.readUInt32BE(0)
    if (packet.length === JPEG_UDP_HEADER_BYTES) {
      if (offset === JPEG_UDP_EOF) return this.#finish(now)
      return { frame: null, dropped: false }
    }

    const payload = packet.subarray(JPEG_UDP_HEADER_BYTES)
    if (offset + payload.length > this.maxFrameBytes) {
      this.#finish(now)
      this.#reset(now)
      return { frame: null, dropped: true }
    }

    if (offset === 0) {
      // 新一帧必须从 SOI 开始；否则视为噪声，不破坏已有的重组状态。
      if (!startsWithSoi(payload)) return { frame: null, dropped: false }

      if (this.hasStart) {
        // 已有帧头时再次收到 offset=0：重复包直接忽略，否则视为新帧覆盖旧残留。
        const first = this.ranges[0]
        if (
          first &&
          first.start === 0 &&
          first.end >= payload.length &&
          this.buffer.subarray(0, payload.length).equals(payload)
        ) {
          this.lastAt = now
          return { frame: null, dropped: false }
        }
        this.#finish(now)
        this.#reset(now)
        this.#write(offset, payload)
        this.hasStart = true
        this.lastAt = now
        return { frame: this.#complete(now), dropped: true }
      }

      // 帧头可能因网络乱序晚于后续分片到达，此时保留已收到的分片一起重组。
      this.#write(offset, payload)
      this.hasStart = true
      this.lastAt = now
      return { frame: this.#complete(now), dropped: false }
    }

    this.#write(offset, payload)
    this.lastAt = now
    return { frame: this.#complete(now), dropped: false }
  }

  /** 定期清理：超时帧能补全则产出（EOF 丢失），否则丢弃。 */
  sweep(now = Date.now()) {
    if (this.lastAt === 0 || now - this.lastAt <= this.frameTimeoutMs) {
      return { frame: null, dropped: false }
    }
    return this.#finish(now)
  }

  #write(offset, payload) {
    const needed = offset + payload.length
    if (needed > this.buffer.length) {
      const capacity = Math.min(
        this.maxFrameBytes,
        Math.max(needed, Math.max(this.initialFrameBytes, this.buffer.length * 2)),
      )
      if (capacity < needed) return
      const next = Buffer.allocUnsafe(capacity)
      if (this.maxEnd > 0) this.buffer.copy(next, 0, 0, this.maxEnd)
      this.buffer = next
    }

    payload.copy(this.buffer, offset)
    this.maxEnd = Math.max(this.maxEnd, needed)

    let merged = { start: offset, end: needed }
    const ranges = []
    for (const range of this.ranges) {
      if (range.end < merged.start || range.start > merged.end) ranges.push(range)
      else {
        merged.start = Math.min(merged.start, range.start)
        merged.end = Math.max(merged.end, range.end)
      }
    }
    ranges.push(merged)
    ranges.sort((a, b) => a.start - b.start)
    this.ranges = ranges
  }

  #complete(now) {
    const end = this.contiguousEnd
    if (this.hasStart && end >= JPEG_UDP_HEADER_BYTES && endsWithEoi(this.buffer, end)) {
      const frame = Buffer.from(this.buffer.subarray(0, end))
      this.#reset(now)
      return frame
    }
    return null
  }

  #finish(now) {
    const frame = this.#complete(now)
    if (frame) return { frame, dropped: false }
    const dropped = this.maxEnd > 0
    this.#reset(now)
    return { frame: null, dropped }
  }

  #reset(now) {
    this.buffer = Buffer.allocUnsafe(this.initialFrameBytes)
    this.ranges = []
    this.maxEnd = 0
    this.hasStart = false
    this.lastAt = now
  }
}

/**
 * 节点级 UDP 接收器：一个 socket 对应一个节点端口，
 * 按来源隔离重组状态，产出完整 JPEG 帧。
 */
export class JpegUdpReceiver extends EventEmitter {
  constructor({
    node,
    config,
    log,
    dgramModule = dgram,
    now = () => Date.now(),
    frameTimeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
    sourceIdleMs = DEFAULT_SOURCE_IDLE_MS,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    maxSources = DEFAULT_MAX_SOURCES,
    sweepMs = DEFAULT_SWEEP_MS,
  }) {
    super()
    this.node = node
    this.config = config
    this.log = log
    this.dgramModule = dgramModule
    this.now = now
    this.frameTimeoutMs = frameTimeoutMs
    this.sourceIdleMs = sourceIdleMs
    this.maxFrameBytes = maxFrameBytes
    this.maxSources = maxSources
    this.sweepMs = sweepMs

    this.socket = null
    this.timer = null
    this.sources = new Map()
    this.running = false
    this.packets = 0
    this.bytes = 0
    this.frames = 0
    this.dropped = 0
    this.timeouts = 0
    this.lastFrameAt = 0
  }

  get stats() {
    return {
      running: this.running,
      packets: this.packets,
      bytes: this.bytes,
      frames: this.frames,
      dropped: this.dropped,
      timeouts: this.timeouts,
      sources: this.sources.size,
      lastFrameAt: this.lastFrameAt,
    }
  }

  async start() {
    if (this.running) return
    const host = this.config?.udpBindHost ?? '0.0.0.0'
    const socket = this.dgramModule.createSocket({ type: 'udp4' })

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.off('error', onError)
        socket.off('listening', onListening)
      }
      const onError = (error) => {
        cleanup()
        try {
          socket.close()
        } catch {
          // 尚未绑定或已关闭
        }
        reject(error)
      }
      const onListening = () => {
        cleanup()
        resolve()
      }
      socket.once('error', onError)
      socket.once('listening', onListening)
      socket.bind({ port: this.node.udp, address: host, exclusive: true })
    })

    socket.on('message', (packet, rinfo) => this.#onPacket(packet, rinfo))
    socket.on('error', (error) => {
      this.running = false
      this.emit('error', error)
    })

    this.socket = socket
    this.running = true
    this.timer = setInterval(() => this.sweep(), this.sweepMs)
    this.timer.unref?.()
    this.log?.info?.(`[${this.node.id}] JPEG UDP 接收器已监听 ${host}:${this.node.udp}`)
  }

  #onPacket(packet, rinfo) {
    const now = this.now()
    this.packets += 1
    this.bytes += packet.length

    const key = `${rinfo.address}:${rinfo.port}`
    let source = this.sources.get(key)
    if (!source) {
      if (this.sources.size >= this.maxSources) {
        // 防止伪造来源耗尽内存：淘汰最久未活动的重组器。
        let oldestKey = null
        let oldestAt = Infinity
        for (const [sourceKey, candidate] of this.sources) {
          if (candidate.lastSeen < oldestAt) {
            oldestAt = candidate.lastSeen
            oldestKey = sourceKey
          }
        }
        if (oldestKey !== null) this.sources.delete(oldestKey)
      }
      source = {
        assembler: new JpegFrameAssembler({
          frameTimeoutMs: this.frameTimeoutMs,
          maxFrameBytes: this.maxFrameBytes,
        }),
        lastSeen: now,
      }
      this.sources.set(key, source)
    }
    source.lastSeen = now

    const result = source.assembler.ingest(packet, now)
    this.#collect(result, rinfo, now)
  }

  #collect(result, rinfo, now) {
    if (result.dropped) this.dropped += 1
    if (!result.frame) return
    this.frames += 1
    this.lastFrameAt = now
    this.emit('frame', result.frame, {
      address: rinfo?.address,
      port: rinfo?.port,
      at: now,
    })
  }

  sweep(now = this.now()) {
    for (const [key, source] of this.sources) {
      const timedOut =
        source.assembler.pendingBytes > 0 &&
        now - source.assembler.lastActivityAt > this.frameTimeoutMs
      const result = source.assembler.sweep(now)
      if (result.frame || result.dropped) this.#collect(result, null, now)
      if (timedOut && !result.frame) this.timeouts += 1
      if (now - source.lastSeen > this.sourceIdleMs) this.sources.delete(key)
    }
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const socket = this.socket
    this.socket = null
    this.running = false
    this.sources.clear()
    if (!socket) return
    await new Promise((resolve) => {
      try {
        socket.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }
}
