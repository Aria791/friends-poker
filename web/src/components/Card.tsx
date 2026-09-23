import { rankLabel, isRed, SUIT_SYMBOL } from '../util/cards';
import type { Card as CardType } from '../shared';

interface Props {
  card?: CardType;
  faceDown?: boolean;
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
}

/**
 * 单张卡牌。faceDown 时渲染牌背（用于他人手牌 / 牌堆）。
 * 安全红线：本组件只负责"展示服务端下发的数据"，绝不接收或推导任何未授权牌面。
 */
export default function Card({ card, faceDown, size = 'md', onClick }: Props) {
  if (faceDown || !card) {
    return <div className={`card back ${size}`} onClick={onClick} />;
  }
  const red = isRed(card.suit);
  return (
    <div
      className={`card ${size} ${red ? 'red' : 'black'}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
    >
      <span className="rank">{rankLabel(card.rank)}</span>
      <span className="suit">{SUIT_SYMBOL[card.suit]}</span>
    </div>
  );
}
