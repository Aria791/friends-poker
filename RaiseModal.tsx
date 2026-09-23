import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { fmtChips } from '../util/format';

/**
 * 加注 / 下注滑块：min / max 直接来自服务端 legal 白名单；
 * 选中的整数金额作为 Action.amount 原样上报，客户端不做任何金额推导。
 */
export default function RaiseModal() {
  const raiseOpen = useStore((s) => s.raiseOpen);
  const closeRaise = useStore((s) => s.closeRaise);
  const sendAction = useStore((s) => s.sendAction);
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (raiseOpen) setValue(raiseOpen.min);
  }, [raiseOpen]);

  if (!raiseOpen) return null;

  const confirm = () => {
    const amount = Math.max(raiseOpen.min, Math.min(raiseOpen.max, Math.trunc(value)));
    sendAction({ type: raiseOpen.kind, amount });
    closeRaise();
  };

  return (
    <div className="modal-mask" onClick={closeRaise}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{raiseOpen.kind === 'bet' ? '下注' : '加注'}金额</h3>
        <div className="raise-val">{fmtChips(value)}</div>
        <input
          className="slider"
          type="range"
          min={raiseOpen.min}
          max={raiseOpen.max}
          step={1}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
        />
        <div className="row" style={{ justifyContent: 'space-between', color: 'var(--muted)', fontSize: 13 }}>
          <span>最小 {fmtChips(raiseOpen.min)}</span>
          <span>最大 {fmtChips(raiseOpen.max)}</span>
        </div>
        <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn ghost" onClick={closeRaise}>
            取消
          </button>
          <button className="btn" onClick={confirm} disabled={value < raiseOpen.min}>
            确认{raiseOpen.kind === 'bet' ? '下注' : '加注'}
          </button>
        </div>
      </div>
    </div>
  );
}
