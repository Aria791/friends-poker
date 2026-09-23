// src/room/room.do.ts
// Durable Object 适配层：把 RoomController（纯逻辑编排）接到 Cloudflare 运行时。
// 职责仅限"管道"：WebSocket 生命周期、按用户分发过滤视图、用 setAlarm 实现回合超时。
// 所有规则裁决都在 core/ 与 RoomController，本文件不含任何牌局逻辑。
//
// 线程模型：DO 单实例串行处理；用 runExclusive 把来自多个 socket 的消息与 alarm
// 串成一条链，杜绝并发改写 GameState 的竞态。
/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers';
import type { RoomConfig } from '../../shared/types';
import { decodeClient, encode, type ClientMessage, type ServerMessage } from '../../shared/protocol';
import { RoomController, type DispatchResult } from './controller';
import { SqliteRoomStorage, type SqlLike } from './storage';

interface InitBody {
  config: RoomConfig;
  members: { id: string; nickname: string; seat?: number }[];
  hostId: string;
}

export class RoomDurableObject extends DurableObject<Record<string, unknown>> {
  private readonly controller: RoomController;
  private readonly storage: SqliteRoomStorage;
  /** 串行化所有状态改写操作，避免多 socket / alarm 并发竞态 */
  private chain: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    const sql = (this.ctx.storage as unknown as { sql: SqlLike }).sql;
    this.storage = new SqliteRoomStorage(sql);
    const roomId = this.ctx.id.toString();
    this.controller = new RoomController(roomId, this.storage, {});
  }

  // -------------------------------------------------------------------------
  // HTTP 入口
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    await this.storage.initSchema();

    // 创建房间：worker 在分配好好友名单后调用一次
    if (request.method === 'POST' && url.pathname === '/init') {
      const body = (await request.json()) as InitBody;
      const result = await this.runExclusive(() =>
        this.controller.init(body.config, body.members, body.hostId),
      );
      if (result.kind === 'error') {
        return new Response(JSON.stringify({ ok: false, code: result.code }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      await this.applyState(result);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // WebSocket 升级：worker 已在校验会话后注入 x-user-id / x-user-name 头
    if (url.pathname.endsWith('/ws')) {
      const userId = request.headers.get('x-user-id');
      const nickname = request.headers.get('x-user-name') ?? '玩家';
      if (!userId) return new Response('missing x-user-id', { status: 400 });

      // 动态加入：若在等待且未满，把该连接者加入牌桌（其余情况忽略，以旁观身份连接）
      const joinRes = await this.controller.join(userId, nickname);
      if (joinRes.kind === 'state') {
        for (const [uid, frame] of joinRes.frames) this.sendToUser(uid, frame);
        await this.rescheduleAlarm(joinRes.alarmAt);
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.serializeAttachment(userId);
      this.ctx.acceptWebSocket(server, [userId, this.ctx.id.toString()]);

      const { welcome, stateFrame, chatFrames } = await this.controller.connect(userId, nickname, 0);
      this.safeSend(server, welcome);
      if (stateFrame) this.safeSend(server, stateFrame);
      for (const cf of chatFrames) this.safeSend(server, cf);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  // -------------------------------------------------------------------------
  // 休眠 WebSocket 生命周期
  // -------------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const userId = ws.deserializeAttachment() as string | undefined;
    if (!userId) return;

    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let msg: ClientMessage;
    try {
      msg = decodeClient(text);
    } catch {
      this.safeSend(ws, { t: 'error', code: 'PROTOCOL_VIOLATION', message: 'bad json' } as ServerMessage);
      return;
    }
    await this.runExclusive(() => this.dispatch(userId, msg, ws));
  }

  async webSocketClose(_ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // 房间状态与闹钟计时保持不变：断线玩家仍以 disconnected 身份参与（可被超时裁决），
    // 不主动销毁 DO（状态已持久化，全员离线亦可恢复）。
    void code;
    void reason;
    void wasClean;
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    /* 错误由 close 兜底，此处留空 */
  }

  // -------------------------------------------------------------------------
  // 闹钟：回合超时
  // -------------------------------------------------------------------------

  async alarm(): Promise<void> {
    const result = await this.runExclusive(() => this.controller.handleTimeout());
    if (result.kind === 'state') {
      for (const [uid, frame] of result.frames) this.sendToUser(uid, frame);
      await this.rescheduleAlarm(result.alarmAt);
    }
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async dispatch(userId: string, msg: ClientMessage, ws: WebSocket): Promise<void> {
    let result: DispatchResult;
    switch (msg.t) {
      case 'start':
        result = await this.controller.startHand(userId);
        break;
      case 'action':
        result = await this.controller.handleAction(userId, msg.action);
        break;
      case 'chat':
        result = await this.controller.handleChat(userId, msg.text);
        break;
      case 'reconnect': {
        const name = await this.controller.nicknameOf(userId);
        const { welcome, stateFrame, chatFrames } = await this.controller.connect(
          userId,
          name,
          msg.lastSeq,
        );
        this.safeSend(ws, welcome);
        if (stateFrame) this.safeSend(ws, stateFrame);
        for (const cf of chatFrames) this.safeSend(ws, cf);
        return;
      }
      case 'ping':
        this.safeSend(ws, { t: 'pong', ts: Date.now() } as ServerMessage);
        return;
      default:
        return;
    }
    await this.applyResult(result, ws);
  }

  private async applyResult(result: DispatchResult, ws: WebSocket): Promise<void> {
    if (result.kind === 'state') {
      for (const [uid, frame] of result.frames) this.sendToUser(uid, frame);
      await this.rescheduleAlarm(result.alarmAt);
    } else if (result.kind === 'chat') {
      this.broadcast(result.frame);
    } else if (result.kind === 'error') {
      this.safeSend(ws, { t: 'error', code: result.code, message: result.message } as ServerMessage);
    }
  }

  /** 把状态结果应用到已连接的 socket 集合（与 dispatch 共享，但无 ws 上下文） */
  private async applyState(result: DispatchResult): Promise<void> {
    await this.applyResult(result, null as unknown as WebSocket);
  }

  private async rescheduleAlarm(alarmAt: number | null): Promise<void> {
    if (alarmAt === null) {
      const existing = await this.ctx.storage.getAlarm();
      if (existing !== null) await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(alarmAt);
    }
  }

  private sendToUser(userId: string, frame: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets(userId)) this.safeSend(ws, frame);
  }

  private broadcast(frame: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) this.safeSend(ws, frame);
  }

  private safeSend(ws: WebSocket, frame: ServerMessage): void {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(encode(frame));
    } catch {
      /* socket 可能已关闭，忽略 */
    }
  }

  /** 把所有异步状态改写串成一条链，保证串行执行 */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
