import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore, mySeatIndex } from '../store';
import { seatPoint, STREET_LABEL } from '../util/layout';
import Seat from './Seat';
import CommunityCards from './CommunityCards';
import ActionBar from './ActionBar';
import RaiseModal from './RaiseModal';
import BigCardModal from './BigCardModal';
import ChatBox from './ChatBox';
import Card from './Card';

const ERROR_TEXT: Record<string, string> = {
  NOT_YOUR_TURN: '还没轮到你',
  AMOUNT_BELOW_CALL: '金额低于跟注',
  BELOW_MIN_RAISE: '低于最小加注',
  INSUFFICIENT_CHIPS: '筹码不足',
  ROOM_FULL: '房间已满（6 人）',
  ROOM_NOT_FOUND: '房间不存在',
  NOT_HOST: '仅房主可开始',
  INVALID_STREET: '当前不可操作',
  PROTOCOL_VIOLATION: '协议错误',
};

export default function TablePage({ code }: { code: string }) {
  const view = useStore((s) => s.view);
  const me = useStore((s) => s.me);
  const welcome = useStore((s) => s.welcome);
  const conn = useStore((s) => s.conn);
  const deadlineAt = useStore((s) => s.deadlineAt);
  const lastError = useStore((s) => s.lastError);
  const clearError = useStore((s) => s.clearError);
  const setBigCard = useStore((s) => s.setBigCard);
  const sendStart = useStore((s) => s.sendStart);

  const myIdx = mySeatIndex(view, me.id);
  const myPlayer = myIdx >= 0 ? view!.players[myIdx] : null;
  const viewerSeat = myPlayer ? myPlayer.seat : 0;
  const isHost = welcome?.hostId === me.id;
  const timeoutMs = welcome?.config?.turnTimeoutMs ?? 30000;
  const roomName = welcome?.config?.name ?? '牌桌';
  const showLobby = view != null && (view.street === 'waiting' || view.street === 'complete');

  useEffect(() => {
    if (!lastError) return;
    const id = setTimeout(clearError, 2600);
    return () => clearTimeout(id);
  }, [lastError, clearError]);

  const leave = () => {
    window.location.hash = '#/';
  };

  return (
    <div className="table-page">
      <div className="table-header">
        <span className="code" title="房间码（分享给朋友即可加入）">{code}</span>
        <span className="street">
          {roomName} · {view ? STREET_LABEL[view.street] : '连接中…'}
        </span>
        <span className="spacer" />
        <span>
          <span className={`conn-dot conn-${conn}`} />
          {conn === 'open'
            ? '已连接'
            : conn === 'reconnecting' || conn === 'connecting'
              ? '重连中…'
              : '未连接'}
        </span>
        <button className="btn ghost" onClick={leave}>
          离开
        </button>
      </div>

      <div className="table-body">
        <div className="felt" />

        {view && (
          <>
            <CommunityCards board={view.board} pots={view.pots} />

            {Array.from({ length: 6 }).map((_, slot) => {
              const player = view.players.find((p) => p.seat === slot);
              const pt = seatPoint(slot, viewerSeat);
              const idx = player ? view.players.findIndex((p) => p.id === player.id) : -1;
              const toAct = view.toAct === idx;
              if (!player) {
                return (
                  <div
                    key={slot}
                    className="seat"
                    style={{ left: `${pt.x}%`, top: `${pt.y}%`, opacity: 0.35 }}
                  >
                    <div
                      className="seat-inner"
                      style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}
                    >
                      空位
                    </div>
                  </div>
                );
              }
              return (
                <Seat
                  key={player.id}
                  player={player}
                  point={pt}
                  isViewer={player.id === me.id}
                  isToAct={toAct}
                  isDealer={view.button === player.seat}
                  deadlineAt={toAct ? deadlineAt : null}
                  timeoutMs={timeoutMs}
                  onCardClick={(c) => setBigCard(c)}
                />
              );
            })}

            {myPlayer && myPlayer.holeCards.length === 2 && (
              <div className="my-hand">
                {myPlayer.holeCards.map((c, i) => (
                  <Card key={i} card={c} size="md" onClick={() => setBigCard(c)} />
                ))}
              </div>
            )}
          </>
        )}

        <ActionBar />

        {showLobby && view && (
          <div className="lobby">
            <div className="hint">房间码（分享给朋友加入）</div>
            <div className="share-code">{code}</div>
            <div className="players">
              {view.players.map((p) => (
                <div className="pc" key={p.id}>
                  {p.nickname}
                  {p.id === me.id ? ' (你)' : ''}
                </div>
              ))}
            </div>
            {view.street === 'waiting' ? (
              <div className="hint">
                {isHost ? '人都到齐后，由你开始第一手' : '等待房主开始游戏…'}
              </div>
            ) : (
              <div className="hint">本手结束，等待房主开始下一手</div>
            )}
            {isHost && (
              <button className="btn" onClick={sendStart}>
                {view.street === 'waiting' ? '开始游戏' : '开始下一手'}
              </button>
            )}
          </div>
        )}

        <ChatBox />
      </div>

      <RaiseModal />
      <BigCardModal />

      <AnimatePresence>
        {lastError && (
          <motion.div
            className="toast"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            {ERROR_TEXT[lastError.code] ?? lastError.code}
            {lastError.message ? `：${lastError.message}` : ''}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
