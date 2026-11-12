/** Same-origin API and dynamically routed video ports. */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? '/api'

export const streamHttpUrl = (port: number, path = ''): string =>
  `${window.location.origin}/video/${port}${path}`

export const streamWsUrl = (port: number, path = '/stream'): string =>
  `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/video/${port}${path}`
