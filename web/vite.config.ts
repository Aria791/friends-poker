import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { roomGateway } from './server/viteGateway';

// 前端开发服务器同时承载：
//  - 静态 SPA（index.html + 资源）
//  - 本地后端网关（server/roomHost.ts）：房间 HTTP 接口 + WebSocket 升级，
//    复用与线上完全一致的 RoomController + 核心引擎（MemoryRoomStorage 实现），
//    因此 `npm run dev` 即可在本地跑通完整牌局，无需 Cloudflare。
export default defineConfig({
  plugins: [react(), roomGateway()],
  server: {
    port: 5173,
    host: true,
  },
});
