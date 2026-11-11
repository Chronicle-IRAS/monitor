import fs from 'node:fs/promises'
import path from 'node:path'
import {
  HttpError,
  assertSafeSegment,
  formatLocalTime,
  formatRecordSize,
  resolveInside,
} from './util.js'

/**
 * 15GB 录像池：按设备分目录、统一 FIFO 覆盖、支持单文件/批量/整目录删除。
 */
export class RecordStore {
  constructor({ config, log }) {
    this.root = config.recordDir
    this.poolBytes = config.recordPoolMb * 1024 * 1024
    this.log = log
  }

  async ensureRoot() {
    await fs.mkdir(this.root, { recursive: true })
  }

  async tree() {
    let dirents = []
    try {
      dirents = await fs.readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }

    const devices = []
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
      const directory = path.join(this.root, dirent.name)
      let entries = []
      try {
        entries = await fs.readdir(directory, { withFileTypes: true })
      } catch {
        continue
      }

      const files = []
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue
        try {
          const stats = await fs.stat(path.join(directory, entry.name))
          files.push({
            filename: entry.name,
            size: formatRecordSize(stats.size),
            time: formatLocalTime(stats.mtime),
            mtimeMs: stats.mtimeMs,
          })
        } catch {
          // 统计期间文件被删除，跳过
        }
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs)
      devices.push({
        deviceId: dirent.name,
        files: files.map(({ filename, size, time }) => ({ filename, size, time })),
      })
    }

    devices.sort((a, b) => a.deviceId.localeCompare(b.deviceId))
    return devices
  }

  async usageBytes() {
    let total = 0
    const dirents = await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])
    for (const device of dirents) {
      if (!device.isDirectory() || device.name.startsWith('.')) continue
      const directory = path.join(this.root, device.name)
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue
        const stats = await fs.stat(path.join(directory, entry.name)).catch(() => null)
        if (stats) total += stats.size
      }
    }
    return total
  }

  async fileInfo(deviceId, filename) {
    const device = assertSafeSegment(deviceId, '设备ID')
    const file = assertSafeSegment(filename, '文件名')
    const target = resolveInside(this.root, device, file)
    const stats = await fs.stat(target).catch(() => null)
    if (!stats || !stats.isFile()) {
      throw new HttpError(404, `录像文件 ${file} 不存在`)
    }
    return { path: target, stats }
  }

  async deleteDevice(deviceId) {
    const device = assertSafeSegment(deviceId, '设备ID')
    const directory = resolveInside(this.root, device)
    const stats = await fs.stat(directory).catch(() => null)
    if (!stats || !stats.isDirectory()) {
      throw new HttpError(404, `设备 ${device} 的录像目录不存在`)
    }
    await fs.rm(directory, { recursive: true, force: true })
    return { deviceId: device, deleted: true }
  }

  async deleteFile(deviceId, filename) {
    const { path: target } = await this.fileInfo(deviceId, filename)
    await fs.rm(target, { force: true })
    return { deviceId, filename, deleted: true }
  }

  async deleteFiles(deviceId, filenames) {
    const deleted = []
    const failed = []
    for (const filename of filenames) {
      try {
        await this.deleteFile(deviceId, filename)
        deleted.push(filename)
      } catch (error) {
        failed.push({ filename, message: error.message })
      }
    }
    return { deviceId, deleted, failed }
  }

  /**
   * FIFO 清理：删除最旧切片直到总量不超限。
   * protectMs 用于保护正在写入的当前分段（其 mtime 持续更新）。
   */
  async enforcePool({ protectMs = 0, now = Date.now() } = {}) {
    const files = []
    let total = 0
    const dirents = await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])
    for (const device of dirents) {
      if (!device.isDirectory() || device.name.startsWith('.')) continue
      const directory = path.join(this.root, device.name)
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue
        const target = path.join(directory, entry.name)
        const stats = await fs.stat(target).catch(() => null)
        if (!stats) continue
        files.push({ path: target, size: stats.size, mtimeMs: stats.mtimeMs })
        total += stats.size
      }
    }

    if (total <= this.poolBytes) return { removed: 0, freedBytes: 0 }

    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    let removed = 0
    let freedBytes = 0
    for (const file of files) {
      if (total <= this.poolBytes) break
      if (protectMs > 0 && now - file.mtimeMs < protectMs) continue
      try {
        await fs.rm(file.path, { force: true })
        total -= file.size
        freedBytes += file.size
        removed += 1
      } catch (error) {
        this.log?.warn?.(`录像池清理失败 ${path.basename(file.path)}: ${error.message}`)
      }
    }

    if (removed > 0) {
      this.log?.info?.(`录像池清理：删除 ${removed} 个旧切片，释放 ${formatRecordSize(freedBytes)}`)
    }
    return { removed, freedBytes }
  }
}
