import type { Card } from '../shared';

const RANK_LABELS: Record<number, string> = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
};

export const SUIT_SYMBOL: Record<string, string> = {
  s: '♠', // ♠
  h: '♥', // ♥
  d: '♦', // ♦
  c: '♣', // ♣
};

const RED_SUITS = new Set(['h', 'd']);

export function rankLabel(rank: number): string {
  return RANK_LABELS[rank] ?? String(rank);
}

export function isRed(suit: string): boolean {
  return RED_SUITS.has(suit);
}

export function cardKey(c: Card): string {
  return `${c.rank}${c.suit}`;
}

/** 简短可读描述，用于无障碍 / 调试（绝不用于推导他人手牌） */
export function cardLabel(c: Card): string {
  return `${rankLabel(c.rank)}${SUIT_SYMBOL[c.suit]}`;
}
