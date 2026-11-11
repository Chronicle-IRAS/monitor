import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import net from 'node:net'
import dgram from 'node:dgram'

const execFileAsync = promisify(execFile)
const SCAN_TIMEOUT_MS = 5000

function parsePort(local) {
  if (typeof local !== 'string') return null
  const index = local.lastIndexOf(':')
  if (index === -1) return null
  const port = Number(local.slice(index + 1))
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

function sorted(ports) {
  return [...ports].sort((a, b) => a - b)
}

/** 尝试绑定 TCP 端口，返回 true 表示端口空闲。 */
export function probeTcp(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

/** 尝试绑定 UDP 端口，返回 true 表示端口空闲。 */
export function probeUdp(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    socket.unref()
    socket.once('error', () => {
      try {
        socket.close()
      } catch {
        // 已关闭
      }
      resolve(false)
    })
    socket.bind({ port, address: host, exclusive: true }, () => {
      socket.close(() => resolve(true))
    })
  })
}

/** 解析 iproute2 `ss -H -ltn` / `ss -H -lun` 输出。 */
function parseSs(output, proto) {
  const ports = new Set()
  for (const raw of output.split(/\r?\n/)) {
    const fields = raw.trim().split(/\s+/)
    if (fields.length < 4) continue
    const state = fields[0].toUpperCase()
    if (proto === 'tcp' && state !== 'LISTEN') continue
    const port = parsePort(fields[3])
    if (port) ports.add(port)
  }
  return sorted(ports)
}

/** 解析 netstat -lntu 输出（ss 不可用时的兜底）。 */
function parseUnixNetstat(output) {
  const tcp = new Set()
  const udp = new Set()
  for (const raw of output.split(/\r?\n/)) {
    const fields = raw.trim().split(/\s+/)
    const proto = fields[0]?.toLowerCase()
    if (proto !== 'tcp' && proto !== 'udp') continue
    if (fields.length < 5) continue
    const state = fields[5]?.toUpperCase()
    if (proto === 'tcp' && state !== 'LISTEN') continue
    const port = parsePort(fields[3])
    if (port) (proto === 'tcp' ? tcp : udp).add(port)
  }
  return { tcp: sorted(tcp), udp: sorted(udp) }
}

/** 解析 Windows netstat -ano -p TCP/UDP 输出。 */
function parseWindowsNetstat(output, proto) {
  const ports = new Set()
  for (const raw of output.split(/\r?\n/)) {
    const fields = raw.trim().split(/\s+/)
    if (fields[0]?.toUpperCase() !== proto) continue
    if (proto === 'TCP' && fields[3]?.toUpperCase() !== 'LISTENING') continue
    const port = parsePort(fields[1])
    if (port) ports.add(port)
  }
  return sorted(ports)
}

async function execScan(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    timeout: SCAN_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    ...options,
  })
  return stdout
}

/**
 * 物理扫描当前主机的监听端口。
 * Linux 优先 ss，其次 netstat；Windows 使用 netstat。
 */
export async function scanListeningPorts({ log } = {}) {
  try {
    if (process.platform === 'win32') {
      const [tcpOut, udpOut] = await Promise.all([
        execScan('netstat', ['-ano', '-p', 'TCP']),
        execScan('netstat', ['-ano', '-p', 'UDP']),
      ])
      return {
        tcp: parseWindowsNetstat(tcpOut, 'TCP'),
        udp: parseWindowsNetstat(udpOut, 'UDP'),
      }
    }

    try {
      const [tcpOut, udpOut] = await Promise.all([
        execScan('ss', ['-H', '-ltn']),
        execScan('ss', ['-H', '-lun']),
      ])
      return { tcp: parseSs(tcpOut, 'tcp'), udp: parseSs(udpOut, 'udp') }
    } catch {
      const output = await execScan('netstat', ['-lntu'])
      return parseUnixNetstat(output)
    }
  } catch (error) {
    log?.warn?.(`端口扫描失败: ${error.message}`)
    return { tcp: [], udp: [] }
  }
}
