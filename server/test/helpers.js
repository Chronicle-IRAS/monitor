import crypto from 'node:crypto'
import dgram from 'node:dgram'
import net from 'node:net'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function getFreeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

export function getFreeUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    socket.once('error', reject)
    socket.bind(0, '0.0.0.0', () => {
      const { port } = socket.address()
      socket.close(() => resolve(port))
    })
  })
}

export async function readJson(response) {
  return JSON.parse(await response.text())
}

export async function waitFor(check, timeout = 3000, interval = 50) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await check()) return true
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw lastError ?? new Error('waitFor 超时')
}

function encodeClientFrame(opcode, payload) {
  const mask = crypto.randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3]

  let header
  if (masked.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | masked.length])
  } else if (masked.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(masked.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(masked.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}

/**
 * 手写的最小 WebSocket 客户端，验证服务端握手/帧编码，同时不依赖 Node 22+ 的全局 WebSocket。
 */
export function connectWebSocket(port, path = '/stream') {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    const expectedAccept = crypto
      .createHash('sha1')
      .update(`${key}${WS_GUID}`)
      .digest('base64')
    const socket = net.connect({ port, host: '127.0.0.1' })
    const queue = []
    const waiters = []
    let buffer = Buffer.alloc(0)
    let handshakeDone = false
    let closed = false

    const deliver = (payload) => {
      if (waiters.length > 0) waiters.shift().resolve(payload)
      else queue.push(payload)
    }

    const sendFrame = (opcode, payload) => {
      if (!closed) socket.write(encodeClientFrame(opcode, payload))
    }

    const nextBinary = (timeout = 3000) => {
      if (queue.length > 0) return Promise.resolve(queue.shift())
      return new Promise((resolveNext, rejectNext) => {
        const waiter = { resolve: resolveNext }
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          rejectNext(new Error('等待 WebSocket 数据超时'))
        }, timeout)
        waiter.resolve = (payload) => {
          clearTimeout(timer)
          resolveNext(payload)
        }
        waiters.push(waiter)
      })
    }

    const close = () => {
      closed = true
      socket.destroy()
    }

    socket.once('error', (error) => {
      if (!handshakeDone) reject(error)
    })
    socket.on('close', () => {
      closed = true
    })
    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      )
    })

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])

      if (!handshakeDone) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end === -1) return
        const head = buffer.subarray(0, end).toString('latin1')
        buffer = buffer.subarray(end + 4)
        const accept = head.match(/sec-websocket-accept:\s*(\S+)/i)?.[1]
        if (!/^HTTP\/1\.1 101/i.test(head) || accept !== expectedAccept) {
          reject(new Error(`WebSocket 握手失败: ${head}`))
          socket.destroy()
          return
        }
        handshakeDone = true
        resolve({ nextBinary, close, sendFrame })
      }

      while (true) {
        if (buffer.length < 2) break
        const opcode = buffer[0] & 0x0f
        let length = buffer[1] & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) break
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) break
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        if (buffer.length < offset + length) break
        const payload = Buffer.from(buffer.subarray(offset, offset + length))
        buffer = buffer.subarray(offset + length)

        if (opcode === 0x2) deliver(payload)
        else if (opcode === 0x9) sendFrame(0x0a, payload)
        else if (opcode === 0x8) {
          socket.end()
          return
        }
      }
    })
  })
}
