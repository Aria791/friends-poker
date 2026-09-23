// test/room/controller.test.ts
// RoomController 单测：用 MemoryRoomStorage 在 Node 下完整验证编排逻辑，
// 不依赖 Cloudflare 运行时。重点覆盖：初始化、开局、合法/非法行动、回合推进、
// 聊天广播、断线重连（rebuild）、超时裁决、视图零泄露（反向验证）、min-raise /
// raise-capped / 顺子 / 边池 / 筹码守恒 fuzz / 重放确定性。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Action, Card, ClientView, GameState, LegalAction, RoomConfig } from '../../shared/types';
import type { ServerMessage, StateFrame } from '../../shared/protocol';
import { MemoryRoomStorage } from '../../src/room/storage';
import { RoomController } from '../../src/room/controller';
// 以下为核心引擎直测（与控制器编排正交，便于单测规则本身）
import { createTable, startHand, applyAction, replay } from '../../core/game';
import { getLegalActions } from '../../core/rules/betting';
import { computePots } from '../../core/rules/pots';
import { evaluate } from '../../core/eval/rank';
import { createRng } from '../../core/rng';

const CONFIG: RoomConfig = {
  name: '测试房',
  startingChips: 1000,
  smallBlind: 10,
  bigBlind: 20,
};

const MEMBERS = [
  { id: 'u1', nickname: 'A' },
  { id: 'u2', nickname: 'B' },
  { id: 'u3', nickname: 'C' },
];

function makeController() {
  const storage = new MemoryRoomStorage();
  const controller = new RoomController('room-1', storage, { turnTimeoutMs: 30_000, now: () => 1_000 });
  return { storage, controller };
}

/** 取某用户的 state 帧视图 */
function viewOf(frames: Map<string, StateFrame>, uid: string): ClientView {
  const f = frames.get(uid);
  assert.ok(f, `应有 ${uid} 的状态帧`);
  return f.view;
}

/** 当前行动者 id（从视图推导） */
function toActId(view: ClientView): string {
  assert.notEqual(view.toAct, null, '应有人待行动');
  const idx = view.toAct as number;
  return view.players[idx].id;
}

/** 取某用户当前的合法行动集合 */
function legalOf(frames: Map<string, StateFrame>, uid: string) {
  const f = frames.get(uid);
  assert.ok(f);
  return f!.legal;
}

/** 筹码守恒：Σ(chips + totalBetThisHand) === 初始总筹码（下注阶段） */
function assertChipsConserved(view: ClientView, expectedTotal: number) {
  const sum = view.players.reduce((acc, p) => acc + p.chips + p.totalBetThisHand, 0);
  assert.equal(sum, expectedTotal, '筹码必须守恒');
}

// ---------------------------------------------------------------------------
// 核心引擎直测辅助
// ---------------------------------------------------------------------------

const TOTAL_CHIPS = MEMBERS.length * CONFIG.startingChips;

/** 开一手新牌局（可复现种子），返回开局后状态 */
function newTable(seed: number): GameState {
  return startHand(createTable('r', CONFIG, MEMBERS), createRng(seed));
}

function sumChips(s: GameState): number {
  return s.players.reduce((a, p) => a + p.chips, 0);
}

function sumTotalBet(s: GameState): number {
  return s.players.reduce((a, p) => a + p.totalBetThisHand, 0);
}

/** 从合法集合里可复现地挑一个行动（bet/raise 取最小额，保证合法） */
function pickAction(legal: LegalAction[], salt: number): Action {
  const r = createRng(salt)();
  const idx = Math.floor(r * legal.length) % legal.length;
  const l = legal[idx];
  switch (l.type) {
    case 'fold':
      return { type: 'fold' };
    case 'check':
      return { type: 'check' };
    case 'call':
      return { type: 'call' };
    case 'allIn':
      return { type: 'allIn' };
    case 'bet':
      return { type: 'bet', amount: l.min };
    case 'raise':
      return { type: 'raise', amount: l.min };
    default:
      return { type: 'fold' };
  }
}

