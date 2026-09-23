import { useEffect, useState } from 'react';

interface Props {
  deadlineAt: number | null;
  totalMs?: number;
  size?: number;
}

/**
 * 倒计时环：根据服务端下发的回合超时（默认 30s）显示剩余时间。
 * 归零后由上层"灰显按钮、等待服务端超时裁决"——本组件只展示，不发起任何行动。
 */
export default function CountdownRing({ deadlineAt, totalMs = 30000, size = 34 }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadlineAt == null) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [deadlineAt]);

  const remaining = deadlineAt == null ? 0 : Math.max(0, deadlineAt - now);
  const fraction = totalMs > 0 ? Math.max(0, Math.min(1, remaining / totalMs)) : 0;
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - fraction);
  const secs = Math.ceil(remaining / 1000);
  const danger = remaining <= 5000;

  return (
    <div className="countdown" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#2c3e4e" strokeWidth={4} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={danger ? '#e23b3b' : '#f4c430'}
          strokeWidth={4}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="num">{secs}</div>
    </div>
  );
}
