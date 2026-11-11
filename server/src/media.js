const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024

function findStartCode(buffer, from) {
  for (let i = from; i + 2 < buffer.length; i++) {
    if (buffer[i] !== 0 || buffer[i + 1] !== 0) continue
    if (buffer[i + 2] === 1) return i
    if (buffer[i + 2] === 0 && i + 3 < buffer.length && buffer[i + 3] === 1) return i
  }
  return -1
}

/**
 * 按 Annex-B 起始码切分 H.264 码流，支持任意分块边界。
 * 返回的每个元素都包含前导起始码。
 */
export class AnnexBSplitter {
  constructor({ maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
    this.buffer = Buffer.alloc(0)
    this.maxBuffer = maxBuffer
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const nals = []
    let searchFrom = 0
    let lastStart = -1

    while (true) {
      const index = findStartCode(this.buffer, searchFrom)
      if (index === -1) break
      if (lastStart !== -1) nals.push(this.buffer.subarray(lastStart, index))
      lastStart = index
      searchFrom = index + (this.buffer[index + 2] === 1 ? 3 : 4)
    }

    if (lastStart === -1) {
      // 尚无起始码：保留少量尾部字节，防止脏数据无限增长。
      if (this.buffer.length > this.maxBuffer) {
        this.buffer = this.buffer.subarray(this.buffer.length - 3)
      }
      return nals
    }

    this.buffer = this.buffer.subarray(lastStart)
    if (this.buffer.length > this.maxBuffer) this.buffer = Buffer.alloc(0)
    return nals
  }
}

export function nalType(nal) {
  if (nal.length < 3) return -1
  const offset = nal[2] === 1 ? 3 : 4
  if (nal.length <= offset) return -1
  return nal[offset] & 0x1f
}

/**
 * 缓存最近一个 IDR 起始的 GOP（含 SPS/PPS），用于 WebSocket 新客户端秒开。
 */
export class H264KeyframeCache {
  constructor({ maxSize = DEFAULT_MAX_BUFFER } = {}) {
    this.sps = null
    this.pps = null
    this.gop = []
    this.size = 0
    this.maxSize = maxSize
  }

  push(nal) {
    const type = nalType(nal)
    if (type === 7) {
      this.sps = nal
      return
    }
    if (type === 8) {
      this.pps = nal
      return
    }
    if (type === 5) {
      this.gop = []
      this.size = 0
      if (this.sps) {
        this.gop.push(this.sps)
        this.size += this.sps.length
      }
      if (this.pps) {
        this.gop.push(this.pps)
        this.size += this.pps.length
      }
      this.gop.push(nal)
      this.size += nal.length
      return
    }
    if (this.gop.length === 0) return
    this.gop.push(nal)
    this.size += nal.length
    if (this.size > this.maxSize) {
      // 长时间没有新关键帧时放弃缓存，等待下一个 IDR，避免内存膨胀。
      this.gop = []
      this.size = 0
    }
  }

  snapshot() {
    return this.gop.length ? Buffer.concat(this.gop) : Buffer.alloc(0)
  }
}

/**
 * 从 ffmpeg image2pipe 输出中切分完整 JPEG 帧（SOI ... EOI）。
 */
export class JpegFramer {
  constructor({ maxBuffer = 8 * 1024 * 1024 } = {}) {
    this.buffer = Buffer.alloc(0)
    this.maxBuffer = maxBuffer
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const frames = []

    while (true) {
      const start = this.buffer.indexOf(Buffer.from([0xff, 0xd8]))
      if (start === -1) {
        if (this.buffer.length > 2) this.buffer = this.buffer.subarray(this.buffer.length - 1)
        break
      }
      if (start > 0) this.buffer = this.buffer.subarray(start)

      let end = -1
      for (let i = 2; i + 1 < this.buffer.length; i++) {
        if (this.buffer[i] === 0xff && this.buffer[i + 1] === 0xd9) {
          end = i
          break
        }
      }
      if (end === -1) break

      frames.push(this.buffer.subarray(0, end + 2))
      this.buffer = this.buffer.subarray(end + 2)
    }

    if (this.buffer.length > this.maxBuffer) this.buffer = Buffer.alloc(0)
    return frames
  }
}
