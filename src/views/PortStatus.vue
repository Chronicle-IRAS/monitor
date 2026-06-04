<template>
  <div class="port-status-page">
    <div class="header">
      <h2>服务器全局端口</h2>
      <el-button type="primary" :loading="loading" @click="scanPorts" icon="Refresh">
        立即物理扫描
      </el-button>
    </div>

    <el-row :gutter="20" v-loading="loading">
      <el-col :xs="24" :sm="12">
        <el-card class="port-card dark-card">
          <template #header>
            <div class="card-title">
              <span class="dot tcp-dot"></span> TCP 监听端口 (共 {{ tcpPorts.length }} 个)
            </div>
          </template>
          <div class="tags-box">
            <el-tag
              v-for="port in tcpPorts"
              :key="'tcp-' + port"
              :type="getSpecialPortType(port)"
              effect="dark"
              class="port-tag"
            >
              {{ port }} {{ getPortDesc(port) }}
            </el-tag>
            <el-empty v-if="tcpPorts.length === 0" description="暂无 TCP 端口" :image-size="60" />
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :sm="12">
        <el-card class="port-card dark-card">
          <template #header>
            <div class="card-title">
              <span class="dot udp-dot"></span> UDP 监听端口 (共 {{ udpPorts.length }} 个)
            </div>
          </template>
          <div class="tags-box">
            <el-tag
              v-for="port in udpPorts"
              :key="'udp-' + port"
              type="warning"
              effect="dark"
              class="port-tag"
            >
              {{ port }} {{ getPortDesc(port) }}
            </el-tag>
            <el-empty v-if="udpPorts.length === 0" description="暂无 UDP 端口" :image-size="60" />
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import axios from 'axios'
import { API_BASE } from '@/config'

const loading = ref(false)
const tcpPorts = ref<number[]>([])
const udpPorts = ref<number[]>([])

const getPortDesc = (port: number) => {
  const dict: Record<number, string> = {
    22: '(SSH)',
    80: '(Nginx HTTP)',
    443: '(Nginx HTTPS)',
    3000: '(Manager API)',
    3306: '(MySQL)',
    6379: '(Redis)',
  }
  return dict[port] || ''
}

// 特殊端口给不同的颜色
const getSpecialPortType = (port: number) => {
  if (port === 22 || port === 80) return 'danger'
  if (port === 3000) return 'success'
  if (port >= 9051 && port <= 9100) return 'primary' // 咱们自己的视频流
  return 'info'
}

const scanPorts = async () => {
  loading.value = true
  try {
    const res = await axios.get(`${API_BASE}/system/all-ports`)
    tcpPorts.value = res.data.tcp
    udpPorts.value = res.data.udp
  } catch (error) {
    console.error('扫描失败', error)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  scanPorts()
})
</script>

<style scoped>
.port-status-page {
  padding: 20px;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
  color: var(--el-text-color-primary);
  flex-wrap: wrap;
  gap: 12px;
}
.header h2 {
  font-size: 18px;
  margin: 0;
}
@media screen and (max-width: 768px) {
  .port-status-page {
    padding: 12px;
  }
  /* 第二张卡片顶到第一张下方时留出间距 */
  .port-status-page :deep(.el-col) {
    margin-bottom: 16px;
  }
}
.dark-card {
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-darker);
}
.card-title {
  display: flex;
  align-items: center;
  font-weight: bold;
  font-size: 16px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 8px;
  box-shadow: 0 0 8px currentColor;
}
.tcp-dot {
  background-color: #409eff;
  color: #409eff;
}
.udp-dot {
  background-color: #e6a23c;
  color: #e6a23c;
}

.tags-box {
  min-height: 200px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-content: flex-start;
}
.port-tag {
  font-size: 14px;
  padding: 6px 12px;
  height: auto;
  font-family: monospace;
}
</style>
