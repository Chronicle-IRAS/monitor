# CAM-WEB 硬件协议与配置核对

核对对象：<https://github.com/FTDBWLZ/CAM-WEB>，提交 `447887e`（2026-06-04），固件版本 `V1.1.2`。
关键文件：`src/main.c`（`send_frame()`、`udp_server_task()`、`load_network_config()`、`save_network_config()`）、`src/config.h`。

## 1. 真实 UDP 视频协议

`src/main.c` 的 `send_frame()` 逐块发送摄像头 `camera_fb_t`：

```
数据报 = [4 字节大端序 offset][最多 1400 字节 JPEG 数据]
帧结束 = [FF FF FF FF]（仅 4 字节，无 offset）
```

- `APP_MAX_PACKET = 1400`，所以单个 UDP 载荷最多 `1400 + 4 = 1404` 字节；加 IP/UDP 头 28 字节为 1432 字节，低于 1500 MTU。
- `offset` 是该分片在整帧 JPEG 中的字节偏移，从 0 开始，每片递增 `chunk`。
- 没有帧号、总长度、设备 ID、序号或校验和。接收端只能按来源 `IP:port` 区分设备，因此**一个 UDP 端口只能接一个硬件**。
- 相机输出为 JPEG：有 PSRAM 时 `FRAMESIZE_QVGA`（320×240）/ quality 30；无 PSRAM 时 `FRAMESIZE_QQVGA`（160×120）/ quality 20。采集任务每帧后 `vTaskDelay(30ms)`，实际约 20–30 fps。
- 设备另有一个 UDP 监听端口 `12345`：收到文本 `Verify` 时回复 `isonline`。这是设备存活探测，不是视频端口，monitor 后端目前不发送该探测。

monitor 后端的兼容实现见 `server/src/jpeg-udp.js`，节点 `streamType` 为 `jpeg-udp`。

## 2. 硬件默认配置（源码值）

| 配置项 | `src/config.h` | 上游默认值 | 说明 |
|--------|----------------|------------|------|
| 目标服务器 IP（生产） | `APP_DEFAULT_DEST_IP` | `121.41.3.7`（本地工作区已改为 `43.142.120.169`） | `APP_ENV=PROD`（默认） |
| 目标服务器 IP（开发） | `APP_DEFAULT_DEST_IP` | `192.168.1.100` | `APP_ENV=DEV` |
| 视频目标端口 | `APP_DEFAULT_DEST_PORT` | `9002` | 必须是 monitor 节点分配到的 UDP 端口 |
| 设备 UDP 监听端口 | `APP_UDP_LISTEN_PORT` | `12345` | 仅用于 `Verify`/`isonline` |
| 单包 JPEG 载荷 | `APP_MAX_PACKET` | `1400` | 不要调大，否则易分片/被丢 |
| WiFi NVS 命名空间 | `APP_WIFI_NAMESPACE` | `"wifi"` | |
| AP SSID / 密码 | `APP_AP_SSID` / `APP_AP_PASS` | `SET_AP_SSID` / `SET_AP_PASS` | 占位符，**烧录前必须修改** |
| MQTT Broker | `APP_MQTT_HOST` / `APP_MQTT_PORT` | `121.41.3.7` / `8883`（本地工作区已改为 `43.142.120.169`） | 生产与开发均写死 |
| MQTT URI | `APP_MQTT_URI` | `mqtt://<host>:8883` | `APP_ENABLE_MQTT_TLS=0`，即明文 MQTT 跑在 8883 |
| MQTT TLS | `APP_ENABLE_MQTT_TLS` | `0` | 改为 1 后 URI 变 `mqtts://...` |
| OTA HTTPS | `APP_ENABLE_OTA_HTTPS` | `0` | OTA URL 实际由 MQTT 指令下发 |
| OTA/MQTT 证书 | `APP_MQTT_SERVER_CERT_PEM` / `APP_OTA_SERVER_CERT_PEM` | `NULL` | 未配置 CA |
| 允许不安全 TLS | `APP_ALLOW_INSECURE_TLS` | `1` | 生产建议收紧 |
| NVS 加密 | `APP_ENABLE_NVS_ENCRYPTION` | `1` | WiFi 密码 AES 加密后存 `pass_enc` |
| 固件版本 | `APP_VERSION` | `V1.1.2` | |

