import { apiUrl } from '../config';

export interface RoomSummary {
  roomId: string;
  name: string;
  players: number;
  maxPlayers: number;
}

export interface CreateRoomInput {
  name: string;
  startingChips: number;
  smallBlind: number;
  bigBlind: number;
  maxRaisesPerStreet?: number;
  hostId: string;
  hostName: string;
}

/** 列出当前可加入的房间（本地网关内存注册表；生产由 Worker + D1 提供） */
export async function listRooms(): Promise<RoomSummary[]> {
  try {
    const r = await fetch(apiUrl('/api/rooms'));
    if (!r.ok) return [];
    const j = (await r.json()) as { rooms?: RoomSummary[] };
    return j.rooms ?? [];
  } catch {
    return [];
  }
}

/** 创建房间：服务端生成 6 位房间码并返回；房主即创建者 uid */
export async function createRoom(input: CreateRoomInput): Promise<{ roomId: string }> {
  const r = await fetch(apiUrl('/api/rooms'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error('创建房间失败');
  return (await r.json()) as { roomId: string };
}
