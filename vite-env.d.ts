/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WS_ORIGIN?: string;
  readonly VITE_API_ORIGIN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
