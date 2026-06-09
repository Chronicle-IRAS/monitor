<template>
  <div class="records-container">
    <el-container class="records-layout" v-if="store.isAdmin" v-loading="loading">
      <el-aside width="280px" class="device-aside">
        <div class="aside-header">
          <div class="aside-title">
            <el-icon><FolderOpened /></el-icon>
            <span>设备录像池</span>
          </div>
          <el-tag size="small" effect="plain">{{ recordTree.length }} 个节点</el-tag>
        </div>

        <div class="aside-summary">
          <div class="summary-item">
            <span class="summary-label">录像切片</span>
            <strong>{{ totalFiles }}</strong>
          </div>
          <div class="summary-divider"></div>
          <div class="summary-item">
            <span class="summary-label">占用空间</span>
            <strong>{{ totalSizeLabel }}</strong>
          </div>
        </div>

        <el-menu :default-active="activeDevice" class="device-menu" @select="handleDeviceSelect">
          <el-menu-item v-for="item in recordTree" :key="item.deviceId" :index="item.deviceId">
            <el-icon><VideoCamera /></el-icon>
            <template #title>
              <div class="menu-item-content">
                <div class="device-copy">
                  <span class="device-name">{{ item.deviceId }}</span>
                  <span class="device-meta">{{ item.files.length }} 个录像文件</span>
                </div>

                <div class="menu-actions" @click.stop>
                  <el-button
                    type="text"
                    :icon="DeleteIcon"
                    class="delete-folder-btn"
                    title="删除此设备所有录像"
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
            <div class="eyebrow">History Archive</div>
            <h2>{{ activeDevice || '未选择设备' }}</h2>
            <p class="subtitle">15GB 录像池按先进先出策略自动覆盖旧文件</p>
            <div class="metric-row">
              <el-tag effect="plain" type="primary">{{ currentFiles.length }} 个切片</el-tag>
              <el-tag effect="plain" type="success">{{ activeSizeLabel }}</el-tag>
              <el-tag effect="plain" type="info">{{ latestTimeLabel }}</el-tag>
            </div>
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
            <el-button :icon="Refresh" circle title="刷新录像列表" @click="fetchRecordTree" />
          </div>
        </div>

        <div class="table-shell">
          <el-table
            :data="currentFiles"
            stripe
            style="width: 100%"
            height="calc(100vh - 280px)"
            @selection-change="handleSelectionChange"
          >
            <el-table-column type="selection" width="54" align="center" />

            <el-table-column type="index" label="序号" width="72" align="center" />
            <el-table-column prop="filename" label="视频档案名称" min-width="260">
              <template #default="scope">
                <div class="file-name-cell">
                  <span class="file-icon">
                    <el-icon><Film /></el-icon>
                  </span>
                  <div class="file-copy">
                    <span class="file-title">{{ scope.row.filename }}</span>
                    <span class="file-subtitle">MP4 录像切片</span>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="time" label="录制生成时间" min-width="180" align="center" />
            <el-table-column prop="size" label="文件大小" width="130" align="center">
              <template #default="scope">
                <el-tag size="small" type="success" effect="plain">{{ scope.row.size }}</el-tag>
              </template>
            </el-table-column>

            <el-table-column label="操作" width="172" align="center" fixed="right">
              <template #default="scope">
                <div class="row-actions">
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
                    plain
                    :icon="DeleteIcon"
                    @click="deleteVideo(scope.row.filename)"
                  >
                    删除
                  </el-button>
                </div>
              </template>
            </el-table-column>

            <template #empty>
              <div class="table-empty">
                <el-icon><Film /></el-icon>
                <strong>{{ activeDevice ? '暂无历史视频切片' : '请选择左侧设备节点' }}</strong>
                <span>{{ emptyHint }}</span>
              </div>
            </template>
          </el-table>
        </div>
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
import { ref, shallowRef, computed, onMounted } from 'vue'
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
const loading = shallowRef(false)
const recordTree = ref<RecordNode[]>([])
const activeDevice = shallowRef('')
const multipleSelection = ref<RecordFile[]>([])

const activeNode = computed(() => recordTree.value.find((node) => node.deviceId === activeDevice.value))
const currentFiles = computed(() => activeNode.value?.files ?? [])
const totalFiles = computed(() =>
  recordTree.value.reduce((total, node) => total + node.files.length, 0),
)
const totalSizeMB = computed(() =>
  recordTree.value.reduce((total, node) => total + sumFileSize(node.files), 0),
)
const activeSizeMB = computed(() => sumFileSize(currentFiles.value))
const totalSizeLabel = computed(() => formatSize(totalSizeMB.value))
const activeSizeLabel = computed(() => formatSize(activeSizeMB.value))
const latestTimeLabel = computed(() => currentFiles.value[0]?.time || '暂无录像')
const emptyHint = computed(() =>
  activeDevice.value ? '当前设备还没有生成录像文件' : '选择一个设备后可查看录像列表',
)

