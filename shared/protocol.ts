// shared/protocol.ts
// 房间 WebSocket 帧协议。客户端→服务端(client)、服务端→客户端(server) 双向约定。
// 所有金额相关字段均为整数；手牌(holeCards)与牌堆(deck)绝不经由此协议下发（toView 过滤）。

import type { Action, ClientView, ErrorCode, LegalAction, RoomConfig } from './types';

// ---------------------------------------------------------------------------
// 客户端 → 服务端
// ---------------------------------------------------------------------------

/** 客户端行动意图（仅 host 可发 start；其余任意参与者可发 action / chat） */
export type ClientMessage =
  | { t: 'start' } // 房主开始新一手（仅 waiting / complete 状态合法）
  | { t: 'action'; action: Action } // 一次下注/跟注/加注/过牌/弃牌/全押
  | { t: 'chat'; text: string } // 聊天（纯文本，服务端限长）
  | { t: 'reconnect'; lastSeq: number } // 断线重连：请求按 lastSeq 补齐
  | { t: 'ping' }; // 心跳保活

// ---------------------------------------------------------------------------
// 服务端 → 客户端
// ---------------------------------------------------------------------------

/** 连接成功后的欢迎帧：携带本人身份、房间配置、房主与当前广播序号 */
export interface WelcomeFrame {
  t: 'welcome';
  you: { id: string; nickname: string };
  roomId: string;
  config: RoomConfig | null;
  hostId: string | null;
  seq: number;
}

/** 牌局状态帧：view 已按接收者过滤；legal 仅对该玩家此刻有效（非行动者恒为空数组） */
export interface StateFrame {
  t: 'state';
  seq: number; // 单调递增广播序号，用于断线重连的 lastSeq 比对
  view: ClientView;
  legal: LegalAction[];
}

/** 聊天帧：全体广播，内容一致 */
export interface ChatFrame {
  t: 'chat';
  fromId: string;
  fromName: string;
  text: string;
  ts: number;
}

/** 错误帧：仅发给触发者 */
export interface ErrorFrame {
  t: 'error';
  code: ErrorCode;
  message?: string;
}

export interface PongFrame {
  t: 'pong';
  ts: number;
}

export type ServerMessage = WelcomeFrame | StateFrame | ChatFrame | ErrorFrame | PongFrame;

// 字符串化辅助：协议走 JSON over WebSocket（文本帧）
export const encode = (m: ServerMessage | ClientMessage): string => JSON.stringify(m);
export const decodeClient = (raw: string): ClientMessage => JSON.parse(raw) as ClientMessage;
