<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
// @ts-ignore
import JMuxer from 'jmuxer'
import {
  Delete,
  Close,
  FullScreen,
  Loading,
  VideoPause,
  WarningFilled,
} from '@element-plus/icons-vue'
import { streamHttpUrl } from '@/config'

const props = defineProps<{
  node: {
    id: string
    udp: number
    http: number
    streamType?: 'ffmpeg' | 'mjpeg' | 'jpeg-udp'
    isRecord?: boolean
  }
  canManage?: boolean
  stopping?: boolean
  streamUrl: string
}>()

const emit = defineEmits(['close'])

const videoRef = ref<HTMLVideoElement | null>(null)
const isExpanded = ref(false)
let jmuxer: any = null
let ws: WebSocket | null = null

// --- 断流自动重连相关 ---
let destroyed = false // 组件已卸载标记，避免卸载后还在重连/建连
let startTimer: number | null = null // 首次建连前的延时句柄
let reconnectTimer: number | null = null // 重连延时句柄
const RECONNECT_DELAY = 2000

const wrapperRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const closeRef = ref<HTMLButtonElement | null>(null)
const CONNECT_TIMEOUT_MS = 6000
const phase = ref<'connecting' | 'playing' | 'waiting' | 'offline'>('connecting')
const mjpegKey = ref(0)
const phaseLabel = computed(
  () =>
    ({
      connecting: '正在连接',
      playing: '实时画面',
      waiting: '等待视频信号',
      offline: '未连接',
    })[phase.value],
)
let connectWatchdog: number | null = null
let watchdogArmed = false
let previousFocus: HTMLElement | null = null
let previousOverflow = ''
let transition: Animation | undefined
let closing = false

const openPreview = async () => {
  if (isExpanded.value) return
  const origin = wrapperRef.value?.getBoundingClientRect()
  previousFocus = document.activeElement as HTMLElement | null
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  isExpanded.value = true
  await nextTick()
  closeRef.value?.focus()
  const panel = panelRef.value
  if (!panel || !origin || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const target = panel.getBoundingClientRect()
  transition = panel.animate(
    [
      {
        transform:
          'translate(' +
          (origin.left - target.left) +
          'px,' +
          (origin.top - target.top) +
          'px) scale(' +
          origin.width / target.width +
          ',' +
          origin.height / target.height +
          ')',
        opacity: 0.6,
      },
      { transform: 'none', opacity: 1 },
    ],
    { duration: 340, easing: 'cubic-bezier(.22,1,.36,1)' },
  )
}

const closePreview = async () => {
  if (!isExpanded.value || closing || props.stopping) return
  closing = true
  transition?.cancel()
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    transition = panelRef.value?.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateY(12px) scale(.98)' },
      ],
      { duration: 160, fill: 'forwards', easing: 'ease-in' },
    )
    await transition?.finished.catch(() => {})
  }
  isExpanded.value = false
  document.body.style.overflow = previousOverflow
  await nextTick()
  transition?.cancel()
  if (previousFocus?.isConnected) previousFocus.focus()
  else wrapperRef.value?.querySelector<HTMLButtonElement>('.open-preview')?.focus()
  closing = false
}

const onPreviewKeydown = (event: KeyboardEvent) => {
  if (!isExpanded.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    void closePreview()
  }
  if (event.key === 'Tab') {
    const controls = panelRef.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [tabindex="0"]',
    )
    if (!controls?.length) return
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }
}

const requestStop = () => {
  if (props.stopping) return
  emit('close', props.node.id)
}

const clearConnectWatchdog = () => {
  if (connectWatchdog !== null) {
    clearTimeout(connectWatchdog)
    connectWatchdog = null
  }
  watchdogArmed = false
}

const armConnectWatchdog = () => {
  if (watchdogArmed) return
  watchdogArmed = true
  if (connectWatchdog !== null) clearTimeout(connectWatchdog)
  connectWatchdog = window.setTimeout(() => {
    connectWatchdog = null
    watchdogArmed = false
    if (phase.value !== 'playing') phase.value = 'offline'
  }, CONNECT_TIMEOUT_MS)
}

