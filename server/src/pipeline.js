import { EventEmitter } from 'node:events'
import { spawn as spawnProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const STOP_TIMEOUT_MS = 3000

/**
 * 构造单节点的 ffmpeg 管道参数：
 * - 输入：硬件 UDP 推流
 * - 输出 1：H.264 裸流（WebSocket /stream）或 MJPEG 帧（HTTP /mjpeg）
 * - 输出 2（可选）：按段录制 MP4 到录像池
 */
export function buildFfmpegArgs(node, config) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-fflags',
    'nobuffer',
    '-flags',
    'low_delay',
    '-probesize',
    '1000000',
    '-analyzeduration',
    '0',
    '-i',
    `udp://0.0.0.0:${node.udp}?overrun_nonfatal=1&fifo_size=5000000`,
    '-map',
    '0:v:0',
  ]

  if (node.streamType === 'mjpeg') {
    args.push('-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1')
  } else {
    args.push('-c:v', 'copy', '-f', 'h264', 'pipe:1')
  }

  if (node.isRecord) {
    args.push(
      '-map',
      '0:v:0',
      '-c:v',
      'copy',
      '-f',
      'segment',
      '-segment_time',
      String(config.segmentSeconds),
      '-segment_format',
      'mp4',
      '-reset_timestamps',
      '1',
      '-strftime',
      '1',
      path.join(config.recordDir, node.id, `${node.id}_%Y%m%d_%H%M%S.mp4`),
    )
  }
  return args
}

export class Pipeline extends EventEmitter {
  constructor({ node, config, spawn = spawnProcess, log }) {
    super()
    this.node = node
    this.config = config
    this.spawn = spawn
    this.log = log
    this.child = null
    this.exited = true
    this.stderrTail = ''
  }

  get diagnostics() {
    return this.stderrTail
  }

  async start() {
    if (this.node.isRecord) {
      await fs.mkdir(path.join(this.config.recordDir, this.node.id), { recursive: true })
    }

    const args = buildFfmpegArgs(this.node, this.config)
    const child = this.spawn(this.config.ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.exited = false

    let exitHandled = false
    const handleExit = (code, signal, error) => {
      if (exitHandled) return
      exitHandled = true
      this.exited = true
      this.emit('exit', { code, signal, error })
    }
    child.once('error', (error) => handleExit(null, null, error))
    child.once('exit', (code, signal) => handleExit(code, signal, null))
    child.stdout?.on('data', (chunk) => this.emit('data', chunk))
    child.stderr?.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000)
    })

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        child.off('spawn', onSpawn)
        child.off('error', onError)
      }
      const onSpawn = () => {
        cleanup()
        resolve()
      }
      const onError = (error) => {
        cleanup()
        reject(error)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })

    this.log?.info?.(`[${this.node.id}] ffmpeg 已启动 (pid=${child.pid ?? 'unknown'})`)
  }

  async stop() {
    const child = this.child
    if (!child || this.exited) return
    try {
      child.kill('SIGTERM')
    } catch {
      // 进程可能已退出
    }
    await new Promise((resolve) => {
      if (this.exited) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // 忽略
        }
        resolve()
      }, STOP_TIMEOUT_MS)
      timer.unref?.()
      this.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
