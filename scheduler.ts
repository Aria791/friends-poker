// src/room/scheduler.ts
// 回合超时调度辅助。服务端权威模型下，"轮到谁、何时超时"完全由状态推导，
// 不依赖任何客户端时钟。使用 Durable Object 的 setAlarm（而非 setTimeout），
// 这样即使 DO 进入休眠也能在到点时被唤醒（hibernation 友好）。

import type { GameState } from '../../shared/types';

const BETTING_STREETS: GameState['street'][] = ['preflop', 'flop', 'turn', 'river'];

/**
 * 计算下一次应触发的闹钟时间（epoch ms）。
 * 仅当处于下注街且确有玩家待行动时返回具体时间；否则返回 null（清除闹钟）。
 */
export function nextAlarmAt(state: GameState, turnTimeoutMs: number, now: number): number | null {
  if (!BETTING_STREETS.includes(state.street)) return null;
  if (state.toAct === null) return null;
  return now + turnTimeoutMs;
}
