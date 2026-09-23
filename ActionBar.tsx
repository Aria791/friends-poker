import { useEffect, useState } from 'react';
import { useStore, mySeatIndex } from '../store';
import { fmtChips } from '../util/format';
import CountdownRing from './CountdownRing';

/**
 * 行动栏：按钮的"有无"与"金额范围"完全来自服务端下发的 legal 白名单。
 * 安全红线：客户端不自行计算任何金额；加注额取自 legal.min/max 滑块；
 * 倒计时归零后灰显，等待服务端超时裁决结果。
 */
export default function ActionBar() {
  const view = useStore((s) => s.view);
  const legal = useStore((s) => s.legal);
  const me = useStore((s) => s.me);
  const deadlineAt = useStore((s) => s.deadlineAt);
  const welcome = useStore((s) => s.welcome);
  const sendAction = useStore((s) => s.sendAction);
  const openRaise = useStore((s) => s.openRaise);

  const timeoutMs = welcome?.config?.turnTimeoutMs ?? 30000;
  const myIdx = mySeatIndex(view, me.id);
  const myTurn = view != null && view.toAct === myIdx && myIdx >= 0;

  // 本地滴答：用于"归零灰显"的即时反馈
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadlineAt == null) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [deadlineAt]);
  const timedOut = deadlineAt != null && now > deadlineAt;
  const disabled = !myTurn || timedOut;

  if (!view) return null;

  if (!myTurn) {
    return (
      <div className="action-bar">
        <span className="waiting">
          {view.toAct === null ? '等待下一手…' : '等待其他玩家行动…'}
        </span>
      </div>
    );
  }

  const hasFold = legal.some((l) => l.type === 'fold');
  const check = legal.find((l) => l.type === 'check');
  const call = legal.find((l) => l.type === 'call');
  const bet = legal.find((l) => l.type === 'bet');
  const raise = legal.find((l) => l.type === 'raise');
  const allIn = legal.find((l) => l.type === 'allIn');

  return (
    <div className="action-bar">
      {hasFold && (
        <button className="btn danger" disabled={disabled} onClick={() => sendAction({ type: 'fold' })}>
          弃牌
        </button>
      )}

      {check ? (
        <button className="btn secondary" disabled={disabled} onClick={() => sendAction({ type: 'check' })}>
          过牌
        </button>
      ) : call ? (
        <button className="btn" disabled={disabled} onClick={() => sendAction({ type: 'call' })}>
          跟注 {fmtChips(call.amount)}
        </button>
      ) : null}

      {bet && (
        <button
          className="btn secondary"
          disabled={disabled}
          onClick={() => openRaise({ kind: 'bet', min: bet.min, max: bet.max })}
        >
          下注
        </button>
      )}
      {raise && (
        <button
          className="btn secondary"
          disabled={disabled}
          onClick={() => openRaise({ kind: 'raise', min: raise.min, max: raise.max })}
        >
          加注
        </button>
      )}

      {allIn && (
        <button className="btn" disabled={disabled} onClick={() => sendAction({ type: 'allIn' })}>
          全押 {fmtChips(allIn.amount)}
        </button>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 6 }}>
        {disabled && timedOut ? (
          <span className="waiting">超时裁决中…</span>
        ) : (
          <CountdownRing deadlineAt={deadlineAt} totalMs={timeoutMs} />
        )}
      </div>
    </div>
  );
}
