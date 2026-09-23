// core/rules/pots.ts
// 边池切分。按"本手总投入 totalBetThisHand"升序去重切分，
// eligible 只记录对该池有投入且未弃牌者。弃牌者的筹码仍计入池中（死钱），
// 只是没有资格赢。
import { GameState, Pot } from '../../shared/types';

export function computePots(s: GameState, cap: number = Infinity): Pot[] {
  const players = s.players;
  const effOf = (p: (typeof players)[number]) => Math.min(p.totalBetThisHand, cap);
  const levels = Array.from(new Set(players.map(effOf).filter((a) => a > 0))).sort(
    (a, b) => a - b,
  );

  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    const contrib = level - prev;
    const contributors = players.filter((p) => effOf(p) >= level);
    const amount = contrib * contributors.length;
    const eligible = contributors.filter((p) => p.status !== 'folded').map((p) => p.id);
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }
  return pots;
}
