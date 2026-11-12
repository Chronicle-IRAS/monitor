import { defineStore } from 'pinia'
import axios from 'axios'
import { ElMessage } from 'element-plus'
import { API_BASE } from '@/config'

axios.defaults.timeout = 5000

export interface DeviceNode {
  id: string
  udp: number
  http: number
  streamType?: 'ffmpeg' | 'mjpeg' | 'jpeg-udp'
  isRecord?: boolean
  status?: string
  receiving?: boolean
  rxFrames?: number
}

export const useDeviceStore = defineStore('device', {
  state: () => ({
    nodes: [] as DeviceNode[],
    systemStatus: { cpuUsage: '0', memUsage: '0', memTotal: '0', uptime: '0' },
    loading: false,
    // 从本地存储读取管理员状态
    isAdmin: false,
  }),
  getters: {
    usedPorts: (state) => {
      const ports = new Set<number>()
      if (state.nodes && Array.isArray(state.nodes)) {
        state.nodes.forEach((n) => {
          if (n.udp) ports.add(Number(n.udp))
          if (n.http) ports.add(Number(n.http))
        })
      }
      return ports
    },
  },
  actions: {
    async login(password: string) {
      try {
        await axios.post(`${API_BASE}/auth/login`, { password })
        this.isAdmin = true
        ElMessage.success('管理员认证成功')
        return true
      } catch {
        this.isAdmin = false
        ElMessage.error('认证失败')
        return false
      }
    },

    async logout() {
      await axios.post(`${API_BASE}/auth/logout`)
      this.isAdmin = false
    },

    async restoreSession() {
      try {
        const { data } = await axios.get(`${API_BASE}/auth/session`)
        this.isAdmin = data.authenticated === true
      } catch { this.isAdmin = false }
    },

    async refreshNodes() {
      this.loading = true
      try {
        const { data } = await axios.get(`${API_BASE}/nodes`)
        this.nodes = data || []
      } catch (err) {
        console.error('获取节点失败:', err)
        this.nodes = []
      } finally {
        this.loading = false
      }
    },

    async fetchSystemStatus() {
      try {
        const { data } = await axios.get(`${API_BASE}/system/status`)
        if (data && data.cpuUsage) {
          this.systemStatus = data
        }
      } catch (err) {
        // 静默失败
      }
    },

    async startNode(node: DeviceNode) {
      if (!this.isAdmin) return ElMessage.error('无权限操作')

      if (this.usedPorts.has(Number(node.udp)) || this.usedPorts.has(Number(node.http))) {
        ElMessage.error('端口冲突：该端口已被占用！')
        throw new Error('Port collision')
      }
      this.loading = true
      try {
        await axios.post(`${API_BASE}/nodes/start`, node)
        ElMessage.success(`节点 ${node.id} 启动成功`)
        await this.refreshNodes()
      } catch (err: any) {
        ElMessage.error('节点部署失败，请检查后端状态')
      } finally {
        this.loading = false
      }
    },

    async stopNode(id: string) {
      if (!this.isAdmin) return ElMessage.error('无权限操作')
      try {
        await axios.post(`${API_BASE}/nodes/stop`, { id })
        ElMessage.success(`节点 ${id} 已下线`)
        await this.refreshNodes()
      } catch (err) {
        ElMessage.error('停止节点失败')
      }
    },

    async resetSystem() {
      if (!this.isAdmin) return ElMessage.error('无权限操作')
      this.loading = true
      try {
        await axios.post(`${API_BASE}/nodes/reset`)
        ElMessage.success('系统进程已全部初始化')
        await this.refreshNodes()
      } catch (err) {
        ElMessage.error('初始化失败，请检查后端是否运行')
      } finally {
        this.loading = false
      }
    },
  },
})
