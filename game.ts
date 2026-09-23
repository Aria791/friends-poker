// core/game.ts
// 与平台无关的核心状态机：发牌、行动裁决、边池结算、序列化/重放、客户端视图过滤。
// 这是"服务器权威模型"的纯逻辑部分，所有金额整数，绝不浮点。
import { Action, Card, ClientView, GameState, Player, RoomConfig } from '../shared/types';
import { buildShuffledDeck } from './deck';
import { Rng, createRng } from './rng';
import { evaluate } from './eval/rank';
import { actableCount, getLegalActions, isActable, isLegal } from './rules/betting';
import { computePots } from './rules/pots';
import { postBlinds, seatAfter } from './rules/blinds';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function clone(s: GameState): GameState {
  return structuredClone(s);
}

function participantSeats(s: GameState): number[] {
  return s.players.filter((p) => p.chips > 0).map((p) => p.seat).sort((a, b) => a - b);
}

/** 庄家位轮转：返回 seat 之后的下一个有筹码参与者（循环） */
function nextSeat(s: GameState, seat: number): number {
  const seats = participantSeats(s);
  if (seats.length === 0) return -1;
  for (const x of seats) if (x > seat) return x;
  return seats[0];
}

function actableSeats(s: GameState): number[] {
  return s.players.filter(isActable).map((p) => p.seat).sort((a, b) => a - b);
}

function nextActableSeat(s: GameState, seat: number): number | null {
  const seats = actableSeats(s);
  if (seats.length === 0) return null;
  for (const x of seats) if (x > seat) return x;
  return seats[0];
}

function firstActableAfterButton(s: GameState): number {
  const seats = actableSeats(s);
  for (const x of seats) if (x > s.button) return x;
  return seats[0];
}

function seatOf(s: GameState, id: string): number {
  return s.players.find((p) => p.id === id)!.seat;
}

// ---------------------------------------------------------------------------
// 建桌 / 开局
// ---------------------------------------------------------------------------

export function createTable(
  roomId: string,
  config: RoomConfig,
  members: { id: string; nickname: string; seat?: number }[],
): GameState {
  const players: Player[] = members.map((m, i) => ({
    id: m.id,
    nickname: m.nickname,
    chips: config.startingChips,
    holeCards: [],
    status: 'active',
    betThisRound: 0,
    totalBetThisHand: 0,
    seat: m.seat ?? i,
    isBot: m.id.startsWith('bot-'),
  }));
  return {
    roomId,
    players,
    deck: [],
    board: [],
    street: 'waiting',
    pots: [],
    currentBet: 0,
    minRaise: config.bigBlind,
    toAct: null,
    button: -1,
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    handNumber: 0,
    actionSeq: 0,
    version: 0,
    numToAct: 0,
    raiseCapped: false,
    isFullRaise: false,
    fullRaiseCount: 0,
    ...(config.maxRaisesPerStreet !== undefined
      ? { maxRaisesPerStreet: config.maxRaisesPerStreet }
      : {}),
  };
}

/** 开始新一手（庄家轮转、洗牌、发盲注、发底牌）。返回新状态。
 *  rng 可选，用于测试可复现；生产环境不传，由 crypto 喂入。 */
export function startHand(prev: GameState, rng?: Rng): GameState {
  const s = clone(prev);
  s.handNumber += 1;
  s.version += 1;
  s.actionSeq = 0;

  s.button = nextSeat(s, s.button);

  const participants = s.players.filter((p) => p.chips > 0);
  if (participants.length < 2) {
    s.street = 'complete';
    s.toAct = null;
    s.players.forEach((p) => {
      if (p.chips === 0) p.status = 'out';
    });
    return s;
  }

  for (const p of s.players) {
    if (p.chips > 0) {
      p.status = p.status === 'disconnected' ? 'disconnected' : 'active';
      p.holeCards = [];
      p.betThisRound = 0;
      p.totalBetThisHand = 0;
    } else {
      p.status = 'out';
      p.holeCards = [];
      p.betThisRound = 0;
      p.totalBetThisHand = 0;
    }
  }

  s.deck = buildShuffledDeck(rng ?? createRng());
  s.board = [];
  s.pots = [];

  const blinds = postBlinds(s);
  s.street = 'preflop';

  // 发底牌：按座位轮转，从 SB 开始，每人一张发两轮。
  // 注意：必须用下盲注“之前”的参与者名单，否则恰好用光筹码下盲注的玩家
  // 会被 chips>0 过滤掉，导致 startIdx = -1 而崩溃。
  const parts = participants.slice().sort((a, b) => a.seat - b.seat);
  const startIdx = parts.findIndex((p) => p.seat === blinds.sbSeat);
  for (let round = 0; round < 2; round++) {
    for (let k = 0; k < parts.length; k++) {
      const p = parts[(startIdx + k) % parts.length];
      p.holeCards.push(s.deck.pop()!);
    }
  }

  const actors = s.players.filter(isActable);
  s.numToAct = actors.length;
  s.currentBet = Math.max(0, ...actors.map((p) => p.betThisRound));
  s.minRaise = s.currentBet; // 正常等于 BB；短码盲注则等于实际下注
  s.raiseCapped = false;
  s.isFullRaise = false;
  s.fullRaiseCount = 0;

  let firstSeat: number;
  if (actors.length === 2) {
    // heads-up：BB 先动 = 非 button 的那名活跃玩家
    firstSeat = s.players.find((p) => isActable(p) && p.seat !== s.button)!.seat;
  } else {
    firstSeat = seatAfter(s, blinds.bbSeat); // UTG
  }
  s.toAct = s.players.findIndex((p) => p.seat === firstSeat && isActable(p));
  return s;
}

