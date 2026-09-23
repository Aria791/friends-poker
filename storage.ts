// src/room/storage.ts
// 房间持久化层。RoomStorage 抽象接口 + 两种实现：
//  - SqliteRoomStorage：基于 Durable Object 内置 SQLite（生产环境），log 与 snapshot 同事务落盘。
//  - MemoryRoomStorage：纯内存实现，专供单元测试，不依赖任何平台 API。
//
// 关键不变量：每次行动必须"先写 action 日志、再写最新状态快照"，二者在同一事务内完成，
// 保证即使中途崩溃，也能从 hand_initial + actions 经 core.replay 完整重建。

import type { Action, GameState, RoomConfig } from '../../shared/types';

/** Durable Object 内置 SQLite 的最小结构类型（避免直接耦合具体类型声明） */
export interface SqlLike {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): { rows: T[] };
}

export interface ChatRecord {
  fromId: string;
  fromName: string;
  text: string;
  ts: number;
}

export interface RoomStorage {
  initSchema(): Promise<void>;

  // ---- 元数据（kv 风格） ----
  loadConfig(): Promise<RoomConfig | null>;
  saveConfig(c: RoomConfig): Promise<void>;
  loadState(): Promise<GameState | null>;
  saveState(s: GameState): Promise<void>;
  loadHostId(): Promise<string | null>;
  saveHostId(id: string): Promise<void>;
  loadUserIds(): Promise<string[]>;
  saveUserIds(ids: string[]): Promise<void>;
  loadSeq(): Promise<number>;
  saveSeq(seq: number): Promise<void>;

  // ---- 当前手初始化快照 + 行动日志（用于重放/重连） ----
  saveHandInitial(handNumber: number, s: GameState): Promise<void>;
  loadHandInitial(handNumber: number): Promise<GameState | null>;
  appendAction(handNumber: number, playerId: string, action: Action, ts: number): Promise<number>;
  loadActions(handNumber: number): Promise<{ playerId: string; action: Action }[]>;
  /** 删除早于指定手号的行动日志，避免重放时串手 */
  pruneActionsBefore(handNumber: number): Promise<void>;

  // ---- 聊天（仅用于重连补齐，可丢弃） ----
  appendChat(rec: ChatRecord): Promise<void>;
  recentChat(limit?: number): Promise<ChatRecord[]>;

  /** 原子事务包装：所有写操作成对出现时必须走它 */
  transaction<T>(fn: () => T | Promise<T>): Promise<T>;
}

const CHAT_LIMIT = 50;

// ---------------------------------------------------------------------------
// SQLite 实现
// ---------------------------------------------------------------------------

export class SqliteRoomStorage implements RoomStorage {
  constructor(private sql: SqlLike) {}

