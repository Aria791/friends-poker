/// <reference types="@cloudflare/workers-types" />
//
// 生产环境 Worker 入口（被 wrangler.jsonc 的 main 引用）。
// 职责：HTTP 路由（房间列表 / 创建 6 位房间码）+ WebSocket 透传（注入身份头后转发给 Durable Object）。
//
// 浏览器 WebSocket 无法自定义请求头，因此客户端把 uid/name 放在 query（?uid=&name=）；
// 本 Worker 读取后注入 x-user-id / x-user-name 头，再以子请求方式转发给 ROOM Durable Object，
// 由 DO 完成真正的连接 / 加入 / 裁决。所有金额与规则仍以 DO + core 引擎为准。
import { RoomDurableObject } from '../room/room.do';

interface Env {
  ROOM: DurableObjectNamespace;
  DB: D1Database;
  /** 可选：用于校验会话并解析出真实 uid/name；这里简化为信任 query（朋友局，无强鉴权） */
}

function json(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function genCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += Math.floor(Math.random() * 10);
  return s;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ---- 房间列表 ----
    if (url.pathname === '/api/rooms' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          'SELECT code, name FROM rooms ORDER BY created_at DESC LIMIT 50',
        ).all();
        const rooms = (results as { code: string; name: string }[]).map((r) => ({
          roomId: r.code,
          name: r.name,
          players: 0,
          maxPlayers: 6,
        }));
        return json({ rooms });
      } catch {
        return json({ rooms: [] });
      }
    }

    // ---- 创建房间（生成 6 位房间码） ----
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const code = genCode();
      const name = (body.name as string) || '朋友牌局';
      const config = {
        name,
        startingChips: Number(body.startingChips) || 1000,
        smallBlind: Number(body.smallBlind) || 5,
        bigBlind: Number(body.bigBlind) || 10,
        turnTimeoutMs: Number(body.turnTimeoutMs) || 30000,
        allowLateJoin: true,
      };
      const hostId = (body.hostId as string) || 'host';
      const hostName = (body.hostName as string) || '房主';

      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      await stub.fetch(new URL('/init', url), {
        method: 'POST',
        body: JSON.stringify({ config, members: [{ id: hostId, nickname: hostName }], hostId }),
      });
      try {
        await env.DB.prepare('INSERT INTO rooms (code, name, created_at) VALUES (?, ?, ?)')
          .bind(code, name, Date.now())
          .run();
      } catch {
        /* 列表仅用于展示，写入失败不影响开局 */
      }
      return json({ roomId: code });
    }

    // ---- WebSocket 透传 /{code}/ws?uid=&name= ----
    const m = url.pathname.match(/^\/([A-Za-z0-9]{6})\/ws$/);
    if (m) {
      const code = m[1];
      const uid = url.searchParams.get('uid') || '';
      const name = url.searchParams.get('name') || '玩家';
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);

      // 注入身份头（浏览器无法在 WS 上设置自定义头），再转发给 DO
      const headers = new Headers(request.headers);
      headers.set('x-user-id', uid);
      headers.set('x-user-name', name);
      return stub.fetch(request, { headers });
    }

    return new Response('not found', { status: 404 });
  },
};

export { RoomDurableObject };
