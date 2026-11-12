import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function intFromEnv(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`环境变量 ${key} 必须是 ${min}~${max} 之间的整数`)
  }
  return value
}

function stringFromEnv(env, key, fallback) {
  const raw = env[key]
  return raw === undefined || raw === '' ? fallback : raw
}

function pathFromEnv(env, key, fallback) {
  const raw = env[key]
  return raw === undefined || raw === '' ? fallback : path.resolve(raw)
}

/**
 * 读取服务配置。所有路径默认相对 server/ 目录解析，与启动时的 cwd 无关。
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
  const config = {
    serverRoot,
    apiPort: intFromEnv(env, 'PORT', 3000, { min: 0, max: 65535 }),
    apiHost: stringFromEnv(env, 'HOST', '0.0.0.0'),
    streamHost: stringFromEnv(env, 'STREAM_HOST', '0.0.0.0'),
    ffmpegPath: stringFromEnv(env, 'FFMPEG_PATH', 'ffmpeg'),
    recordDir: pathFromEnv(env, 'RECORD_DIR', path.join(serverRoot, 'records')),
    dataDir: pathFromEnv(env, 'DATA_DIR', path.join(serverRoot, 'data')),
    diskPath: pathFromEnv(
      env,
      'DISK_PATH',
      process.platform === 'win32' ? path.parse(serverRoot).root : '/',
    ),
    recordPoolMb: intFromEnv(env, 'RECORD_POOL_MB', 3 * 1024, { min: 1, max: 1024 * 1024 }),
    segmentSeconds: intFromEnv(env, 'SEGMENT_SECONDS', 300, { min: 5, max: 86400 }),
    udpPortMin: intFromEnv(env, 'UDP_PORT_MIN', 9001, { min: 1, max: 65535 }),
    udpPortMax: intFromEnv(env, 'UDP_PORT_MAX', 9050, { min: 1, max: 65535 }),
    httpPortMin: intFromEnv(env, 'HTTP_PORT_MIN', 9051, { min: 1, max: 65535 }),
    httpPortMax: intFromEnv(env, 'HTTP_PORT_MAX', 9100, { min: 1, max: 65535 }),
    corsOrigin: stringFromEnv(env, 'CORS_ORIGIN', '*'),
    adminToken: stringFromEnv(env, 'ADMIN_TOKEN', ''),
    logLevel: stringFromEnv(env, 'LOG_LEVEL', 'info'),
  }
  config.stateFile = path.join(config.dataDir, 'nodes.json')

  if (config.udpPortMin > config.udpPortMax) {
    throw new Error('UDP_PORT_MIN 不能大于 UDP_PORT_MAX')
  }
  if (config.httpPortMin > config.httpPortMax) {
    throw new Error('HTTP_PORT_MIN 不能大于 HTTP_PORT_MAX')
  }
  return Object.freeze(config)
}
