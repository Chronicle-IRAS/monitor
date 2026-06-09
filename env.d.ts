/// <reference types="vite/client" />
declare module 'jmuxer'

interface ImportMetaEnv {
  readonly VITE_API_BASE: string
  readonly VITE_STREAM_HOST: string
  readonly VITE_ADMIN_PASSWORD?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