// ---------------------------------------------------------------------------
// 行动裁决
// ---------------------------------------------------------------------------

function errorFor(action: Action, s: GameState, playerId: string): string {
  const idx = s.players.findIndex((p) => p.id === playerId);
  if (idx < 0) return 'PROTOCOL_VIOLATION';
  if (s.toAct !== idx) return 'NOT_YOUR_TURN';
  const p = s.players[idx];
  const callAmount = s.currentBet - p.betThisRound;
  switch (action.type) {
    case 'call':
      return callAmount <= 0 ? 'PROTOCOL_VIOLATION' : 'INSUFFICIENT_CHIPS';
    case 'bet':
    case 'raise':
      return 'BELOW_MIN_RAISE';
    case 'allIn':
      return 'INSUFFICIENT_CHIPS';
    default:
      return 'PROTOCOL_VIOLATION';
  }
}

export function applyAction(
  prev: GameState,
  action: Action,
  playerId: string,
): GameState | { error: string } {
  const legal = getLegalActions(prev, playerId);
  if (legal.length === 0) return { error: 'NOT_YOUR_TURN' };
  if (!isLegal(legal, action)) return { error: errorFor(action, prev, playerId) };

  const s = clone(prev);
  s.actionSeq += 1;
  s.version += 1;
  s.isFullRaise = false; // 每次行动重置；仅"完整"下注/加注在下方置 true

  const prevCurrentBet = s.currentBet;
  const prevMinRaise = s.minRaise;
  const idx = s.players.findIndex((p) => p.id === playerId);
  const p = s.players[idx];

  let reopened = false;

  switch (action.type) {
    case 'fold':
      p.status = 'folded';
      break;

    case 'check':
      // 仅当 callAmount<=0 时合法（已在 isLegal 校验）
      break;

    case 'call': {
      const need = s.currentBet - p.betThisRound;
      const pay = Math.min(need, p.chips);
      p.chips -= pay;
      p.betThisRound += pay;
      p.totalBetThisHand += pay;
      if (p.chips === 0) p.status = 'allIn';
      break;
    }

    case 'bet': {
      const amt = action.amount!;
      const pay = Math.min(amt - p.betThisRound, p.chips);
      p.chips -= pay;
      p.betThisRound += pay;
      p.totalBetThisHand += pay;
      s.currentBet = p.betThisRound;
      // 首注即"完整"下注：minRaise = 本次下注额（必 >= 大盲）
      s.minRaise = Math.max(s.bigBlind, p.betThisRound);
      s.isFullRaise = true;
      s.fullRaiseCount += 1;
      // 达到预设加注上限（如 3 次 re-raise）→ 封顶，禁止继续加注
      if (s.maxRaisesPerStreet !== undefined && s.fullRaiseCount >= s.maxRaisesPerStreet) {
        s.raiseCapped = true;
      }
      if (p.chips === 0) p.status = 'allIn';
      reopened = true;
      break;
    }

    case 'raise':
    case 'allIn': {
      const isRaise = action.type === 'raise';
      // target：仅接收客户端请求值（raise 的 amount；allIn 时等于"筹码 + 本輪已下注"）。
      // 它不参与任何比较与赋值——所有游戏状态判定一律使用 actual（真实投入）。
      const target = isRaise ? action.amount! : p.chips + p.betThisRound;
      const pay = Math.min(target - p.betThisRound, p.chips); // pay 只是由 target 推导的"应付上限"，仍被钳制到筹码
      const actual = p.betThisRound + pay; // 真实投入（唯一真相），绝不依赖 target 做比较
      p.chips -= pay;
      p.betThisRound = actual;
      p.totalBetThisHand += pay;
      if (p.chips === 0) p.status = 'allIn';

      // 以下判定全部基于 actual（真实投入），与 target 无关：
      const delta = actual - prevCurrentBet;
      const isFull = prevCurrentBet === 0 ? actual >= s.bigBlind : delta >= prevMinRaise;
      s.isFullRaise = isFull;
      if (isFull) {
        // 完整下注/加注：更新 currentBet 与 minRaise，重新开放回合
        s.currentBet = actual;
        s.minRaise = prevCurrentBet === 0 ? Math.max(s.bigBlind, actual) : delta;
        s.fullRaiseCount += 1;
        // 达到预设加注上限（如 3 次 re-raise）→ 封顶，禁止继续加注；
        // 未达上限则保持 raiseCapped=false（完整加注不封顶）。
        if (s.maxRaisesPerStreet !== undefined && s.fullRaiseCount >= s.maxRaisesPerStreet) {
          s.raiseCapped = true;
        }
        reopened = true;
      } else {
        // 短码全押（增量不足最小加注）：本次"不算 raise"——不抬高 currentBet、
        // 不重开回合、且绝对不置 raiseCapped，下一位玩家仍可 re-raise。
        // raiseCapped 保持原值（可能本就是 false，也可能此前已被上限封顶）。
      }
      break;
    }
  }

  // 更新本轮待行动计数
  const nowActable = s.players.filter(isActable).length;
  if (reopened) {
    s.numToAct = nowActable - (isActable(p) ? 1 : 0);
  } else {
    s.numToAct -= 1;
  }

  proceed(s);
  return s;
}

