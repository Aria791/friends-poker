// core/rules/blinds.ts
// 盲注发布与座位轮转辅助。heads-up 时 SB = button，BB = 非 button。
import { GameState } from '../../shared/types';

/** 在参与者（chips>0）中，返回座位 seat 之后的下一个座位（循环） */
export function seatAfter(s: GameState, seat: number): number {
  const seats = s.players
    .filter((p) => p.chips > 0)
    .map((p) => p.seat)
    .sort((a, b) => a - b);
  if (seats.length === 0) return seat;
  for (const x of seats) if (x > seat) return x;
  return seats[0];
}

export interface BlindSeats {
  sbSeat: number;
  bbSeat: number;
}

/** 发布盲注，直接修改 state（调用方已 clone）。返回 SB/BB 座位。 */
export function postBlinds(s: GameState): BlindSeats {
  const parts = s.players.filter((p) => p.chips > 0).sort((a, b) => a.seat - b.seat);
  let sbSeat: number;
  let bbSeat: number;
  if (parts.length === 2) {
    sbSeat = s.button;
    bbSeat = seatAfter(s, sbSeat);
  } else {
    sbSeat = seatAfter(s, s.button);
    bbSeat = seatAfter(s, sbSeat);
  }
  const sb = s.players.find((p) => p.seat === sbSeat)!;
  const bb = s.players.find((p) => p.seat === bbSeat)!;

  const sbPay = Math.min(s.smallBlind, sb.chips);
  sb.chips -= sbPay;
  sb.betThisRound += sbPay;
  sb.totalBetThisHand += sbPay;
  if (sb.chips === 0) sb.status = 'allIn';

  const bbPay = Math.min(s.bigBlind, bb.chips);
  bb.chips -= bbPay;
  bb.betThisRound += bbPay;
  bb.totalBetThisHand += bbPay;
  if (bb.chips === 0) bb.status = 'allIn';

  return { sbSeat, bbSeat };
}
