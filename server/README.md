# monitor-pro 后端服务

与 `src/` 前端配套的 Node.js 后端，零 npm 依赖（仅依赖系统 `ffmpeg`），负责：

- 接收 ESP32 硬件经 UDP 推入的 H.264 / MJPEG 流；
- 接收 CAM-WEB 固件的自定义 JPEG/UDP 分片协议（4 字节大端偏移 + 1400 字节载荷 + `0xFFFFFFFF` 帧结束），完成乱序重组、丢包检测、超时清理；
- 为每个节点在独立 HTTP 端口分发 **WebSocket H.264**（jmuxer）与 **MJPEG**（浏览器 `<img>`）；
- 按需用 ffmpeg 将 JPEG 帧转码录制为 MP4 分段，并支持 H.264 直接复制录制；
- 按 3GB 上限循环录制 MP4 切片（FIFO 覆盖），提供列表、下载、单删、批量删；
- 采集 CPU / 内存 / 磁盘 / 录像池指标，扫描主机监听端口；
- 节点进程看门狗：ffmpeg / UDP 接收器退出后指数退避重启，配置持久化到 `data/nodes.json`。

> **硬件联调状态**：截至本文档更新，尚未接入实体 ESP32-S3。
> 协议实现与测试基于 CAM-WEB 源码（提交 `447887e`）与按真实数据报格式生成的模拟包，
> 只能证明软件链路正确，不能证明实体硬件已出图。接入实体设备后必须补充现场验收。

## 环境要求

- Node.js `>= 20.19.0`（开发机可更高）
- `ffmpeg` 5.0+，且在 `PATH` 中（或通过 `FFMPEG_PATH` 指定绝对路径）
- Linux 生产机建议安装 `iproute2`（`ss`）；缺失时自动回退 `netstat`

## 快速开始

```sh
cd server
npm test          # 纯 Node 测试，不依赖 ffmpeg
npm start         # 默认监听 0.0.0.0:3000
```

前端默认使用同源 `/api` 与 `/video/<port>/stream`、`/video/<port>/mjpeg`。
HTTPS 页面自动使用 WSS。生产 Nginx 和 systemd 配置见 `../ops/`。
管理员令牌只放在服务器环境文件中，浏览器登录时由用户输入。

## 目录与运行时数据

```
server/
├── src/
│   ├── index.js          # 入口 / 信号处理
│   ├── server.js         # API + 录像池定时任务组装
│   ├── api.js            # HTTP 路由
│   ├── nodes.js          # 节点注册表、端口校验、看门狗、持久化
│   ├── pipeline.js       # ffmpeg 参数与子进程生命周期
│   ├── stream-server.js  # 每节点 HTTP/WS 流服务
│   ├── media.js          # Annex-B 切分、关键帧缓存、JPEG 分帧
│   ├── ws.js             # 最小 WebSocket 实现（二进制下行 + ping/pong）
│   ├── records.js        # 录像池 FIFO / 删除 / 下载
│   ├── system.js         # CPU / 内存 / 磁盘 / 录像指标
│   └── ports.js          # 端口探测与监听扫描
├── test/                 # node:test 单元 + 端到端测试（伪 ffmpeg）
├── deploy/               # systemd 示例
└── .env.example          # 环境变量参考（服务不会自动加载 .env）
```

运行时生成：

- `records/<deviceId>/<deviceId>_YYYYmmdd_HHMMSS.mp4`：录像切片
- `data/nodes.json`：节点定义，重启后自动恢复

两者均已在根 `.gitignore` 中忽略。生产环境建议把 `RECORD_DIR`、`DATA_DIR` 指到独立数据盘。

## HTTP API

基址 `http://<host>:3000/api`，响应均为 JSON（下载除外）；错误形如 `{ "message": "..." }`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/nodes` | 节点列表 `[{ id, udp, http, streamType, isRecord, status }]` |
| POST | `/nodes/start` | 启动节点，body `{ id, udp, http, streamType, isRecord }` |
| POST | `/nodes/stop` | 停止节点，body `{ id }` |
| POST | `/nodes/reset` | 停止全部节点 |
| GET | `/ports/check?udp=9001&http=9051` | 端口占用探测，返回 `{ udpUsed, httpUsed }` |
| GET | `/system/status` | 前端仪表盘指标（见下） |
| GET | `/system/all-ports` | 主机监听端口 `{ tcp: number[], udp: number[] }` |
| GET | `/records` | `[{ deviceId, files: [{ filename, size, time }] }]` |
| GET | `/records/download/:deviceId/:filename` | 下载录像（`Content-Disposition: attachment`） |
| DELETE | `/records/:deviceId` | 删除整个设备录像目录 |
| DELETE | `/records/:deviceId/:filename` | 删除单个切片 |
| POST | `/records/batch-delete` | body `{ deviceId, filenames: string[] }`（1~500 个） |

设备名称（`id`）支持中文、空格与常见符号（前端仅要求必填），但会拒绝路径分隔符、控制字符及 `#%?*:"<>|` 等 URL/文件系统保留字符，长度 1~64 个字符。