/** 超时：默认弃牌；若已无合法行动（只剩 check）则等同 check。 */
export function timeoutAction(
  prev: GameState,
  playerId: string,
): GameState | { error: string } {
  const legal = getLegalActions(prev, playerId);
  if (legal.some((l) => l.type === 'check')) {
    return applyAction(prev, { type: 'check' }, playerId);
  }
  return applyAction(prev, { type: 'fold' }, playerId);
}

// ---------------------------------------------------------------------------
// 推进 / 结算
// ---------------------------------------------------------------------------

function dealCommunity(s: GameState, count: number): void {
  s.deck.pop(); // burn 一张，不写入任何对外日志
  for (let i = 0; i < count; i++) s.board.push(s.deck.pop()!);
}

/** 仅推进 street 并发对应数量的社区牌；不做任何下注轮设置，也不调用 advanceStreet。 */
function dealCommunityCards(s: GameState): void {
  switch (s.street) {
    case 'preflop':
      s.street = 'flop';
      dealCommunity(s, 3);
      break;
    case 'flop':
      s.street = 'turn';
      dealCommunity(s, 1);
      break;
    case 'turn':
      s.street = 'river';
      dealCommunity(s, 1);
      break;
    case 'river':
      s.street = 'showdown'; // 无更多牌可发，进入摊牌
      break;
  }
}

/** 全员 all-in / 仅剩一人可行动：跳过所有剩余下注轮，直接发完社区牌到摊牌并结算。 */
function runOutBoard(s: GameState): void {
  while (s.street !== 'showdown' && s.street !== 'complete') {
    dealCommunityCards(s);
  }
  if (s.street === 'showdown') settle(s);
}

function startBettingRound(s: GameState): void {
  for (const p of s.players) p.betThisRound = 0;
  s.currentBet = 0;
  s.minRaise = s.bigBlind;
  s.raiseCapped = false;
  s.isFullRaise = false;
  s.fullRaiseCount = 0;

  const actors = s.players.filter(isActable);
  s.numToAct = actors.length;
  if (actors.length <= 1) {
    // 仅剩一名可行动者或全员 all-in：本街无需下注。绝不能在此停住——
    // 必须"跳过下注轮、但继续发社区牌"，直接把剩余街的牌发完并进入摊牌。
    // 注意：此处调 runOutBoard（专发牌），绝不能调 advanceStreet（否则会误入下注轮设置）。
    runOutBoard(s);
    return;
  }
  const firstSeat = firstActableAfterButton(s);
  s.toAct = s.players.findIndex((p) => p.seat === firstSeat && isActable(p));
}

function advanceStreet(s: GameState): void {
  if (s.street === 'preflop') {
    s.street = 'flop';
    dealCommunity(s, 3);
  } else if (s.street === 'flop') {
    s.street = 'turn';
    dealCommunity(s, 1);
  } else if (s.street === 'turn') {
    s.street = 'river';
    dealCommunity(s, 1);
  } else if (s.street === 'river') {
    settle(s);
    return;
  }
  startBettingRound(s);
}

