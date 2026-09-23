// core/deck.ts
import { Card, Rank, Suit } from '../shared/types';
import { createRng, Rng } from './rng';

const SUITS: Suit[] = ['s', 'h', 'd', 'c'];

export function freshDeck(): Card[] {
  const d: Card[] = [];
  for (const suit of SUITS) {
    for (let r = 2; r <= 14; r++) {
      d.push({ rank: r as Rank, suit });
    }
  }
  return d;
}

/** Fisher-Yates，使用注入的 CSPRNG */
export function shuffle(deck: Card[], rng: Rng): Card[] {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

export function buildShuffledDeck(rng?: Rng): Card[] {
  const r = rng ?? createRng();
  return shuffle(freshDeck(), r);
}
