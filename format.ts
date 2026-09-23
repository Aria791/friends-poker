// 所有金额均为整数，禁止浮点运算与显示。
export function fmtChips(n: number): string {
  return Math.trunc(n).toLocaleString('en-US');
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
