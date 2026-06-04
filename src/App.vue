<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { Fold, UserFilled, Sunrise, Moon } from '@element-plus/icons-vue'
import NavMenu from '@/components/NavMenu.vue'
import { useDeviceStore } from '@/stores/deviceStore'

const systemStatus = ref('运行正常')
const route = useRoute()
const store = useDeviceStore()

// --- 响应式断点：< 768px 视为移动端 ---
const MOBILE_BREAKPOINT = 768
const isMobile = ref(false)
const updateIsMobile = () => {
  isMobile.value = window.innerWidth < MOBILE_BREAKPOINT
}

// 桌面端侧边栏折叠态 / 移动端抽屉开关
const isCollapse = ref(false)
const mobileMenuOpen = ref(false)

// 左上角按钮：移动端唤出抽屉，桌面端折叠侧边栏
const toggleSidebar = () => {
  if (isMobile.value) {
    mobileMenuOpen.value = !mobileMenuOpen.value
  } else {
    isCollapse.value = !isCollapse.value
  }
}

const currentCrumb = computed(() => {
  switch (route.name) {
    case 'monitor':
      return '实时预览'
    case 'records':
      return '历史录像'
    case 'terminal':
      return '通讯终端'
    case 'config':
      return '系统配置'
    default:
      return ''
  }
})

const isDark = ref(false)

onMounted(() => {
  updateIsMobile()
  window.addEventListener('resize', updateIsMobile)

  const savedTheme = localStorage.getItem('pro-admin-theme')
  if (savedTheme === 'dark') {
    isDark.value = true
    toggleDarkMode()
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', updateIsMobile)
})

const toggleDarkMode = () => {
  const html = document.documentElement
  if (isDark.value) {
    html.classList.add('dark')
    localStorage.setItem('pro-admin-theme', 'dark')
  } else {
    html.classList.remove('dark')
    localStorage.setItem('pro-admin-theme', 'light')
  }
}

// 登录弹窗相关
const showAuthDialog = ref(false)
const adminPwd = ref('')

const handleLogin = () => {
  if (store.login(adminPwd.value)) {
    showAuthDialog.value = false
    adminPwd.value = ''
  }
}
</script>

<template>
  <el-container class="main-shell">
    <!-- 桌面端常驻侧边栏 -->
    <el-aside
      v-if="!isMobile"
      :class="['aside-menu', isCollapse ? 'is-collapsed' : '']"
    >
      <div class="logo-container">
        <span class="logo-text full-logo" :class="{ 'is-hidden': isCollapse }">PRO_ADMIN</span>
        <span class="logo-text mini-logo" :class="{ 'is-hidden': !isCollapse }">PA</span>
      </div>
      <NavMenu :active-path="route.path" :collapse="isCollapse" />
    </el-aside>

    <el-container class="right-container">
      <el-header class="main-header">
        <div class="header-left">
          <el-button type="text" @click="toggleSidebar" class="collapse-btn">
            <el-icon size="22" :class="['fold-icon', isCollapse ? 'is-active' : '']"
              ><Fold
            /></el-icon>
          </el-button>
          <el-breadcrumb separator="/" class="breadcrumb">
            <el-breadcrumb-item>控制台</el-breadcrumb-item>
            <el-breadcrumb-item>{{ currentCrumb }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>

        <div class="header-right">
          <el-switch
            v-model="isDark"
            inline-prompt
            :active-icon="Moon"
            :inactive-icon="Sunrise"
            active-color="#2c3e50"
            inactive-color="#e67e22"
            @change="toggleDarkMode"
            class="theme-switch"
          />
          <el-tag size="small" type="success" effect="dark" class="status-tag">{{
            systemStatus
          }}</el-tag>

          <el-dropdown>
            <span class="user-info">
              <el-avatar
                :size="28"
                :icon="UserFilled"
                :style="{ background: store.isAdmin ? '#409EFF' : '#909399' }"
              />
              <span
                class="username"
                :style="{
                  color: store.isAdmin ? 'var(--el-color-primary)' : 'var(--el-text-color-regular)',
                }"
              >
                {{ store.isAdmin ? '实验室管理员' : '访客 (仅查看)' }}
              </span>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-if="!store.isAdmin" @click="showAuthDialog = true"
                  >🛡️ 管理员登录</el-dropdown-item
                >
                <el-dropdown-item v-if="store.isAdmin" @click="store.logout"
                  >🚪 退出登录</el-dropdown-item
                >
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main class="main-content">
        <router-view v-slot="{ Component }">
          <transition name="fade-page" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </el-main>
    </el-container>

    <!-- 移动端抽屉式侧边栏 -->
    <el-drawer
      v-model="mobileMenuOpen"
      direction="ltr"
      :with-header="false"
      size="220px"
      class="mobile-drawer"
    >
      <div class="logo-container"><span class="logo-text full-logo">PRO_ADMIN</span></div>
      <NavMenu :active-path="route.path" @select="mobileMenuOpen = false" />
    </el-drawer>

    <el-dialog v-model="showAuthDialog" title="安全认证" width="350px" center>
      <div style="text-align: center; margin-bottom: 20px; color: #909399; font-size: 13px">
        仅允许授权人员进行设备调度与核心进程管控
      </div>
      <el-input
        v-model="adminPwd"
        type="password"
        placeholder="请输入超级管理员密码"
        show-password
        @keyup.enter="handleLogin"
      />
      <template #footer>
        <el-button @click="showAuthDialog = false">取消</el-button>
        <el-button type="primary" @click="handleLogin">认证授权</el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<style>
/* --- 全局基础 --- */
body {
  margin: 0;
  background-color: var(--el-bg-color);
  color: var(--el-text-color-primary);
}
.main-shell {
  height: 100vh;
  height: 100dvh; /* 规避移动端浏览器地址栏导致的 100vh 溢出 */
  display: flex;
}

/* --- 🌟 侧边栏：苹果级阻尼曲线 --- */
.aside-menu {
  background-color: var(--el-bg-color-overlay);
  width: 220px;
  transition:
    width 0.4s cubic-bezier(0.2, 0.8, 0.2, 1),
    background-color 0.3s;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--el-border-color-light);
  white-space: nowrap;
  overflow: hidden;
  z-index: 10;
}
.aside-menu.is-collapsed {
  width: 64px;
}

