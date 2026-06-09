import axios from 'axios'
import { ElMessage } from 'element-plus'
import { API_BASE } from '@/config'

const service = axios.create({
  baseURL: API_BASE,
  timeout: 5000,
})

// 响应拦截器：
service.interceptors.response.use(
  (response) => response.data,
  (error) => {
    ElMessage.error(error.response?.data?.message || '网络连接失败')
    return Promise.reject(error)
  },
)

export default service
