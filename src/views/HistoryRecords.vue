<template>
  <div class="records-container">
    <el-container class="records-layout" v-if="store.isAdmin" v-loading="loading">
      <el-aside width="260px" class="device-aside">
        <div class="aside-header">
          <el-icon><FolderOpened /></el-icon>
          <span>监控设备录像池</span>
        </div>
        <el-menu :default-active="activeDevice" class="device-menu" @select="handleDeviceSelect">
          <el-menu-item v-for="item in recordTree" :key="item.deviceId" :index="item.deviceId">
            <el-icon><VideoCamera /></el-icon>
            <template #title>
              <div class="menu-item-content">
                <span class="device-name">{{ item.deviceId }}</span>

                <div class="menu-actions" @click.stop>
                  <el-badge :value="item.files.length" type="info" class="file-badge" />
                  <el-button
                    type="text"
                    :icon="DeleteIcon"
                    class="delete-folder-btn"
                    title="彻底删除此设备所有录像"
                    @click="deleteDeviceFolder(item.deviceId)"
                  />
                </div>
              </div>
            </template>
          </el-menu-item>
        </el-menu>
        <div v-if="recordTree.length === 0" class="empty-aside">
          <el-empty description="暂无录像目录" :image-size="60" />
        </div>
      </el-aside>

      <el-main class="file-main">
        <div class="main-header">
          <div class="title-area">
            <h2>
              当前节点：<span class="highlight">{{ activeDevice || '未选择' }}</span>
            </h2>
            <p class="subtitle">系统严格执行 15GB 空间上限保护，新录制文件将自动覆盖旧档案</p>
          </div>

          <div class="action-group">
            <transition name="fade">
              <el-button
                v-if="multipleSelection.length > 0"
                type="danger"
                :icon="DeleteIcon"
                @click="handleBatchDelete"
              >
                批量删除 (已选 {{ multipleSelection.length }} 项)
              </el-button>
            </transition>
            <el-button :icon="Refresh" circle @click="fetchRecordTree" />
          </div>
        </div>

        <el-table
          :data="currentFiles"
          stripe
          style="width: 100%"
          height="calc(100vh - 220px)"
          empty-text="此设备下暂无历史视频切片"
          @selection-change="handleSelectionChange"
        >
          <el-table-column type="selection" width="55" align="center" />

          <el-table-column type="index" label="序号" width="60" align="center" />
          <el-table-column prop="filename" label="视频档案名称" min-width="200">
            <template #default="scope">
              <div class="file-name-cell">
                <el-icon class="mp4-icon"><Film /></el-icon>
                <span>{{ scope.row.filename }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="time" label="录制生成时间" width="180" align="center" />
          <el-table-column prop="size" label="文件大小" width="120" align="center">
            <template #default="scope">
              <el-tag size="small" type="success" effect="plain">{{ scope.row.size }}</el-tag>
            </template>
          </el-table-column>

          <el-table-column label="操作区域" width="180" align="center" fixed="right">
            <template #default="scope">
              <el-button
                type="primary"
                size="small"
                :icon="Download"
                @click="downloadVideo(scope.row.filename)"
              >
                下载
              </el-button>
              <el-button
                type="danger"
                size="small"
                :icon="DeleteIcon"
                @click="deleteVideo(scope.row.filename)"
              >
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-main>
    </el-container>

    <el-alert
      v-else
      title="权限不足：您当前处于访客只读模式"
      type="error"
      description="历史录像回溯功能涉及实验室硬件隐私安全，仅对管理员开放。请在系统右上角登录管理员账号后再试。"
      show-icon
      :closable="false"
      style="padding: 20px"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  FolderOpened,
  VideoCamera,
  Film,
  Download,
  Refresh,
  Delete as DeleteIcon,
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useDeviceStore } from '@/stores/deviceStore'
import axios from 'axios'
import { API_BASE } from '@/config'

interface RecordFile {
  filename: string
  size: string
  time: string
}

interface RecordNode {
  deviceId: string
  files: RecordFile[]
}

const store = useDeviceStore()
const loading = ref(false)
const recordTree = ref<RecordNode[]>([])
const activeDevice = ref<string>('')
const multipleSelection = ref<RecordFile[]>([])

const currentFiles = computed(() => {
  const target = recordTree.value.find((node) => node.deviceId === activeDevice.value)
  return target ? target.files : []
})

const handleSelectionChange = (val: RecordFile[]) => {
  multipleSelection.value = val
}

const fetchRecordTree = async () => {
  if (!store.isAdmin) return

  loading.value = true
  try {
    const res = await axios.get(`${API_BASE}/records`)
    recordTree.value = res.data

    const stillExists = recordTree.value.some((node) => node.deviceId === activeDevice.value)
    if (!stillExists && recordTree.value.length > 0) {
      activeDevice.value = recordTree.value[0]?.deviceId || ''
    } else if (recordTree.value.length === 0) {
      activeDevice.value = ''
    }
  } catch (error) {
    console.error('获取历史录像结构失败:', error)
    ElMessage.error('无法读取服务器录像空间状态')
  } finally {
    loading.value = false
  }
}

const handleDeviceSelect = (deviceId: string) => {
  activeDevice.value = deviceId
  multipleSelection.value = []
}

