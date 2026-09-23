// 运行期配置：WebSocket / API 的基址。
//  - 本地开发：默认同源（Vite 网关同时提供 HTTP 与 WebSocket）。
//  - 生产部署：通过环境变量指向 Cloudflare Worker 域名
//    VITE_WS_ORIGIN=wss://your-worker.dev  VITE_API_ORIGIN=https://your-worker.dev
// 浏览器 WebSocket 无法自定义请求头，因此 uid/name 通过 query 传递；
// 生产 Worker 在收到后注入 x-user-id / x-user-name 头再转发给 Durable Object。

const fallback =
  typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';

export const WS_ORIGIN =
  (import.meta.env.VITE_WS_ORIGIN as string | undefined) || fallback;
export const API_ORIGIN =
  (import.meta.env.VITE_API_ORIGIN as string | undefined) || WS_ORIGIN;

export function wsUrl(
  code: string,
  uid: string,
  name: string,
  lastSeq = 0,
): string {
  const u = encodeURIComponent(uid);
  const n = encodeURIComponent(name);
  return `${WS_ORIGIN}/${code}/ws?uid=${u}&name=${n}&lastSeq=${lastSeq}`;
}

export function apiUrl(path: string): string {
  return `${API_ORIGIN}${path}`;
}
