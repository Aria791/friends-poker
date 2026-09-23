// 端到端冒烟测试：直接复用与 Vite 开发网关完全相同的 roomHost 逻辑（controller + 引擎），
// 用真实 ws 客户端模拟两名玩家，跑通：创建房间 → 第二人加入 → 开局 → 一手完整流程，
// 并校验：1) 对手底牌绝不外泄；2) 筹码总量守恒。
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { handleApiRooms, getOrCreateRoom, handleConnection } from './roomHost';
import type { ClientView, LegalAction, ServerMessage } from '../../shared/protocol';

const PORT = 0;

function startServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const handled = await handleApiRooms(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const m = url.pathname.match(/^\/([A-Za-z0-9]{6})\/ws$/);
      if (!m) {
        socket.destroy();
        return;
      }
      const code = m[1];
      const uid = url.searchParams.get('uid') || '';
      const name = url.searchParams.get('name') || '玩家';
      const lastSeq = Number(url.searchParams.get('lastSeq') || '0');
      const wss = new WebSocketServer({ noServer: true });
      wss.handleUpgrade(req as never, socket as never, head as never, (ws) => {
        void handleConnection(getOrCreateRoom(code), ws as never, uid, name, lastSeq);
      });
    });
    server.listen(PORT, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

interface PlayerBot {
  uid: string;
  name: string;
  ws: WebSocket;
  view: ClientView | null;
  legal: LegalAction[];
  hostId: string | null;
  seq: number;
  sawComplete: boolean;
  leaked: boolean; // 是否收到过对手的底牌（应永远为 false）
  actedThisTurn: boolean;
}

function attachBot(bot: PlayerBot, onState: () => void) {
  bot.ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as ServerMessage;
    if (msg.t === 'welcome') {
      bot.hostId = msg.hostId;
    } else if (msg.t === 'state') {
      bot.view = msg.view;
      bot.legal = msg.legal;
      bot.seq = msg.seq;
      // 安全校验：任何非本人的玩家，其 holeCards 必须为空
      for (const p of msg.view.players) {
        if (p.id !== bot.uid && p.holeCards.length > 0) bot.leaked = true;
      }
      bot.actedThisTurn = false;
      onState();
    }
  });
}

function pickAction(legal: LegalAction[]): { type: string; amount?: number } {
  if (legal.some((l) => l.type === 'check')) return { type: 'check' };
  const call = legal.find((l) => l.type === 'call');
  if (call) return { type: 'call' };
  const bet = legal.find((l) => l.type === 'bet');
  if (bet) return { type: 'bet', amount: bet.min };
  const raise = legal.find((l) => l.type === 'raise');
  if (raise) return { type: 'raise', amount: raise.min };
  const allIn = legal.find((l) => l.type === 'allIn');
  if (allIn) return { type: 'allIn' };
  return { type: 'fold' };
}

async function run(): Promise<void> {
  const { server, port } = await startServer();
  const base = `ws://localhost:${port}`;

  // 1) 创建房间（host）
  const createRes = await fetch(`http://localhost:${port}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '冒烟测试局',
      startingChips: 1000,
      smallBlind: 5,
      bigBlind: 10,
      hostId: 'host-A',
      hostName: 'Host',
    }),
  });
  const { roomId } = (await createRes.json()) as { roomId: string };
  console.log('创建房间:', roomId);

  // 列表应包含该房间
  const listRes = await fetch(`http://localhost:${port}/api/rooms`);
  const list = (await listRes.json()) as { rooms: { roomId: string; players: number }[] };
  const inList = list.rooms.find((r) => r.roomId === roomId);
  if (!inList) throw new Error('房间未出现在列表中');
  console.log('列表 OK，初始人数:', inList.players);

  // 2) 两名玩家连接
  const botA: PlayerBot = {
    uid: 'host-A',
    name: 'Host',
    ws: new WebSocket(`${base}/${roomId}/ws?uid=host-A&name=Host`),
    view: null,
    legal: [],
    hostId: null,
    seq: 0,
    sawComplete: false,
    leaked: false,
    actedThisTurn: false,
  };
  const botB: PlayerBot = {
    uid: 'guest-B',
    name: 'Guest',
    ws: new WebSocket(`${base}/${roomId}/ws?uid=guest-B&name=Guest`),
    view: null,
    legal: [],
    hostId: null,
    seq: 0,
    sawComplete: false,
    leaked: false,
    actedThisTurn: false,
  };

  const bothConnected = Promise.all([
    new Promise<void>((r) => botA.ws.on('open', () => r())),
    new Promise<void>((r) => botB.ws.on('open', () => r())),
  ]);

  const onState = () => {
    for (const bot of [botA, botB]) {
      if (!bot.view || bot.actedThisTurn) continue;
      if (bot.view.street === 'waiting' && bot.hostId === bot.uid && !bot.sawComplete) {
        bot.ws.send(JSON.stringify({ t: 'start' }));
        bot.actedThisTurn = true;
        continue;
      }
      if (bot.legal.length > 0) {
        bot.ws.send(JSON.stringify({ t: 'action', action: pickAction(bot.legal) }));
        bot.actedThisTurn = true;
      }
      if (bot.view.street === 'complete') bot.sawComplete = true;
    }
  };

  attachBot(botA, onState);
  attachBot(botB, onState);

  await bothConnected;
  console.log('两人均已连接（第二人自动加入）');

  // 3) 等待一手完成（或超时）
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (botA.sawComplete && botB.sawComplete) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // 4) 断言
  const aComplete = botA.sawComplete && botB.sawComplete;
  const noLeak = !botA.leaked && !botB.leaked;
  const players = botA.view?.players ?? [];
  const totalChips = players.reduce((s, p) => s + p.chips, 0);

  console.log('--- 断言 ---');
  console.log('两手均看到 complete:', aComplete);
  console.log('对手底牌未外泄:', noLeak);
  console.log('筹码总量守恒 (应为 2000):', totalChips, '玩家数:', players.length);
  console.log('最终街:', botA.view?.street, '底池:', botA.view?.pots);

  botA.ws.close();
  botB.ws.close();
  server.close();

  if (!aComplete) throw new Error('一手未跑完');
  if (!noLeak) throw new Error('安全红线被违反：对手底牌外泄！');
  if (totalChips !== 2000) throw new Error(`筹码守恒失败：${totalChips}`);
  console.log('\n✅ 冒烟测试通过：创建→加入→开局→一手完整流程，安全与守恒均OK');
}

run().catch((e) => {
  console.error('❌ 冒烟测试失败:', e);
  process.exit(1);
});
