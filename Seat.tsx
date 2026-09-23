import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Card from './Card';
import CountdownRing from './CountdownRing';
import { fmtChips } from '../util/format';
import type { Card as CardType, Player } from '../shared';
import type { Point } from '../util/layout';

interface Props {
  player: Player;
  point: Point;
  isViewer: boolean;
  isToAct: boolean;
  isDealer: boolean;
  deadlineAt: number | null;
  timeoutMs: number;
  onCardClick?: (card: CardType) => void;
}

const STATUS_LABEL: Record<string, string> = {
  active: '行动中',
  folded: '已弃牌',
  allIn: '全押',
  disconnected: '掉线',
  out: '出局',
};

interface FloatDelta {
  id: number;
  delta: number;
}

export default function Seat({
  player,
  point,
  isViewer,
  isToAct,
  isDealer,
  deadlineAt,
  timeoutMs,
  onCardClick,
}: Props) {
  const prevBet = useRef(player.betThisRound);
  const prevChips = useRef(player.chips);
  const [floats, setFloats] = useState<FloatDelta[]>([]);
  const floatSeq = useRef(0);

  useEffect(() => {
    const betDelta = player.betThisRound - prevBet.current;
    const chipDelta = player.chips - prevChips.current;
    prevBet.current = player.betThisRound;
    prevChips.current = player.chips;
    if (betDelta > 0) {
      const id = ++floatSeq.current;
      setFloats((f) => [...f, { id, delta: -betDelta }]);
      setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1100);
    } else if (chipDelta > 0) {
      const id = ++floatSeq.current;
      setFloats((f) => [...f, { id, delta: chipDelta }]);
      setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1100);
    }
  }, [player.betThisRound, player.chips]);

  const statusClass = player.status === 'active' ? 'active' : player.status;

  return (
    <div
      className={`seat ${isToAct ? 'active-turn' : ''}`}
      style={{ left: `${point.x}%`, top: `${point.y}%` }}
    >
      {isDealer && <div className="dealer-badge" title="庄家">D</div>}

      <div className="seat-inner">
        <div className="name">
          {player.nickname}
          {isViewer && ' (你)'}
        </div>
        <div className="chips">{fmtChips(player.chips)}</div>
        <div className="bet">
          {player.betThisRound > 0 ? `本手 ${fmtChips(player.betThisRound)}` : ''}
        </div>
        <div className={`status ${statusClass}`}>{STATUS_LABEL[player.status] ?? player.status}</div>

        <div className="seat-cards">
          {player.holeCards.length > 0 ? (
            player.holeCards.map((c, i) => (
              <Card
                key={i}
                card={c}
                size="sm"
                onClick={isViewer && onCardClick ? () => onCardClick(c) : undefined}
              />
            ))
          ) : (
            <>
              <Card faceDown size="sm" />
              <Card faceDown size="sm" />
            </>
          )}
        </div>

        <AnimatePresence>
          {floats.map((f) => (
            <motion.div
              key={f.id}
              className={`float-delta ${f.delta >= 0 ? 'plus' : 'minus'}`}
              initial={{ opacity: 0, y: 0 }}
              animate={{ opacity: 1, y: -22 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1 }}
            >
              {f.delta >= 0 ? '+' : ''}
              {fmtChips(f.delta)}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {isToAct && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 4 }}>
          <CountdownRing deadlineAt={deadlineAt} totalMs={timeoutMs} />
        </div>
      )}
    </div>
  );
}
