import fs from 'node:fs/promises'
import os from 'node:os'
import { clamp, formatGb, round } from './util.js'

function cpuSnapshot() {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
    idle += cpu.times.idle
  }
  return { idle, total }
}

async function memoryInfo() {
  try {
    const text = await fs.readFile('/proc/meminfo', 'utf8')
    const read = (key) => Number(text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1])
    const total = read('MemTotal')
    const available = read('MemAvailable')
    if (total > 0 && available >= 0) {
      return { total: total * 1024, free: available * 1024 }
    }
  } catch {
    // 非 Linux 或 /proc 不可读，回退到 os
  }
  const total = os.totalmem()
  return { total, free: os.freemem() }
}

async function diskInfo(target) {
  try {
    const stats = await fs.statfs(target)
    const total = stats.bsize * stats.blocks
    const free = stats.bsize * stats.bavail
    return { total, free }
  } catch {
    return null
  }
}

/**
 * 采集前端「系统配置」页所需的指标，字段名与视图严格对应。
 */
export class SystemMetrics {
  constructor({ config, recordStore }) {
    this.config = config
    this.recordStore = recordStore
    this.lastCpu = cpuSnapshot()
    this.diskPath = config.diskPath
  }

  async collect(onlineNodes) {
    const cpuUsage = this.#cpuUsage()
    const [memory, disk, recordBytes] = await Promise.all([
      memoryInfo(),
      diskInfo(this.diskPath).then((value) => value ?? diskInfo(this.config.recordDir)),
      this.recordStore.usageBytes(),
    ])
    const poolBytes = this.config.recordPoolMb * 1024 * 1024

    const memUsage = memory.total > 0 ? ((memory.total - memory.free) / memory.total) * 100 : 0
    const diskUsage = disk && disk.total > 0 ? ((disk.total - disk.free) / disk.total) * 100 : 0
    const recordPercent = poolBytes > 0 ? (recordBytes / poolBytes) * 100 : 0

    return {
      cpuUsage: round(clamp(cpuUsage, 0, 100)),
      memUsage: round(clamp(memUsage, 0, 100)),
      memTotal: formatGb(memory.total),
      uptime: round(process.uptime() / 3600, 2),
      recordUsageMB: round(recordBytes / 1024 / 1024),
      recordPercent: round(clamp(recordPercent, 0, 100)),
      diskUsage: round(clamp(diskUsage, 0, 100)),
      diskTotal: disk ? formatGb(disk.total) : '0GB',
      onlineNodes,
    }
  }

  #cpuUsage() {
    const now = cpuSnapshot()
    const totalDelta = now.total - this.lastCpu.total
    const idleDelta = now.idle - this.lastCpu.idle
    this.lastCpu = now
    if (totalDelta <= 0) return 0
    return (1 - idleDelta / totalDelta) * 100
  }
}
