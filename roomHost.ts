// 本地开发网关的"房间宿主"逻辑（与框架无关）。
// 直接复用与线上完全一致的 RoomController + 核心引擎，仅把持久化换成 MemoryRoomStorage，
// 因此本地 `npm run dev` 即拥有权威裁决能力，可完整跑通牌局。
//
// 安全红线：本文件只是"管道"——所有规则、金额校验、超时裁决都在 RoomController / core 内，
// 这里绝不自行计算任何金额或牌局逻辑。
import { RoomController } from '../../src/room/controller';
import { MemoryRoomStorage } from '../../src/room/storage';
import {
  encode,
  decodeClient,
  type ClientMessage,
  type ServerMessage,
  type StateFrame,
} from '../../shared/protocol';
import type { RoomConfig } from '../../shared/types';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RoomHost {
  controller: RoomController;
  storage: MemoryRoomStorage;
  sockets: Map<string, Set<WebSocket>>;
  alarmTimer: ReturnType<typeof setTimeout> | null;
  name: string;
}

const registry = new Map<string, RoomHost>();
const roomMeta = new Map<string, { name: string; createdAt: number }>();

export function getOrCreateRoom(roomId: string, name = '牌桌'): RoomHost {
  let h = registry.get(roomId);
  if (!h) {
    const storage = new MemoryRoomStorage();
    const controller = new RoomController(roomId, storage, {});
    h = { controller, storage, sockets: new Map(), alarmTimer: null, name };
    registry.set(roomId, h);
  }
  return h;
}

function send(ws: WebSocket, frame: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(encode(frame));
    } catch {
      /* 连接可能已断开 */
    }
  }
}

function broadcast(h: RoomHost, frames: Map<string, StateFrame>): void {
  for (const [uid, frame] of frames) {
    const set = h.sockets.get(uid);
    if (!set) continue;
    for (const ws of set) send(ws, frame);
  }
}

function broadcastAll(h: RoomHost, frame: ServerMessage): void {
  for (const set of h.sockets.values()) for (const ws of set) send(ws, frame);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyResult(h: RoomHost, result: any, ws: WebSocket | null): Promise<void> {
  if (result.kind === 'state') {
    broadcast(h, result.frames);
    scheduleAlarm(h, result.alarmAt);
  } else if (result.kind === 'chat') {
    broadcastAll(h, result.frame);
  } else if (result.kind === 'error' && ws) {
    send(ws, { t: 'error', code: result.code, message: result.message } as ServerMessage);
  }
}

function scheduleAlarm(h: RoomHost, alarmAt: number | null): void {
  if (h.alarmTimer) {
    clearTimeout(h.alarmTimer);
    h.alarmTimer = null;
  }
  if (alarmAt == null) return;
  const delay = Math.max(0, alarmAt - Date.now());
  h.alarmTimer = setTimeout(async () => {
    const res = await h.controller.handleTimeout();
    await applyResult(h, res, null);
  }, delay);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function genCode(): string {
  let code: string;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (registry.has(code));
  return code;
}

/** HTTP：GET 列出房间 / POST 创建房间（生成 6 位房间码）。 */
export async function handleApiRooms(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/api/rooms') return false;

  if (req.method === 'GET') {
    const rooms = await Promise.all(
      [...roomMeta.entries()].map(async ([id, m]) => {
        const h = registry.get(id);
        const count = h ? ((await h.storage.loadState())?.players.length ?? 0) : 0;
        return { roomId: id, name: m.name, players: count, maxPlayers: 6 };
      }),
    );
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rooms }));
    return true;
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const roomId = genCode();
    const name = (body.name as string) || '朋友牌局';
    const config: RoomConfig = {
      name,
      startingChips: Number(body.startingChips) || 1000,
      smallBlind: Number(body.smallBlind) || 5,
      bigBlind: Number(body.bigBlind) || 10,
      turnTimeoutMs: Number(body.turnTimeoutMs) || 30000,
      allowLateJoin: true,
    };
    if (body.maxRaisesPerStreet) config.maxRaisesPerStreet = Number(body.maxRaisesPerStreet);
    const hostId = (body.hostId as string) || 'host';
    const hostName = (body.hostName as string) || '房主';

    const h = getOrCreateRoom(roomId, name);
    await h.controller.init(config, [{ id: hostId, nickname: hostName }], hostId);
    roomMeta.set(roomId, { name, createdAt: Date.now() });

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ roomId }));
    return true;
  }

  res.writeHead(405);
  res.end();
  return true;
}

/**
 * 处理一条 WebSocket 连接：自动加入（若在等待且未满）→ 发送 welcome/state/chat → 注册 socket。
 * 浏览器 WebSocket 无法自定义请求头，因此 uid/name 通过 query 传入；
 * 生产 Worker 会读取后注入 x-user-id / x-user-name 头再转发给 Durable Object。
 */
export async function handleConnection(
  h: RoomHost,
  ws: WebSocket,
  uid: string,
  name: string,
  lastSeq: number,
): Promise<void> {
  // 动态加入（waiting 且未在场且未满）
  const state = await h.storage.loadState();
  if (
    state &&
    !state.players.some((p) => p.id === uid) &&
    state.street === 'waiting' &&
    state.players.length < 6
  ) {
    const joinRes = await h.controller.join(uid, name);
    if (joinRes.kind === 'state') broadcast(h, joinRes.frames);
  }

  const { welcome, stateFrame, chatFrames } = await h.controller.connect(uid, name, lastSeq);
  send(ws, welcome);
  if (stateFrame) send(ws, stateFrame);
  for (const cf of chatFrames) send(ws, cf);

  if (!h.sockets.has(uid)) h.sockets.set(uid, new Set());
  h.sockets.get(uid)!.add(ws);

  ws.on('message', async (data) => {
    let msg: ClientMessage;
    try {
      msg = decodeClient(data.toString());
    } catch {
      send(ws, { t: 'error', code: 'PROTOCOL_VIOLATION', message: 'bad json' } as ServerMessage);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any;
    switch (msg.t) {
      case 'start':
        result = await h.controller.startHand(uid);
        break;
      case 'action':
        result = await h.controller.handleAction(uid, msg.action);
        break;
      case 'chat':
        result = await h.controller.handleChat(uid, msg.text);
        break;
      case 'ping':
        send(ws, { t: 'pong', ts: Date.now() } as ServerMessage);
        return;
      case 'reconnect': {
        const nm = await h.controller.nicknameOf(uid);
        const r = await h.controller.connect(uid, nm, msg.lastSeq);
        send(ws, r.welcome);
        if (r.stateFrame) send(ws, r.stateFrame);
        for (const cf of r.chatFrames) send(ws, cf);
        return;
      }
      default:
        return;
    }
    await applyResult(h, result, ws);
  });

  ws.on('close', () => {
    const set = h.sockets.get(uid);
    if (set) {
      set.delete(ws);
      if (set.size === 0) h.sockets.delete(uid);
    }
  });
}

export { WebSocketServer };
