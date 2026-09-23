// src/room/controller.ts
// 房间编排层（与平台无关，可单测）。职责：
//  1. 持有一个 GameState（由 core 引擎保证权威性）；
//  2. 每条行动先经 getLegalActions 白名单校验，再原子落库（log + snapshot 同事务）；
//  3. 按接收者过滤出 ClientView（toView），生成 per-user 状态帧；
//  4. 断线重连：以 hand_initial + actions 经 core.replay 重建，保证与线上一致；
//  5. 计算下次回合超时闹钟时间，交给 DO 用 setAlarm 落地。
//
// 本类不直接碰 WebSocket / SQLite / Alarm，只依赖注入的 RoomStorage 与时钟，
// 因此可用 MemoryRoomStorage 在 Node 下完整单测。

import type { Action, ErrorCode, GameState, Player, RoomConfig } from '../../shared/types';
import { applyAction, createTable, replay, startHand, toView } from '../../core/game';
import { getLegalActions } from '../../core/rules/betting';
import { createRng, type Rng } from '../../core/rng';
import type { ChatFrame, StateFrame, WelcomeFrame } from '../../shared/protocol';
import type { RoomStorage } from './storage';
import { nextAlarmAt } from './scheduler';

export interface ControllerOptions {
  turnTimeoutMs?: number;
  now?: () => number;
  /** 注入随机源（测试可复现）；生产默认 crypto */
  rng?: () => Rng;
}

/** 一次调度结果：state=需按用户分发的状态帧；chat=全体广播；error=仅回复发起者；noop=无操作 */
export type DispatchResult =
  | { kind: 'state'; frames: Map<string, StateFrame>; alarmAt: number | null }
  | { kind: 'chat'; frame: ChatFrame }
  | { kind: 'error'; code: ErrorCode; message?: string }
  | { kind: 'noop' };

export interface ConnectResult {
  welcome: WelcomeFrame;
  stateFrame: StateFrame | null;
  chatFrames: ChatFrame[];
}

const DEFAULT_TURN_TIMEOUT_MS = 30_000;
const CHAT_MAX_LEN = 500;

export class RoomController {
  private readonly turnTimeoutMs: number;
  private readonly now: () => number;
  private readonly rng: () => Rng;

  constructor(
    private readonly roomId: string,
    private readonly storage: RoomStorage,
    options: ControllerOptions = {},
  ) {
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.rng = options.rng ?? (() => createRng());
  }

  // -------------------------------------------------------------------------
  // 初始化（由 worker 在创建房间后调用一次）
  // -------------------------------------------------------------------------

  async init(
    config: RoomConfig,
    members: { id: string; nickname: string; seat?: number }[],
    hostId: string,
  ): Promise<DispatchResult> {
    const existing = await this.storage.loadState();
    if (existing) return { kind: 'noop' };

    const state = createTable(this.roomId, config, members);
    await this.storage.transaction(async () => {
      await this.storage.saveConfig(config);
      await this.storage.saveState(state);
      await this.storage.saveHostId(hostId);
      await this.storage.saveUserIds(members.map((m) => m.id));
      await this.storage.saveSeq(0);
    });
    // 通知已连接的客户端（通常此时无人，但保持语义完整）
    return this.broadcast(state);
  }

  // -------------------------------------------------------------------------
  // 连接 / 重连
  // -------------------------------------------------------------------------

  async connect(userId: string, nickname: string, lastSeq: number): Promise<ConnectResult> {
    const userIds = await this.storage.loadUserIds();
    if (!userIds.includes(userId)) {
      userIds.push(userId);
      await this.storage.saveUserIds(userIds);
    }

    const state = await this.storage.loadState();
    const config = await this.storage.loadConfig();
    const hostId = await this.storage.loadHostId();
    const seq = await this.storage.loadSeq();

    const welcome: WelcomeFrame = {
      t: 'welcome',
      you: { id: userId, nickname },
      roomId: this.roomId,
      config,
      hostId,
      seq,
    };

    // 重连：若客户端落后于最新广播（lastSeq < seq），从 action_log 经 replay 重建，
    // 保证断线期间发生的行动被完整补齐，且与权威状态一致。
    let stateFrame: StateFrame | null = null;
    if (state) {
      const base = lastSeq < seq ? ((await this.rebuild()) ?? state) : state;
      stateFrame = { t: 'state', seq, view: toView(base, userId), legal: getLegalActions(base, userId) };
    }

    const chatFrames: ChatFrame[] = (await this.storage.recentChat()).map(
      (c) => ({ t: 'chat', fromId: c.fromId, fromName: c.fromName, text: c.text, ts: c.ts }) as ChatFrame,
    );

    return { welcome, stateFrame, chatFrames };
  }

  /** 从 hand_initial + actions 经 core.replay 重建当前权威状态（重连/恢复用） */
  private async rebuild(): Promise<GameState | null> {
    const state = await this.storage.loadState();
    if (!state) return null;
    const initial = await this.storage.loadHandInitial(state.handNumber);
    if (!initial) return state;
    const log = await this.storage.loadActions(state.handNumber);
    return replay(initial, log);
  }

  /** 取玩家展示名（重连 welcome 用） */
  async nicknameOf(userId: string): Promise<string> {
    const state = await this.storage.loadState();
    const pl = state?.players.find((p) => p.id === userId);
    return pl?.nickname ?? '玩家';
  }

