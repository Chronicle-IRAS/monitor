import { EventEmitter } from 'node:events'
import { spawn as spawnProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const STOP_TIMEOUT_MS = 3000
const RESTART_DELAY_MS = 3000
const MAX_STDIN_BACKLOG = 4 * 1024 * 1024

/**
 * 将重组后的 JPEG 帧按需转码录制为分段 MP4。
 * 与 H.264 节点不同，JPEG 不能直接 copy 进 MP4（浏览器不可播），
 * 因此用 ffmpeg 的 mjpeg 解复用器从 stdin 读取并转码为 H.264。
 */
export function buildJpegRecorderArgs(node, config) {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-fflags',
    '+genpts',
    '-f',
    'mjpeg',
    '-use_wallclock_as_timestamps',
    '1',
    '-i',
    'pipe:0',
    '-map',
    '0:v:0',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(config.jpegRecordFps ?? 15),
    '-f',
    'segment',
    '-segment_time',
    String(config.segmentSeconds),
    '-segment_format',
    'mp4',
    '-segment_format_options',
    'movflags=+frag_keyframe+empty_moov+default_base_moof',
    '-reset_timestamps',
    '1',
    '-strftime',
    '1',
    path.join(
      config.recordDir,
      node.id,
      `${node.id}_${randomBytes(4).toString('hex')}_%Y%m%d_%H%M%S.mp4`,
    ),
  ]
}

export class JpegRecorder extends EventEmitter {
  constructor({
    node,
    config,
    log,
    spawn = spawnProcess,
    now = () => Date.now(),
    idleMs = 30_000,
  }) {
    super()
    this.node = node
    this.config = config
    this.log = log
    this.spawn = spawn
    this.now = now
    this.idleMs = idleMs

    this.enabled = false
    this.child = null
    this.exited = true
    this.stderrTail = ''
    this.frames = 0
    this.dropped = 0
    this.lastFrameAt = 0
    this.nextStartAt = 0
    this.timer = null
    this.closePromise = null
  }

  get running() {
    return Boolean(this.child) && !this.exited
  }

  get diagnostics() {
    return this.stderrTail
  }

  async start() {
    this.enabled = Boolean(this.node.isRecord)
    if (!this.enabled) return
    await fs.mkdir(path.join(this.config.recordDir, this.node.id), { recursive: true })
    this.timer = setInterval(() => this.#sweep(), 1000)
    this.timer.unref?.()
  }

  /**
   * 只有收到完整 JPEG 帧且开启录制时才启动 ffmpeg。
   * 无帧期间不保留空转进程，实现按需录制。
   */
  push(frame) {
    if (!this.enabled || !frame || frame.length === 0) return
    if (this.closePromise) {
      this.dropped += 1
      return
    }
    const now = this.now()
    this.lastFrameAt = now

    if (!this.running) {
      if (now < this.nextStartAt) {
        this.dropped += 1
        return
      }
      if (!this.#spawnChild()) {
        this.nextStartAt = now + RESTART_DELAY_MS
        this.dropped += 1
        return
      }
    }

    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      this.dropped += 1
      return
    }
    if (stdin.writableLength > MAX_STDIN_BACKLOG) {
      this.dropped += 1
      return
    }

    stdin.write(frame)
    this.frames += 1
  }

  #spawnChild() {
    const args = buildJpegRecorderArgs(this.node, this.config)
    let child
    try {
      child = this.spawn(this.config.ffmpegPath, args, {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
      })
    } catch (error) {
      this.log?.warn?.(`[${this.node.id}] JPEG 录制 ffmpeg 启动失败: ${error.message}`)
      return false
    }

    this.child = child
    this.exited = false
    let handled = false
    const handleExit = (code, signal, error) => {
      if (handled) return
      handled = true
      this.exited = true
      if (this.child === child) this.child = null
      this.nextStartAt = this.now() + RESTART_DELAY_MS
      if (error) {
        this.log?.warn?.(`[${this.node.id}] JPEG 录制 ffmpeg 异常: ${error.message}`)
      } else if (code !== 0 && signal === null) {
        this.log?.warn?.(
          `[${this.node.id}] JPEG 录制 ffmpeg 已退出 (code=${code})${this.stderrTail ? `: ${this.stderrTail.slice(-400)}` : ''}`,
        )
      }
      this.emit('exit', { code, signal, error })
    }

    child.once('error', (error) => handleExit(null, null, error))
    child.once('exit', (code, signal) => handleExit(code, signal, null))
    child.stdin?.on('error', () => {
      // ffmpeg 提前退出时写管道会触发 EPIPE，由 exit 处理器统一恢复。
    })
    child.stderr?.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000)
    })

    this.log?.info?.(`[${this.node.id}] JPEG 录制 ffmpeg 已启动 (pid=${child.pid ?? 'unknown'})`)
    return true
  }

  #sweep() {
    if (!this.running) return
    if (this.now() - this.lastFrameAt > this.idleMs) {
      void this.#closeChild()
    }
  }

  async #closeChild() {
    if (this.closePromise) return this.closePromise
    const child = this.child
    if (!child) return
    this.child = null
    this.exited = true
    this.nextStartAt = this.now() + RESTART_DELAY_MS

    try {
      child.stdin?.end()
    } catch {
      // 已关闭
    }

    this.closePromise = new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // 已退出
        }
        finish()
      }, STOP_TIMEOUT_MS)
      timer.unref?.()
      child.once('exit', finish)
      child.once('error', finish)
    })
    try {
      await this.closePromise
    } finally {
      this.closePromise = null
    }
  }

  async stop() {
    this.enabled = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.#closeChild()
  }
}