  async initSchema(): Promise<void> {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS hand_initial (hand_number INTEGER PRIMARY KEY, state_json TEXT);
      CREATE TABLE IF NOT EXISTS actions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        hand_number INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        action_json TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT NOT NULL,
        from_name TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
    `);
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const r = await fn();
      this.sql.exec('COMMIT');
      return r;
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  private kvGet<T>(k: string): T | null {
    const rows = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).rows;
    if (rows.length === 0) return null;
    return JSON.parse(rows[0].v) as T;
  }

  private kvSet(k: string, v: unknown): void {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = ?', k, JSON.stringify(v), JSON.stringify(v));
  }

  async loadConfig(): Promise<RoomConfig | null> {
    return this.kvGet<RoomConfig>('config');
  }
  async saveConfig(c: RoomConfig): Promise<void> {
    this.kvSet('config', c);
  }
  async loadState(): Promise<GameState | null> {
    const s = this.kvGet<GameState>('state');
    return s;
  }
  async saveState(s: GameState): Promise<void> {
    this.kvSet('state', s);
  }
  async loadHostId(): Promise<string | null> {
    return this.kvGet<string>('hostId');
  }
  async saveHostId(id: string): Promise<void> {
    this.kvSet('hostId', id);
  }
  async loadUserIds(): Promise<string[]> {
    return this.kvGet<string[]>('userIds') ?? [];
  }
  async saveUserIds(ids: string[]): Promise<void> {
    this.kvSet('userIds', ids);
  }
  async loadSeq(): Promise<number> {
    return this.kvGet<number>('seq') ?? 0;
  }
  async saveSeq(seq: number): Promise<void> {
    this.kvSet('seq', seq);
  }

  async saveHandInitial(handNumber: number, s: GameState): Promise<void> {
    this.sql.exec(
      'INSERT INTO hand_initial (hand_number, state_json) VALUES (?, ?) ON CONFLICT(hand_number) DO UPDATE SET state_json = ?',
      handNumber,
      JSON.stringify(s),
      JSON.stringify(s),
    );
  }
  async loadHandInitial(handNumber: number): Promise<GameState | null> {
    const rows = this.sql.exec<{ state_json: string }>(
      'SELECT state_json FROM hand_initial WHERE hand_number = ?',
      handNumber,
    ).rows;
    if (rows.length === 0) return null;
    return JSON.parse(rows[0].state_json) as GameState;
  }

  async appendAction(handNumber: number, playerId: string, action: Action, ts: number): Promise<number> {
    this.sql.exec(
      'INSERT INTO actions (hand_number, player_id, action_json, ts) VALUES (?, ?, ?, ?)',
      handNumber,
      playerId,
      JSON.stringify(action),
      ts,
    );
    const r = this.sql.exec<{ id: number }>('SELECT last_insert_rowid() AS id').rows;
    return r[0].id;
  }
  async loadActions(handNumber: number): Promise<{ playerId: string; action: Action }[]> {
    const rows = this.sql.exec<{ player_id: string; action_json: string }>(
      'SELECT player_id, action_json FROM actions WHERE hand_number = ? ORDER BY seq ASC',
      handNumber,
    ).rows;
    return rows.map((r) => ({ playerId: r.player_id, action: JSON.parse(r.action_json) as Action }));
  }
  async pruneActionsBefore(handNumber: number): Promise<void> {
    this.sql.exec('DELETE FROM actions WHERE hand_number < ?', handNumber);
  }

  async appendChat(rec: ChatRecord): Promise<void> {
    this.sql.exec(
      'INSERT INTO chat (from_id, from_name, text, ts) VALUES (?, ?, ?, ?)',
      rec.fromId,
      rec.fromName,
      rec.text,
      rec.ts,
    );
    // 控制聊天表体积：仅保留最近 CHAT_LIMIT 条
    this.sql.exec('DELETE FROM chat WHERE id <= (SELECT MAX(id) - ? FROM chat)', CHAT_LIMIT);
  }
  async recentChat(limit = CHAT_LIMIT): Promise<ChatRecord[]> {
    const rows = this.sql.exec<ChatRecord>(
      'SELECT from_id, from_name, text, ts FROM chat ORDER BY id DESC LIMIT ?',
      limit,
    ).rows;
    return rows.reverse();
  }
}

// ---------------------------------------------------------------------------
// 内存实现（测试用）
// ---------------------------------------------------------------------------

export class MemoryRoomStorage implements RoomStorage {
  private kv = new Map<string, unknown>();
  private handInitial = new Map<number, GameState>();
  private actions: { handNumber: number; playerId: string; action: Action; ts: number; seq: number }[] = [];
  private chat: ChatRecord[] = [];
  private seqCounter = 0;

  async initSchema(): Promise<void> {
    /* no-op */
  }
  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    return fn();
  }

  private get<T>(k: string): T | null {
    return (this.kv.get(k) as T) ?? null;
  }
  private set(k: string, v: unknown): void {
    this.kv.set(k, v);
  }

  async loadConfig(): Promise<RoomConfig | null> {
    return this.get('config');
  }
  async saveConfig(c: RoomConfig): Promise<void> {
    this.set('config', c);
  }
  async loadState(): Promise<GameState | null> {
    return this.get('state');
  }
  async saveState(s: GameState): Promise<void> {
    this.set('state', s);
  }
  async loadHostId(): Promise<string | null> {
    return this.get('hostId');
  }
  async saveHostId(id: string): Promise<void> {
    this.set('hostId', id);
  }
  async loadUserIds(): Promise<string[]> {
    return this.get<string[]>('userIds') ?? [];
  }
  async saveUserIds(ids: string[]): Promise<void> {
    this.set('userIds', ids);
  }
  async loadSeq(): Promise<number> {
    return this.get<number>('seq') ?? 0;
  }
  async saveSeq(seq: number): Promise<void> {
    this.set('seq', seq);
  }

  async saveHandInitial(handNumber: number, s: GameState): Promise<void> {
    this.handInitial.set(handNumber, s);
  }
  async loadHandInitial(handNumber: number): Promise<GameState | null> {
    return this.handInitial.get(handNumber) ?? null;
  }
  async appendAction(handNumber: number, playerId: string, action: Action, ts: number): Promise<number> {
    const seq = ++this.seqCounter;
    this.actions.push({ handNumber, playerId, action, ts, seq });
    return seq;
  }
  async loadActions(handNumber: number): Promise<{ playerId: string; action: Action }[]> {
    return this.actions
      .filter((a) => a.handNumber === handNumber)
      .map((a) => ({ playerId: a.playerId, action: a.action }));
  }
  async pruneActionsBefore(handNumber: number): Promise<void> {
    this.actions = this.actions.filter((a) => a.handNumber >= handNumber);
  }

  async appendChat(rec: ChatRecord): Promise<void> {
    this.chat.push(rec);
    if (this.chat.length > CHAT_LIMIT) this.chat.splice(0, this.chat.length - CHAT_LIMIT);
  }
  async recentChat(limit = CHAT_LIMIT): Promise<ChatRecord[]> {
    return this.chat.slice(-limit);
  }
}
