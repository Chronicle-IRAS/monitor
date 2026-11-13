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

    <div v-if="orderedNodes.length > 1" class="grid-hint">
      <el-icon><Rank /></el-icon>
      <span>长按节点可拖动排序</span>
    </div>

    <div
      class="grid"
      v-if="store.nodes && store.nodes.length > 0"
      @click.capture="onGridClickCapture"
    >
      <div
        v-for="node in orderedNodes"
        :key="node.id"
        class="node-slot"
        :class="{ 'is-dragging': draggingId === node.id }"
        :data-node-id="node.id"
        @pointerdown="onSlotPointerDown($event, node.id)"
        @contextmenu="onSlotContextMenu"
      >
        <MonitorCard
          :node="node"
          :can-manage="store.isAdmin"
          :stopping="store.stoppingIds.includes(node.id)"
          :streamUrl="streamWsUrl(node.http)"
          @close="store.stopNode(node.id)"
        />
      </div>
    </div>

    <el-empty v-else description="暂无在线监控流" />

    <Teleport to="body">
      <div
        v-if="dragGhost"
        class="drag-ghost"
        :class="{ 'is-dropping': dragGhost.dropping }"
        :style="{
          width: dragGhost.width + 'px',
          transform:
            'translate3d(' +
            (dragGhost.x - dragGhost.width / 2) +
            'px,' +
            (dragGhost.y - 40) +
            'px,0)',
        }"
      >
        <div class="drag-ghost-inner">
          <el-icon class="drag-ghost-grip"><Rank /></el-icon>
          <div class="drag-ghost-copy">
            <strong>{{ dragGhost.id }}</strong>
            <small>{{ dragGhost.dropping ? '已放置' : '拖动中 · 松手放置' }}</small>
          </div>
        </div>
      </div>
    </Teleport>

    <el-dialog v-model="showAdd" title="动态部署新流节点" width="480px" destroy-on-close>
      <div class="occupied-ports-info" v-if="store.nodes && store.nodes.length > 0">
        <div class="info-title">当前系统已分配端口 (请避开以下数字)：</div>
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
            <el-radio label="jpeg-udp">ESP32 硬件 JPEG (UDP 分片)</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="自动录制" prop="isRecord">
          <el-switch v-model="addForm.isRecord" active-text="开启服务器本地录制" />
        </el-form-item>

        <el-form-item label="UDP 端口" prop="udp">
          <el-input-number v-model="addForm.udp" :min="9001" :max="9050" style="width: 100%" />
          <div v-if="isPortUsed(addForm.udp)" class="err-tip">此 UDP 端口已被占用</div>
        </el-form-item>

        <el-form-item label="HTTP 端口" prop="http">
          <el-input-number v-model="addForm.http" :min="9051" :max="9100" style="width: 100%" />
          <div v-if="isPortUsed(addForm.http)" class="err-tip">此 HTTP 端口已被占用</div>
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
import { ref, reactive, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { useDeviceStore } from '@/stores/deviceStore'
import type { DeviceNode } from '@/stores/deviceStore'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { Rank } from '@element-plus/icons-vue'
import MonitorCard from '@/components/MonitorCard.vue'
import axios from 'axios'
import { API_BASE, streamWsUrl } from '@/config'

const checkPortStatus = async (type: 'udp' | 'http', port: number) => {
  try {
    const res = await axios.get(`${API_BASE}/ports/check?${type}=${port}`)
    return type === 'udp' ? res.data.udpUsed : res.data.httpUsed
  } catch {
    return false
  }
}

const store = useDeviceStore()
const showAdd = ref(false)
const isStarting = ref(false)

const addForm = reactive<{
  id: string
  udp: number
  http: number
  streamType: 'ffmpeg' | 'mjpeg' | 'jpeg-udp'
  isRecord: boolean
}>({
  id: '',
  udp: 9001,
  http: 9051,
  streamType: 'ffmpeg',
  isRecord: false,
})

const ORDER_KEY = 'monitor-node-order'
const LONG_PRESS_MS = 300

function readNodeOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

const nodeOrder = ref<string[]>(readNodeOrder())
const orderedNodes = computed<DeviceNode[]>(() => {
  const nodes = store.nodes ?? []
  const remaining = new Map(nodes.map((node) => [node.id, node]))
  const ordered: DeviceNode[] = []
  for (const id of nodeOrder.value) {
    const node = remaining.get(id)
    if (!node) continue
    ordered.push(node)
    remaining.delete(id)
  }
  for (const node of nodes) {
    if (remaining.delete(node.id)) ordered.push(node)
  }
  return ordered
})

interface DragGhostState {
  id: string
  x: number
  y: number
  width: number
  dropping: boolean
}

const draggingId = ref('')
const dragGhost = ref<DragGhostState | null>(null)
const slotAnimations = new WeakMap<HTMLElement, Animation>()
let pressTimer: number | null = null
let pressNodeId = ''
let pressX = 0
let pressY = 0
let dragActive = false
let reorderLock = false
let suppressClick = false
let suppressTimer: number | null = null
let ghostTimer: number | null = null

function findSlot(nodeId: string) {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('.node-slot')).find(
      (element) => element.dataset.nodeId === nodeId,
    ) ?? null
  )
}

