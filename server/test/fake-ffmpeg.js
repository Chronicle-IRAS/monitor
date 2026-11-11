import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const startCode = Buffer.from([0x00, 0x00, 0x00, 0x01])

export const SPS = Buffer.concat([startCode, Buffer.from([0x67, 0x42, 0x00, 0x1e])])
export const PPS = Buffer.concat([startCode, Buffer.from([0x68, 0xce, 0x3c, 0x80])])
export const IDR = Buffer.concat([startCode, Buffer.from([0x65, 0x88, 0x84, 0x00])])
export const INTER = Buffer.concat([startCode, Buffer.from([0x41, 0x9a, 0x20])])
export const H264_CHUNK = Buffer.concat([SPS, PPS, IDR, INTER])

export const JPEG_FRAME = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
  Buffer.from([0xff, 0xd9]),
])

/**
 * 伪造 ffmpeg 子进程：按输出模式向 stdout 持续写入测试帧，供端到端测试驱动解码/分发链路。
 */
export function createFakeFfmpeg({ interval = 40 } = {}) {
  const children = []
  const spawn = (_command, args) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exited = false
    child.killed = false

    const isMjpeg = args.includes('image2pipe')
    const timer = setInterval(() => {
      if (!child.exited) child.stdout.write(isMjpeg ? JPEG_FRAME : H264_CHUNK)
    }, interval)
    timer.unref?.()

    child.kill = () => {
      if (child.exited) return true
      child.exited = true
      clearInterval(timer)
      process.nextTick(() => child.emit('exit', 0, 'SIGTERM'))
      return true
    }

    children.push(child)
    process.nextTick(() => child.emit('spawn'))
    return child
  }
  return { spawn, children }
}
