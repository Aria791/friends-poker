// core/rules/betting.ts
// 下注轮白名单校验 + 合法行动枚举。DO 是单线程串行执行，天然无竞态，
// 但每条行动仍必须走 getLegalActions 白名单，拒绝任何"魔法金额"。
import { Action, GameState, LegalAction, Player } from '../../shared/types';

export function isActable(p: Player): boolean {
  return p.status === 'active' || p.status === 'disconnected';
}

export function actableCount(s: GameState): number {
  return s.players.filter(isActable).length;
}

/** 当前玩家此刻的合法行动集合（空数组 = 不是他的回合 / 无资格） */
export function getLegalActions(s: GameState, playerId: string): LegalAction[] {
  const idx = s.players.findIndex((p) => p.id === playerId);
  if (idx < 0 || s.toAct !== idx) return [];
  const p = s.players[idx];
  if (!isActable(p)) return [];

  const actions: LegalAction[] = [];
  const callAmount = s.currentBet - p.betThisRound;
  const maxCommit = p.chips + p.betThisRound; // 若全押，本轮目标总下注
  const onlyOneActor = actableCount(s) <= 1;

  // 永远可以弃牌（即使 check 免费，弃牌也合法，只是没意义）
  actions.push({ type: 'fold' });

  if (callAmount <= 0) {
    actions.push({ type: 'check' });
  } else if (p.chips > 0) {
    actions.push({ type: 'call', amount: Math.min(callAmount, p.chips) });
  }

  // 加注/下注：未封顶、且不止一名可行动者、且有筹码
  if (!s.raiseCapped && !onlyOneActor && p.chips > 0) {
    if (s.currentBet === 0) {
      const minBet = s.bigBlind;
      if (maxCommit >= minBet) actions.push({ type: 'bet', min: minBet, max: maxCommit });
    } else {
      const minRaiseTo = s.currentBet + s.minRaise;
      if (maxCommit >= minRaiseTo) actions.push({ type: 'raise', min: minRaiseTo, max: maxCommit });
    }
  }

  if (p.chips > 0) actions.push({ type: 'allIn', amount: maxCommit });
  return actions;
}

export function isLegal(legal: LegalAction[], action: Action): boolean {
  switch (action.type) {
    case 'fold':
      return legal.some((l) => l.type === 'fold');
    case 'check':
      return legal.some((l) => l.type === 'check');
    case 'call':
      return legal.some((l) => l.type === 'call');
    case 'allIn':
      return legal.some((l) => l.type === 'allIn');
    case 'bet': {
      const l = legal.find((x) => x.type === 'bet') as { min: number; max: number } | undefined;
      if (!l) return false;
      const amt = action.amount!;
      // 仅强制整数 + 不低于最小下注；超过 maxCommit（玩家全部筹码）的请求，
      // 在 applyAction 内被钳制为全押，绝不允许多押，也绝不拒绝（否则短码加注会被误杀）。
      return Number.isInteger(amt) && amt >= l.min;
    }
    case 'raise': {
      const l = legal.find((x) => x.type === 'raise') as { min: number; max: number } | undefined;
      if (!l) return false;
      const amt = action.amount!;
      // 同上：只校验整数 + 不低于最小加注；超过筹码的加注额被 applyAction 钳制为实际投入。
      return Number.isInteger(amt) && amt >= l.min;
    }
  }
  return false;
}
