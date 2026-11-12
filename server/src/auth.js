import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { HttpError } from './util.js'

export function createAuth(config) {
  const sessions = new Map()
  const digest = (value) => createHash('sha256').update(String(value)).digest()
  const validToken = (value) => Boolean(config.adminToken) && timingSafeEqual(digest(value), digest(config.adminToken))
  const sessionId = (req) => /(?:^|;\s*)monitor_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1]
  const authenticated = (req) => {
    const expiry = sessions.get(sessionId(req))
    return Boolean(expiry && expiry > Date.now())
  }
  const requireAdmin = (req) => {
    if (validToken(req.headers['x-admin-token']) || authenticated(req)) return
    throw new HttpError(401, '需要管理员认证')
  }
  const cookie = (req, value, age) => `monitor_session=${value}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${age}${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`
  return {
    authenticated,
    requireAdmin: (req) => { if (config.adminToken) requireAdmin(req) },
    login(req, res, password) {
      if (!validToken(password)) throw new HttpError(401, '认证失败')
      for (const [id, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(id)
      if (sessions.size >= 100) sessions.delete(sessions.keys().next().value)
      const id = randomBytes(32).toString('hex')
      sessions.set(id, Date.now() + 8 * 3600_000)
      res.setHeader('Set-Cookie', cookie(req, id, 8 * 3600))
    },
    logout(req, res) {
      sessions.delete(sessionId(req))
      res.setHeader('Set-Cookie', cookie(req, '', 0))
    },
  }
}
