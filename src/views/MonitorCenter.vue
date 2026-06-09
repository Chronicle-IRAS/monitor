<template>
  <div class="dashboard" v-loading="store.loading">
    <div class="action-bar" v-if="store.isAdmin">
      <el-button type="primary" @click="openAddDialog">添加监控节点</el-button>
      <el-popconfirm title="确定重置所有进程吗？危险操作！" @confirm="store.resetSystem">
        <template #reference>
          <el-button type="danger" plain>一键初始化</el-button>
        </template>
      </el-popconfirm>
      <el-button @click="store.refreshNodes">同步服务器状态</el-button>
    </div>

    <el-alert
      v-else
      title="当前为访客只读模式"
      type="info"
      description="您正在观看实验室硬件实时监控流。如需调度设备，请在右上角登录管理员账号。"
      show-icon
      style="margin-bottom: 20px"
      :closable="false"
    />

    <div class="grid" v-if="store.nodes && store.nodes.length > 0">
      <MonitorCard
        v-for="node in store.nodes"
        :key="node.id"
        :node="node"
        :streamUrl="streamWsUrl(node.http)"
        @close="store.stopNode(node.id)"
      />
    </div>

    <el-empty v-else description="暂无在线监控流" />

    <el-dialog v-model="showAdd" title="动态部署新流节点" width="480px" destroy-on-close>
      <div class="occupied-ports-info" v-if="store.nodes && store.nodes.length > 0">
        <div class="info-title"> 当前系统已分配端口 (请避开以下数字)：</div>
        <div class="tags-container">
          <el-tag v-for="node in store.nodes" :key="node.id" type="warning" effect="dark" round>
            {{ node.id }} UDP: {{ node.udp }} | HTTP: {{ node.http }}
          </el-tag>
        </div>
      </div>

      <el-form
        :model="addForm"
        :rules="rules"
        ref="formRef"
        label-width="100px"
        class="custom-form"
      >
        <el-form-item label="设备名称" prop="id">
          <el-input v-model="addForm.id" placeholder="如: stm32_lab_01" />
        </el-form-item>

        <el-form-item label="推流模式" prop="streamType">
          <el-radio-group v-model="addForm.streamType">
            <el-radio label="ffmpeg">H.264 视频 (省带宽/流畅)</el-radio>
            <el-radio label="mjpeg">MJPEG 原图 (高画质/低延迟)</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="自动录制" prop="isRecord">
          <el-switch v-model="addForm.isRecord" active-text="开启服务器本地录制" />
        </el-form-item>

        <el-form-item label="UDP 端口" prop="udp">
          <el-input-number v-model="addForm.udp" :min="9001" :max="9050" style="width: 100%" />
          <div v-if="isPortUsed(addForm.udp)" class="err-tip"> 此 UDP 端口已被占用</div>
        </el-form-item>

        <el-form-item label="HTTP 端口" prop="http">
          <el-input-number v-model="addForm.http" :min="9051" :max="9100" style="width: 100%" />
          <div v-if="isPortUsed(addForm.http)" class="err-tip"> 此 HTTP 端口已被占用</div>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="showAdd = false">取消</el-button>
        <el-button type="primary" :loading="isStarting" @click="confirmAddNode">立即启动</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useDeviceStore } from '@/stores/deviceStore'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import MonitorCard from '@/components/MonitorCard.vue'
import axios from 'axios'
import { API_BASE, streamWsUrl } from '@/config'

const checkPortStatus = async (type: 'udp' | 'http', port: number) => {
  try {
    const res = await axios.get(`${API_BASE}/ports/check?${type}=${port}`)
    return type === 'udp' ? res.data.udpUsed : res.data.httpUsed
  } catch (error) {
    return false
  }
}

const store = useDeviceStore()
const showAdd = ref(false)
const isStarting = ref(false)

const addForm = reactive({
  id: '',
  udp: 9001,
  http: 9051,
  streamType: 'ffmpeg',
  isRecord: false,
})

const formRef = ref<FormInstance>()

const rules = reactive<FormRules>({
  id: [{ required: true, message: '必须填写设备名称', trigger: 'blur' }],
  streamType: [{ required: true, message: '请选择推流模式', trigger: 'change' }],
  udp: [
    { required: true, message: '必须填写硬件通讯端口', trigger: 'blur' },
    { type: 'number', min: 9001, max: 9050, message: '规范：9001 ~ 9050', trigger: 'change' },
    {
      validator: async (rule, value, callback) => {
        if (!value) return callback()
        const isUsed = await checkPortStatus('udp', value)
        if (isUsed) callback(new Error('⚠️ 警告：该系统端口已被后台物理占用！'))
        else callback()
      },
      trigger: 'blur',
    },
  ],
  http: [
    { required: true, message: '必须填写视频流端口', trigger: 'blur' },
    { type: 'number', min: 9051, max: 9100, message: '规范：9051 ~ 9100', trigger: 'change' },
    {
      validator: async (rule, value, callback) => {
        if (!value) return callback()
        const isUsed = await checkPortStatus('http', value)
        if (isUsed) callback(new Error('⚠️ 警告：该系统端口已被后台物理占用！'))
        else callback()
      },
      trigger: 'blur',
    },
  ],
})

onMounted(() => {
  store.refreshNodes()
})

const openAddDialog = () => {
  showAdd.value = true
}

const isPortUsed = (port: number) => {
  return store.usedPorts && store.usedPorts.has(port)
}

const confirmAddNode = async () => {
  if (!formRef.value) return
  try {
    await formRef.value.validate()
  } catch (err) {
    ElMessage.warning('请检查填写的端口号是否符合规范！')
    return
  }

  if (isPortUsed(addForm.udp) || isPortUsed(addForm.http)) {
    ElMessage.error('存在被占用的端口，请修改后再试！')
    return
  }

  isStarting.value = true
  try {
    await store.startNode({ ...addForm })
    showAdd.value = false
    formRef.value.resetFields()
    addForm.id = ''
    addForm.streamType = 'ffmpeg'
    addForm.isRecord = false
  } catch (error) {
    console.error('部署节点失败:', error)
  } finally {
    isStarting.value = false
  }
}
</script>

<style scoped>
.dashboard {
  padding: 20px;
  background: transparent;
  min-height: calc(100vh - 100px);
}
.action-bar {
  margin-bottom: 20px;
  display: flex;
  gap: 15px;
  flex-wrap: wrap;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 20px;
}
.occupied-ports-info {
  background-color: var(--el-color-warning-light-9);
  border: 1px solid var(--el-color-warning-light-5);
  padding: 12px 15px;
  border-radius: 6px;
  margin-bottom: 20px;
}
.info-title {
  font-size: 13px;
  color: var(--el-color-warning);
  margin-bottom: 10px;
  font-weight: bold;
}
.tags-container {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.custom-form .el-form-item {
  margin-bottom: 24px;
  position: relative;
}
.err-tip {
  position: absolute;
  bottom: -22px;
  left: 0;
  color: #f56c6c;
  font-size: 12px;
  font-weight: 500;
  animation: fadeIn 0.3s ease;
}
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media screen and (max-width: 768px) {
  .dashboard {
    padding: 10px;
  }
  .action-bar {
    gap: 10px;
  }
  .action-bar .el-button {
    flex: 1;
    min-width: calc(50% - 10px);
    margin-left: 0 !important;
  }
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
