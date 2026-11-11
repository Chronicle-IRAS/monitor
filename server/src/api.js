import { createReadStream } from 'node:fs'
import { HttpError, round } from './util.js'
import { probeTcp, probeUdp, scanListeningPorts } from './ports.js'

const MAX_BODY_BYTES = 64 * 1024

function corsHeaders(config) {
  return {
    'Access-Control-Allow-Origin': config.corsOrigin,
    Vary: 'Origin',
  }
}

function parsePortParam(value) {
  if (value === null || value === '') return null
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

async function readJson(req) {
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.includes('application/json')) {
    throw new HttpError(415, 'Content-Type 必须是 application/json')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) throw new HttpError(400, '请求体为空')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON')
  }
}

function requireAdmin(req, url, config) {
  if (!config.adminToken) return
  const header = req.headers['x-admin-token']
  const fromHeader = Array.isArray(header) ? header[0] : header
  const token = fromHeader ?? url.searchParams.get('token')
  if (token !== config.adminToken) {
    throw new HttpError(401, '未授权：需要管理员令牌')
  }
}

export function createApiHandler({ config, nodes, records, metrics, log }) {
  const json = (res, status, body) => {
    const payload = Buffer.from(JSON.stringify(body))
    res.writeHead(status, {
      ...corsHeaders(config),
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': payload.length,
    })
    res.end(payload)
  }

  const handler = (req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (error instanceof HttpError) {
        json(res, error.status, { message: error.message })
        return
      }
      log.error(`${req.method} ${req.url} 处理失败`, error)
      json(res, 500, { message: '服务器内部错误' })
    })
  }
  return handler

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders(config),
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
        'Access-Control-Max-Age': '86400',
      })
      res.end()
      return
    }

    const rawSegments = url.pathname.split('/').filter((part) => part !== '')
    if (rawSegments[0] !== 'api') {
      json(res, 404, { message: '接口不存在' })
      return
    }

    let segments
    try {
      segments = rawSegments.slice(1).map((part) => decodeURIComponent(part))
    } catch {
      throw new HttpError(400, '非法 URL 编码')
    }

    const method = req.method ?? 'GET'
    const isAdminRoute =
      segments[0] === 'records' || (segments[0] === 'nodes' && method === 'POST')
    if (isAdminRoute) requireAdmin(req, url, config)

    // --- 健康检查 ---
    if (method === 'GET' && segments.length === 1 && segments[0] === 'health') {
      json(res, 200, {
        ok: true,
        name: 'monitor-pro-server',
        uptimeSeconds: Math.round(process.uptime()),
        nodes: nodes.list().length,
      })
      return
    }

    // --- 节点管理 ---
    if (segments[0] === 'nodes') {
      if (method === 'GET' && segments.length === 1) {
        json(res, 200, nodes.list())
        return
      }
      if (method === 'POST' && segments.length === 2 && segments[1] === 'start') {
        json(res, 200, await nodes.start(await readJson(req)))
        return
      }
      if (method === 'POST' && segments.length === 2 && segments[1] === 'stop') {
        const body = await readJson(req)
        if (typeof body.id !== 'string' || body.id.length === 0) {
          throw new HttpError(400, '缺少节点 id')
        }
        json(res, 200, await nodes.stop(body.id))
        return
      }
      if (method === 'POST' && segments.length === 2 && segments[1] === 'reset') {
        json(res, 200, await nodes.reset())
        return
      }
    }

    // --- 系统指标 ---
    if (method === 'GET' && segments.length === 2 && segments[0] === 'system') {
      if (segments[1] === 'status') {
        json(res, 200, await metrics.collect(nodes.list().length))
        return
      }
      if (segments[1] === 'all-ports') {
        json(res, 200, await scanListeningPorts({ log }))
        return
      }
    }

    // --- 端口占用检查 ---
    if (method === 'GET' && segments.length === 2 && segments[0] === 'ports') {
      if (segments[1] === 'check') {
        const udpPort = parsePortParam(url.searchParams.get('udp'))
        const tcpPort = parsePortParam(url.searchParams.get('http'))
        const active = nodes.list()

        const isRegistered = (port) =>
          port !== null && active.some((node) => node.udp === port || node.http === port)

        const [scan, udpFree, httpFree] = await Promise.all([
          scanListeningPorts({ log }),
          udpPort !== null ? probeUdp(udpPort) : true,
          tcpPort !== null ? probeTcp(tcpPort) : true,
        ])

        const udpUsed =
          udpPort !== null &&
          (isRegistered(udpPort) || scan.udp.includes(udpPort) || udpFree === false)
        const httpUsed =
          tcpPort !== null &&
          (isRegistered(tcpPort) || scan.tcp.includes(tcpPort) || httpFree === false)
        json(res, 200, { udpUsed, httpUsed })
        return
      }
    }

    // --- 历史录像 ---
    if (segments[0] === 'records') {
      if (method === 'GET' && segments.length === 1) {
        json(res, 200, await records.tree())
        return
      }

      if (method === 'POST' && segments.length === 2 && segments[1] === 'batch-delete') {
        const body = await readJson(req)
        if (typeof body.deviceId !== 'string' || !Array.isArray(body.filenames)) {
          throw new HttpError(400, 'deviceId 与 filenames 必填')
        }
        if (body.filenames.length === 0 || body.filenames.length > 500) {
          throw new HttpError(400, 'filenames 数量必须在 1 ~ 500 之间')
        }
        json(res, 200, await records.deleteFiles(body.deviceId, body.filenames))
        return
      }

      if (method === 'GET' && segments.length === 4 && segments[1] === 'download') {
        const deviceId = segments[2]
        const filename = segments[3]
        const { path: filePath, stats } = await records.fileInfo(deviceId, filename)
        res.writeHead(200, {
          ...corsHeaders(config),
          'Content-Type': 'video/mp4',
          'Content-Length': stats.size,
          'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'no-store',
        })
        const stream = createReadStream(filePath)
        stream.on('error', (error) => {
          log.error(`录像下载失败: ${error.message}`)
          res.destroy()
        })
        res.on('close', () => stream.destroy())
        stream.pipe(res)
        return
      }

      if (method === 'DELETE' && segments.length === 2) {
        json(res, 200, await records.deleteDevice(segments[1]))
        return
      }

      if (method === 'DELETE' && segments.length === 3) {
        json(res, 200, await records.deleteFile(segments[1], segments[2]))
        return
      }
    }

    json(res, 404, { message: '接口不存在' })
  }
}
