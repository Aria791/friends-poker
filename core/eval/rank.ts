// core/eval/rank.ts
// 七选五最优牌型评估。纯整数运算，禁止浮点。
// 牌型等级基值（与开发指南一致）：
import { Card } from '../../shared/types';

export type HandCategory =
  | 'highCard'
  | 'onePair'
  | 'twoPair'
  | 'threeOfAKind'
  | 'straight'
  | 'flush'
  | 'fullHouse'
  | 'fourOfAKind'
  | 'straightFlush';

export const CATEGORY_BASE: Record<HandCategory, number> = {
  highCard: 1_000_000_000,
  onePair: 2_000_000_000,
  twoPair: 3_000_000_000,
  threeOfAKind: 4_000_000_000,
  straight: 5_000_000_000,
  flush: 6_000_000_000,
  fullHouse: 7_000_000_000,
  fourOfAKind: 8_000_000_000,
  straightFlush: 9_000_000_000,
};

export interface EvalResult {
  value: number;
  category: HandCategory;
  tiebreak: number[];
}

/** 把若干牌点压成一个 < 15^5 的整数，作为基值后的平局比较位 */
function encodeTiebreak(tb: number[]): number {
  let v = 0;
  for (const r of tb) v = v * 15 + r;
  return v;
}

/** 返回顺子的最大牌点；A-2-3-4-5 返回 5；K-A-2-3-4 不是顺子（返回 null） */
export function findStraightHigh(present: Set<number>): number | null {
  const has = (r: number) => present.has(r);
  // 轮顺（A 作 1）：A-2-3-4-5
  if (has(14) && has(2) && has(3) && has(4) && has(5)) return 5;
  for (let high = 14; high >= 5; high--) {
    let ok = true;
    for (let k = 0; k < 5; k++) {
      if (!has(high - k)) {
        ok = false;
        break;
      }
    }
    if (ok) return high;
  }
  return null;
}

function topKickers(rankCount: Map<number, number>, exclude: number[], n: number): number[] {
  return [...rankCount.keys()]
    .filter((r) => !exclude.includes(r))
    .sort((a, b) => b - a)
    .slice(0, n);
}

/**
 * 评估 5~7 张牌，返回最优 5 张的等级。
 * value 可直接数值比较：同牌型比平局位，跨牌型因基值不同而分开。
 */
export function evaluate(cards: Card[]): EvalResult {
  const suits: Record<string, number> = { s: 0, h: 0, d: 0, c: 0 };
  const rankCount = new Map<number, number>();
  for (const c of cards) {
    suits[c.suit]++;
    rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);
  }
  const isFlush = Object.values(suits).some((s) => s >= 5);
  const present = new Set(cards.map((c) => c.rank));
  const straightHigh = findStraightHigh(present);

  const make = (category: HandCategory, tb: number[]): EvalResult => ({
    value: CATEGORY_BASE[category] + encodeTiebreak(tb),
    category,
    tiebreak: tb,
  });

  if (isFlush && straightHigh !== null) return make('straightFlush', [straightHigh]);

  const counts = [...rankCount.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const quads = counts.filter(([, c]) => c === 4);
  if (quads.length) {
    const quad = quads[0][0];
    const kicker = [...rankCount.keys()].filter((r) => r !== quad).sort((a, b) => b - a)[0];
    return make('fourOfAKind', [quad, kicker]);
  }

  const trips = counts.filter(([, c]) => c === 3);
  const pairs = counts.filter(([, c]) => c === 2);
  if (trips.length) {
    const tripRank = trips[0][0];
    let pairRank: number | undefined;
    if (trips.length >= 2) pairRank = trips[1][0];
    else if (pairs.length) pairRank = pairs[0][0];
    if (pairRank !== undefined) return make('fullHouse', [tripRank, pairRank]);
    return make('threeOfAKind', [tripRank, ...topKickers(rankCount, [tripRank], 2)]);
  }

  if (isFlush) {
    const flushSuit = (Object.keys(suits) as string[]).find((s) => suits[s] >= 5)!;
    const tb = cards
      .filter((c) => c.suit === flushSuit)
      .map((c) => c.rank)
      .sort((a, b) => b - a)
      .slice(0, 5);
    return make('flush', tb);
  }

  if (straightHigh !== null) return make('straight', [straightHigh]);

  if (pairs.length >= 2) {
    const [p1, p2] = pairs;
    const kicker = topKickers(rankCount, [p1[0], p2[0]], 1)[0];
    return make('twoPair', [p1[0], p2[0], kicker]);
  }

  if (pairs.length === 1) {
    const p = pairs[0][0];
    return make('onePair', [p, ...topKickers(rankCount, [p], 3)]);
  }

  const tb = [...rankCount.keys()].sort((a, b) => b - a).slice(0, 5);
  return make('highCard', tb);
}

export function evaluate7(cards: Card[]): EvalResult {
  return evaluate(cards);
}
