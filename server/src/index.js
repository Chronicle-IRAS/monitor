import { loadConfig } from './config.js'
import { startServer } from './server.js'

let app
try {
  app = await startServer(loadConfig())
} catch (error) {
  console.error('[FATAL] 后端启动失败:', error)
  process.exit(1)
}

let closing = false
async function shutdown(signal) {
  if (closing) return
  closing = true
  app.log.info(`收到 ${signal}，正在停止服务...`)
  try {
    await app.close()
    process.exit(0)
  } catch (error) {
    app.log.error('关闭服务失败:', error)
    process.exit(1)
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void shutdown(signal)
  })
}

process.on('unhandledRejection', (reason) => {
  app.log.error('未处理的 Promise 拒绝:', reason)
})
