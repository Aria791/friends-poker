import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { handleApiRooms, getOrCreateRoom, handleConnection, WebSocketServer } from './roomHost';

/**
 * Vite 插件：在开发服务器上同时提供
 *  - HTTP 接口  /api/rooms （列表 / 创建 6 位房间码）
 *  - WebSocket /{code}/ws （升级后交由 roomHost 处理）
 * 这样前端 `npm run dev` 即可在本地跑通完整牌局，无需 Cloudflare。
 */
export function roomGateway(): Plugin {
  return {
    name: 'room-gateway',
    configureServer(server: ViteDevServer) {
      // ---- HTTP 接口 ----
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        try {
          const handled = await handleApiRooms(req, res);
          if (!handled) next();
        } catch {
          next();
        }
      });

      // ---- WebSocket 升级 ----
      server.httpServer?.on(
        'upgrade',
        (req: IncomingMessage, socket: Socket, head: Buffer) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const m = url.pathname.match(/^\/([A-Za-z0-9]{6})\/ws$/);
          if (!m) return; // 非房间 WS：交给 Vite（HMR 等）处理

          const code = m[1];
          const uid = url.searchParams.get('uid') || '';
          const name = url.searchParams.get('name') || '玩家';
          const lastSeq = Number(url.searchParams.get('lastSeq') || '0');

          const wss = new WebSocketServer({ noServer: true });
          const h = getOrCreateRoom(code);
          wss.handleUpgrade(req, socket, head, (ws) => {
            void handleConnection(h, ws, uid, name, lastSeq);
          });
        },
      );
    },
  };
}