本地工作区 `E:/al-projects/cam-web` 存在未提交修改：`APP_DEFAULT_DEST_IP` 与 `APP_MQTT_HOST` 已指向 `43.142.120.169`，其余协议与端口未变。该地址目前是 monitor 后端所在主机；若该主机未运行 MQTT Broker，OTA/确认链路会失败（不影响视频）。

MQTT Topics（`src/config.h`）：

| Topic | 方向 | 用途 |
|-------|------|------|
| `ota/all/info` | 服务器 → 设备 | 新固件公告：`{ "cmd":"info", "ver", "filename", "md5", "size" }` |
| `ota/all/cmd` | 服务器 → 设备 | 升级指令：`{ "cmd":"update", "url", "md5", "size" }` |
| `ota/log` | 设备 → 服务器 | 升级/运行日志 |
| `ota/confirm` | 设备 → 服务器 | 升级确认：`{ "id":"esp32-XXXXXX" }` |

OTA 下载 URL 不在源码写死，由 `ota/all/cmd` 的 `url` 字段下发；设备校验 `size` 与 MD5 后写入 OTA 分区。`url` 最长 159 字符。

## 3. NVS 持久化配置

命名空间 `wifi`，键如下：

| 键 | 类型 | 内容 |
|----|------|------|
| `ssid` | str | WiFi SSID |
| `pass_enc` | blob | AES-128-ECB 加密后的 WiFi 密码（16 字节对齐填充） |
| `pass` | str | 仅当 `pass_enc` 不存在时的明文回退 |
| `ip` | str | 目标服务器 IPv4 |
| `port` | i32 | 目标 UDP 端口 |

AES 密钥由 WiFi STA MAC 派生：`key[i] = mac[i % 6] ^ (0x3D + 17 * i)`，所以 NVS 中的 `pass_enc` **不可跨设备复制**。

配网流程：设备进入 AP 模式 → 连接 `APP_AP_SSID` → 浏览器打开 `http://192.168.4.1/` → 填写 SSID / 密码 / 目标 IP / 目标端口 → `/save` → 设备 2 秒后重启。`/save` 是明文 HTTP GET，无鉴权，仅应在受控配网环境使用。

**修改 `config.h` 的默认值不会改写已配网设备**：`load_network_config()` 优先读取 NVS 中的 `ip` / `port`。已部署设备必须重新配网，或长按 GPIO0 ≥3 秒执行 `clear_network_config()` 清空 `wifi` 命名空间后重启。

GPIO0 行为（`check_button()`）：

- 按住约 0.3–3 秒：强制进入 AP 模式（`s_force_ap`）。
- 按住 ≥3 秒：清空 NVS 网络配置并重启。
- GPIO2：OTA 确认键。

## 4. 接入 monitor 平台需要修改的配置清单

按优先级排列。“代码默认值”与“已配网设备”是两件事，必须分别处理。

