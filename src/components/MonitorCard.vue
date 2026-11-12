<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
// @ts-ignore
import JMuxer from 'jmuxer'
import { Delete, Close, FullScreen, VideoCamera } from '@element-plus/icons-vue'
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
const phase = ref<'connecting' | 'playing' | 'waiting'>('connecting')
const phaseLabel = computed(
  () => ({ connecting: '正在连接', playing: '实时画面', waiting: '等待视频信号' })[phase.value],
)
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
  if (!isExpanded.value || closing) return
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

const connect = () => {
  if (destroyed) return
  ws = new WebSocket(props.streamUrl)
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => {
    phase.value = 'waiting'
  }

  ws.onmessage = (event) => {
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
    console.log(`[${props.node.id}] 视频流断开，${RECONNECT_DELAY}ms 后重连`)
    reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY)
  }
}

onMounted(() => {
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
          <div class="video-stage">
            <img
              v-if="node.streamType === 'mjpeg' || node.streamType === 'jpeg-udp'"
              :src="streamHttpUrl(node.http, '/mjpeg')"
              class="video-player"
              alt="MJPEG 实时画面"
              @load="phase = 'playing'"
              @error="phase = 'waiting'"
            />
            <video
              v-else
              ref="videoRef"
              autoplay
              muted
              playsinline
              class="video-player"
              @playing="phase = 'playing'"
              @waiting="phase = 'waiting'"
              @error="phase = 'waiting'"
            ></video>
            <div v-if="phase !== 'playing'" class="signal-placeholder">
              <el-icon><VideoCamera /></el-icon><span>{{ phaseLabel }}</span>
              <small v-if="isExpanded">收到设备画面后将自动播放</small>
            </div>
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
              <span class="connection-status" :class="{ live: phase === 'playing' }"
                ><i></i>{{ phaseLabel }}</span
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
              @confirm="emit('close', node.id)"
            >
              <template #reference
                ><el-button type="danger" text :icon="Delete">停止节点</el-button></template
              >
            </el-popconfirm>
            <el-icon v-if="!isExpanded" class="expand-icon"><FullScreen /></el-icon>
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
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: #8291a5;
  pointer-events: none;
  background: radial-gradient(ellipse at center, #19253688, transparent 70%);
}
.signal-placeholder .el-icon {
  font-size: 32px;
  opacity: 0.6;
}
.signal-placeholder span {
  font-size: 13px;
}
.signal-placeholder small {
  color: #65758b;
  font-size: 12px;
}
.stream-badges {
  position: absolute;
  top: 16px;
  left: 16px;
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
.expand-icon {
  margin-left: auto;
  color: var(--el-text-color-secondary);
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
