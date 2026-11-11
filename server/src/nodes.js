import fs from 'node:fs/promises'
import { HttpError } from './util.js'
import { Pipeline } from './pipeline.js'
import { StreamServer } from './stream-server.js'
import { probeTcp, probeUdp } from './ports.js'

const TICK_MS = 5000
const MAX_RESTART_DELAY_MS = 30_000
const HEALTHY_RESET_MS = 60_000

function assertPortInRange(port, min, max, label) {
  if (!Number.isInteger(port) || port < min || port > max) {
    throw new HttpError(400, `${label}必须在 ${min} ~ ${max} 之间`)
  }
}

function normalizeNodeInput(input, config) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id)) {
    throw new HttpError(400, '设备名称只能包含字母、数字、下划线、短横线，且不超过 32 个字符')
  }

  const streamType = input.streamType === undefined ? 'ffmpeg' : input.streamType
  if (streamType !== 'ffmpeg' && streamType !== 'mjpeg') {
    throw new HttpError(400, "推流模式必须是 'ffmpeg' 或 'mjpeg'")
  }

  const udp = Number(input.udp)
  const http = Number(input.http)
  assertPortInRange(udp, config.udpPortMin, config.udpPortMax, 'UDP 端口')
  assertPortInRange(http, config.httpPortMin, config.httpPortMax, 'HTTP 端口')
  if (udp === http) throw new HttpError(400, 'UDP 与 HTTP 端口不能相同')

  return {
    id,
    udp,
    http,
    streamType,
    isRecord: Boolean(input.isRecord),
  }
}

/**
 * 节点注册表：负责校验、端口探测、ffmpeg 生命周期、崩溃自动重启与状态持久化。
 */
export class NodeManager {
  constructor({ config, log, spawn }) {
    this.config = config
    this.log = log
    this.spawn = spawn
    this.nodes = new Map()
    this.timer = null
    this.saveChain = Promise.resolve()
  }

  async init() {
    await fs.mkdir(this.config.dataDir, { recursive: true })
    let saved = []
    try {
      const raw = await fs.readFile(this.config.stateFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) saved = parsed
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.log.warn(`节点状态文件读取失败，忽略: ${error.message}`)
      }
    }

    for (const item of saved) {
      try {
        await this.start(item)
        this.log.info(`节点 ${item?.id} 已从状态文件恢复`)
      } catch (error) {
        this.log.warn(`节点 ${item?.id} 恢复失败: ${error.message}`)
      }
    }

    this.timer = setInterval(() => this.#tick(), TICK_MS)
    this.timer.unref?.()
  }

  list() {
    return [...this.nodes.values()].map((record) => this.#publicNode(record))
  }

  async start(input) {
    const node = normalizeNodeInput(input, this.config)

    if (this.nodes.has(node.id)) {
      throw new HttpError(409, `节点 ${node.id} 已存在`)
    }
    for (const other of this.nodes.values()) {
      if (
        other.udp === node.udp ||
        other.udp === node.http ||
        other.http === node.udp ||
        other.http === node.http
      ) {
        throw new HttpError(409, `端口冲突：${node.udp}/${node.http} 已被节点 ${other.id} 占用`)
      }
    }

    const [udpFree, httpFree] = await Promise.all([probeUdp(node.udp), probeTcp(node.http)])
    if (!udpFree || !httpFree) {
      const busy = [!udpFree ? `UDP ${node.udp}` : null, !httpFree ? `HTTP ${node.http}` : null]
        .filter(Boolean)
        .join('、')
      throw new HttpError(409, `端口已被系统占用：${busy}`)
    }

    const record = {
      ...node,
      createdAt: Date.now(),
      startedAt: 0,
      stopping: false,
      restarting: false,
      restarts: 0,
      restartTimer: null,
      pipeline: null,
      server: null,
    }

    const server = new StreamServer({ node: record, config: this.config, log: this.log })
    try {
      await server.listen()
    } catch (error) {
      throw new HttpError(500, `视频流端口 ${node.http} 监听失败: ${error.message}`)
    }

    const pipeline = this.#createPipeline(record)
    server.attachPipeline(pipeline)
    try {
      await pipeline.start()
    } catch (error) {
      await server.close()
      clearTimeout(record.restartTimer)
      throw new HttpError(500, `ffmpeg 启动失败: ${error.message}`)
    }

    record.pipeline = pipeline
    record.server = server
    record.startedAt = Date.now()
    this.nodes.set(record.id, record)
    await this.#save()
    this.log.info(`节点 ${record.id} 已启动 (udp=${record.udp}, http=${record.http})`)
    return this.#publicNode(record)
  }

  async stop(id) {
    const record = this.nodes.get(id)
    if (!record) throw new HttpError(404, `节点 ${id} 不存在`)

    record.stopping = true
    this.nodes.delete(id)
    if (record.restartTimer) {
      clearTimeout(record.restartTimer)
      record.restartTimer = null
    }
    if (record.pipeline) await record.pipeline.stop()
    if (record.server) await record.server.close()
    await this.#save()
    this.log.info(`节点 ${id} 已停止`)
    return { id, stopped: true }
  }

  async reset() {
    const ids = [...this.nodes.keys()]
    await Promise.all(
      ids.map((id) =>
        this.stop(id).catch((error) => this.log.warn(`停止节点 ${id} 失败: ${error.message}`)),
      ),
    )
    return { reset: true, stopped: ids.length }
  }

  async shutdown() {
    clearInterval(this.timer)
    this.timer = null
    await this.reset()
  }

  #publicNode(record) {
    return {
      id: record.id,
      udp: record.udp,
      http: record.http,
      streamType: record.streamType,
      isRecord: record.isRecord,
      status: record.pipeline && !record.pipeline.exited ? 'online' : 'restarting',
    }
  }

