import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { fmtTime } from '../util/format';

/** 聊天框：纯文本收发，内容由服务端限长（≤500 字）并广播。 */
export default function ChatBox() {
  const chat = useStore((s) => s.chat);
  const me = useStore((s) => s.me);
  const sendChat = useStore((s) => s.sendChat);
  const [text, setText] = useState('');
  const msgsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
  }, [chat]);

  const submit = () => {
    if (!text.trim()) return;
    sendChat(text);
    setText('');
  };

  return (
    <div className="chat-box">
      <div className="head">牌桌聊天</div>
      <div className="msgs" ref={msgsRef}>
        {chat.length === 0 && <div className="hint" style={{ color: 'var(--muted)', fontSize: 12 }}>还没有人说话</div>}
        {chat.map((m) => (
          <div className="msg" key={m.id}>
            <div className="who">{m.fromId === me.id ? '我' : m.fromName} · {fmtTime(m.ts)}</div>
            <div className="txt">{m.text}</div>
          </div>
        ))}
      </div>
      <div className="compose">
        <input
          value={text}
          placeholder="说点什么…"
          maxLength={200}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button onClick={submit}>发送</button>
      </div>
    </div>
  );
}