| # | 项目 | 当前值 | 需要改为 | 影响 |
|---|------|--------|----------|------|
| 1 | `APP_DEFAULT_DEST_IP`（PROD） | 上游 `121.41.3.7`；本地工作区已改 `43.142.120.169` | monitor 后端公网 IP，当前部署为 `43.142.120.169` | 上游默认值会把视频继续发往旧 MQTT/OTA 主机 |
| 2 | `APP_DEFAULT_DEST_PORT` | `9002` | 与 monitor 节点 `udp` 一致，通常 `9001–9050` 内按设备分配 | 端口不一致时节点 `rxFrames` 恒为 0 |
| 3 | 已配网设备的 NVS `ip` / `port` | 旧值 | 通过 AP 配网页面重新写入，或长按 GPIO0 清 NVS 后重配 | **只改 `config.h` 对已部署设备无效** |
| 4 | 云安全组 / 主机防火墙 | 仅确认过 TCP/HTTP | 放行 `43.142.120.169` 的 UDP `9001–9050` 入站 | 腾讯云安全组未放行时公网探测超时；Nginx 不代理 UDP |
| 5 | `APP_AP_SSID` / `APP_AP_PASS` | `SET_AP_SSID` / `SET_AP_PASS` | 现场唯一 SSID 与强密码 | 占位符会导致任意人可连配网热点 |
| 6 | MQTT `APP_MQTT_HOST` / `APP_MQTT_PORT` | 上游 `121.41.3.7:8883`；本地工作区已改 `43.142.120.169:8883` | 确认目标主机确实运行 Broker 且 8883 接受**明文 MQTT**，否则开启 `APP_ENABLE_MQTT_TLS=1` 并配置 CA | 配错只影响 OTA/日志，不影响视频。2026-11-12 从本机探测 `43.142.120.169:8883` 与 `121.41.3.7:8883` 均超时，需在云安全组/主机防火墙放行后再验证 |
| 7 | `APP_ENABLE_MQTT_TLS` / 证书 | `0` / `NULL` | 生产建议 `1` 并写入 Broker CA；若保持 0，确保 8883 仅内网可达 | 明文 MQTT 会暴露 OTA 指令与日志 |
| 8 | `APP_ENABLE_OTA_HTTPS` / `APP_ALLOW_INSECURE_TLS` | `0` / `1` | 生产建议 OTA URL 使用 HTTPS 并收紧不安全 TLS | 防止固件被篡改 |
| 9 | OTA `url` | 由 MQTT 下发 | 指向设备可达的固件下载地址，长度 <160，配套正确 `md5` / `size` | 配错则 OTA 下载失败 |
| 10 | `APP_UDP_LISTEN_PORT` | `12345` | 通常无需修改；若与现场服务冲突再改 | 仅影响 `Verify` 探活，monitor 不使用 |
| 11 | `APP_MAX_PACKET` | `1400` | 保持不变 | 调大可导致 IP 分片与丢包率上升 |
| 12 | 摄像头分辨率/质量 | QVGA/30 或 QQVGA/20 | 无 PSRAM 设备不要期望 320×240 | 影响带宽与录像清晰度 |

> 生产后端域名 `monitor.chronicleiras.top` 可以配给 MQTT/OTA 使用，但视频目标 IP 字段只接受 IPv4 文本（`is_valid_ipv4_text()` / `inet_pton`），不能填域名。

## 5. 实体硬件联调状态

**未完成。** 本次工作没有接入实体 ESP32-S3，也没有在真实链路上观察到硬件出图。

检查结果：本机串口列表只有蓝牙虚拟串口与 `com0com` 虚拟串口，没有 CP210x / CH340 / USB-JTAG 等 ESP32 USB 串口设备；`E:/al-projects/cam-web` 中存在 2026-11-12 构建的 `firmware.bin`，但未烧录、未上电验证。

已完成的部分：

- 按 `send_frame()` 的真实数据报格式实现了 UDP 接收、重组、乱序/重复/丢包处理、超时清理、MJPEG 直出与按需录制；
- 测试使用 4 字节大端偏移、1400 字节分片、`0xFFFFFFFF` 结束包构造数据，并通过真实 UDP socket 与 HTTP `/mjpeg` 验证；
- 测试**没有**用标准 H.264 流或普通 MJPEG 流冒充硬件协议。

接入实体设备后必须补做：

1. 服务器 `sudo tcpdump -ni any udp port 9002`，确认收到 `offset + payload` 与 `FF FF FF FF`；
2. 创建 `streamType=jpeg-udp` 节点，`GET /api/nodes` 中 `rxPackets`、`rxFrames`、`lastFrameAt` 增长，`receiving=true`；
3. 浏览器打开 `https://monitor.chronicleiras.top/video/<http端口>/mjpeg`，确认真实画面（不是“节点 online”或“ffmpeg 启动成功”）；
4. 开启录制后检查 `records/<设备ID>/*.mp4` 可播放，并用 `ffprobe` 确认时长与编码；
5. 记录设备 MAC / `esp32-XXXXXX`、分配端口、固件版本与实测帧率。
