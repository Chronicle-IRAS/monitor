// 全局运行时配置：统一从环境变量读取，避免 IP 散落各处硬编码。
// 修改部署地址只需改根目录 .env，无需动业务代码。

/** 后端管理 API 基址，形如 http://host:3000/api */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? 'http://<YOUR_SERVER_IP>:3000/api'

/** 视频流主机（不含端口，端口随节点动态分配） */
export const STREAM_HOST: string = import.meta.env.VITE_STREAM_HOST ?? '<YOUR_SERVER_IP>'

/** Client-side admin gate. Keep the actual value in local env files only. */
export const ADMIN_PASSWORD: string = import.meta.env.VITE_ADMIN_PASSWORD ?? ''

/** 拼接某节点的 HTTP 流地址，如 MJPEG 原图 */
export const streamHttpUrl = (port: number, path = ''): string =>
  `http://${STREAM_HOST}:${port}${path}`

/** 拼接某节点的 WebSocket 流地址 */
export const streamWsUrl = (port: number, path = '/stream'): string =>
  `ws://${STREAM_HOST}:${port}${path}`
