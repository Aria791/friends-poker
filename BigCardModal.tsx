import { useStore } from '../store';
import Card from './Card';

/** 点击本人手牌后弹出的放大查看。仅展示本人已授权可见的手牌。 */
export default function BigCardModal() {
  const bigCard = useStore((s) => s.bigCard);
  const setBigCard = useStore((s) => s.setBigCard);
  if (!bigCard) return null;
  return (
    <div className="modal-mask" onClick={() => setBigCard(null)}>
      <div className="big-card-wrap" onClick={(e) => e.stopPropagation()}>
        <Card card={bigCard} size="lg" />
      </div>
    </div>
  );
}