  /**
   * 动态加入：仅在 waiting（未开局）且人数未满时，把新玩家加入牌桌并分配最小空位座位。
   * 这样朋友可凭房间码随时进来，无需在创建时预置名单。
   */
  async join(userId: string, nickname: string): Promise<DispatchResult> {
    const state = await this.storage.loadState();
    if (!state) return this.err('ROOM_NOT_FOUND');
    if (state.players.some((p) => p.id === userId)) return { kind: 'noop' };
    if (state.street !== 'waiting') return this.err('INVALID_STREET');
    if (state.players.length >= 6) return this.err('ROOM_FULL');

    const used = new Set(state.players.map((p) => p.seat));
    let seat = 0;
    while (used.has(seat)) seat++;
    const config = await this.storage.loadConfig();
    const startChips = config?.startingChips ?? 1000;
    const player: Player = {
      id: userId,
      nickname,
      chips: startChips,
      holeCards: [],
      status: 'active',
      betThisRound: 0,
      totalBetThisHand: 0,
      seat,
      isBot: userId.startsWith('bot-'),
    };
    state.players.push(player);
    await this.storage.transaction(async () => {
      await this.storage.saveState(state);
      const ids = await this.storage.loadUserIds();
      if (!ids.includes(userId)) ids.push(userId);
      await this.storage.saveUserIds(ids);
    });
    return this.broadcast(state);
  }

  // -------------------------------------------------------------------------
  // 行动类消息
  // -------------------------------------------------------------------------

  async startHand(hostId: string): Promise<DispatchResult> {
    const state = await this.storage.loadState();
    if (!state) return this.err('ROOM_NOT_FOUND');
    if (hostId !== (await this.storage.loadHostId())) return this.err('NOT_HOST');
    if (state.street !== 'waiting' && state.street !== 'complete') return this.err('INVALID_STREET');

    const newState = startHand(state, this.rng());
    await this.storage.transaction(async () => {
      await this.storage.saveState(newState);
      await this.storage.saveHandInitial(newState.handNumber, newState);
      // 旧手日志不再参与重放，清理之
      await this.storage.pruneActionsBefore(newState.handNumber);
    });
    return this.broadcast(newState);
  }

  async handleAction(userId: string, action: Action): Promise<DispatchResult> {
    const state = await this.storage.loadState();
    if (!state) return this.err('ROOM_NOT_FOUND');
    if (state.street === 'waiting' || state.street === 'complete') return this.err('INVALID_STREET');

    const legal = getLegalActions(state, userId);
    if (legal.length === 0) return this.err('NOT_YOUR_TURN');
    const res = applyAction(state, action, userId);
    if ('error' in res) return this.err(res.error as ErrorCode);

    const newState = res;
    await this.storage.transaction(async () => {
      await this.storage.saveState(newState);
      await this.storage.appendAction(newState.handNumber, userId, action, this.now());
    });
    return this.broadcast(newState);
  }

  /** 闹钟触发：当前待行动者超时 → 有 check 选项则过牌，否则弃牌 */
  async handleTimeout(): Promise<DispatchResult> {
    const state = await this.storage.loadState();
    if (!state) return { kind: 'noop' };
    if (state.toAct === null) return { kind: 'noop' };
    const p = state.players[state.toAct];
    if (!p) return { kind: 'noop' };

    const legal = getLegalActions(state, p.id);
    const action: Action = legal.some((l) => l.type === 'check') ? { type: 'check' } : { type: 'fold' };
    const res = applyAction(state, action, p.id);
    if ('error' in res) return { kind: 'noop' };

    const newState = res;
    await this.storage.transaction(async () => {
      await this.storage.saveState(newState);
      await this.storage.appendAction(newState.handNumber, p.id, action, this.now());
    });
    return this.broadcast(newState);
  }

  async handleChat(userId: string, text: string): Promise<DispatchResult> {
    const trimmed = (text ?? '').toString().slice(0, CHAT_MAX_LEN).trim();
    if (!trimmed) return { kind: 'noop' };

    const state = await this.storage.loadState();
    let name = '匿名';
    if (state) {
      const pl = state.players.find((p) => p.id === userId);
      if (pl) name = pl.nickname;
    }
    const ts = this.now();
    const rec = { fromId: userId, fromName: name, text: trimmed, ts };
    await this.storage.appendChat(rec);
    return { kind: 'chat', frame: { t: 'chat', ...rec } };
  }

  // -------------------------------------------------------------------------
  // 内部工具
  // -------------------------------------------------------------------------

  private err(code: ErrorCode, message?: string): DispatchResult {
    return { kind: 'error', code, message };
  }

  /** 持久化广播序号并生成 per-user 状态帧（含合法行动） */
  private async broadcast(state: GameState): Promise<DispatchResult> {
    const seq = await this.bumpSeq();
    const frames = await this.stateFrames(state, seq);
    return { kind: 'state', frames, alarmAt: nextAlarmAt(state, this.turnTimeoutMs, this.now()) };
  }

  private async stateFrames(state: GameState, seq: number): Promise<Map<string, StateFrame>> {
    const userIds = await this.storage.loadUserIds();
    const frames = new Map<string, StateFrame>();
    for (const uid of userIds) {
      frames.set(uid, {
        t: 'state',
        seq,
        view: toView(state, uid),
        legal: getLegalActions(state, uid),
      });
    }
    return frames;
  }

  private async bumpSeq(): Promise<number> {
    const seq = (await this.storage.loadSeq()) + 1;
    await this.storage.saveSeq(seq);
    return seq;
  }
}
