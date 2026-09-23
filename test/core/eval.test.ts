// test/core/eval.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Card, Rank, Suit } from '../../shared/types';
import { evaluate, findStraightHigh } from '../../core/eval/rank';

const RANK_MAP: Record<string, Rank> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

function cards(str: string): Card[] {
  return str
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const suit = tok[tok.length - 1] as Suit;
      const rank = RANK_MAP[tok.slice(0, -1).toUpperCase()];
      if (!rank) throw new Error('bad rank: ' + tok);
      return { rank, suit };
    });
}

test('牌型等级基值符合开发指南', () => {
  assert.equal(evaluate(cards('As Ks Qs Js Ts')).category, 'straightFlush');
  assert.equal(evaluate(cards('As Ah Ad Ac Kh')).category, 'fourOfAKind');
  assert.equal(evaluate(cards('As Ah Ad Ks Kh')).category, 'fullHouse');
  assert.equal(evaluate(cards('As Ks 9s 5s 2s')).category, 'flush');
  assert.equal(evaluate(cards('9s 8h 7d 6c 5s')).category, 'straight');
  assert.equal(evaluate(cards('As Ah Ad Ks Qh')).category, 'threeOfAKind');
  assert.equal(evaluate(cards('As Ah Ks Kh Qd')).category, 'twoPair');
  assert.equal(evaluate(cards('As Ah Ks Qh Jd')).category, 'onePair');
  assert.equal(evaluate(cards('As Kh Qd Jc 9s')).category, 'highCard');
});

test('A-2-3-4-5 是合法低顺子', () => {
  assert.equal(findStraightHigh(new Set([14, 2, 3, 4, 5])), 5);
  const r = evaluate(cards('As 2h 3d 4c 5s'));
  assert.equal(r.category, 'straight');
  assert.equal(r.tiebreak[0], 5);
});

test('K-A-2-3-4 不是顺子', () => {
  assert.equal(findStraightHigh(new Set([13, 14, 2, 3, 4])), null);
  const r = evaluate(cards('Ks Ah 2d 3c 4s'));
  assert.equal(r.category, 'highCard');
  // 高牌：最大牌为 A(14)
  assert.equal(r.tiebreak[0], 14);
});

test('高低顺子比较：A 高顺 > 5 高顺（轮顺）', () => {
  const high = evaluate(cards('As Ks Qs Js Ts')).value; // 顺子，高牌 A
  const wheel = evaluate(cards('As 2h 3d 4c 5s')).value; // 顺子，高牌 5
  assert.ok(high > wheel);
});

test('同花比高牌', () => {
  const a = evaluate(cards('As Ks 9s 5s 2s')).value;
  const b = evaluate(cards('As Qs 9s 5s 2s')).value;
  assert.ok(a > b);
});

test('葫芦 > 三条', () => {
  const fh = evaluate(cards('As Ah Ad Ks Kh')).value;
  const tk = evaluate(cards('As Ah Ad Ks Qh')).value;
  assert.ok(fh > tk);
});

test('完全相同的牌型 → 数值相等（可平分）', () => {
  const a = evaluate(cards('As Ah Ks Qh Jd'));
  const b = evaluate(cards('Ac Ad Kc Qc Jc'));
  assert.equal(a.value, b.value);
  assert.equal(a.category, b.category);
});

test('七选五：四带一从 7 张中取最优', () => {
  const r = evaluate(cards('As Ah Ad Ac Ks Kh Qd'));
  assert.equal(r.category, 'fourOfAKind');
  assert.deepEqual(r.tiebreak, [14, 13]); // 四条 A，踢脚 K
});
