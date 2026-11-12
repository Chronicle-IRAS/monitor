<template>
  <div class="records-container">
    <el-container
      class="records-layout"
      v-if="store.isAdmin"
      v-loading="loading"
      element-loading-text="正在读取录像索引…"
    >
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
                  <span class="device-meta"
                    >{{ item.files.length }} 个切片 ·
                    {{ formatSize(sumFileSize(item.files)) }}</span
                  >
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
            <p class="subtitle">3GB 录像池按先进先出策略自动覆盖旧文件</p>
            <div class="metric-row">
              <el-tag effect="plain" type="primary">{{ currentFiles.length }} 个切片</el-tag>
              <el-tag effect="plain" type="success">{{ activeSizeLabel }}</el-tag>
              <el-tag effect="plain" type="info">{{ latestTimeLabel }}</el-tag>
            </div>
          </div>

          <div class="action-group">
            <el-button :icon="Refresh" @click="fetchRecordTree">刷新</el-button>
          </div>
        </div>

        <Transition name="fade">
          <div v-if="multipleSelection.length > 0" class="selection-bar">
            <span class="selection-count"
              >已选择 <strong>{{ multipleSelection.length }}</strong> 个切片</span
            >
            <div class="selection-actions">
              <el-button text @click="clearSelection">取消选择</el-button>
              <el-button type="danger" :icon="DeleteIcon" @click="handleBatchDelete">
                删除选中
              </el-button>
            </div>
          </div>
        </Transition>

        <div v-if="!isMobile" class="table-shell">
          <el-table
            ref="tableRef"
            :data="currentFiles"
            stripe
            style="width: 100%"
            max-height="calc(100vh - 360px)"
            @selection-change="handleSelectionChange"
          >
            <el-table-column type="selection" width="48" align="center" />

            <el-table-column label="录像文件" min-width="220">
              <template #default="scope">
                <div class="file-name-cell">
                  <span class="file-icon">
                    <el-icon><Film /></el-icon>
                  </span>
                  <div class="file-copy">
                    <span class="file-title">{{ scope.row.time }}</span>
                    <span class="file-meta">
                      <span class="file-name" :title="scope.row.filename">{{
                        scope.row.filename
                      }}</span>
                      <span class="file-dot">·</span>
                      <span>{{ scope.row.size }}</span>
                    </span>
                  </div>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="操作" width="156" align="center" fixed="right">
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
                <strong>{{ emptyTitle }}</strong>
                <span>{{ emptyHint }}</span>
                <el-button size="small" :icon="Refresh" @click="fetchRecordTree"
                  >刷新列表</el-button
                >
              </div>
            </template>
          </el-table>
          <div class="table-footer">
            <span>共 {{ currentFiles.length }} 个切片</span>
            <span>{{ activeSizeLabel }} · 最新 {{ latestTimeLabel }}</span>
          </div>
        </div>

        <div v-else class="file-card-list">
          <article
            v-for="file in currentFiles"
            :key="file.filename"
            class="file-card"
            :class="{ selected: isSelected(file) }"
          >
            <div class="file-card-head">
              <el-checkbox
                :model-value="isSelected(file)"
                :aria-label="'选择 ' + file.filename"
                @change="toggleFileSelection(file, $event)"
              />
              <span class="file-icon">
                <el-icon><Film /></el-icon>
              </span>
              <div class="file-copy">
                <span class="file-title">{{ file.time }}</span>
                <span class="file-meta">
                  <span class="file-name" :title="file.filename">{{ file.filename }}</span>
                  <span class="file-dot">·</span>
                  <span>{{ file.size }}</span>
                </span>
              </div>
            </div>
            <div class="file-card-actions">
              <el-button
                type="primary"
                size="small"
                :icon="Download"
                @click="downloadVideo(file.filename)"
              >
                下载
              </el-button>
              <el-button
                type="danger"
                size="small"
                plain
                :icon="DeleteIcon"
                @click="deleteVideo(file.filename)"
              >
                删除
              </el-button>
            </div>
          </article>

          <div v-if="currentFiles.length === 0" class="table-empty">
            <el-icon><Film /></el-icon>
            <strong>{{ emptyTitle }}</strong>
            <span>{{ emptyHint }}</span>
            <el-button size="small" :icon="Refresh" @click="fetchRecordTree">刷新列表</el-button>
          </div>

          <div class="table-footer">
            <span>共 {{ currentFiles.length }} 个切片</span>
            <span>{{ activeSizeLabel }} · 最新 {{ latestTimeLabel }}</span>
          </div>
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
import { ref, shallowRef, computed, watch, onMounted, onUnmounted } from 'vue'
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
const tableRef = ref<{ clearSelection: () => void } | null>(null)
const isMobile = ref(typeof window !== 'undefined' && window.innerWidth <= 768)
const syncViewport = () => {
  isMobile.value = window.innerWidth <= 768
}

