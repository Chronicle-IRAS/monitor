import { createRouter, createWebHistory } from 'vue-router'
import MonitorCenter from '../views/MonitorCenter.vue'
import PortStatus from '../views/PortStatus.vue'
import SystemConfig from '../views/SystemConfig.vue'
import HistoryRecords from '@/views/HistoryRecords.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/monitor' },
    { path: '/monitor', name: 'monitor', component: MonitorCenter },
    { path: '/terminal', name: 'terminal', component: PortStatus },
    { path: '/config', name: 'config', component: SystemConfig },
    { path: '/records', name:'records', component:HistoryRecords}
  ],
})

export default router