function clearPress() {
  if (pressTimer !== null) {
    clearTimeout(pressTimer)
    pressTimer = null
  }
  window.removeEventListener('pointermove', onPressMove)
  window.removeEventListener('pointerup', cancelPress)
  pressNodeId = ''
}

function onPressMove(event: PointerEvent) {
  if (Math.hypot(event.clientX - pressX, event.clientY - pressY) <= 8) return
  clearPress()
}

function cancelPress() {
  clearPress()
}

function captureSlotRects() {
  const rects = new Map<string, DOMRect>()
  document.querySelectorAll<HTMLElement>('.node-slot').forEach((element) => {
    if (element.dataset.nodeId) rects.set(element.dataset.nodeId, element.getBoundingClientRect())
  })
  return rects
}

function animateSlots(rects: Map<string, DOMRect>) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  document.querySelectorAll<HTMLElement>('.node-slot').forEach((element) => {
    const id = element.dataset.nodeId
    const before = id ? rects.get(id) : null
    if (!before) return
    const after = element.getBoundingClientRect()
    const dx = before.left - after.left
    const dy = before.top - after.top
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    slotAnimations.get(element)?.cancel()
    const animation = element.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    )
    slotAnimations.set(element, animation)
  })
}

async function reorderTo(targetId: string) {
  if (reorderLock) return
  const from = nodeOrder.value.indexOf(draggingId.value)
  const to = nodeOrder.value.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return

  reorderLock = true
  const rects = captureSlotRects()
  const next = [...nodeOrder.value]
  next.splice(from, 1)
  next.splice(to, 0, draggingId.value)
  nodeOrder.value = next
  await nextTick()
  animateSlots(rects)
  window.setTimeout(() => {
    reorderLock = false
  }, 90)
}

function beginDrag(nodeId: string, clientX: number, clientY: number) {
  if (!orderedNodes.value.some((node) => node.id === nodeId)) return
  clearPress()
  if (ghostTimer !== null) {
    clearTimeout(ghostTimer)
    ghostTimer = null
  }
  const slot = findSlot(nodeId)
  const rect = slot?.getBoundingClientRect()
  nodeOrder.value = orderedNodes.value.map((node) => node.id)
  draggingId.value = nodeId
  dragGhost.value = {
    id: nodeId,
    x: clientX,
    y: clientY,
    width: Math.min(rect?.width ?? 260, 300),
    dropping: false,
  }
  dragActive = true
  suppressClick = true
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'grabbing'
  window.addEventListener('pointermove', onDragMove, { passive: false })
  window.addEventListener('pointerup', endDrag, { once: true })
  window.addEventListener('pointercancel', endDrag, { once: true })
  window.addEventListener('blur', endDrag)
}

function onSlotPointerDown(event: PointerEvent, nodeId: string) {
  if (event.button !== 0 || orderedNodes.value.length < 2 || dragActive) return
  const target = event.target as HTMLElement | null
  if (
    target?.closest(
      '.card-stop-button, .expand-button, .el-button, .icon-button, a, input, textarea, select',
    )
  ) {
    return
  }
  clearPress()
  pressNodeId = nodeId
  pressX = event.clientX
  pressY = event.clientY
  window.addEventListener('pointermove', onPressMove, { passive: true })
  window.addEventListener('pointerup', cancelPress, { once: true })
  pressTimer = window.setTimeout(() => {
    pressTimer = null
    beginDrag(nodeId, pressX, pressY)
  }, LONG_PRESS_MS)
}

