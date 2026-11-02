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

## 项目用途

本项目是实验室 ESP32 摄像头集群的监控前端，用于在浏览器中集中查看各节点的实时画面、回放历史录像、管理设备端口与节点启停，并由管理员维护系统配置。后端 API 与视频流服务需单独部署，前端通过环境变量指定其地址。

## 前置条件

- Node.js `^20.19.0` 或 `>=22.12.0`（见 `package.json` 的 `engines` 字段）
- npm（项目使用 `package-lock.json` 锁定依赖版本）

## 安装依赖

```sh
npm ci        # 按 package-lock.json 精确安装（推荐）
# 或
npm install
```

## 环境变量

在项目根目录创建 `.env` 文件（亦可使用 `.env.development` / `.env.production` 区分环境；这些文件已被 `.gitignore` 忽略，请勿提交）：

```env
# 后端 API 地址
VITE_API_BASE=http://<YOUR_SERVER_IP>:3000/api

# 视频流主机地址（不含端口）
VITE_STREAM_HOST=<YOUR_SERVER_IP>

# 管理员密码（可选，仅保存在本地环境文件中）
VITE_ADMIN_PASSWORD=<YOUR_ADMIN_PASSWORD>
```

> 详细配置参见 `src/config.ts`，所有 API/流地址均收敛于此，避免硬编码散落。

## 启动开发环境

```sh
npm run dev
```

启动 Vite 开发服务器（支持热更新），默认地址为 http://localhost:5173 ，实际地址以终端输出为准。

## 构建生产版本

```sh
npm run build
```

该命令会并行执行类型检查（`vue-tsc --build`）与 Vite 打包，产物输出至 `dist/` 目录。构建完成后可本地预览：

```sh
npm run preview
```

## 其他命令

```sh
npm run lint     # 代码检查（Oxlint + ESLint，自动修复）
npm run format   # 使用 Prettier 格式化 src/
```

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

项目提供 `deploy.bat` 一键部署脚本（Windows），自动完成构建 → 上传 → 替换线上静态文件。执行前需设置目标服务器地址：

```bat
set DEPLOY_SERVER=<YOUR_SERVER_IP>
deploy.bat
```

脚本执行流程：
1. `npm run build` 构建生产产物
2. 通过 SSH 连接远程服务器，准备临时上传目录
3. 通过 SCP 上传 `dist/` 到临时目录
4. 替换 `/var/www/monitor-pro/` 下的线上文件并设置权限

> 脚本以 `root` 用户通过 SSH/SCP 连接服务器，请提前配置好 SSH 访问。

## 推荐 IDE

[VS Code](https://code.visualstudio.com/) + [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar)（请禁用 Vetur）。
