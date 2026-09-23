import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../store';
import { createRoom, listRooms, type RoomSummary } from '../net/api';

function go(code: string) {
  window.location.hash = `#/r/${code}`;
}

export default function RoomListPage() {
  const me = useStore((s) => s.me);
  const setName = useStore((s) => s.setName);

  const [nameDraft, setNameDraft] = useState(me.name);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [joinCode, setJoinCode] = useState('');
  const [creating, setCreating] = useState(false);

  const [roomName, setRoomName] = useState('朋友牌局');
  const [startingChips, setStartingChips] = useState(1000);
  const [smallBlind, setSmallBlind] = useState(5);
  const [bigBlind, setBigBlind] = useState(10);

  const refresh = () => listRooms().then(setRooms).catch(() => setRooms([]));
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, []);

  const saveName = () => setName(nameDraft.trim());

  const doCreate = async () => {
    setCreating(true);
    try {
      const { roomId } = await createRoom({
        name: roomName.trim() || '朋友牌局',
        startingChips,
        smallBlind,
        bigBlind,
        hostId: me.id,
        hostName: nameDraft.trim() || '玩家',
      });
      go(roomId);
    } catch (e) {
      alert((e as Error).message || '创建失败');
      setCreating(false);
    }
  };

  const doJoin = () => {
    const code = joinCode.trim().toUpperCase();
    if (code.length !== 6) {
      alert('房间码为 6 位');
      return;
    }
    go(code);
  };

  return (
    <motion.div className="list-page" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      <h1>朋友德州 · 联机扑克</h1>
      <p className="sub">纯朋友娱乐局 · 整数筹码 · 服务端权威裁决</p>

      <div className="card-panel">
        <h2>你的昵称</h2>
        <div className="field">
          <input
            value={nameDraft}
            maxLength={16}
            placeholder="输入昵称"
            onChange={(e) => setNameDraft(e.target.value)}
          />
        </div>
        <button className="btn secondary" onClick={saveName} disabled={!nameDraft.trim()}>
          保存昵称
        </button>
      </div>

      <div className="card-panel">
        <h2>创建房间</h2>
        <div className="field">
          <label>房间名</label>
          <input value={roomName} maxLength={20} onChange={(e) => setRoomName(e.target.value)} />
        </div>
        <div className="row wrap">
          <div className="field" style={{ flex: 1 }}>
            <label>初始筹码</label>
            <input type="number" min={100} step={100} value={startingChips} onChange={(e) => setStartingChips(Number(e.target.value))} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>小盲</label>
            <input type="number" min={1} value={smallBlind} onChange={(e) => setSmallBlind(Number(e.target.value))} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>大盲</label>
            <input type="number" min={1} value={bigBlind} onChange={(e) => setBigBlind(Number(e.target.value))} />
          </div>
        </div>
        <button className="btn" onClick={doCreate} disabled={creating || !nameDraft.trim()}>
          {creating ? '创建中…' : '创建房间'}
        </button>
      </div>

      <div className="card-panel">
        <h2>加入房间</h2>
        <div className="row">
          <input
            className="code-input"
            style={{ flex: 1 }}
            value={joinCode}
            maxLength={6}
            placeholder="6 位房间码"
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          />
          <button className="btn" onClick={doJoin}>
            加入
          </button>
        </div>
      </div>

      <div className="card-panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>房间列表</h2>
          <button className="btn ghost" onClick={refresh}>刷新</button>
        </div>
        {rooms.length === 0 && <p className="hint" style={{ color: 'var(--muted)', fontSize: 13 }}>暂无房间，去创建一个吧</p>}
        {rooms.map((r) => (
          <div className="room-item" key={r.roomId}>
            <div>
              <div className="name">
                {r.name} <span className="tag">{r.roomId}</span>
              </div>
              <div className="meta">{r.players}/{r.maxPlayers} 人</div>
            </div>
            <button className="btn secondary" onClick={() => go(r.roomId)}>
              进入
            </button>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