  #createPipeline(record) {
    const pipeline = new Pipeline({
      node: record,
      config: this.config,
      spawn: this.spawn,
      log: this.log,
    })
    pipeline.on('exit', (info) => {
      if (record.stopping || record.pipeline !== pipeline) return
      const reason = info.error ? info.error.message : `code=${info.code} signal=${info.signal}`
      this.log.warn(`[${record.id}] ffmpeg 已退出（${reason}），准备重启`)
      this.#scheduleRestart(record)
    })
    return pipeline
  }

  #tick() {
    const now = Date.now()
    for (const record of this.nodes.values()) {
      if (record.stopping) continue
      if (
        record.pipeline &&
        !record.pipeline.exited &&
        record.restarts > 0 &&
        now - record.startedAt > HEALTHY_RESET_MS
      ) {
        record.restarts = 0
      }
      if (record.pipeline?.exited && !record.restartTimer && !record.restarting) {
        this.#scheduleRestart(record)
      }
    }
  }

  #scheduleRestart(record) {
    if (record.stopping || !this.nodes.has(record.id) || record.restartTimer) return
    record.restarts += 1
    const delay = Math.min(
      MAX_RESTART_DELAY_MS,
      1000 * 2 ** Math.min(record.restarts - 1, 5),
    )
    record.restartTimer = setTimeout(() => {
      record.restartTimer = null
      this.#restart(record).catch((error) => {
        this.log.error(`[${record.id}] 重启流程异常: ${error.message}`)
      })
    }, delay)
  }

  async #restart(record) {
    if (record.stopping || !this.nodes.has(record.id) || record.restarting) return
    record.restarting = true
    const pipeline = this.#createPipeline(record)
    record.server.attachPipeline(pipeline)
    try {
      await pipeline.start()
      record.pipeline = pipeline
      record.startedAt = Date.now()
      this.log.info(`[${record.id}] ffmpeg 管道已重启`)
    } catch (error) {
      this.log.error(`[${record.id}] ffmpeg 重启失败: ${error.message}`)
      this.#scheduleRestart(record)
    } finally {
      record.restarting = false
    }
  }

  #save() {
    const payload = JSON.stringify(
      [...this.nodes.values()].map((record) => ({
        id: record.id,
        udp: record.udp,
        http: record.http,
        streamType: record.streamType,
        isRecord: record.isRecord,
      })),
      null,
      2,
    )
    const tempFile = `${this.config.stateFile}.${process.pid}.tmp`
    this.saveChain = this.saveChain.then(async () => {
      try {
        await fs.mkdir(this.config.dataDir, { recursive: true })
        await fs.writeFile(tempFile, payload, 'utf8')
        await fs.rename(tempFile, this.config.stateFile)
      } catch (error) {
        this.log.warn(`节点状态保存失败: ${error.message}`)
      }
    })
    return this.saveChain
  }
}