function onDragMove(event: PointerEvent) {
  if (!dragActive) return
  event.preventDefault()
  if (dragGhost.value) {
    dragGhost.value = { ...dragGhost.value, x: event.clientX, y: event.clientY }
  }
  const element = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
  const slot = element?.closest<HTMLElement>('.node-slot')
  if (!slot) return
  const targetId = slot.dataset.nodeId
  if (!targetId || targetId === draggingId.value) return
  const rect = slot.getBoundingClientRect()
  const ratio = (event.clientY - rect.top) / rect.height
  if (ratio < 0.2 || ratio > 0.8) return
  void reorderTo(targetId)
}

function endDrag() {
  if (!dragActive) return
  const ghost = dragGhost.value
  const sourceSlot = ghost ? findSlot(ghost.id) : null
  const sourceRect = sourceSlot?.getBoundingClientRect()
  dragActive = false
  reorderLock = false
  draggingId.value = ''
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', endDrag)
  window.removeEventListener('blur', endDrag)
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(nodeOrder.value))
  } catch {
    // 隐私模式或存储不可用时仅保留本次会话顺序
  }
  if (ghost && sourceRect) {
    dragGhost.value = {
      ...ghost,
      x: sourceRect.left + sourceRect.width / 2,
      y: sourceRect.top + sourceRect.height / 2,
      dropping: true,
    }
    if (ghostTimer !== null) clearTimeout(ghostTimer)
    ghostTimer = window.setTimeout(() => {
      dragGhost.value = null
      ghostTimer = null
    }, 200)
  } else {
    dragGhost.value = null
  }
  if (suppressTimer !== null) clearTimeout(suppressTimer)
  suppressTimer = window.setTimeout(() => {
    suppressClick = false
    suppressTimer = null
  }, 320)
}

function onGridClickCapture(event: MouseEvent) {
  if (!suppressClick) return
  event.preventDefault()
  event.stopPropagation()
  suppressClick = false
  if (suppressTimer !== null) {
    clearTimeout(suppressTimer)
    suppressTimer = null
  }
}

function onSlotContextMenu(event: MouseEvent) {
  if (dragActive || pressNodeId) event.preventDefault()
}

onUnmounted(() => {
  clearPress()
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', endDrag)
  window.removeEventListener('blur', endDrag)
  if (suppressTimer !== null) clearTimeout(suppressTimer)
  if (ghostTimer !== null) clearTimeout(ghostTimer)
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
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
  } catch {
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
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 420px));
  gap: 20px;
}
.grid-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: -6px 0 14px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.node-slot {
  position: relative;
  min-width: 0;
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.node-slot.is-dragging {
  z-index: 2;
  pointer-events: none;
}
.node-slot.is-dragging :deep(.monitor-card) {
  opacity: 0;
}
.node-slot.is-dragging::after {
  content: '松手放置';
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-items: center;
  border: 2px dashed var(--el-color-primary-light-5);
  border-radius: 16px;
  background: color-mix(in srgb, var(--el-bg-color) 82%, var(--el-color-primary) 18%);
  color: var(--el-color-primary);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.drag-ghost {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 3000;
  box-sizing: border-box;
  pointer-events: none;
  will-change: transform;
}
.drag-ghost.is-dropping {
  opacity: 0;
  transition:
    transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 160ms ease;
}
.drag-ghost-inner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--el-color-primary-light-5);
  border-radius: 14px;
  background: var(--el-bg-color-overlay);
  box-shadow:
    0 22px 60px rgba(15, 23, 42, 0.28),
    0 2px 8px rgba(15, 23, 42, 0.12);
  transform: scale(1.02) rotate(1.2deg);
  animation: drag-lift 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.drag-ghost-grip {
  color: var(--el-color-primary);
  font-size: 18px;
}
.drag-ghost-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.drag-ghost-copy strong {
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drag-ghost-copy small {
  color: var(--el-text-color-secondary);
  font-size: 11px;
}
@keyframes drag-lift {
  from {
    opacity: 0.6;
    transform: scale(0.96) rotate(0);
  }
  to {
    opacity: 1;
    transform: scale(1.02) rotate(1.2deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .drag-ghost.is-dropping {
    transition: none;
  }
  .drag-ghost-inner {
    animation: none;
  }
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