`/system/status` 字段：`cpuUsage`、`memUsage`、`memTotal`、`uptime`（小时）、`recordUsageMB`、`recordPercent`、`diskUsage`、`diskTotal`、`onlineNodes`。

### 节点推流模式

`streamType` 决定后端如何接收与分发视频，三种模式互不影响：

| `streamType` | 硬件输入 | 分发方式 | 录制 |
|--------------|----------|----------|------|
| `ffmpeg` | 标准 H.264 over UDP（MPEG-TS 或裸流，由 ffmpeg 探测） | WS `/stream`（H.264） | ffmpeg 从 UDP 输入直接 `-c:v copy` 分段 |
| `mjpeg` | 可被 ffmpeg `udp://` 解析的 MJPEG 输入 | `/mjpeg`（ffmpeg 转封装，限 5fps / 640px） | ffmpeg 从 UDP 输入录制 |
| `jpeg-udp` | CAM-WEB 自定义 JPEG/UDP 分片 | `/mjpeg`（原帧直出） | 首帧到达时按需启动 ffmpeg `-f mjpeg -i pipe:0` 转码分段 |

`jpeg-udp` 节点的 `/nodes` 响应额外包含 `receiving`、`rxFrames`、`rxPackets`、`rxDropped`、`lastFrameAt`。
`status=online` 只表示 UDP socket 已绑定；是否真正收到画面必须看 `receiving` / `lastFrameAt`。

### 视频流端点（每个节点独立端口，非 3000）

| 协议 | 路径 | 说明 |
|------|------|------|
| WS | `ws://<host>:<node.http>/stream` | H.264 Annex-B 裸流，首包为缓存的 SPS/PPS/IDR；`jpeg-udp` 节点返回 409 |
| GET | `http://<host>:<node.http>/mjpeg` | `multipart/x-mixed-replace` JPEG 流（`streamType=mjpeg` 或 `jpeg-udp`） |
| GET | `http://<host>:<node.http>/` | 节点自检信息；`jpeg-udp` 节点含 `rx` 统计 |

### CAM-WEB JPEG/UDP 协议

来源：<https://github.com/FTDBWLZ/CAM-WEB> `src/main.c` 的 `send_frame()`。协议没有帧号、总长度或设备 ID：

```
数据报: [4 字节大端序 JPEG 偏移][最多 1400 字节 JPEG 数据]
帧结束: [FF FF FF FF]
```

接收端行为：

- 按来源 `IP:port` 隔离重组状态，同一 UDP 端口只能对应一个硬件来源；
- 按偏移量写入，天然支持乱序；重复分片不会产生重复帧；
- 只有从偏移 0 起连续且以 JPEG EOI（`FF D9`）结尾的数据才产出帧，中间丢包整帧丢弃；
- 帧结束包丢失时，连续数据末尾的 EOI 可立即完成该帧；
- 超过 `JPEG_FRAME_TIMEOUT_MS` 未完成的帧被清理；来源超过 `JPEG_SOURCE_IDLE_MS` 无包时释放内存；
- 单帧超过 `JPEG_MAX_FRAME_BYTES` 或 offset 越界的数据报被拒绝。

可用真实数据报格式做端到端验证（不依赖 ffmpeg）：

```sh
node --test server/test/jpeg-udp.test.js
```

测试覆盖：真实 1400 字节分片、4 字节大端偏移、`0xFFFFFFFF` 结束包、乱序、重复、首/中/尾分片丢失、EOF 丢失、超时清理、真实 UDP socket、`/mjpeg` 原帧分发与按需录制。

## 配置

