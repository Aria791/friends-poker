// 客户端类型定义 —— 单一事实来源，直接从 shared/ 协议层再导出，避免与 protocol.ts 漂移。
// 安全红线：这里绝不包含任何 holeCards 推导逻辑；客户端只消费服务端下发的 ClientView。
export type {
  Rank,
  Suit,
  Card,
  Street,
  ActionType,
  PlayerStatus,
  Player,
  Pot,
  GameState,
  RoomConfig,
  Action,
  LegalAction,
  ErrorCode,
  ClientView,
} from '../../shared/types';

export type {
  ClientMessage,
  ServerMessage,
  WelcomeFrame,
  StateFrame,
  ChatFrame,
  ErrorFrame,
  PongFrame,
} from '../../shared/protocol';