const activeNode = computed(() =>
  recordTree.value.find((node) => node.deviceId === activeDevice.value),
)
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
const emptyHint = computed(() => {
  if (recordTree.value.length === 0) return '服务器录像池为空，等待设备生成切片'
  if (activeDevice.value) return '当前设备还没有生成录像文件'
  return '选择一个设备后可查看录像列表'
})
const emptyTitle = computed(() => {
  if (recordTree.value.length === 0) return '暂无录像目录'
  if (activeDevice.value) return '暂无历史视频切片'
  return '请选择左侧设备节点'
})

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

const clearSelection = () => {
  multipleSelection.value = []
  tableRef.value?.clearSelection()
}

const isSelected = (file: RecordFile) =>
  multipleSelection.value.some((item) => item.filename === file.filename)

const toggleFileSelection = (file: RecordFile, checked: boolean | string | number) => {
  if (checked) {
    if (!isSelected(file)) multipleSelection.value = [...multipleSelection.value, file]
  } else {
    multipleSelection.value = multipleSelection.value.filter(
      (item) => item.filename !== file.filename,
    )
  }
}

const fetchRecordTree = async () => {
  if (!store.isAdmin) return

  loading.value = true
  try {
    const res = await axios.get(`${API_BASE}/records`)
    recordTree.value = res.data
    clearSelection()

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
  clearSelection()
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
  const downloadUrl = `${API_BASE}/records/download/${encodeURIComponent(activeDevice.value)}/${encodeURIComponent(filename)}`
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
        await axios.delete(
          `${API_BASE}/records/${encodeURIComponent(activeDevice.value)}/${encodeURIComponent(filename)}`,
        )
        ElMessage.success('录像文件已删除')
        await fetchRecordTree()
      } catch {
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
      } catch {
        ElMessage.error('批量删除未完全成功')
      } finally {
        loading.value = false
      }
    })
    .catch(() => {})
}

watch(
  () => store.isAdmin,
  (isAdmin) => {
    if (isAdmin) fetchRecordTree()
  },
  { immediate: true },
)

watch(isMobile, () => {
  clearSelection()
})

onMounted(() => {
  window.addEventListener('resize', syncViewport)
})

onUnmounted(() => {
  window.removeEventListener('resize', syncViewport)
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
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  margin-bottom: 16px;
  padding: 18px 20px;
  background: linear-gradient(
    120deg,
    var(--el-fill-color-extra-light),
    color-mix(in srgb, var(--el-bg-color) 88%, var(--el-color-primary) 12%)
  );
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
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
.selection-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding: 9px 14px;
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 10px;
  background: var(--el-color-primary-light-9);
  color: var(--el-text-color-primary);
}
.selection-count {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.selection-count strong {
  color: var(--el-color-primary);
  font-weight: 700;
}
.selection-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.table-shell {
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
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
  border-radius: 8px;
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
  gap: 2px;
}
.file-title {
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-meta {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 5px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-dot {
  color: var(--el-text-color-placeholder);
}
.file-card-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.file-card {
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  background: var(--el-bg-color);
  transition:
    border-color 180ms,
    background 180ms;
}
.file-card.selected {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
}
.file-card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.file-card-head .el-checkbox {
  margin-right: 0;
  flex-shrink: 0;
}
.file-card-head .file-copy {
  flex: 1;
}
.file-card-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--el-border-color-lighter);
}
.file-card-actions .el-button {
  flex: 1;
  margin-left: 0;
}
.file-card-list .table-footer {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
}
.table-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-extra-light);
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
.table-empty .el-button {
  margin-top: 6px;
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
  /* 设备列表改为横向滑动，避免窄屏出现被截断的嵌套滚动 */
  .device-aside {
    width: 100% !important;
    max-width: 100% !important;
    max-height: none;
    overflow: visible;
    border-right: none;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }
  .device-menu {
    display: flex;
    gap: 8px;
    padding: 8px 12px 12px;
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .device-menu :deep(.el-menu-item) {
    flex: 0 0 220px;
    height: 58px;
    margin-bottom: 0;
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
  .selection-bar {
    flex-wrap: wrap;
  }
  .selection-actions {
    width: 100%;
    justify-content: flex-end;
  }
  .table-footer {
    flex-wrap: wrap;
    gap: 4px 12px;
  }
  .device-name {
    max-width: 140px;
  }
  .row-actions {
    flex-direction: column;
  }
  .row-actions .el-button {
    width: 100%;
  }
}
</style>
