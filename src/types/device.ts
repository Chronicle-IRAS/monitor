// src/types/device.ts
export interface DeviceNode {
  id: string // 设备唯一标识
  udp: number // 硬件发包端口
  http: number // 网页抓流端口
}

export interface StartDeviceDto {
  id: string
  udp: number
  http: number
}