const parseSizeMB = (size: string) => {
  const value = Number.parseFloat(size)
  if (Number.isNaN(value)) return 0
  return size.toLowerCase().includes('gb') ? value * 1024 : value
}

const sumFileSize = (files: RecordFile[]) =>
  files.reduce((total, file) => total + parseSizeMB(file.size), 0)

const formatSize = (sizeMB: number) => {
  if (sizeMB >= 1024) return `${(sizeMB / 1024).toFixed(2)} GB`
  return `${sizeMB.toFixed(1)} MB`
}

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
    `确定删除设备 [ ${deviceId} ] 的全部录像文件吗？该操作会清空此设备的历史视频，且不可恢复。`,
    '删除设备录像目录',
    {
      confirmButtonText: '删除整个目录',
      cancelButtonText: '取消',
      type: 'error',
      buttonSize: 'small',
    },
  )
    .then(async () => {
      loading.value = true
      try {
        await axios.delete(`${API_BASE}/records/${deviceId}`)
        ElMessage.success(`设备 [${deviceId}] 的录像目录已删除`)

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
        ElMessage.success('录像文件已删除')
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
    `当前已选择 [ ${totalSelected} ] 个视频文件，确定批量删除吗？该操作不可恢复。`,
    '批量删除录像文件',
    {
      confirmButtonText: `删除 ${totalSelected} 个文件`,
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
        ElMessage.success(`已删除 ${totalSelected} 个历史视频文件`)
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
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
}
.device-aside {
  background: color-mix(in srgb, var(--el-bg-color) 92%, var(--el-color-primary) 8%);
  border-right: 1px solid var(--el-border-color-lighter);
  display: flex;
  flex-direction: column;
}
.aside-header {
  padding: 16px 18px;
  font-size: 14px;
  font-weight: bold;
  color: var(--el-text-color-primary);
  border-bottom: 1px solid var(--el-border-color-lighter);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: var(--el-fill-color-light);
}
.aside-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.aside-summary {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 14px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.summary-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.summary-label {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.summary-item strong {
  color: var(--el-text-color-primary);
  font-size: 18px;
  line-height: 1.2;
}
.summary-divider {
  width: 1px;
  height: 34px;
  background: var(--el-border-color-lighter);
}
.device-menu {
  border-right: none;
  background: transparent;
  padding: 8px;
}
.device-menu :deep(.el-menu-item) {
  height: 62px;
  border-radius: 6px;
  margin-bottom: 6px;
  padding: 0 10px !important;
}
.menu-item-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  min-width: 0;
}
.device-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.device-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 150px;
  line-height: 1.2;
}
.device-meta {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.2;
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
  min-width: 0;
}
.main-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 18px;
  margin-bottom: 18px;
  padding: 18px 20px;
  background: var(--el-fill-color-extra-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.title-area {
  min-width: 0;
}
.eyebrow {
  margin-bottom: 4px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}
.title-area h2 {
  margin: 0 0 8px 0;
  color: var(--el-text-color-primary);
  font-size: 22px;
  line-height: 1.25;
  overflow-wrap: anywhere;
}
.metric-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.title-area .highlight {
  color: var(--el-text-color-primary);
}
.subtitle {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.action-group {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
.table-shell {
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
}
.file-name-cell {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.file-icon {
  display: inline-flex;
  width: 34px;
  height: 34px;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border-radius: 6px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
.file-icon .el-icon {
  font-size: 16px;
}
.file-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}
.file-title {
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-subtitle {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.row-actions {
  display: flex;
  justify-content: center;
  gap: 8px;
}
.row-actions .el-button + .el-button {
  margin-left: 0;
}
.table-empty {
  min-height: 280px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  color: var(--el-text-color-secondary);
}
.table-empty .el-icon {
  color: var(--el-text-color-placeholder);
  font-size: 42px;
}
.table-empty strong {
  color: var(--el-text-color-primary);
  font-size: 15px;
}
.table-empty span {
  font-size: 13px;
}
:deep(.el-menu-item.is-active) {
  background-color: var(--el-color-primary-light-9) !important;
  font-weight: bold;
}
:deep(.el-table) {
  --el-table-border-color: var(--el-border-color-lighter);
  --el-table-header-bg-color: var(--el-fill-color-extra-light);
}
:deep(.el-table th.el-table__cell) {
  color: var(--el-text-color-secondary);
  font-weight: 700;
}
:deep(.el-table .el-table__cell) {
  padding: 12px 0;
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
    max-height: 36vh;
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
    padding: 16px;
  }
  .action-group {
    justify-content: space-between;
  }
  .device-name {
    max-width: 60vw;
  }
  .row-actions {
    flex-direction: column;
  }
  .row-actions .el-button {
    width: 100%;
  }
}
</style>