所有配置来自环境变量（见 `.env.example`）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 管理 API |
| `STREAM_HOST` | `0.0.0.0` | 视频流服务绑定地址 |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg 可执行文件 |
| `RECORD_DIR` | `server/records` | 录像根目录 |
| `DATA_DIR` | `server/data` | 节点状态目录 |
| `DISK_PATH` | `/`（Windows 为盘符根） | “服务器根磁盘”指标统计的分区 |
| `RECORD_POOL_MB` | `3072` | 录像池上限（3GB） |
| `SEGMENT_SECONDS` | `300` | 单个 MP4 切片时长 |
| `UDP_PORT_MIN` / `UDP_PORT_MAX` | `9001` / `9050` | 允许的硬件通讯端口 |
| `UDP_BIND_HOST` | `0.0.0.0` | JPEG/UDP 接收 socket 绑定地址 |
| `JPEG_FRAME_TIMEOUT_MS` | `2000` | 单帧重组超时，超时残缺帧丢弃 |
| `JPEG_SOURCE_IDLE_MS` | `30000` | 来源空闲多久后释放重组状态 |
| `JPEG_MAX_FRAME_BYTES` | `1048576` | 单帧 JPEG 上限（防御异常偏移） |
| `JPEG_RECORD_IDLE_MS` | `30000` | 无帧多久后关闭录制 ffmpeg |
| `JPEG_RECORD_FPS` | `15` | JPEG 录制转码输出帧率 |
| `HTTP_PORT_MIN` / `HTTP_PORT_MAX` | `9051` / `9100` | 允许的视频流端口 |
| `CORS_ORIGIN` | `*` | 允许的前端来源 |
| `ADMIN_TOKEN` | 空 | 非空时启用后端鉴权 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

默认端口区间与前端表单（9001–9050 / 9051–9100）一致，修改时需同步前端。

硬件侧默认目标 IP、UDP 端口、NVS 持久化键、MQTT/OTA 地址与需要修改的配置清单见
[`../ops/HARDWARE-CONFIG.md`](../ops/HARDWARE-CONFIG.md)。

## 鉴权说明

生产必须设置 `ADMIN_TOKEN`。节点写操作和录像读取、下载需要认证。

- `POST /api/auth/login` 接受 `{ "password": "..." }`，签发 8 小时 HttpOnly、SameSite=Strict 会话，HTTPS 使用 Secure Cookie。
- `GET /api/auth/session` 查询会话，`POST /api/auth/logout` 注销。
- 自动化脚本可使用 `X-Admin-Token` 请求头。服务重启后会话失效，需要重新登录。
- 本地开发允许空 `ADMIN_TOKEN`，生产环境文件必须设置非空值。

生产 API 和视频 HTTP 仅监听回环接口，通过 Nginx 同源代理访问。

## 部署（systemd 示例）

```sh
sudo useradd -r -s /usr/sbin/nologin monitor || true
sudo mkdir -p /opt/monitor-pro /var/lib/monitor-pro/{records,data}
sudo chown -R monitor:monitor /opt/monitor-pro /var/lib/monitor-pro
# 将仓库中的 server/ 放到 /opt/monitor-pro/server
sudo cp server/deploy/monitor-pro.service /etc/systemd/system/
sudo cp server/.env.example /etc/monitor-pro.env
sudoeditor /etc/monitor-pro.env
sudo systemctl daemon-reload
sudo systemctl enable --now monitor-pro
journalctl -u monitor-pro -f
```

对应的 Nginx 只需托管前端静态文件（即 `deploy.bat` 的流程）；视频流由后端节点端口直出。

## 排障

| 现象 | 排查 |
|------|------|
| 启动节点报 `ffmpeg 启动失败` | `ffmpeg -version`；或设置 `FFMPEG_PATH` 绝对路径 |
| 卡片黑屏但节点在线 | 确认硬件已向 `server:<udp>` 发包；`ffmpeg` stderr 会打印在服务日志 |
| `jpeg-udp` 节点在线但 `rxFrames=0` | 检查硬件目标 IP/端口与服务器防火墙；抓包确认 4 字节偏移分片是否到达；`/status` 的 `rx.packets` 可区分“没包”与“重组失败” |
| `jpeg-udp` 节点 `rxDropped` 持续增长 | 多为网络丢包或 MTU 问题；确认链路允许 1404 字节 UDP 载荷且未启用会重排/丢弃的隧道 |
| `jpeg-udp` 录制目录为空 | 开启「自动录制」；录制只在该节点首次收到完整 JPEG 帧后启动，`ffmpeg` 缺失或转码失败会写 warn 日志 |
| `端口已被系统占用` | 用 `/api/system/all-ports` 或 `ss -ltnup` 定位占用者 |
| 录像不生成 | 启动时勾选「自动录制」；确认 `RECORD_DIR` 可写、磁盘有余量 |
| 重启后节点消失 | 检查 `data/nodes.json` 与 `DATA_DIR` 权限；部分节点恢复失败会写入日志 |
