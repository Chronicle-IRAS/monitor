import http from 'node:http'
import { createApiHandler } from './api.js'
import { NodeManager } from './nodes.js'
import { RecordStore } from './records.js'
import { SystemMetrics } from './system.js'
import { createLogger } from './util.js'

const POOL_SWEEP_MS = 30_000

/**
 * 启动后端：HTTP API + 节点管理器 + 录像池清理。
 * 传入 spawn 可替换 ffmpeg 进程工厂（测试用）。
 */
export async function startServer(config, { spawn, logger } = {}) {
  const log = logger ?? createLogger(config.logLevel)

  const records = new RecordStore({ config, log })
  await records.ensureRoot()

  const nodes = new NodeManager({ config, log, spawn })
  await nodes.init()

  const metrics = new SystemMetrics({ config, recordStore: records })
  const apiServer = http.createServer(
    createApiHandler({ config, nodes, records, metrics, log }),
  )

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      apiServer.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      apiServer.off('error', onError)
      resolve()
    }
    apiServer.once('error', onError)
    apiServer.once('listening', onListening)
    apiServer.listen(config.apiPort, config.apiHost)
  })

  const poolTimer = setInterval(() => {
    records
      .enforcePool({ protectMs: config.segmentSeconds * 1000 })
      .catch((error) => log.warn(`录像池清理失败: ${error.message}`))
  }, POOL_SWEEP_MS)
  poolTimer.unref?.()

  const address = apiServer.address()
  const port = typeof address === 'object' && address ? address.port : config.apiPort
  log.info(`管理 API 已监听 http://${config.apiHost}:${port}/api`)
  log.info(
    `录像池 ${config.recordPoolMb} MB -> ${config.recordDir}；ffmpeg: ${config.ffmpegPath}`,
  )

  return {
    config,
    log,
    port,
    nodes,
    records,
    metrics,
    apiServer,
    async close() {
      clearInterval(poolTimer)
      await nodes.shutdown()
      const closed = new Promise((resolve) => apiServer.close(() => resolve()))
      apiServer.closeAllConnections?.()
      await closed
      log.info('服务已关闭')
    },
  }
}
