<script setup lang="ts">
import { Monitor, Film, ChatLineRound, Setting } from '@element-plus/icons-vue'

defineProps<{
  /** 当前激活路由，对应 el-menu 的 default-active */
  activePath: string
  /** 是否折叠为图标模式（仅桌面端侧边栏使用） */
  collapse?: boolean
}>()

// 移动端抽屉里点击菜单后需要关闭抽屉，桌面端可忽略此事件
const emit = defineEmits<{ select: [] }>()
</script>

<template>
  <el-menu
    :default-active="activePath"
    class="nav-menu"
    :collapse="collapse"
    :collapse-transition="false"
    router
    @select="emit('select')"
  >
    <el-menu-item index="/monitor">
      <el-icon><Monitor /></el-icon>
      <template #title>实验室监控</template>
    </el-menu-item>

    <el-menu-item index="/records">
      <el-icon><Film /></el-icon>
      <template #title>历史录像</template>
    </el-menu-item>

    <el-menu-item index="/terminal">
      <el-icon><ChatLineRound /></el-icon>
      <template #title>端口状态</template>
    </el-menu-item>

    <el-menu-item index="/config">
      <el-icon><Setting /></el-icon>
      <template #title>系统配置信息</template>
    </el-menu-item>
  </el-menu>
</template>

<style scoped>
.nav-menu {
  border-right: none;
  flex: 1;
  background: transparent;
  width: 100% !important;
}
.nav-menu .el-menu-item.is-active {
  background: var(--el-color-primary-light-8);
}
</style>
