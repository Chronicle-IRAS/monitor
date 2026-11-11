import path from 'node:path'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

export function round(value, digits = 1) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function formatGb(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`
}

export function formatRecordSize(bytes) {
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

export function formatLocalTime(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * 校验单个路径片段（设备 ID / 文件名），阻断目录穿越与响应头注入。
 */
export function assertSafeSegment(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new HttpError(400, `非法的${label}`)
  }
  if (value === '.' || value === '..' || value.includes('..')) {
    throw new HttpError(400, `非法的${label}`)
  }
  if (/[\\/\0\r\n"]/.test(value)) {
    throw new HttpError(400, `非法的${label}`)
  }
  return value
}

/**
 * 在 root 内解析路径，越界时抛 400。
 */
export function resolveInside(root, ...segments) {
  const target = path.resolve(root, ...segments)
  const relative = path.relative(root, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(400, '非法路径')
  }
  return target
}

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

export function createLogger(level = 'info') {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info
  const write = (name, args) => {
    if (LOG_LEVELS[name] < threshold) return
    const line = `[${new Date().toISOString()}] ${name.toUpperCase()}`
    if (name === 'error') console.error(line, ...args)
    else if (name === 'warn') console.warn(line, ...args)
    else console.log(line, ...args)
  }
  return {
    level,
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  }
}