/** 确定性状态哈希（FNV-1a over 规范化序列化），用于重放一致性校验 */
function hashState(s: GameState): string {
  const json = JSON.stringify(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// 控制器编排测试
// ---------------------------------------------------------------------------

test('init → connect 拿到 waiting 视图与配置', async () => {
  const { controller } = makeController();
  await controller.init(CONFIG, MEMBERS, 'u1');
  const { welcome, stateFrame } = await controller.connect('u1', 'A', 0);
  assert.equal(welcome.config?.name, '测试房');
  assert.equal(welcome.hostId, 'u1');
  assert.ok(stateFrame, '应有状态帧');
  assert.equal(stateFrame!.view.street, 'waiting');
  assert.equal(stateFrame!.view.players.length, 3);
});

test('init 幂等：重复 init 不产生新状态', async () => {
  const { controller } = makeController();
  const r1 = await controller.init(CONFIG, MEMBERS, 'u1');
  const r2 = await controller.init(CONFIG, MEMBERS, 'u1');
  assert.equal(r1.kind, 'state');
  assert.equal(r2.kind, 'noop');
});

test('host 开局 → 进入 preflop，仅行动者有合法行动', async () => {
  const { controller } = makeController();
  await controller.init(CONFIG, MEMBERS, 'u1');
  const r = await controller.startHand('u1');
  assert.equal(r.kind, 'state');
  if (r.kind !== 'state') return;
  const view = viewOf(r.frames, 'u1');
  assert.equal(view.street, 'preflop');
  assert.notEqual(view.toAct, null);
  // 行动者非空，旁观者为空
  const actor = toActId(view);
  assert.ok(legalOf(r.frames, actor).length > 0, '行动者应有合法行动');
  for (const uid of ['u1', 'u2', 'u3']) {
    if (uid === actor) continue;
    assert.equal(legalOf(r.frames, uid).length, 0, `${uid} 非行动者应为空合法集合`);
  }
  assertChipsConserved(view, TOTAL_CHIPS);
});

test('非房主不能开局', async () => {
  const { controller } = makeController();
  await controller.init(CONFIG, MEMBERS, 'u1');
  const r = await controller.startHand('u2');
  assert.equal(r.kind, 'error');
  if (r.kind === 'error') assert.equal(r.code, 'NOT_HOST');
});

test('非行动者行动 → NOT_YOUR_TURN；非法金额 → 错误码', async () => {
  const { controller } = makeController();
  await controller.init(CONFIG, MEMBERS, 'u1');
  const r0 = await controller.startHand('u1');
  assert.equal(r0.kind, 'state');
  if (r0.kind !== 'state') return;
  const actor = toActId(viewOf(r0.frames, 'u1'));
  const bystander = ['u1', 'u2', 'u3'].find((u) => u !== actor)!;

  const r1 = await controller.handleAction(bystander, { type: 'check' });
  assert.equal(r1.kind, 'error');
  if (r1.kind === 'error') assert.equal(r1.code, 'NOT_YOUR_TURN');

  // 行动者下注一个远低于最小下注的"魔法金额"
  const r2 = await controller.handleAction(actor, { type: 'bet', amount: 1 });
  assert.equal(r2.kind, 'error');
  if (r2.kind === 'error') assert.ok(['BELOW_MIN_RAISE', 'INSUFFICIENT_CHIPS'].includes(r2.code), `应为下注类错误，实为 ${r2.code}`);
});

test('完整推进一手：循环行动直至结算，筹码守恒', async () => {
  const { controller } = makeController();
  await controller.init(CONFIG, MEMBERS, 'u1');
  const initial = TOTAL_CHIPS;
  let r = await controller.startHand('u1');
  assert.equal(r.kind, 'state');
  if (r.kind !== 'state') return;

  // 最多 200 步，模拟"能过牌就过牌、否则跟注、否则弃牌"
  let steps = 0;
  while (steps++ < 200) {
    const view = viewOf(r.frames, 'u1');
    if (view.street === 'complete') break;
    const actor = toActId(view);
    const legal = legalOf(r.frames, actor);
    assert.ok(legal.length > 0, '行动者必有合法行动');
    const pick =
      legal.find((l) => l.type === 'check') ??
      legal.find((l) => l.type === 'call') ??
      legal[0];
    const action =
      pick.type === 'check'
        ? { type: 'check' as const }
        : pick.type === 'call'
          ? { type: 'call' as const }
          : pick.type === 'fold'
            ? { type: 'fold' as const }
            : { type: 'allIn' as const };
    r = await controller.handleAction(actor, action);
    assert.equal(r.kind, 'state', `行动应成功，实为 ${(r as { kind: string }).kind}`);
    // 下注阶段守恒：Σ(chips + totalBetThisHand) === 初始；结算后该式不再成立
    const nv = viewOf(r.frames, 'u1');
    if (nv.street !== 'complete') assertChipsConserved(nv, initial);
  }
  const finalView = viewOf(r.frames, 'u1');
  assert.equal(finalView.street, 'complete', '应结算完成');
  // 结算后：所有筹码（不含已清零的 totalBetThisHand）之和必须等于初始总筹码
  const chipSum = finalView.players.reduce((acc, p) => acc + p.chips, 0);
  assert.equal(chipSum, initial, '结算后桌上总筹码必须守恒');
});

test('聊天广播', async () => {
  const { controller } = makeController();
  await controller.init(CONFIG, MEMBERS, 'u1');
  const r = await controller.handleChat('u2', '  大家好  ');
  assert.equal(r.kind, 'chat');
  if (r.kind === 'chat') {
    assert.equal(r.frame.fromId, 'u2');
    assert.equal(r.frame.text, '大家好');
    assert.equal(r.frame.fromName, 'B');
  }
  // 空聊天被忽略
  const r2 = await controller.handleChat('u2', '   ');
  assert.equal(r2.kind, 'noop');
});

test('断线重连：落后序号时经 rebuild 补齐状态（真实 action_log 重放）', async () => {
  const { controller } = makeController();
  await controller.init(CONFIG, MEMBERS, 'u1');
  let r = await controller.startHand('u1');
  assert.equal(r.kind, 'state');
  if (r.kind !== 'state') return;
  const startSeq = r.frames.get('u1')!.seq;

  // 模拟 3~5 步合法行动，使广播序号显著大于开局时的 startSeq（actionSeq 已 > 0）
  let steps = 0;
  while (steps < 5) {
    const view = viewOf(r.frames, 'u1');
    if (view.street === 'complete') break;
    const actor = toActId(view);
    const legal = legalOf(r.frames, actor);
    const pick =
      legal.find((l) => l.type === 'check') ??
      legal.find((l) => l.type === 'call') ??
      legal[0];
    const action =
      pick.type === 'check'
        ? { type: 'check' as const }
        : pick.type === 'call'
          ? { type: 'call' as const }
          : pick.type === 'fold'
            ? { type: 'fold' as const }
            : { type: 'allIn' as const };
    r = await controller.handleAction(actor, action);
    assert.equal(r.kind, 'state', `行动应成功，实为 ${(r as { kind: string }).kind}`);
    steps++;
  }
  const currentSeq = r.frames.get('u1')!.seq;
  assert.ok(currentSeq > startSeq, `应已发生多步行动使序号递增（start=${startSeq}, now=${currentSeq}）`);

  // 用落后序号（lastSeq=0）重连，应经 rebuild（hand_initial + actions 重放）补齐
  const { stateFrame } = await controller.connect('u1', 'A', 0);
  assert.ok(stateFrame, '重连应返回状态帧');
  assert.equal(stateFrame!.seq, currentSeq, '重连帧序号应与当前权威状态一致');
  assert.notEqual(stateFrame!.view.street, 'waiting', '重连后应处于对局中');
  // 非本人手牌不得泄露
  for (const p of stateFrame!.view.players) {
    if (p.id !== 'u1') assert.equal(p.holeCards.length, 0, '不应看到他人手牌');
    else assert.equal(p.holeCards.length, 2, '本人应看到自己两张底牌');
  }
});

test('超时裁决：轮到某人且无法过牌则弃牌，回合推进', async () => {
  const { controller } = makeController();
  await controller.init(CONFIG, MEMBERS, 'u1');
  // 开局后第一个行动者（UTG）面对已有盲注，callAmount>0，无法过牌 → 超时=弃牌
  const r0 = await controller.startHand('u1');
  assert.equal(r0.kind, 'state');
  if (r0.kind !== 'state') return;
  const before = viewOf(r0.frames, 'u1');
  const actor = toActId(before);
  const r = await controller.handleTimeout();
  assert.equal(r.kind, 'state');
  if (r.kind !== 'state') return;
  const after = viewOf(r.frames, 'u1');
  // 该玩家状态应为 folded
  const folded = after.players.find((p) => p.id === actor);
  assert.equal(folded?.status, 'folded', '超时玩家应弃牌');
  assertChipsConserved(after, TOTAL_CHIPS);
});

test('视图不含 deck，且不泄露他人手牌（反向验证 deck 永不外泄）', async () => {
  const { controller } = makeController();
  await controller.init(CONFIG, MEMBERS, 'u1');
  const r = await controller.startHand('u1');
  assert.equal(r.kind, 'state');
  if (r.kind !== 'state') return;
  const actor = toActId(viewOf(r.frames, 'u1'));
  for (const uid of ['u1', 'u2', 'u3']) {
    const f = r.frames.get(uid)! as StateFrame;
    // deck 不得出现在客户端视图中（类型与序列化双重保险）
    assert.ok(!('deck' in f.view), `${uid} 的 view 不应含 deck 字段`);
    assert.ok(
      !JSON.stringify(f.view).includes('"deck"'),
      `${uid} 的 view 序列化不应含 deck 字符串`,
    );
    for (const p of f.view.players) {
      if (p.id !== uid) assert.equal(p.holeCards.length, 0, `${uid} 不应看到 ${p.id} 的手牌`);
      else assert.equal(p.holeCards.length, 2, '本人应看到自己两张底牌');
    }
  }
  void actor;
});

// ---------------------------------------------------------------------------
// 核心引擎直测（与控制器编排正交）
// ---------------------------------------------------------------------------

test('a) min-raise：A 加注到 100，B 再加注到 250，下一手最小加注额 = 150', () => {
  let s = newTable(1);
  assert.equal(s.currentBet, 20, '开局后 currentBet = 大盲 20');
  assert.equal(s.minRaise, 20, '开局后 minRaise = 大盲 20');

  const raiseTo = (amt: number) => {
    const idx = s.toAct!;
    const p = s.players[idx];
    const res = applyAction(s, { type: 'raise', amount: amt }, p.id);
    if ('error' in res) throw new Error(`raise ${amt} 失败: ${res.error}`);
    s = res;
  };

  raiseTo(100); // 完整加注到 100：minRaise -> 80
  assert.equal(s.currentBet, 100);
  assert.equal(s.minRaise, 80, '一次完整加注后 minRaise 应为增量 80');

  raiseTo(250); // 完整加注到 250：minRaise -> 150
  assert.equal(s.minRaise, 150, '两次完整加注后最小加注增量应为 150');

  // 下一个行动者的合法加注下限 = currentBet + minRaise = 250 + 150 = 400
  const legal = getLegalActions(s, s.players[s.toAct!].id);
  const raise = legal.find((l) => l.type === 'raise') as { min: number } | undefined;
  assert.ok(raise, '应仍允许加注');
  assert.equal(raise!.min, 400, '下一手最小加注额 = 250 + 150 = 400');
});

test('b) 短码全押不污染 raiseCapped：A 完整加注 → B 短码全押 → C 仍可 re-raise', () => {
  let s = newTable(3);
  // 3-handed：button=seat0, SB=seat1, BB=seat2, UTG=seat0。先用一次完整加注制造 currentBet=100。
  const firstActor = s.players[s.toAct!];
  const res1 = applyAction(s, { type: 'raise', amount: 100 }, firstActor.id);
  assert.ok(!('error' in res1), '首轮加注到 100 应合法');
  s = res1 as GameState;
  assert.equal(s.currentBet, 100);

  // 轮到下一个玩家（SB），设为短码（仅 120 筹码）后全押：
  // 全押总投入 = betThisRound(5) + 120 = 125，delta = 125-100 = 25 < minRaise → 短码全押。
  const idx = s.toAct!;
  const shortie = s.players[idx];
  shortie.chips = 120;
  const res2 = applyAction(s, { type: 'allIn' }, shortie.id);
  assert.ok(!('error' in res2), '短码全押应合法');
  s = res2 as GameState;
  // 契约修正：短码全押只是"本次不算 raise"，绝不置 raiseCapped，currentBet 也不抬高。
  assert.equal(s.isFullRaise, false, '短码全押 isFullRaise 必须为 false');
  assert.equal(s.raiseCapped, false, '短码全押不得污染 raiseCapped（下一位仍可 re-raise）');
  assert.equal(s.currentBet, 100, 'currentBet 不应被不足额全押抬高');

  // 下一位仍可行动并能够加注（raiseCapped 未被污染）
  const nextId = s.players[s.toAct!].id;
  const legal = getLegalActions(s, nextId);
  assert.ok(
    legal.some((l) => l.type === 'raise'),
    `${nextId} 在短码全押后仍应能 re-raise（raiseCapped 未被污染）`,
  );
});

test('c) 牌型：A-2-3-4-5 是合法顺子，K-A-2-3-4 不是顺子', () => {
  const C = (rank: number, suit: 's' | 'h' | 'd' | 'c'): Card => ({ rank, suit });

  // 轮顺 A-2-3-4-5（A 作 1），另加两张无关踢脚
  const wheel = evaluate([
    C(14, 's'), C(2, 'h'), C(3, 'd'), C(4, 'c'), C(5, 's'), C(9, 'h'), C(11, 'd'),
  ]);
  assert.equal(wheel.category, 'straight', 'A-2-3-4-5 应为顺子');
  assert.equal(wheel.tiebreak[0], 5, '轮顺高点应为 5');

  // K-A-2-3-4：A 只能作高牌（14），不构成连续五张
  const notStraight = evaluate([
    C(13, 's'), C(14, 'h'), C(2, 'd'), C(3, 'c'), C(4, 's'), C(9, 'h'), C(11, 'd'),
  ]);
  assert.notEqual(notStraight.category, 'straight', 'K-A-2-3-4 不应是顺子');
});

test('d) 边池：三人分别以 200/500/1000 全押，切分为 3 个池且 eligible 正确', () => {
  // computePots 仅依赖 players 的 totalBetThisHand / status / id
  const fake = {
    players: [
      { id: 'p1', status: 'allIn', totalBetThisHand: 200 },
      { id: 'p2', status: 'allIn', totalBetThisHand: 500 },
      { id: 'p3', status: 'allIn', totalBetThisHand: 1000 },
    ],
  } as unknown as GameState;

  const pots = computePots(fake);
  assert.equal(pots.length, 3, '应切分出 3 个池');
  assert.deepEqual(pots.map((p) => p.amount), [600, 600, 500], '各池金额应为 [600, 600, 500]');
  assert.deepEqual(pots[0].eligible, ['p1', 'p2', 'p3'], '主池三方均可争');
  assert.deepEqual(pots[1].eligible, ['p2', 'p3'], '第一边池仅 p2/p3 可争');
  assert.deepEqual(pots[2].eligible, ['p3'], '第二边池仅 p3 可争');
});

test('e) 筹码守恒 fuzz：1000 手，每手前后 Σ(chips+totalBet) 与 Σ(chips) 严格相等', () => {
  // 守恒说明：盲注在 startHand 内即已扣入 totalBetThisHand，故"手开始/进行中"
  // 的守恒量为 Σ(chips + totalBetThisHand)；结算后底池已 award 回 chips、
  // totalBetThisHand 仅作下一手重置前的陈旧字段，故"手结束"时守恒量为 Σ(chips)。
  let s0 = createTable('r', CONFIG, MEMBERS);
  for (let h = 0; h < 1000; h++) {
    const rng = createRng(h + 1);
    let s = startHand(s0, rng);

    if (s.street === 'complete') {
      // 参与者不足两手牌即结束（已有玩家破产），仅校验总筹码后继续
      assert.equal(sumChips(s), TOTAL_CHIPS, `第 ${h} 手（提前结束）Σ(chips) 守恒`);
      s0 = s;
      continue;
    }
    // 手开始时（盲注已下）：Σ(chips + totalBetThisHand) = 总筹码
    assert.equal(sumChips(s) + sumTotalBet(s), TOTAL_CHIPS, `第 ${h} 手开始 Σ(chips+totalBet) 守恒`);

    let guard = 0;
    while (s.street !== 'complete' && guard++ < 500) {
      const idx = s.toAct;
      if (idx === null) break;
      const p = s.players[idx];
      const legal = getLegalActions(s, p.id);
      if (legal.length === 0) break;
      const action = pickAction(legal, h * 1000 + guard);
      const res = applyAction(s, action, p.id);
      if ('error' in res) break;
      s = res;
      // 结算前（street 仍在进行）：Σ(chips + totalBetThisHand) 恒等于总筹码
      if (s.street !== 'complete') {
        assert.equal(
          sumChips(s) + sumTotalBet(s),
          TOTAL_CHIPS,
          `第 ${h} 手第 ${guard} 步 Σ(chips+totalBet) 守恒`,
        );
      }
    }

    assert.equal(s.street, 'complete', `第 ${h} 手应可结算`);
    // 手结束时：底池已分配回玩家，Σ(chips) = 总筹码
    assert.equal(sumChips(s), TOTAL_CHIPS, `第 ${h} 手结束 Σ(chips) 守恒`);
    s0 = s;
  }
});

test('f) 重放确定性：同种子 + 同 action log 重放，状态哈希一致', () => {
  const rng = createRng(42);
  const initial = startHand(createTable('r', CONFIG, MEMBERS), rng);
  const log: { playerId: string; action: Action }[] = [];

  let s = initial;
  let guard = 0;
  while (s.street !== 'complete' && guard++ < 500) {
    const idx = s.toAct;
    if (idx === null) break;
    const p = s.players[idx];
    const legal = getLegalActions(s, p.id);
    if (legal.length === 0) break;
    const action = pickAction(legal, guard + 100);
    log.push({ playerId: p.id, action });
    const res = applyAction(s, action, p.id);
    if ('error' in res) break;
    s = res;
  }
  const final = s;

  const r1 = replay(initial, log);
  const r2 = replay(initial, log);
  assert.equal(hashState(r1), hashState(r2), '两次重放哈希一致');
  assert.equal(hashState(r1), hashState(final), '重放结果与原终态哈希一致');
});

test('g) 跳街：3 人 preflop 全押，转牌/河牌社区牌照常发出', () => {
  let s = newTable(7);
  // 三人依次全押（按引擎当前 toAct 顺序）：preflop 即全员 all-in，
  // 应"跳过所有下注轮、但继续发社区牌"，直接把转牌/河牌发满到 5 张并结算。
  let guard = 0;
  while (s.street !== 'complete' && s.toAct !== null && guard++ < 10) {
    const p = s.players[s.toAct];
    const res = applyAction(s, { type: 'allIn' }, p.id);
    assert.ok(!('error' in res), `${p.id} 全押应合法（street=${s.street}）`);
    s = res as GameState;
  }
  assert.equal(s.board.length, 5, '三人 all-in 后社区牌应发满 5 张（转牌/河牌正常发出，未被吞掉）');
  assert.equal(s.street, 'complete', '应进入结算（showdown → complete）');
});

test('h) 边池恒等式 fuzz 1000 局：Σpot.amount + Σuncalled = ΣtotalBetThisHand', () => {
  // 恒等式：结算时底池金额（computePots 已按"被跟注水平" cap）加上退回的未跟注注码，
  // 必须严格等于本手所有玩家的总投入。全员弃牌的特殊分支（pots=[]，注码全退）不套用此式。
  let s0 = createTable('r', CONFIG, MEMBERS);
  for (let h = 0; h < 1000; h++) {
    const rng = createRng(h + 1);
    let s = startHand(s0, rng);
    if (s.street === 'complete') {
      s0 = s;
      continue;
    }

    let guard = 0;
    while (s.street !== 'complete' && guard++ < 500) {
      const idx = s.toAct;
      if (idx === null) break;
      const p = s.players[idx];
      const legal = getLegalActions(s, p.id);
      if (legal.length === 0) break;
      const action = pickAction(legal, h * 1000 + guard);
      const res = applyAction(s, action, p.id);
      if ('error' in res) break;
      s = res;
    }

    const nonFolded = s.players.filter((p) => p.status !== 'folded' && p.status !== 'out');
    if (nonFolded.length === 0) {
      s0 = s;
      continue; // 全员弃牌：pots=[]，注码全退，走 settle 的特殊分支
    }

    // 复刻 settle 的"被跟注水平" maxCalled 逻辑
    const totals = nonFolded.map((p) => p.totalBetThisHand);
    const maxTotal = Math.max(...totals);
    const secondMax = totals.some((t) => t < maxTotal)
      ? Math.max(...totals.filter((t) => t < maxTotal))
      : 0;
    const topCount = totals.filter((t) => t === maxTotal).length;
    const maxCalled = topCount > 1 ? maxTotal : secondMax;

    const potSum = s.pots.reduce((a, pot) => a + pot.amount, 0);
    const uncalledSum = s.players.reduce((a, p) => a + Math.max(0, p.totalBetThisHand - maxCalled), 0);
    const totalBet = s.players.reduce((a, p) => a + p.totalBetThisHand, 0);
    assert.equal(
      potSum + uncalledSum,
      totalBet,
      `第 ${h} 局边池恒等式：pot(${potSum}) + uncalled(${uncalledSum}) = total(${totalBet})`,
    );
    s0 = s;
  }
});