const markPlaying = () => {
  phase.value = 'playing'
  clearConnectWatchdog()
}

const markOffline = () => {
  phase.value = 'offline'
  clearConnectWatchdog()
}

const retryConnection = () => {
  if (props.stopping) return
  clearConnectWatchdog()
  phase.value = 'connecting'
  armConnectWatchdog()

  if (props.node.streamType === 'mjpeg' || props.node.streamType === 'jpeg-udp') {
    mjpegKey.value += 1
    return
  }

  if (startTimer !== null) {
    clearTimeout(startTimer)
    startTimer = null
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.onclose = null
    ws.close()
    ws = null
  }
  startTimer = window.setTimeout(connect, 100)
}

const connect = () => {
  if (destroyed) return
  ws = new WebSocket(props.streamUrl)
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => {
    if (phase.value !== 'playing') phase.value = 'waiting'
  }

  ws.onmessage = (event) => {
    if (phase.value !== 'playing') phase.value = 'waiting'
    clearConnectWatchdog()
    if (jmuxer) {
      jmuxer.feed({ video: new Uint8Array(event.data) })
    }
  }
  ws.onerror = () => {
    // onerror 后通常紧跟 onclose，重连逻辑统一放在 onclose
    console.warn(`[${props.node.id}] 视频流连接异常`)
  }
  ws.onclose = () => {
    if (destroyed) return
    phase.value = 'connecting'
    armConnectWatchdog()
    console.log(`[${props.node.id}] 视频流断开，${RECONNECT_DELAY}ms 后重连`)
    reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY)
  }
}

onMounted(() => {
  armConnectWatchdog()
  if (props.node.streamType === 'mjpeg' || props.node.streamType === 'jpeg-udp') return
  if (!videoRef.value) return

  jmuxer = new JMuxer({
    node: videoRef.value,
    mode: 'video',
    flushingTime: 100,
    fps: 10,
    debug: false,
  })

  // 等 jmuxer 初始化完成再建连
  startTimer = window.setTimeout(connect, 100)
})

onUnmounted(() => {
  destroyed = true
  transition?.cancel()
  clearConnectWatchdog()
  if (isExpanded.value) document.body.style.overflow = previousOverflow
  if (startTimer) window.clearTimeout(startTimer)
  if (reconnectTimer) window.clearTimeout(reconnectTimer)
  if (ws) {
    // 主动关闭前摘掉 onclose，避免触发重连
    ws.onclose = null
    ws.close()
  }
  if (jmuxer) jmuxer.destroy()
})
</script>

