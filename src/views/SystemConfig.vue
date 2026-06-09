<template>
  <div class="system-config">
    <el-card shadow="never" class="header-card">
      <div class="config-header">
        <h2>⚙️ 服务器状态信息 </h2>
        <div class="header-actions">
          <el-button type="primary" plain @click="forceSync">手动刷新高精数据</el-button>
        </div>
      </div>
    </el-card>

    <el-row :gutter="20" class="stat-row">
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <template #header><span class="card-title">处理器负载 (CPU)</span></template>
          <div class="dashboard-box">
            <el-progress type="dashboard" :percentage="cpuVal" color="#409eff" />
            <div class="dashboard-footer">CPU使用占用</div>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <template #header>
            <span class="card-title">物理内存 (共 {{ memTotalVal }})</span>
          </template>
          <div class="dashboard-box">
            <el-progress type="dashboard" :percentage="memVal" :color="customColors" />
            <div class="dashboard-footer">系统缓存及常驻服务</div>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <template #header>
            <span class="card-title">录像缓存池 (限额 15.0GB)</span>
          </template>
          <div class="dashboard-box">
            <el-progress type="dashboard" :percentage="recordVal" :color="recordColors" />
            <div class="dashboard-footer text-highlight">
              已用: <strong>{{ recordUsedStr }}</strong>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <template #header>
            <span class="card-title">服务器根磁盘 (共 {{ diskTotalVal }})</span>
          </template>
          <div class="dashboard-box">
            <el-progress type="dashboard" :percentage="diskVal" color="#67C23A" />
            <div class="dashboard-footer">Linux 系统分区总健康度</div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="watchdog-card">
      <template #header>
        <div class="watchdog-header">
          <span>🛡️ 系统运行看门狗守护状态清单</span>
          <el-tag type="success" size="small" effect="dark">守护中</el-tag>
        </div>
      </template>

      <el-descriptions :column="2" border class="custom-descriptions">
        <el-descriptions-item label="Node.js 服务启动时间">
          <el-tag type="primary" effect="plain">{{ uptimeVal }} 小时</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="当前服务器在线监控流节点">
          <el-tag type="warning" effect="dark">{{ store.nodes?.length || 0 }} 个在线节点</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="流媒体总缓冲阈值保护">
          <span class="text-safe">15360 MB</span>
        </el-descriptions-item>
        <el-descriptions-item label="UDP通讯及转码管道状态">
          <span class="text-safe">🟢 正常 </span>
        </el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useDeviceStore } from '@/stores/deviceStore'

const store = useDeviceStore()
const timer = ref<number | null>(null)

// 物理内存渐变颜色规则
const customColors = [
  { color: '#5cb87a', percentage: 50 },
  { color: '#e6a23c', percentage: 80 },
  { color: '#f56c6c', percentage: 100 },
]

// 录像容量池专属颜色提醒：快到15GB时变成黄色橙色提示覆盖
const recordColors = [
  { color: '#409eff', percentage: 60 },
  { color: '#e6a23c', percentage: 85 },
  { color: '#e74c3c', percentage: 100 },
]

const statusAny = computed(() => store.systemStatus as any)

const cpuVal = computed(() => {
  if (!statusAny.value) return 0
  const val = Number(statusAny.value.cpuUsage)
  return Number.isNaN(val) || val < 0 ? 0 : val > 100 ? 100 : val
})

// 物理内存占用率
const memVal = computed(() => {
  if (!statusAny.value) return 0
  const val = Number(statusAny.value.memUsage)
  return Number.isNaN(val) || val < 0 ? 0 : val > 100 ? 100 : val
})

// 15GB 视频缓冲池百分比
const recordVal = computed(() => {
  if (!statusAny.value) return 0
  const val = Number(statusAny.value.recordPercent)
  return Number.isNaN(val) || val < 0 ? 0 : val > 100 ? 100 : val
})

// 15GB 视频缓冲池已用文字表现（自动由 MB 转换为更直观的 GB）
const recordUsedStr = computed(() => {
  if (!statusAny.value || !statusAny.value.recordUsageMB) return '0.0 MB'
  const mb = Number(statusAny.value.recordUsageMB)
  if (mb > 1024) {
    return (mb / 1024).toFixed(2) + ' GB'
  }
  return mb.toFixed(1) + ' MB'
})

//  系统主磁盘占用率
const diskVal = computed(() => {
  if (!statusAny.value) return 0
  const val = Number(statusAny.value.diskUsage)
  return Number.isNaN(val) || val < 0 ? 0 : val > 100 ? 100 : val
})

// 字符型安全兜底表现
const diskTotalVal = computed(() => statusAny.value?.diskTotal || '40.0GB')
const memTotalVal = computed(() => statusAny.value?.memTotal || '2.0GB')
const uptimeVal = computed(() => statusAny.value?.uptime || '0')

// 手动拉取并同步后端高精数据的方法
const forceSync = async () => {
  try {
    await store.fetchSystemStatus()
  } catch (err) {
    console.error('抓取系统数据异常:', err)
  }
}

const POLL_INTERVAL = 5000

const startPolling = () => {
  if (timer.value) return
  timer.value = window.setInterval(forceSync, POLL_INTERVAL)
}

const stopPolling = () => {
  if (timer.value) {
    window.clearInterval(timer.value)
    timer.value = null
  }
}

// 页面切到后台时暂停轮询，回到前台立即拉一次并恢复，省去无意义请求与耗电
const handleVisibility = () => {
  if (document.hidden) {
    stopPolling()
  } else {
    forceSync()
    startPolling()
  }
}

onMounted(() => {
  forceSync()
  startPolling()
  document.addEventListener('visibilitychange', handleVisibility)
})

onUnmounted(() => {
  stopPolling()
  document.removeEventListener('visibilitychange', handleVisibility)
})
</script>

<style scoped>
.system-config {
  padding: 20px;
  background: transparent;
  min-height: calc(100vh - 100px);
}
.header-card {
  margin-bottom: 20px;
  border-radius: 12px;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-lighter);
}
.config-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.config-header h2 {
  margin: 0;
  font-size: 18px;
  color: var(--el-text-color-primary);
}
@media screen and (max-width: 768px) {
  .system-config {
    padding: 12px;
  }
  .config-header h2 {
    font-size: 15px;
  }
}
.stat-row {
  display: flex;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.stat-card {
  text-align: center;
  margin-bottom: 20px;
  border-radius: 12px;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-lighter);
  transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.stat-card:hover {
  transform: translateY(-4px);
  box-shadow: var(--el-box-shadow-light);
}
.card-title {
  font-weight: bold;
  color: var(--el-text-color-primary);
  font-size: 14px;
}
.dashboard-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 10px 0;
}
.dashboard-footer {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-top: 12px;
}
.text-highlight strong {
  color: var(--el-color-primary);
  font-size: 15px;
}

/* 底部看门狗面板组件样式 */
.watchdog-card {
  border-radius: 12px;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-lighter);
}
.watchdog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: bold;
  font-size: 15px;
  color: var(--el-text-color-primary);
}
.custom-descriptions {
  margin-top: 5px;
}
.text-safe {
  color: #67c23a;
  font-weight: 500;
}
</style>
