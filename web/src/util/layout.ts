export interface Point {
  x: number; // 百分比 0..100
  y: number; // 百分比 0..100
}

/**
 * 计算某个座位在牌桌上的坐标（百分比），保证"本人座位永远在底部"。
 * 以 6 个固定槽位环绕椭圆：槽位 0 在顶部，顺时针排布；
 * 再整体旋转，使 viewerSeat 对应的槽位落在底部（角度 = +90°）。
 */
export function seatPoint(seat: number, viewerSeat: number, totalSlots = 6): Point {
  const base = -Math.PI / 2 + (seat * 2 * Math.PI) / totalSlots;
  const viewerBase = -Math.PI / 2 + (viewerSeat * 2 * Math.PI) / totalSlots;
  const rot = Math.PI / 2 - viewerBase;
  const a = base + rot;
  return {
    x: 50 + 40 * Math.cos(a),
    y: 50 + 42 * Math.sin(a),
  };
}

export const STREET_LABEL: Record<string, string> = {
  waiting: '等待开始',
  preflop: '翻牌前',
  flop: '翻牌圈',
  turn: '转牌圈',
  river: '河牌圈',
  showdown: '摊牌',
  complete: '本手结束',
};
