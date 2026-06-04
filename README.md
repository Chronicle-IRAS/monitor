# 实验室监控中心 (monitor-pro)

基于 Vue 3 + TypeScript + Element Plus 的 ESP32 摄像头集群实时监控前端系统，支持多路视频流预览、历史录像回放、端口管理及系统配置。

## 功能概览

| 模块 | 说明 |
|------|------|
| **实时预览** | 多路 ESP32 摄像头 MJPEG/WebSocket 流实时播放，支持 jmuxer 解码 |
| **历史录像** | 录像文件列表查询与回放 |
| **通讯终端** | 设备端口状态查看、节点启停管理 |
| **系统配置** | 管理员专属的系统参数与设备调度配置 |
| **权限管控** | 访客（仅查看）/ 管理员（完整控制）双角色，密码认证 |
| **深色模式** | 亮色 / 深色主题一键切换，偏好本地持久化 |
| **响应式布局** | 桌面端侧边栏 + 移动端抽屉导航，自适应屏幕尺寸 |

## 技术栈

- **框架**: Vue 3（Composition API + `<script setup>`）
- **语言**: TypeScript
- **构建**: Vite 7
- **UI 库**: Element Plus
- **状态管理**: Pinia
- **路由**: Vue Router 5
- **HTTP**: Axios
- **视频解码**: jmuxer
- **代码规范**: ESLint + Oxlint + Prettier

## 前置条件

- Node.js `^20.19.0` 或 `>=22.12.0`
- npm 8+

## 本地开发

```sh
# 安装依赖
npm install

# 启动开发服务器（热更新）
npm run dev

# 生产构建
npm run build

# 预览生产构建
npm run preview

# 代码检查
npm run lint

# 代码格式化
npm run format
```

## 环境变量

在项目根目录创建 `.env` 文件（亦可使用 `.env.development` / `.env.production` 区分环境）：

```env
# 后端 API 地址
VITE_API_BASE=http://121.41.3.7:3000/api

# 视频流主机地址
VITE_STREAM_HOST=121.41.3.7
```

> 详细配置参见 `src/config.ts`，所有 API/流地址均收敛于此，避免硬编码散落。

## 项目结构

```
├── src/
│   ├── api/             # Axios 请求封装
│   ├── components/      # 公共组件（MonitorCard、NavMenu）
│   ├── router/          # 路由配置
│   ├── stores/          # Pinia 状态管理
│   ├── types/           # TypeScript 类型定义
│   ├── views/           # 页面组件
│   │   ├── MonitorCenter.vue   # 实时预览
│   │   ├── HistoryRecords.vue  # 历史录像
│   │   ├── PortStatus.vue      # 通讯终端
│   │   └── SystemConfig.vue    # 系统配置
│   ├── App.vue          # 根组件（布局、主题、权限）
│   ├── config.ts        # 全局运行时配置
│   └── main.ts          # 入口文件
├── deploy.bat           # Windows 一键部署脚本
├── vite.config.ts       # Vite 配置
└── tsconfig.json        # TypeScript 配置
```

## 部署

项目提供 `deploy.bat` 一键部署脚本，自动完成构建 → 上传 → Nginx 更新：

```bat
deploy.bat
```

脚本执行流程：
1. `npm run build` 构建生产产物
2. 通过 SSH 连接远程服务器，清理旧文件
3. 通过 SCP 上传 `dist/` 到 `/var/www/monitor-pro/`
4. 移动文件并设置 Nginx 权限

> 目标服务器地址默认为 `121.41.3.7`，请在 `deploy.bat` 中按需修改。

## 推荐 IDE

[VS Code](https://code.visualstudio.com/) + [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar)（请禁用 Vetur）。