function settle(s: GameState): void {
  s.street = 'showdown';
  s.toAct = null;
  s.numToAct = 0;
  s.version += 1;

  const nonFolded = s.players.filter((p) => p.status !== 'folded' && p.status !== 'out');
  if (nonFolded.length === 0) {
    // 极端情况：全员弃牌，退回全部注码，避免筹码丢失
    for (const p of s.players) p.chips += p.totalBetThisHand;
    s.pots = [];
    s.street = 'complete';
    return;
  }

  // 退回未被跟注的注码（uncalled bet）。关键：maxCalled 必须是"被至少一名其他玩家
  // 跟到的注码水平"，而非非-folded 玩家的最高总投入——否则当某人下注超过所有人能跟
  // 的额度时，其超额部分会被错误地留在池中（多轮 re-raise 尤其容易算错）。
  // 规则：若最高注只有一人下到（topCount===1），则被跟注水平取次高注；否则取最高注。
  const totals = nonFolded.map((p) => p.totalBetThisHand);
  const maxTotal = Math.max(...totals);
  const secondMax = totals.some((t) => t < maxTotal)
    ? Math.max(...totals.filter((t) => t < maxTotal))
    : 0;
  const topCount = totals.filter((t) => t === maxTotal).length;
  const maxCalled = topCount > 1 ? maxTotal : secondMax;

  for (const p of s.players) {
    // 退回超过"被跟注水平"的部分：等价于 totalBetThisHand - min(totalBetThisHand, maxCalled)
    const uncalled = Math.max(0, p.totalBetThisHand - maxCalled);
    if (uncalled > 0) p.chips += uncalled;
  }

  // 用"被跟注"的投入构建边池（cap = maxCalled）。computePots 内部对每个玩家取
  // Math.min(totalBetThisHand, maxCalled)，与上面的退回逻辑同源，多轮 re-raise 也不会算错。
  s.pots = computePots(s, maxCalled);

  for (const pot of s.pots) {
    if (pot.eligible.length === 0) continue;
    let best = -1;
    let winners: string[] = [];
    for (const id of pot.eligible) {
      const p = s.players.find((x) => x.id === id)!;
      const val = evaluate([...p.holeCards, ...s.board]).value;
      if (val > best) {
        best = val;
        winners = [id];
      } else if (val === best) {
        winners.push(id);
      }
    }
    const share = Math.floor(pot.amount / winners.length);
    let rem = pot.amount - share * winners.length;
    // 余币归最先行动的庄家侧玩家（此处取座位号最小者）
    const ordered = winners.slice().sort((a, b) => seatOf(s, a) - seatOf(s, b));
    for (const id of ordered) {
      const p = s.players.find((x) => x.id === id)!;
      let amt = share;
      if (rem > 0) {
        amt += 1;
        rem -= 1;
      }
      p.chips += amt;
    }
  }
  s.street = 'complete';
}

function proceed(s: GameState): void {
  const nonFolded = s.players.filter((p) => p.status !== 'folded' && p.status !== 'out');
  if (nonFolded.length <= 1) {
    settle(s);
    return;
  }
  if (s.numToAct <= 0 || actableCount(s) === 0) {
    advanceStreet(s);
    return;
  }
  const cur = s.players[s.toAct!];
  const next = nextActableSeat(s, cur.seat);
  s.toAct = next === null ? null : s.players.findIndex((p) => p.seat === next);
}

// ---------------------------------------------------------------------------
// 序列化 / 重放 / 视图
// ---------------------------------------------------------------------------

export const serialize = (s: GameState): string => JSON.stringify(s);
export const deserialize = (j: string): GameState => JSON.parse(j);

export function replay(
  initial: GameState,
  log: { playerId: string; action: Action }[],
): GameState {
  let s = clone(initial);
  for (const { playerId, action } of log) {
    const r = applyAction(s, action, playerId);
    if ('error' in r) throw new Error('replay failed: ' + r.error);
    s = r;
  }
  return s;
}

/** 过滤为客户端视图：不含 deck；他人 holeCards 为空数组。
 *  显式列出每个字段（不再用 { ...rest } 隐式覆盖），从结构上杜绝 deck 被意外透传。 */
export function toView(s: GameState, viewerId: string): ClientView {
  return {
    roomId: s.roomId,
    players: s.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      chips: p.chips,
      holeCards: p.id === viewerId ? p.holeCards : [],
      status: p.status,
      betThisRound: p.betThisRound,
      totalBetThisHand: p.totalBetThisHand,
      seat: p.seat,
      isBot: p.isBot,
    })),
    board: s.board,
    street: s.street,
    pots: s.pots,
    currentBet: s.currentBet,
    minRaise: s.minRaise,
    toAct: s.toAct,
    button: s.button,
    smallBlind: s.smallBlind,
    bigBlind: s.bigBlind,
    handNumber: s.handNumber,
    actionSeq: s.actionSeq,
    version: s.version,
    numToAct: s.numToAct,
    raiseCapped: s.raiseCapped,
    isFullRaise: s.isFullRaise,
    fullRaiseCount: s.fullRaiseCount,
    ...(s.maxRaisesPerStreet !== undefined ? { maxRaisesPerStreet: s.maxRaisesPerStreet } : {}),
  } as ClientView;
}