<template>
  <div ref="wrapperRef" class="monitor-wrapper">
    <Teleport to="body" :disabled="!isExpanded">
      <div
        :class="{ 'preview-layer': isExpanded }"
        @click.self="closePreview"
        @keydown="onPreviewKeydown"
      >
        <section
          ref="panelRef"
          class="monitor-card"
          :class="{ 'is-expanded': isExpanded }"
          :role="isExpanded ? 'dialog' : undefined"
          :aria-modal="isExpanded ? true : undefined"
          :aria-label="isExpanded ? node.id + ' 实时预览' : undefined"
        >
          <header v-if="isExpanded" class="preview-header">
            <div class="preview-title">
              <span class="eyebrow">实时预览</span>
              <h2>{{ node.id }}</h2>
            </div>
            <button ref="closeRef" class="icon-button" aria-label="关闭预览" @click="closePreview">
              <el-icon><Close /></el-icon>
            </button>
          </header>
          <div class="video-stage" :aria-busy="phase === 'connecting' || phase === 'waiting'">
            <img
              v-if="node.streamType === 'mjpeg' || node.streamType === 'jpeg-udp'"
              :key="mjpegKey"
              :src="streamHttpUrl(node.http, '/mjpeg')"
              class="video-player"
              alt="MJPEG 实时画面"
              @load="markPlaying"
              @error="markOffline"
            />
            <video
              v-else
              ref="videoRef"
              autoplay
              muted
              playsinline
              class="video-player"
              @playing="markPlaying"
              @waiting="phase = 'waiting'"
              @error="markOffline"
            ></video>
            <Transition name="signal-fade">
              <div
                v-if="phase !== 'playing'"
                class="signal-placeholder"
                role="status"
                aria-live="polite"
              >
                <span v-if="phase === 'offline'" class="signal-offline-icon" aria-hidden="true"
                  ><el-icon><WarningFilled /></el-icon
                ></span>
                <span v-else class="signal-spinner" :class="phase" aria-hidden="true"></span>
                <span class="signal-label">
                  <span>{{ phaseLabel }}</span>
                  <span v-if="phase !== 'offline'" class="signal-dots" aria-hidden="true"
                    ><i>.</i><i>.</i><i>.</i></span
                  >
                </span>
                <small v-if="phase === 'offline'">请检查设备电源、网络或推流地址</small>
                <small v-else-if="isExpanded">正在建立视频连接，收到画面后自动播放</small>
                <button
                  v-if="phase === 'offline'"
                  type="button"
                  class="retry-button"
                  @click.stop="retryConnection"
                >
                  重新检测
                </button>
              </div>
            </Transition>
            <Transition name="signal-fade">
              <div v-if="stopping" class="stopping-overlay" role="status" aria-live="assertive">
                <span class="signal-spinner waiting" aria-hidden="true"></span>
                <strong>正在停止节点…</strong>
                <small>正在关闭视频流与录制，请稍候</small>
              </div>
            </Transition>
            <div class="stream-badges">
              <span class="stream-badge">{{
                node.streamType === 'ffmpeg' ? 'H.264' : 'MJPEG'
              }}</span>
              <span v-if="node.isRecord" class="record-badge"><i></i> REC</span>
            </div>
            <button
              v-if="!isExpanded"
              class="open-preview"
              :aria-label="'预览节点 ' + node.id"
              @click="openPreview"
            >
              <span class="open-hint"
                ><el-icon><FullScreen /></el-icon>打开预览</span
              >
            </button>
          </div>
          <footer class="preview-footer">
            <div class="node-summary">
              <strong v-if="!isExpanded">{{ node.id }}</strong>
              <span
                class="connection-status"
                :class="{
                  live: phase === 'playing' && !stopping,
                  waiting: phase === 'waiting',
                  offline: phase === 'offline',
                  stopping,
                }"
                ><i></i>{{ stopping ? '正在停止' : phaseLabel }}</span
              >
            </div>
            <div v-if="isExpanded" class="node-details">
              <span
                >UDP <b>{{ node.udp }}</b></span
              ><span
                >视频端口 <b>{{ node.http }}</b></span
              >
              <span>{{ node.isRecord ? '录制已开启 · 3GB 录像池' : '录制未开启' }}</span>
            </div>
            <el-popconfirm
              v-if="isExpanded && canManage"
              title="确定停止该节点的视频与录制？"
              width="240"
              confirm-button-text="停止"
              cancel-button-text="取消"
              popper-class="stop-node-popconfirm"
              @confirm="requestStop"
            >
              <template #reference
                ><el-button
                  type="danger"
                  text
                  :icon="Delete"
                  :loading="stopping"
                  :disabled="stopping"
                  >{{ stopping ? '正在停止' : '停止节点' }}</el-button
                ></template
              >
            </el-popconfirm>
            <div v-if="!isExpanded" class="card-action-group">
              <el-popconfirm
                v-if="canManage"
                title="确定停止该节点？录像文件不会被删除。"
                width="230"
                confirm-button-text="停止"
                cancel-button-text="取消"
                popper-class="card-stop-popconfirm"
                @confirm="requestStop"
              >
                <template #reference>
                  <button
                    type="button"
                    class="card-stop-button"
                    :disabled="stopping"
                    :aria-label="'停止节点 ' + node.id"
                    title="停止该节点（录像保留）"
                  >
                    <el-icon v-if="stopping" class="is-loading"><Loading /></el-icon>
                    <el-icon v-else><VideoPause /></el-icon>
                    <span>{{ stopping ? '停止中' : '停止' }}</span>
                  </button>
                </template>
              </el-popconfirm>
              <button
                type="button"
                class="expand-button"
                :aria-label="'放大预览 ' + node.id"
                title="放大预览"
                @click="openPreview"
              >
                <el-icon><FullScreen /></el-icon>
              </button>
            </div>
          </footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.monitor-wrapper {
  min-width: 0;
}
.monitor-card {
  overflow: hidden;
  border: 1px solid var(--el-border-color);
  border-radius: 16px;
  background: var(--el-bg-color-overlay);
  box-shadow: 0 4px 20px #0000000a;
}
.monitor-card:not(.is-expanded) {
  transition:
    border-color 180ms,
    box-shadow 180ms;
}
.monitor-card:not(.is-expanded):hover {
  border-color: var(--el-color-primary);
  box-shadow: 0 8px 28px #00000020;
}
.video-stage {
  position: relative;
  aspect-ratio: 16 / 10;
  background: #0b1018;
  overflow: hidden;
}
.video-player {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.signal-placeholder {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: #8291a5;
  pointer-events: none;
  background: #0b1018;
}
.signal-spinner {
  width: 36px;
  height: 36px;
  border: 2px solid #ffffff1a;
  border-top-color: #6aa8ff;
  border-radius: 50%;
  animation: signal-spin 0.9s linear infinite;
  box-shadow: 0 0 24px #6aa8ff33;
}
.signal-spinner::after {
  content: '';
  display: block;
  width: 8px;
  height: 8px;
  margin: 12px;
  border-radius: 50%;
  background: #6aa8ff;
  opacity: 0.65;
  animation: signal-blink 1.6s ease-in-out infinite;
}
.signal-spinner.waiting {
  border-top-color: #e5b567;
  animation-duration: 1.5s;
  box-shadow: 0 0 24px #e5b56733;
}
.signal-spinner.waiting::after {
  background: #e5b567;
}
.signal-label {
  display: inline-flex;
  align-items: baseline;
  font-size: 13px;
  letter-spacing: 0.02em;
}
.signal-dots {
  display: inline-flex;
  margin-left: 2px;
}
.signal-dots i {
  font-style: normal;
  animation: signal-dot 1.4s ease-in-out infinite;
}
.signal-dots i:nth-child(2) {
  animation-delay: 0.16s;
}
.signal-dots i:nth-child(3) {
  animation-delay: 0.32s;
}
.signal-placeholder small {
  color: #65758b;
  font-size: 12px;
}
.signal-offline-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 1px solid #ffffff1f;
  border-radius: 50%;
  background: #ffffff08;
  color: #e5b567;
  font-size: 20px;
}
.retry-button {
  margin-top: 2px;
  padding: 6px 14px;
  border: 1px solid #ffffff26;
  border-radius: 8px;
  background: #ffffff0d;
  color: #d6e1f0;
  font: inherit;
  font-size: 12px;
  pointer-events: auto;
  cursor: pointer;
  transition:
    color 160ms,
    border-color 160ms,
    background 160ms;
}
.retry-button:hover {
  border-color: var(--el-color-primary);
  background: #6aa8ff14;
  color: var(--el-color-primary);
}
.retry-button:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.signal-fade-enter-active,
.signal-fade-leave-active {
  transition:
    opacity 220ms ease,
    transform 220ms ease;
}
.signal-fade-enter-from,
.signal-fade-leave-to {
  opacity: 0;
  transform: scale(0.985);
}
.stopping-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #f3f7fd;
  text-align: center;
  background: #0b1018;
  cursor: progress;
}
.stopping-overlay strong {
  font-size: 15px;
  font-weight: 600;
}
.stopping-overlay small {
  color: #9fb0c5;
  font-size: 12px;
}
@keyframes signal-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes signal-blink {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.8);
  }
  50% {
    opacity: 0.9;
    transform: scale(1);
  }
}
@keyframes signal-dot {
  0%,
  80%,
  100% {
    opacity: 0.25;
  }
  40% {
    opacity: 1;
  }
}
@keyframes status-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}
.stream-badges {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 4;
  display: flex;
  gap: 8px;
  pointer-events: none;
}
.stream-badge,
.record-badge {
  padding: 5px 8px;
  border: 1px solid #ffffff1c;
  border-radius: 6px;
  color: #d6e1f0;
  background: #101722ba;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.record-badge {
  color: #ff9696;
}
.record-badge i,
.connection-status i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.open-preview {
  position: absolute;
  inset: 0;
  width: 100%;
  border: 0;
  cursor: pointer;
  background: transparent;
  color: white;
}
.open-preview:focus-visible {
  outline: 3px solid var(--el-color-primary);
  outline-offset: -3px;
}
.open-hint {
  position: absolute;
  bottom: 16px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: #ffffff16;
  font-size: 12px;
  opacity: 0;
  transform: translateY(4px);
  transition:
    opacity 180ms,
    transform 180ms;
}
.open-preview:hover .open-hint,
.open-preview:focus-visible .open-hint {
  opacity: 1;
  transform: none;
}
.preview-footer {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 16px 20px;
  min-height: 28px;
}
.node-summary {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 6px;
}
.node-summary strong {
  font-size: 14px;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connection-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.connection-status.live {
  color: #39b887;
}
.connection-status.waiting {
  color: #d7a85a;
}
.connection-status.stopping {
  color: #e5b567;
}
.connection-status.offline {
  color: var(--el-color-danger);
}
.connection-status:not(.live):not(.offline) i {
  animation: status-pulse 1.5s ease-in-out infinite;
}
.card-action-group {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}
.card-stop-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--el-text-color-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    color 160ms,
    background 160ms,
    border-color 160ms;
}
.card-stop-button:hover:not(:disabled) {
  color: var(--el-color-danger);
  background: var(--el-color-danger-light-9);
  border-color: var(--el-color-danger-light-7);
}
.card-stop-button:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.card-stop-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.card-action-group .expand-button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 15px;
  cursor: pointer;
  transition:
    color 160ms,
    background 160ms,
    border-color 160ms;
}
.card-action-group .expand-button:hover {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-7);
}
.card-action-group .expand-button:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.preview-layer {
  position: fixed;
  inset: 0;
  z-index: 2100;
  display: grid;
  place-items: center;
  padding: 24px;
  background: #03070ed9;
  backdrop-filter: blur(12px);
}
.is-expanded {
  width: min(1200px, 100%);
  height: min(820px, calc(100dvh - 48px));
  display: flex;
  flex-direction: column;
  transform-origin: top left;
  border-color: #ffffff20;
  box-shadow: 0 32px 120px #0008;
}
.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  gap: 20px;
}
.preview-title {
  min-width: 0;
}
.eyebrow {
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--el-text-color-secondary);
}
.preview-title h2 {
  margin: 5px 0 0;
  font-size: 19px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  overflow-wrap: anywhere;
  max-height: 58px;
  overflow: auto;
}
.icon-button {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  background: transparent;
  color: var(--el-text-color-primary);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background 160ms;
}
.icon-button:hover {
  background: var(--el-fill-color);
}
.icon-button:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 3px;
}
.is-expanded .video-stage {
  flex: 1;
  min-height: 0;
  aspect-ratio: auto;
}
.is-expanded .preview-footer {
  flex-wrap: wrap;
  border-top: 1px solid var(--el-border-color);
}
.node-details {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-right: auto;
}
.node-details b {
  font-weight: 500;
  color: var(--el-text-color-primary);
  margin-left: 5px;
}
@media (max-width: 640px) {
  .preview-layer {
    padding: 10px;
  }
  .is-expanded {
    height: calc(100dvh - 20px);
    border-radius: 12px;
  }
  .preview-header {
    padding: 16px;
  }
  .preview-footer {
    padding: 14px 16px;
    gap: 14px;
  }
  .node-details {
    width: 100%;
    gap: 10px 16px;
  }
  .is-expanded .preview-footer > .el-button {
    margin-left: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition: none !important;
    animation: none !important;
  }
}
</style>

<style>
/* 预览层 z-index 为 2100，确认气泡必须在其上，否则按钮被遮挡、看起来“没有反应”。 */
.stop-node-popconfirm {
  z-index: 2200 !important;
}
</style>