// 🚀 新增：彻底删除整个摄像头设备录像文件夹（极高危动作）
const deleteDeviceFolder = (deviceId: string) => {
  if (!store.isAdmin) return

  ElMessageBox.confirm(
    `毁灭性警告：确定要从云服务器中【彻底删除】设备 [ ${deviceId} ] 的整个录像文件夹吗？该文件夹下的所有历史监控视频将全部被抹除，本操作不可恢复！`,
    '设备录像池完整清空提示',
    {
      confirmButtonText: '确定级联删除整个目录',
      cancelButtonText: '取消',
      type: 'error',
      buttonSize: 'small',
    },
  )
    .then(async () => {
      loading.value = true
      try {
        await axios.delete(`${API_BASE}/records/${deviceId}`)
        ElMessage.success(`设备 [${deviceId}] 的录像目录已成功从磁盘粉碎`)

        // 如果删掉的正是当前高亮选中的，退回空选状态状态
        if (activeDevice.value === deviceId) {
          activeDevice.value = ''
        }

        await fetchRecordTree()
      } catch (error) {
        console.error('删除设备文件夹失败:', error)
        ElMessage.error('删除失败，请检查后端联动状态')
      } finally {
        loading.value = false
      }
    })
    .catch(() => {})
}

const downloadVideo = (filename: string) => {
  if (!store.isAdmin || !activeDevice.value) {
    ElMessage.error('非法操作，拒绝下载')
    return
  }
  const downloadUrl = `${API_BASE}/records/download/${activeDevice.value}/${filename}`
  const link = document.createElement('a')
  link.href = downloadUrl
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

// 单个文件删除
const deleteVideo = (filename: string) => {
  if (!store.isAdmin || !activeDevice.value) return

  ElMessageBox.confirm(`确定要彻底删除录像切片 [${filename}] 吗？`, '存储物理删除提示', {
    confirmButtonText: '确定删除',
    cancelButtonText: '取消',
    type: 'warning',
    buttonSize: 'small',
  })
    .then(async () => {
      loading.value = true
      try {
        await axios.delete(`${API_BASE}/records/${activeDevice.value}/${filename}`)
        ElMessage.success('该文件已被成功物理清除')
        await fetchRecordTree()
      } catch (error) {
        ElMessage.error('删除失败')
      } finally {
        loading.value = false
      }
    })
    .catch(() => {})
}

// 批量删除
const handleBatchDelete = () => {
  if (!store.isAdmin || !activeDevice.value || multipleSelection.value.length === 0) return

  const totalSelected = multipleSelection.value.length
  const fileNamesPayload = multipleSelection.value.map((item) => item.filename)

  ElMessageBox.confirm(
    `高危操作警告：您当前勾选了 [ ${totalSelected} ] 个视频文件，确定要将它们从服务器中批量抹除吗？`,
    '存储空间批量销毁提示',
    {
      confirmButtonText: `确定批量粉碎这 ${totalSelected} 个文件`,
      cancelButtonText: '取消',
      type: 'error',
      buttonSize: 'small',
    },
  )
    .then(async () => {
      loading.value = true
      try {
        await axios.post(`${API_BASE}/records/batch-delete`, {
          deviceId: activeDevice.value,
          filenames: fileNamesPayload,
        })
        ElMessage.success(`成功批量粉碎了 ${totalSelected} 个历史视频档案！`)
        multipleSelection.value = []
        await fetchRecordTree()
      } catch (error) {
        ElMessage.error('批量删除未完全成功')
      } finally {
        loading.value = false
      }
    })
    .catch(() => {})
}

onMounted(() => {
  fetchRecordTree()
})
</script>

<style scoped>
.records-container {
  padding: 20px;
  background: transparent;
  min-height: calc(100vh - 100px);
  box-sizing: border-box;
}
.records-layout {
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
}
.device-aside {
  background: var(--el-bg-color);
  border-right: 1px solid var(--el-border-color-lighter);
  display: flex;
  flex-direction: column;
}
.aside-header {
  padding: 16px 20px;
  font-size: 14px;
  font-weight: bold;
  color: var(--el-text-color-primary);
  border-bottom: 1px solid var(--el-border-color-lighter);
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--el-fill-color-light);
}
.device-menu {
  border-right: none;
  background: transparent;
}
.menu-item-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}
.device-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 130px;
}
.empty-aside {
  padding-top: 40px;
}

/* 🚀 侧边栏小垃圾桶交互动效样式 */
.menu-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.delete-folder-btn {
  color: var(--el-text-color-secondary);
  padding: 0;
  font-size: 14px;
  transition: color 0.2s;
}
.delete-folder-btn:hover {
  color: var(--el-color-danger) !important;
}

.file-main {
  background: var(--el-bg-color-overlay);
  padding: 24px;
}
.main-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  padding-bottom: 15px;
}
.title-area h2 {
  margin: 0 0 6px 0;
  font-size: 18px;
  color: var(--el-text-color-primary);
}
.title-area .highlight {
  color: var(--el-color-primary);
}
.subtitle {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.action-group {
  display: flex;
  align-items: center;
  gap: 12px;
}
.file-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mp4-icon {
  color: var(--el-color-primary);
  font-size: 16px;
}
:deep(.el-menu-item.is-active) {
  background-color: var(--el-color-primary-light-9) !important;
  font-weight: bold;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* --- 📱 移动端：左右分栏改为上下堆叠 --- */
@media screen and (max-width: 768px) {
  .records-container {
    padding: 12px;
  }
  /* el-container 默认横向，窄屏强制竖向堆叠 */
  .records-layout {
    flex-direction: column;
  }
  /* 设备列表收到顶部，限制高度可滚动，边框由右改下 */
  .device-aside {
    width: 100% !important;
    max-width: 100% !important;
    max-height: 30vh;
    overflow-y: auto;
    border-right: none;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }
  .file-main {
    padding: 16px;
  }
  /* 标题区与操作按钮在窄屏换行 */
  .main-header {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }
  .device-name {
    max-width: 60vw;
  }
}
</style>
