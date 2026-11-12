# monitor-pro 后端服务

与 `src/` 前端配套的 Node.js 后端，零 npm 依赖（仅依赖系统 `ffmpeg`），负责：

- 接收 ESP32 硬件经 UDP 推入的 H.264 流；
- 为每个节点在独立 HTTP 端口分发 **WebSocket H.264**（jmuxer）与 **MJPEG**（浏览器 `<img>`）；
- 按 3GB 上限循环录制 MP4 切片（FIFO 覆盖），提供列表、下载、单删、批量删；
- 采集 CPU / 内存 / 磁盘 / 录像池指标，扫描主机监听端口；
- 节点进程看门狗：ffmpeg 退出后指数退避重启，配置持久化到 `data/nodes.json`。

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

### 视频流端点（每个节点独立端口，非 3000）

| 协议 | 路径 | 说明 |
|------|------|------|
| WS | `ws://<host>:<node.http>/stream` | H.264 Annex-B 裸流，首包为缓存的 SPS/PPS/IDR |
| GET | `http://<host>:<node.http>/mjpeg` | `multipart/x-mixed-replace` JPEG 流（仅 `streamType=mjpeg`） |
| GET | `http://<host>:<node.http>/` | 节点自检信息 |

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
| `HTTP_PORT_MIN` / `HTTP_PORT_MAX` | `9051` / `9100` | 允许的视频流端口 |
| `CORS_ORIGIN` | `*` | 允许的前端来源 |
| `ADMIN_TOKEN` | 空 | 非空时启用后端鉴权 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

默认端口区间与前端表单（9001–9050 / 9051–9100）一致，修改时需同步前端。

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
| `端口已被系统占用` | 用 `/api/system/all-ports` 或 `ss -ltnup` 定位占用者 |
| 录像不生成 | 启动时勾选「自动录制」；确认 `RECORD_DIR` 可写、磁盘有余量 |
| 重启后节点消失 | 检查 `data/nodes.json` 与 `DATA_DIR` 权限；部分节点恢复失败会写入日志 |
