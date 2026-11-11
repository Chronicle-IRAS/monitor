import { createHash } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_INBOUND = 512 * 1024
const MAX_BACKLOG = 8 * 1024 * 1024

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
}

export function encodeFrame(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/**
 * 极简 WebSocket 服务端：只实现视频分发所需的握手、二进制帧、ping/pong 与关闭。
 * 零依赖，避免为单条下行流引入第三方库。
 */
export class WsHub {
  constructor({
    path = '/stream',
    log = console,
    onOpen,
    onClose,
    pingInterval = 30_000,
    timeout = 90_000,
  } = {}) {
    this.path = path
    this.log = log
    this.onOpen = onOpen
    this.onClose = onClose
    this.pingInterval = pingInterval
    this.timeout = timeout
    this.clients = new Set()
    this.timer = setInterval(() => this.#ping(), this.pingInterval)
    this.timer.unref?.()
  }

  get size() {
    return this.clients.size
  }

  handleUpgrade(req, socket, head) {
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      this.#reject(socket, 400, 'Bad Request')
      return
    }
    if (pathname !== this.path) {
      this.#reject(socket, 404, 'Not Found')
      return
    }

    const key = req.headers['sec-websocket-key']
    const version = req.headers['sec-websocket-version']
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase()
    if (upgrade !== 'websocket' || typeof key !== 'string' || version !== '13') {
      this.#reject(socket, 400, 'Bad Request')
      return
    }

    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.setNoDelay?.(true)
    socket.setTimeout(0)

    const client = { socket, buffer: Buffer.alloc(0), pongAt: Date.now(), closed: false }
    this.clients.add(client)
    socket.on('data', (chunk) => this.#onData(client, chunk))
    socket.on('error', () => this.#cleanup(client))
    socket.on('close', () => this.#cleanup(client))
    if (head && head.length > 0) this.#onData(client, head)

    try {
      this.onOpen?.(client)
    } catch (error) {
      this.log.warn?.(`WebSocket onOpen 回调异常: ${error.message}`)
    }
  }

  send(client, data) {
    if (!client || client.closed || client.socket.destroyed) return
    if (client.socket.writableLength > MAX_BACKLOG) {
      this.#terminate(client)
      return
    }
    this.#write(client, encodeFrame(OPCODE.BINARY, data))
  }

  broadcast(data) {
    if (this.clients.size === 0) return
    const frame = encodeFrame(OPCODE.BINARY, data)
    for (const client of this.clients) {
      if (client.closed || client.socket.destroyed) continue
      if (client.socket.writableLength > MAX_BACKLOG) {
        this.#terminate(client)
        continue
      }
      this.#write(client, frame)
    }
  }

  stop() {
    clearInterval(this.timer)
    for (const client of [...this.clients]) this.#terminate(client)
    this.clients.clear()
  }

  #onData(client, chunk) {
    if (client.closed) return
    client.buffer = client.buffer.length ? Buffer.concat([client.buffer, chunk]) : chunk
    if (client.buffer.length > MAX_INBOUND) {
      this.#terminate(client)
      return
    }

    while (!client.closed) {
      const buffer = client.buffer
      if (buffer.length < 2) return
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const bigLength = buffer.readBigUInt64BE(2)
        if (bigLength > BigInt(MAX_INBOUND)) {
          this.#terminate(client)
          return
        }
        length = Number(bigLength)
        offset = 10
      }
      const maskOffset = offset
      if (masked) offset += 4
      if (buffer.length < offset + length) return

      const mask = masked ? buffer.subarray(maskOffset, maskOffset + 4) : null
      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      client.buffer = buffer.subarray(offset + length)
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      }
      this.#onFrame(client, opcode, payload)
    }
  }

  #onFrame(client, opcode, payload) {
    switch (opcode) {
      case OPCODE.PING:
        this.#write(client, encodeFrame(OPCODE.PONG, payload))
        break
      case OPCODE.PONG:
        client.pongAt = Date.now()
        break
      case OPCODE.CLOSE:
        this.#write(client, encodeFrame(OPCODE.CLOSE, Buffer.alloc(0)))
        client.socket.end()
        this.#cleanup(client)
        break
      default:
        // 视频场景下客户端不会上行业务数据，文本/二进制帧直接忽略。
        break
    }
  }

  #ping() {
    const now = Date.now()
    for (const client of [...this.clients]) {
      if (now - client.pongAt > this.timeout) {
        this.#terminate(client)
        continue
      }
      this.#write(client, encodeFrame(OPCODE.PING, Buffer.alloc(0)))
    }
  }

  #write(client, frame) {
    if (client.closed || client.socket.destroyed) return
    try {
      client.socket.write(frame)
    } catch {
      this.#terminate(client)
    }
  }

  #terminate(client) {
    client.closed = true
    try {
      client.socket.destroy()
    } catch {
      // 忽略重复销毁
    }
    this.clients.delete(client)
    try {
      this.onClose?.(client)
    } catch {
      // 回调异常不影响主流程
    }
  }

  #cleanup(client) {
    if (client.closed) return
    client.closed = true
    this.clients.delete(client)
    try {
      this.onClose?.(client)
    } catch {
      // 回调异常不影响主流程
    }
  }

  #reject(socket, status, reason) {
    try {
      socket.write(
        `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      )
    } finally {
      socket.destroy()
    }
  }
}
