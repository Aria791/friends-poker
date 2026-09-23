// shared/types.ts
// 前后端共用类型定义。core/ 仅依赖这里的纯数据类型，不依赖任何平台 API。

export type Rank = number; // 2..14 （11=J, 12=Q, 13=K, 14=A）
export type Suit = 's' | 'h' | 'd' | 'c';

export interface Card {
  rank: Rank;
  suit: Suit;
}

export type Street =
  | 'waiting'
  | 'preflop'
  | 'flop'
  | 'turn'
  | 'river'
  | 'showdown'
  | 'complete';

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allIn';

export type PlayerStatus = 'active' | 'folded' | 'allIn' | 'out' | 'disconnected';

export interface Player {
  id: string;
  nickname: string;
  /** 当前剩余筹码（不含已下注金额；已下注见 totalBetThisHand） */
  chips: number;
  /** 仅本人可见；未摊牌时对外一律为空数组 */
  holeCards: Card[];
  status: PlayerStatus;
  /** 本轮已下注（每街重置） */
  betThisRound: number;
  /** 本手累计下注（用于边池切分，绝不浮点） */
  totalBetThisHand: number;
  seat: number;
  isBot?: boolean;
}

export interface Pot {
  amount: number;
  /** 对该池有投入且未弃牌的 playerId 列表 */
  eligible: string[];
}

/**
 * 房间运行时完整状态。DO 持久化此对象（不含玩家手牌泄露风险，因 toView 过滤）。
 * numToAct / raiseCapped 为服务端内部裁决字段。
 */
export interface GameState {
  roomId: string;
  players: Player[];
  /** 未发牌堆，顺序不可外泄，绝不下发客户端 */
  deck: Card[];
  board: Card[];
  street: Street;
  pots: Pot[];
  currentBet: number;
  minRaise: number;
  toAct: number | null;
  button: number;
  smallBlind: number;
  bigBlind: number;
  handNumber: number;
  actionSeq: number;
  version: number;
  /** 本轮还需行动的玩家数（用于判定回合结束） */
  numToAct: number;
  /** 轮次封顶：达到预设加注上限后为真，禁止继续加注。短码全押不置此标志。 */
  raiseCapped: boolean;
  /** 最近一次行动是否为"完整"下注/加注（增量达到最小加注）；短码全押为 false。 */
  isFullRaise: boolean;
  /** 本下注街已发生的完整加注/下注次数（用于达到上限后封顶） */
  fullRaiseCount: number;
  /** 每街最大完整加注次数；未设置（undefined）表示不封顶（标准无限注）。 */
  maxRaisesPerStreet?: number;
}

export interface RoomConfig {
  name: string;
  startingChips: number;
  smallBlind: number;
  bigBlind: number;
  turnTimeoutMs?: number;
  allowLateJoin?: boolean;
  /** 每街最大完整加注次数；设置后达到该次数即 raiseCapped。缺省=不封顶。 */
  maxRaisesPerStreet?: number;
}

/** 客户端行动意图（金额一律整数） */
export interface Action {
  type: ActionType;
  /** bet/raise: 本轮目标总下注额；allIn: 可选，缺省即全部筹码 */
  amount?: number;
}

/** 服务端下发给客户端的"该玩家此刻合法行动" */
export type LegalAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call'; amount: number }
  | { type: 'bet'; min: number; max: number }
  | { type: 'raise'; min: number; max: number }
  | { type: 'allIn'; amount: number };

/** 机器可判定的错误码 */
export type ErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'ROOM_FULL'
  | 'ROOM_NOT_FOUND'
  | 'CODE_EXPIRED'
  | 'NOT_YOUR_TURN'
  | 'AMOUNT_BELOW_CALL'
  | 'BELOW_MIN_RAISE'
  | 'INSUFFICIENT_CHIPS'
  | 'INVALID_STREET'
  | 'NOT_HOST'
  | 'RATE_LIMITED'
  | 'PROTOCOL_VIOLATION';

/** 客户端视图：绝不包含 deck，且不暴露他人 holeCards */
export type ClientView = Omit<GameState, 'deck'> & {
  players: Array<Omit<Player, 'holeCards'> & { holeCards: Card[] }>;
};
