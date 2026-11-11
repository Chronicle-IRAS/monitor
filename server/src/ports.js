import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import net from 'node:net'
import dgram from 'node:dgram'

const execFileAsync = promisify(execFile)
const SCAN_TIMEOUT_MS = 5000
const SCAN_TTL_MS = 2000

let scanCache = { at: 0, value: null, generation: 0 }
let scanInFlight = null
let scanGeneration = 0

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

/**
 * 解析 `ss -H -ltn` / `ss -H -lun`。
 * 兼容带 `Netid` 列（多协议或部分 iproute2 版本）与不带该列的两种输出。
 */
export function parseSsOutput(output, proto) {
  const ports = new Set()
  for (const raw of output.split(/\r?\n/)) {
    const fields = raw.trim().split(/\s+/)
    if (fields.length < 4) continue
    const stateIndex = fields[0]?.toLowerCase() === proto ? 1 : 0
    if (fields.length < stateIndex + 4) continue
    if (proto === 'tcp' && fields[stateIndex]?.toUpperCase() !== 'LISTEN') continue
    const port = parsePort(fields[stateIndex + 3])
    if (port) ports.add(port)
  }
  return sorted(ports)
}

/** 解析 `netstat -lntu` 输出（ss 不可用时的兜底）。 */
export function parseUnixNetstatOutput(output) {
  const tcp = new Set()
  const udp = new Set()
  for (const raw of output.split(/\r?\n/)) {
    const fields = raw.trim().split(/\s+/)
    const proto = fields[0]?.toLowerCase()
    if (proto !== 'tcp' && proto !== 'udp') continue
    if (fields.length < 5) continue
    if (proto === 'tcp' && fields[5]?.toUpperCase() !== 'LISTEN') continue
    const port = parsePort(fields[3])
    if (port) (proto === 'tcp' ? tcp : udp).add(port)
  }
  return { tcp: sorted(tcp), udp: sorted(udp) }
}

function isWindowsListeningRow(fields) {
  const state = fields[3]?.toUpperCase() ?? ''
  if (state.includes('LISTEN')) return true
  // 非英文系统状态：外部地址端口为 0 / * 且不是已知的连接态时，视为监听。
  const foreign = fields[2] ?? ''
  if (!/(^|:)(0|\*)$/.test(foreign)) return false
  return !/ESTABLISHED|TIME_WAIT|CLOSE_WAIT|SYN_SENT|SYN_RECEIVED|FIN_WAIT|LAST_ACK|CLOSING|DELETE_TCB/.test(
    state,
  )
}

/** 解析 Windows `netstat -ano -p TCP|UDP` 输出。 */
export function parseWindowsNetstatOutput(output, proto) {
  const ports = new Set()
  for (const raw of output.split(/\r?\n/)) {
    const fields = raw.trim().split(/\s+/)
    if (fields[0]?.toUpperCase() !== proto) continue
    if (proto === 'TCP' && !isWindowsListeningRow(fields)) continue
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

async function scanOnce(log) {
  try {
    if (process.platform === 'win32') {
      const [tcpOut, udpOut] = await Promise.all([
        execScan('netstat', ['-ano', '-p', 'TCP']),
        execScan('netstat', ['-ano', '-p', 'UDP']),
      ])
      return {
        tcp: parseWindowsNetstatOutput(tcpOut, 'TCP'),
        udp: parseWindowsNetstatOutput(udpOut, 'UDP'),
      }
    }

    try {
      const [tcpOut, udpOut] = await Promise.all([
        execScan('ss', ['-H', '-ltn']),
        execScan('ss', ['-H', '-lun']),
      ])
      return { tcp: parseSsOutput(tcpOut, 'tcp'), udp: parseSsOutput(udpOut, 'udp') }
    } catch {
      const output = await execScan('netstat', ['-lntu'])
      return parseUnixNetstatOutput(output)
    }
  } catch (error) {
    log?.warn?.(`端口扫描失败: ${error.message}`)
    return null
  }
}

/** 节点启停后调用，避免复用 1~2 秒前的旧扫描结果。 */
export function invalidatePortScanCache() {
  scanGeneration += 1
  scanCache = { at: 0, value: null, generation: scanGeneration }
}

/**
 * 物理扫描当前主机的监听端口（2 秒 TTL + 并发请求合并）。
 * Linux 优先 ss，其次 netstat；Windows 使用 netstat。
 */
export async function scanListeningPorts({ log } = {}) {
  const now = Date.now()
  if (
    scanCache.value &&
    scanCache.generation === scanGeneration &&
    now - scanCache.at < SCAN_TTL_MS
  ) {
    return scanCache.value
  }
  if (scanInFlight) return scanInFlight

  const generation = scanGeneration
  const task = (async () => {
    const result = await scanOnce(log)
    if (!result) return { tcp: [], udp: [] }
    if (generation === scanGeneration) {
      scanCache = { at: Date.now(), value: result, generation }
    }
    return result
  })()

  scanInFlight = task.finally(() => {
    scanInFlight = null
  })
  return scanInFlight
}