/* --- 🌟 Logo 纯 CSS 交叉渐变 --- */
.logo-container {
  height: 60px;
  line-height: 60px;
  background: var(--el-color-primary-light-9);
  position: relative;
  overflow: hidden;
  transition: background-color 0.3s;
}
.logo-text {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  text-align: center;
  color: var(--el-color-primary);
  font-weight: bold;
  font-size: 16px;
  transition:
    opacity 0.3s ease,
    transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
}

/* 展开时的长 Logo */
.full-logo {
  opacity: 1;
  transform: translateX(0);
}
.full-logo.is-hidden {
  opacity: 0;
  transform: translateX(-20px);
  pointer-events: none;
}

/* 收起时的短 Logo */
.mini-logo {
  opacity: 1;
  transform: translateX(0);
}
.mini-logo.is-hidden {
  opacity: 0;
  transform: translateX(20px);
  pointer-events: none;
}

/* --- 移动端抽屉内部去掉默认内边距 --- */
.mobile-drawer .el-drawer__body {
  padding: 0;
  display: flex;
  flex-direction: column;
}

/* --- 右侧布局 --- */
.right-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* --- Header --- */
.main-header {
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-light);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 15px;
  transition: background-color 0.3s;
}
.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 15px;
  min-width: 0;
}

.collapse-btn {
  color: var(--el-text-color-regular);
  padding: 0 10px;
}
.collapse-btn:hover {
  color: var(--el-color-primary);
}
.fold-icon {
  transition: transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.fold-icon.is-active {
  transform: rotate(-180deg);
}

.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--el-text-color-regular);
}
.theme-switch {
  margin-right: 10px;
}

/* --- 内容区 & 页面路由动画 --- */
.main-content {
  padding: 20px;
  background: var(--el-bg-color-page);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  transition: background-color 0.3s;
}

.fade-page-enter-active,
.fade-page-leave-active {
  transition: all 0.25s ease-out;
}
.fade-page-enter-from {
  opacity: 0;
  transform: translateY(10px);
}
.fade-page-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

/* --- 📱 移动端适配 --- */
@media screen and (max-width: 768px) {
  .main-header {
    padding: 0 10px;
  }
  .header-left,
  .header-right {
    gap: 8px;
  }
  /* 移动端隐藏面包屑与状态标签，给标题和操作让位 */
  .breadcrumb,
  .status-tag {
    display: none;
  }
  .theme-switch {
    margin-right: 0;
  }
  /* 用户名文字过长，移动端只保留头像 */
  .username {
    display: none;
  }
  .main-content {
    padding: 12px;
  }
}
</style>
