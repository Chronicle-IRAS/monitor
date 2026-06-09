<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
// @ts-ignore
import JMuxer from 'jmuxer'
import { Delete } from '@element-plus/icons-vue'
import { streamHttpUrl } from '@/config'

const props = defineProps<{
  node: {
    id: string
    udp: number
    http: number
    streamType?: 'ffmpeg' | 'mjpeg'
    isRecord?: boolean
  }
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

const toggleExpand = () => {
  isExpanded.value = !isExpanded.value
}

const handleClose = (e: Event) => {
  e.stopPropagation()
  emit('close', props.node.id)
}

const connect = () => {
  if (destroyed) return
  ws = new WebSocket(props.streamUrl)
  ws.binaryType = 'arraybuffer'

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
    console.log(`[${props.node.id}] 视频流断开，${RECONNECT_DELAY}ms 后重连`)
    reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY)
  }
}

onMounted(() => {
  if (props.node.streamType === 'mjpeg') return
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
  <div class="monitor-wrapper" :style="{ zIndex: isExpanded ? 100 : 1 }">
    <transition name="fade">
      <div v-if="isExpanded" class="backdrop" @click="toggleExpand"></div>
    </transition>

    <div :class="['monitor-card', { 'is-expanded': isExpanded }]" @click="toggleExpand">
      <template v-if="node.streamType === 'mjpeg'">
        <img :src="streamHttpUrl(node.http, '/mjpeg')" class="video-player" alt="MJPEG 流" />
      </template>
      <template v-else>
        <video ref="videoRef" autoplay muted playsinline class="video-player"></video>
      </template>

      <div
        class="tag-live"
        :style="{ backgroundColor: node.streamType === 'mjpeg' ? '#e67e22' : '#e74c3c' }"
      >
        LIVE | {{ node.streamType === 'mjpeg' ? 'MJPEG' : 'H.264' }}
      </div>

      <div v-if="node.isRecord" class="tag-rec"><span class="dot">●</span> REC</div>

      <div class="tag-id">{{ node.id }}</div>

      <transition name="slide-fade">
        <div v-if="isExpanded" class="detail-panel" @click.stop>
          <div class="panel-header">节点详情</div>
          <div class="info-item"><span>设备名称:</span> {{ node.id }}</div>
          <div class="info-item">
            <span>推流模式:</span> {{ node.streamType === 'mjpeg' ? 'MJPEG 原图' : 'H.264 视频' }}
          </div>

          <div class="info-item">
            <span>录制状态:</span>
            <el-tag :type="node.isRecord ? 'danger' : 'info'" size="small" effect="dark">
              {{ node.isRecord ? '服务器同步录制中 (15G上限覆盖)' : '未开启录制' }}
            </el-tag>
          </div>
          <div class="info-item"><span>UDP 通讯端口:</span> {{ node.udp }}</div>
          <div class="info-item"><span>数据流端口:</span> {{ node.http }}</div>

          <div class="action-footer">
            <el-button type="danger" :icon="Delete" size="small" @click="handleClose">
              强制中断此节点
            </el-button>
            <el-button size="small" @click="toggleExpand">收起预览</el-button>
          </div>
        </div>
      </transition>
    </div>
  </div>
</template>

<style scoped>
.monitor-wrapper {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
}
.backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  z-index: 99;
}
.monitor-card {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: #000;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-darker);
  cursor: pointer;
  transition: all 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
  display: flex;
}
.monitor-card.is-expanded {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 80vw;
  max-width: 1000px;
  height: auto;
  aspect-ratio: auto;
  z-index: 100;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6);
  cursor: default;
}
.video-player {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: width 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
  background: #111;
}
.monitor-card.is-expanded .video-player {
  width: 70%;
  border-right: 1px solid var(--el-border-color-darker);
}
.tag-live {
  position: absolute;
  top: 10px;
  left: 10px;
  color: white;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: bold;
  border-radius: 4px;
  letter-spacing: 0.5px;
  z-index: 2;
}

.tag-rec {
  position: absolute;
  top: 10px;
  right: 10px;
  background: rgba(0, 0, 0, 0.6);
  color: #f56c6c;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: bold;
  border-radius: 4px;
  border: 1px solid #f56c6c;
  z-index: 2;
  animation: blink 1.5s infinite;
}
.tag-rec .dot {
  margin-right: 3px;
}
@keyframes blink {
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
  100% {
    opacity: 1;
  }
}

.tag-id {
  position: absolute;
  bottom: 10px;
  left: 10px;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  padding: 4px 10px;
  font-size: 13px;
  border-radius: 6px;
  backdrop-filter: blur(4px);
  transition: opacity 0.2s;
}
.monitor-card.is-expanded .tag-live,
.monitor-card.is-expanded .tag-rec,
.monitor-card.is-expanded .tag-id {
  opacity: 0;
  pointer-events: none;
}
.detail-panel {
  width: 30%;
  background: var(--el-bg-color-overlay);
  padding: 24px;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
.panel-header {
  font-size: 16px;
  font-weight: bold;
  margin-bottom: 20px;
  color: var(--el-text-color-primary);
  border-bottom: 1px solid var(--el-border-color-lighter);
  padding-bottom: 12px;
}
.info-item {
  font-size: 13px;
  color: var(--el-text-color-regular);
  margin-bottom: 16px;
}
.info-item span {
  color: var(--el-text-color-secondary);
  display: block;
  font-size: 11px;
  margin-bottom: 6px;
}
.action-footer {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.slide-fade-enter-active {
  transition: all 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.slide-fade-leave-active {
  transition: all 0.25s ease;
}
.slide-fade-enter-from,
.slide-fade-leave-to {
  transform: translateX(30px);
  opacity: 0;
}

/* --- 移动端：放大态由「左右分栏」改为「上下堆叠」 --- */
@media screen and (max-width: 768px) {
  .monitor-card.is-expanded {
    width: 94vw;
    max-width: 94vw;
    max-height: 88vh;
    flex-direction: column;
    overflow-y: auto;
  }
  /* 视频铺满宽度，详情面板移到下方 */
  .monitor-card.is-expanded .video-player {
    width: 100%;
    aspect-ratio: 4 / 3;
    border-right: none;
    border-bottom: 1px solid var(--el-border-color-darker);
  }
  .detail-panel {
    width: 100%;
    padding: 16px;
  }
  /* 竖向布局下详情面板从下方滑入更自然 */
  .slide-fade-enter-from,
  .slide-fade-leave-to {
    transform: translateY(20px);
  }
}
</style>
