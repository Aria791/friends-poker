import { create } from 'zustand';
import { PokerClient, type ConnStatus } from './net/ws';
import { wsUrl } from './config';
import type {
  Action,
  Card,
  ClientView,
  LegalAction,
  ServerMessage,
  WelcomeFrame,
} from './shared';

const UID_KEY = 'poker_uid';
const NAME_KEY = 'poker_name';

function loadUid(): string {
  if (typeof localStorage === 'undefined') return crypto.randomUUID();
  let u = localStorage.getItem(UID_KEY);
  if (!u) {
    u = crypto.randomUUID();
    localStorage.setItem(UID_KEY, u);
  }
  return u;
}
function loadName(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(NAME_KEY) ?? '';
}

export interface ChatMsg {
  id: number;
  fromId: string;
  fromName: string;
  text: string;
  ts: number;
}

interface RaiseSpec {
  kind: 'bet' | 'raise';
  min: number;
  max: number;
}

interface StoreState {
  me: { id: string; name: string };
  conn: ConnStatus;
  code: string | null;
  welcome: WelcomeFrame | null;
  view: ClientView | null;
  legal: LegalAction[];
  seq: number;
  chat: ChatMsg[];
  lastError: { code: string; message?: string } | null;
  deadlineAt: number | null;
  raiseOpen: RaiseSpec | null;
  bigCard: Card | null;

  setName: (name: string) => void;
  enterRoom: (code: string) => void;
  leaveRoom: () => void;
  sendAction: (action: Action) => void;
  sendStart: () => void;
  sendChat: (text: string) => void;
  openRaise: (spec: RaiseSpec) => void;
  closeRaise: () => void;
  setBigCard: (c: Card | null) => void;
  clearError: () => void;
}

let client: PokerClient | null = null;
let prevToAct: number | null = null;
let chatId = 0;

export const useStore = create<StoreState>((set, get) => ({
  me: { id: loadUid(), name: loadName() },
  conn: 'idle',
  code: null,
  welcome: null,
  view: null,
  legal: [],
  seq: 0,
  chat: [],
  lastError: null,
  deadlineAt: null,
  raiseOpen: null,
  bigCard: null,

  setName: (name) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(NAME_KEY, name);
    set((s) => ({ me: { ...s.me, name } }));
  },

  enterRoom: (code) => {
    const { me } = get();
    if (client) client.close();
    prevToAct = null;
    set({
      code,
      conn: 'connecting',
      view: null,
      legal: [],
      chat: [],
      welcome: null,
      deadlineAt: null,
      seq: 0,
      lastError: null,
      raiseOpen: null,
      bigCard: null,
    });
    client = new PokerClient({
      url: wsUrl(code, me.id, me.name, 0),
      onStatus: (c) => set({ conn: c }),
      onMessage: (msg) => handleMessage(msg, set, get),
    });
    client.connect(0);
  },

  leaveRoom: () => {
    if (client) {
      client.close();
      client = null;
    }
    set({
      code: null,
      conn: 'idle',
      view: null,
      legal: [],
      chat: [],
      welcome: null,
      deadlineAt: null,
      raiseOpen: null,
      bigCard: null,
    });
  },

  sendAction: (action) => {
    // 安全红线：只发送 Action 类型与（来自服务端白名单的）amount；客户端不计算金额。
    client?.send({ t: 'action', action });
    set({ raiseOpen: null });
  },

  sendStart: () => {
    // 房主开始 / 下一手：仅发送 start 意图，由服务端裁决是否合法（waiting / complete）。
    client?.send({ t: 'start' });
  },

  sendChat: (text) => {
    const t = text.trim();
    if (t) client?.send({ t: 'chat', text: t });
  },

  openRaise: (spec) => set({ raiseOpen: spec }),
  closeRaise: () => set({ raiseOpen: null }),
  setBigCard: (c) => set({ bigCard: c }),
  clearError: () => set({ lastError: null }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleMessage(msg: ServerMessage, set: any, get: any): void {
  if (msg.t === 'welcome') {
    set({
      welcome: msg,
      me: { ...get().me, id: msg.you.id, name: msg.you.nickname },
    });
  } else if (msg.t === 'state') {
    const view = msg.view;
    const timeout = get().welcome?.config?.turnTimeoutMs ?? 30000;
    const betting = ['preflop', 'flop', 'turn', 'river'].includes(view.street);
    let deadlineAt = get().deadlineAt;
    if (view.toAct !== prevToAct) {
      prevToAct = view.toAct;
      deadlineAt =
        betting && view.toAct !== null ? Date.now() + timeout : null;
    } else if (view.toAct === null) {
      deadlineAt = null;
    }
    set({ view, legal: msg.legal, seq: msg.seq, deadlineAt, lastError: null });
  } else if (msg.t === 'chat') {
    const cm: ChatMsg = {
      id: ++chatId,
      fromId: msg.fromId,
      fromName: msg.fromName,
      text: msg.text,
      ts: msg.ts,
    };
    set((s: StoreState) => ({ chat: [...s.chat, cm].slice(-120) }));
  } else if (msg.t === 'error') {
    set({ lastError: { code: msg.code, message: msg.message } });
  }
  // pong：忽略
}

export function mySeatIndex(view: ClientView | null, myId: string): number {
  if (!view) return -1;
  return view.players.findIndex((p) => p.id === myId);
}
