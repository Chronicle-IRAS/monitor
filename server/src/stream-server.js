import http from 'node:http'
import { AnnexBSplitter, H264KeyframeCache, JpegFramer } from './media.js'
import { WsHub } from './ws.js'

const MJPEG_BOUNDARY = 'frame'
const MAX_MJPEG_BACKLOG = 4 * 1024 * 1024

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Access-Control-Allow-Origin': '*',
  })
  res.end(payload)
}

/**
 * 每个节点独占一个 HTTP 端口：
 * - GET /mjpeg  → multipart/x-mixed-replace JPEG 流
 * - WS  /stream → H.264 裸流（jmuxer）
 */
export class StreamServer {
  constructor({ node, config, log }) {
    this.node = node
    this.config = config
    this.log = log
    this.splitter = new AnnexBSplitter()
    this.cache = new H264KeyframeCache()
    this.framer = new JpegFramer()
    this.lastFrame = null
    this.pipeline = null
    this.server = null
    this.sockets = new Set()
    this.mjpegClients = new Set()
    this.onPipelineData = (chunk) => this.#handleData(chunk)

    this.hub = new WsHub({
      path: '/stream',
      log,
      onOpen: (client) => {
        const snapshot = this.cache.snapshot()
        if (snapshot.length > 0) this.hub.send(client, snapshot)
      },
    })
  }

  async listen() {
    this.server = http.createServer((req, res) => this.#handleHttp(req, res))
    this.server.on('upgrade', (req, socket, head) => this.hub.handleUpgrade(req, socket, head))
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.server.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.node.http, this.config.streamHost)
    })

    this.server.on('error', (error) => {
      this.log?.warn?.(`[${this.node.id}] 视频流端口 ${this.node.http} 异常: ${error.message}`)
    })
  }

  attachPipeline(pipeline) {
    if (this.pipeline) this.pipeline.off('data', this.onPipelineData)
    this.pipeline = pipeline
    pipeline.on('data', this.onPipelineData)
  }

  async close() {
    this.hub.stop()
    for (const res of this.mjpegClients) {
      try {
        res.end()
      } catch {
        // 已断开
      }
    }
    this.mjpegClients.clear()
    if (this.pipeline) {
      this.pipeline.off('data', this.onPipelineData)
      this.pipeline = null
    }

    const server = this.server
    this.server = null
    if (!server) return
    await new Promise((resolve) => {
      server.close(() => resolve())
      for (const socket of this.sockets) socket.destroy()
    })
  }

  #handleData(chunk) {
    if (this.node.streamType === 'mjpeg') {
      for (const frame of this.framer.push(chunk)) {
        this.lastFrame = frame
        for (const res of this.mjpegClients) this.#writeFrame(res, frame)
      }
      return
    }

    for (const nal of this.splitter.push(chunk)) this.cache.push(nal)
    this.hub.broadcast(chunk)
  }

  #handleHttp(req, res) {
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      sendJson(res, 400, { message: '非法请求' })
      return
    }

    if (pathname === '/mjpeg') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { message: '仅支持 GET' })
        return
      }
      this.#serveMjpeg(req, res)
      return
    }

    if (pathname === '/' || pathname === '/status') {
      sendJson(res, 200, {
        id: this.node.id,
        udp: this.node.udp,
        http: this.node.http,
        streamType: this.node.streamType,
        isRecord: this.node.isRecord,
        wsClients: this.hub.size,
        mjpegClients: this.mjpegClients.size,
      })
      return
    }

    sendJson(res, 404, { message: '接口不存在' })
  }

  #serveMjpeg(req, res) {
    if (this.node.streamType !== 'mjpeg') {
      sendJson(res, 409, { message: '该节点为 H.264 推流模式，请使用 WebSocket /stream 拉流' })
      return
    }

    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    this.mjpegClients.add(res)
    if (this.lastFrame) this.#writeFrame(res, this.lastFrame)

    const cleanup = () => this.mjpegClients.delete(res)
    res.on('close', cleanup)
    res.on('error', cleanup)
    req.on('error', cleanup)
  }

  #writeFrame(res, jpeg) {
    if (res.destroyed || res.writableEnded) return
    if (res.writableLength > MAX_MJPEG_BACKLOG) return
    res.write(
      `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
    )
    res.write(jpeg)
    res.write('\r\n')
  }
}
