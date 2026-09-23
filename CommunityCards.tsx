import { AnimatePresence, motion } from 'framer-motion';
import Card from './Card';
import { fmtChips } from '../util/format';
import type { Card as CardType, Pot } from '../shared';

interface Props {
  board: CardType[];
  pots: Pot[];
}

/** 5 张公共牌区域 + 底池展示；新发出的牌从牌堆（上方）飞入。 */
export default function CommunityCards({ board, pots }: Props) {
  const potTotal = pots.reduce((s, p) => s + p.amount, 0);
  return (
    <div className="board">
      {potTotal > 0 && <div className="pot">底池 {fmtChips(potTotal)}</div>}
      {Array.from({ length: 5 }).map((_, i) => {
        const c = board[i];
        return (
          <AnimatePresence key={i} mode="popLayout">
            {c ? (
              <motion.div
                key={c.rank + c.suit}
                initial={{ y: -260, opacity: 0, rotate: -25, scale: 0.8 }}
                animate={{ y: 0, opacity: 1, rotate: 0, scale: 1 }}
                transition={{ type: 'spring', stiffness: 220, damping: 18 }}
              >
                <Card card={c} size="md" />
              </motion.div>
            ) : (
              <Card key="empty" faceDown size="md" />
            )}
          </AnimatePresence>
        );
      })}
    </div>
  );
}
