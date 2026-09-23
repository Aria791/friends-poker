// test/core/engine.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Card, GameState, RoomConfig } from '../../shared/types';
import { createTable, startHand, applyAction, toView, replay, serialize } from '../../core/game';
import { getLegalActions } from '../../core/rules/betting';
import { computePots } from '../../core/rules/pots';
import { createRng } from '../../core/rng';

const CONFIG: RoomConfig = {
  name: 'test',
  startingChips: 1000,
  smallBlind: 5,
  bigBlind: 10,
};

function table(n: number, cfg = CONFIG): GameState {
  const members = Array.from({ length: n }, (_, i) => ({
    id: 'p' + i,
    nickname: 'P' + i,
    seat: i,
  }));
  return createTable('room', cfg, members);
}

test('开局：发牌、盲注、先手正确', () => {
  const s0 = table(4);
  const s = startHand(s0);
  assert.equal(s.handNumber, 1);
  assert.equal(s.deck.length, 44); // 4 人 × 2 张已发，52 - 8
  // 每人两张底牌
  for (const p of s.players) assert.equal(p.holeCards.length, 2);
  assert.equal(s.board.length, 0);
  // 盲注已扣
  const totalCommitted = s.players.reduce((a, p) => a + p.totalBetThisHand, 0);
  assert.equal(totalCommitted, 15); // SB 5 + BB 10
  assert.equal(s.currentBet, 10);
  assert.equal(s.minRaise, 10);
  // 先手是 UTG（BB 之后、button 之后的活跃玩家）
  const toAct = s.players[s.toAct!];
  assert.ok(toAct);
  // 4 人：button=seat0, SB=seat1, BB=seat2, UTG=seat3
  assert.equal(s.players[s.toAct!].seat, 3);
});

test('heads-up：SB=button，BB 先动', () => {
  const s0 = table(2);
  const s = startHand(s0);
  // button 落在 seat0（首手 nextSeat(-1)=0），SB=button=seat0，BB=seat1
  assert.equal(s.button, 0);
  // BB（seat1）先动
  assert.equal(s.players[s.toAct!].seat, 1);
  // heads-up 翻前 BB 拥有"过牌/加注"选项（BB 选项），合法行动中应含 check
  const legal = getLegalActions(s, 'p1');
  assert.ok(legal.some((l) => l.type === 'check'));
});

test('最小加注：raise 后 minRaise = 增量，且低于最小加注被拒', () => {
  const s0 = table(4);
  let s = startHand(s0); // toAct = UTG (seat3)
  const utg = 'p3';
  // 不足最小加注（currentBet=10，minRaise=10，raiseTo=15 → delta 5）
  const bad = applyAction(s, { type: 'raise', amount: 15 }, utg);
  assert.ok('error' in bad);
  assert.equal((bad as { error: string }).error, 'BELOW_MIN_RAISE');
  // 合法加注到 20（delta 10 = minRaise）
  s = applyAction(s, { type: 'raise', amount: 20 }, utg) as GameState;
  assert.equal(s.currentBet, 20);
  assert.equal(s.minRaise, 10); // delta
  // 加注后轮到 p0（button），此时可再加注，min raiseTo = 20 + 10 = 30
  const legal0 = getLegalActions(s, 'p0');
  const r0 = legal0.find((l) => l.type === 'raise') as { min: number; max: number };
  assert.equal(r0.min, 30);
});

test('a) 短码全押不污染 raiseCapped：A 完整加注 → B 短码全押 → C 仍可 re-raise', () => {
  // 构造 flop 局面：currentBet=100, minRaise=100，三人均已跟到 100。
  const C = (rank: number, suit: 's' | 'h' | 'd' | 'c'): Card => ({ rank, suit });
  const base: GameState = {
    roomId: 'r',
    players: [
      { id: 'p0', nickname: 'A', chips: 1000, holeCards: [C(14, 's'), C(13, 's')], status: 'active', betThisRound: 100, totalBetThisHand: 100, seat: 0, isBot: false },
      { id: 'p1', nickname: 'B', chips: 80, holeCards: [C(14, 'h'), C(13, 'h')], status: 'active', betThisRound: 100, totalBetThisHand: 100, seat: 1, isBot: false },
      { id: 'p2', nickname: 'C', chips: 1000, holeCards: [C(14, 'd'), C(13, 'd')], status: 'active', betThisRound: 100, totalBetThisHand: 100, seat: 2, isBot: false },
    ],
    deck: [],
    board: [C(2, 'c'), C(3, 'd'), C(4, 's'), C(5, 'h'), C(7, 'c')],
    street: 'flop',
    pots: [],
    currentBet: 100,
    minRaise: 100,
    toAct: 0,
    button: 2,
    smallBlind: 5,
    bigBlind: 10,
    handNumber: 1,
    actionSeq: 0,
    version: 0,
    numToAct: 2,
    raiseCapped: false,
    isFullRaise: false,
    fullRaiseCount: 0,
  };

  // A 完整加注到 200：delta=100 >= minRaise(100) → 完整；currentBet=200, minRaise=100
  const r1 = applyAction(base, { type: 'raise', amount: 200 }, 'p0');
  assert.ok(!('error' in r1), 'A 加注到 200 应合法');
  const s1 = r1 as GameState;
  assert.equal(s1.isFullRaise, true, 'A 的加注应为完整加注');
  assert.equal(s1.currentBet, 200);
  assert.equal(s1.minRaise, 100);

  // B 短码全押：总投入 180（100 已跟 + 80 全押），delta=180-200=-20 < minRaise → 短码。
  // 短码全押只是"本次不算 raise"，不得置 raiseCapped，currentBet 也不应被抬高。
  const r2 = applyAction(s1, { type: 'allIn' }, 'p1');
  assert.ok(!('error' in r2), 'B 短码全押应合法');
  const s2 = r2 as GameState;
  assert.equal(s2.isFullRaise, false, '短码全押 isFullRaise 必须为 false');
  assert.equal(s2.raiseCapped, false, '短码全押不得污染 raiseCapped（下一位仍可 re-raise）');
  assert.equal(s2.currentBet, 200, '短码全押不应抬高 currentBet');

  // C 仍可 re-raise：min raiseTo = currentBet + minRaise = 200 + 100 = 300
  const legalC = getLegalActions(s2, 'p2');
  const raiseC = legalC.find((l) => l.type === 'raise') as { min: number } | undefined;
  assert.ok(raiseC, 'C 在短码全押后必须仍可加注（raiseCapped 未被污染）');
  assert.equal(raiseC!.min, 300, 'C 的最小加注额 = 200 + 100 = 300');
});

test('边池：三人不同 all-in 切分正确', () => {
  const s = table(4);
  // 手工构造结算前状态
  s.players[0].totalBetThisHand = 100;
  s.players[1].totalBetThisHand = 180;
  s.players[2].totalBetThisHand = 250;
  s.players[3].totalBetThisHand = 100; // 第4人弃牌前投入 100（死钱），仍进池
  s.players[3].status = 'folded';
  const pots = computePots(s);
  const amounts = pots.map((p) => p.amount).sort((a, b) => a - b);
  assert.deepEqual(amounts, [70, 160, 400]);
  // 主池：4 人各 100 = 400
  assert.equal(pots[0].amount, 400);
});

test('客户端视图：不含 deck，他人手牌为空', () => {
  const s0 = table(3);
  const s = startHand(s0);
  const view = toView(s, 'p0');
  // 直接检查 toView 返回值本身不含 deck 字段（而非检查外层的 StateFrame）
  assert.ok(!('deck' in toView(s, 'p0')), 'toView 返回值不得含 deck 字段');
  assert.ok(!JSON.stringify(toView(s, 'p0')).includes('"deck"'), 'toView 序列化不得含 deck');
  assert.equal((view as any).deck, undefined);
  const me = view.players.find((p) => p.id === 'p0')!;
  assert.equal(me.holeCards.length, 2);
  const other = view.players.find((p) => p.id === 'p1')!;
  assert.equal(other.holeCards.length, 0);
});

test('重放：相同 action 日志逐字节一致', () => {
  const s0 = table(4);
  const initial = startHand(s0); // 捕获含本局牌堆的初始状态
  let s = initial;
  const log: { playerId: string; action: any }[] = [];
  const rng = createRng(12345);
  let guard = 0;
  while (s.street !== 'complete' && guard++ < 500) {
    const id = s.players[s.toAct!].id;
    const legal = getLegalActions(s, id);
    const pick = legal[Math.floor(rng() * legal.length)];
    let action: any = { type: pick.type };
    if (pick.type === 'bet' || pick.type === 'raise') {
      action.amount = pick.min + Math.floor(rng() * (pick.max - pick.min + 1));
    }
    log.push({ playerId: id, action });
    const r = applyAction(s, action, id);
    assert.ok(!('error' in r), 'random action must be legal');
    s = r as GameState;
  }
  // 从同一初始状态（同一牌堆）重放，必须逐字节一致
  const replayed = replay(initial, log);
  assert.equal(serialize(replayed), serialize(s));
});

// ---------------------------------------------------------------------------
// 筹码守恒 Fuzz：随机驱动数千手，硬校验不变量
// ---------------------------------------------------------------------------

function fuzzOneSeed(seed: number): number {
  const rng = createRng(seed);
  let state = table(6);
  let handsPlayed = 0;
  const HANDS = 1500;
  for (let h = 0; h < HANDS; h++) {
    state = startHand(state, rng); // 牌堆也可复现，确保确定性
    if (state.street === 'complete') {
      state = table(6);
      continue;
    }
    handsPlayed++;

    const initialTotal = state.players.reduce((a, p) => a + p.chips, 0) +
      state.players.reduce((a, p) => a + p.totalBetThisHand, 0);

    const dealt = state.players.filter((p) => p.holeCards.length === 2).length;
    assert.equal(state.deck.length, 52 - 2 * dealt);

    let guard = 0;
    while (state.street !== 'complete' && guard++ < 2000) {
      const live = state.players.reduce((a, p) => a + p.chips, 0) +
        state.players.reduce((a, p) => a + p.totalBetThisHand, 0);
      assert.equal(live, initialTotal, 'chip conservation violated (betting phase)');

      // 无重复牌（底牌 + 公共牌）
      const keys = new Set<string>();
      const allCards = [
        ...state.players.flatMap((p) => p.holeCards),
        ...state.board,
      ];
      for (const c of allCards) {
        const k = c.rank + c.suit;
        assert.ok(!keys.has(k), 'duplicate card dealt: ' + k);
        keys.add(k);
      }
      assert.equal(allCards.length, keys.size);

      const id = state.players[state.toAct!].id;
      const legal = getLegalActions(state, id);
      assert.ok(legal.length > 0, 'toAct player must have legal actions');
      const pick = legal[Math.floor(rng() * legal.length)];
      let action: any = { type: pick.type };
      if (pick.type === 'bet' || pick.type === 'raise') {
        action.amount = pick.min + Math.floor(rng() * (pick.max - pick.min + 1));
      }
      const r = applyAction(state, action, id);
      assert.ok(!('error' in r), 'random legal action returned error: ' +
        ('error' in r ? (r as any).error : ''));
      state = r as GameState;
    }
    assert.ok(guard < 2000, 'hand did not terminate (possible infinite loop)');

    const finalTotal = state.players.reduce((a, p) => a + p.chips, 0);
    assert.equal(finalTotal, initialTotal, 'chips not conserved at showdown');
  }
  assert.ok(handsPlayed > 0, 'should have played at least one hand');
  return handsPlayed;
}

test('Fuzz：筹码守恒 + 无重复牌 + 必然终止（多随机种子）', () => {
  // 多个固定种子，确定性地覆盖多种牌堆/局面；任一不变量被破坏即失败
  const seeds = [20260922, 7, 99, 123456, 555, 8675309, 42, 314159];
  let total = 0;
  for (const seed of seeds) total += fuzzOneSeed(seed);
  assert.ok(total > 5000, 'should have played thousands of hands, got ' + total);
});

// ---------------------------------------------------------------------------
// 针对 code review 指出的具体 bug 的回归测试
// ---------------------------------------------------------------------------

test('Bug1) 短码 raise：target 超筹码时按 actual 真实投入，minRaise 按 actual 计算', () => {
  // 构造 flop 局面：currentBet=100，p0 已跟到 100、仅剩 105 筹码；p1 跟到 100；p2 已弃牌。
  const C = (rank: number, suit: 's' | 'h' | 'd' | 'c'): Card => ({ rank, suit });
  const s: GameState = {
    roomId: 'r',
    players: [
      { id: 'p0', nickname: 'A', chips: 105, holeCards: [C(14, 's'), C(13, 's')], status: 'active', betThisRound: 100, totalBetThisHand: 100, seat: 0, isBot: false },
      { id: 'p1', nickname: 'B', chips: 500, holeCards: [C(14, 'h'), C(13, 'h')], status: 'active', betThisRound: 100, totalBetThisHand: 100, seat: 1, isBot: false },
      { id: 'p2', nickname: 'C', chips: 300, holeCards: [C(14, 'd'), C(13, 'd')], status: 'folded', betThisRound: 100, totalBetThisHand: 100, seat: 2, isBot: false },
    ],
    deck: [],
    board: [C(2, 'c'), C(3, 'd'), C(4, 's'), C(5, 'h'), C(7, 'c')],
    street: 'flop',
    pots: [],
    currentBet: 100,
    minRaise: 100,
    toAct: 0,
    button: 2,
    smallBlind: 5,
    bigBlind: 10,
    handNumber: 1,
    actionSeq: 0,
    version: 0,
    numToAct: 2,
    raiseCapped: false,
    isFullRaise: false,
    fullRaiseCount: 0,
  };

  // p0 想 raise 到 250，但只剩 105 筹码——应被钳制为全押到 205，而非报错或按 250 计。
  const res = applyAction(s, { type: 'raise', amount: 250 }, 'p0');
  assert.ok(!('error' in res), 'raise 应被接受（超出筹码部分被钳制为全押）');
  const ns = res as GameState;
  const p0 = ns.players[0];
  assert.equal(p0.chips, 0, '实际投入后筹码清零（钳制为全押）');
  assert.equal(p0.betThisRound, 205, '真实投入 = betThisRound + 全部剩余筹码 = 205');
  assert.equal(p0.totalBetThisHand, 205, '本手累计投入 = 205');
  assert.equal(p0.status, 'allIn', '不足额加注但筹码耗尽 → allIn');
  // minRaise 必须按 actual(205) 计算：delta = 205 - 100 = 105，而非按 target(250) 的 150。
  assert.equal(ns.minRaise, 105, 'minRaise 增量应按 actual 计算(105)，而非 target 的 150');
  assert.equal(ns.currentBet, 205, 'currentBet 应为实际投入 205，而非目标 250');
});

test('Bug2) 多人 all-in：skip 本街下注但社区牌继续发到 5 张（不吞街）', () => {
  let s = startHand(table(3)); // preflop，已发盲注与底牌
  // 让所有玩家在翻前全押；最后一手全押会触发 proceed→advanceStreet 递归发完剩余街。
  let guard = 0;
  while (s.street === 'preflop' && s.toAct !== null && guard++ < 20) {
    const id = s.players[s.toAct!].id;
    s = applyAction(s, { type: 'allIn' }, id) as GameState;
  }
  // 全员 all-in 场景下，applyAction 内部会一路 advanceStreet 直到 settle，社区牌必须发满 5 张。
  assert.equal(s.board.length, 5, '多人 all-in 仍须发满 5 张社区牌（整条街不得被吞掉）');
  assert.ok(s.street === 'showdown' || s.street === 'complete', '应进入结算');
});

test('Bug5) settle 退回未跟注注码：X 下注 500 / Y 仅能跟 350 全押，X 超额 150 退回，池仅 700', () => {
  // 构造 river 局面（currentBet=0，双方均可行动）：X 下注 500，Y 仅 350 筹码只能跟到全押。
  // Y 无法匹配 X 的 500，X 超过 350 的 150 必须退回，池只含被跟注的 700。
  const C = (rank: number, suit: 's' | 'h' | 'd' | 'c'): Card => ({ rank, suit });
  const s: GameState = {
    roomId: 'r',
    players: [
      { id: 'x', nickname: 'X', chips: 1000, holeCards: [C(14, 's'), C(13, 's')], status: 'active', betThisRound: 0, totalBetThisHand: 0, seat: 0, isBot: false },
      { id: 'y', nickname: 'Y', chips: 350, holeCards: [C(14, 'h'), C(13, 'h')], status: 'active', betThisRound: 0, totalBetThisHand: 0, seat: 1, isBot: false },
    ],
    deck: [],
    board: [C(2, 'c'), C(3, 'd'), C(4, 's'), C(5, 'h'), C(7, 'c')],
    street: 'river',
    pots: [],
    currentBet: 0,
    minRaise: 10,
    toAct: 0,
    button: 0,
    smallBlind: 5,
    bigBlind: 10,
    handNumber: 1,
    actionSeq: 0,
    version: 0,
    numToAct: 2,
    raiseCapped: false,
    isFullRaise: false,
    fullRaiseCount: 0,
  };

  // X 下注 500
  const r1 = applyAction(s, { type: 'bet', amount: 500 }, 'x');
  assert.ok(!('error' in r1), 'X 下注 500 应合法');
  const s1 = r1 as GameState;
  // Y 跟注（不足 500，钳制为全押到 350）
  const r2 = applyAction(s1, { type: 'call' }, 'y');
  assert.ok(!('error' in r2), 'Y 跟注 350 应合法（钳制为全押）');
  const ns = r2 as GameState;
  assert.ok(ns.street === 'showdown' || ns.street === 'complete', '应进入结算');

  // 池总额应为被跟注水平：350*2 = 700。X 超额 150 已退回，绝不应是 850。
  const potTotal = ns.pots.reduce((acc, p) => acc + p.amount, 0);
  assert.equal(potTotal, 700, '池仅含被跟注的 700，X 未跟注的 150 已退回（修复前会误算为 850）');

  // 筹码守恒：X(下注后剩 500 + 退回 150 + 可能池奖金) + Y(0 + 可能池奖金) = 1000+350 = 1350
  const chipSum = ns.players.reduce((acc, p) => acc + p.chips, 0);
  assert.equal(chipSum, 1350, '结算后总筹码必须守恒（含退回的未跟注注码）');

  // X 必须拿回至少 150 未跟注注码（无论 X 是否赢得底池）
  assert.ok(ns.players[0].chips >= 150, 'X 必须拿回至少 150 未跟注注码');
});

test('c) allIn 传任意 amount 都等价于全押（amount 参数被忽略）', () => {
  const amounts = [undefined, 0, 1, 50, 99999];
  for (const amt of amounts) {
    const s0 = startHand(table(3));
    const id = s0.players[s0.toAct!].id;
    const before = s0.players[s0.toAct!];
    const chipsBefore = before.chips;
    const betBefore = before.betThisRound;
    const res = applyAction(s0, { type: 'allIn', amount: amt }, id);
    assert.ok(!('error' in res), `allIn(${String(amt)}) 应合法`);
    const ns = res as GameState;
    const p = ns.players.find((x) => x.id === id)!;
    assert.equal(p.chips, 0, `allIn(${String(amt)}) 后筹码应清零`);
    assert.equal(p.betThisRound, betBefore + chipsBefore, `allIn(${String(amt)}) 真实投入应等于全部筹码（amount 参数被忽略）`);
    assert.equal(p.status, 'allIn', `allIn(${String(amt)}) 状态应为 allIn`);
  }
});

test('d) fuzz 1000 手：筹码守恒，且 raiseCapped 始终不被短码全押污染（默认不封顶）', () => {
  let s0 = createTable('r', CONFIG, [
    { id: 'p0', nickname: 'A' },
    { id: 'p1', nickname: 'B' },
    { id: 'p2', nickname: 'C' },
  ]);
  const TOTAL = 3000;
  for (let h = 0; h < 1000; h++) {
    const rng = createRng(h + 7);
    let s = startHand(s0, rng);
    if (s.street === 'complete') {
      s0 = s;
      continue;
    }
    const sumChips = (x: GameState) => x.players.reduce((a, p) => a + p.chips, 0);
    const sumTotalBet = (x: GameState) => x.players.reduce((a, p) => a + p.totalBetThisHand, 0);
    assert.equal(sumChips(s) + sumTotalBet(s), TOTAL, `第 ${h} 手开始 Σ(chips+totalBet) 守恒`);

    let guard = 0;
    while (s.street !== 'complete' && guard++ < 500) {
      // 默认不封顶：raiseCapped 在整个手牌中必须始终为 false（短码全押不得污染它）
      assert.equal(s.raiseCapped, false, `第 ${h} 手第 ${guard} 步 raiseCapped 应为 false（默认不封顶）`);
      const idx = s.toAct;
      if (idx === null) break;
      const p = s.players[idx];
      const legal = getLegalActions(s, p.id);
      if (legal.length === 0) break;
      const pick = legal[Math.floor(rng() * legal.length)];
      let action: any = { type: pick.type };
      if (pick.type === 'bet' || pick.type === 'raise') {
        action.amount = pick.min + Math.floor(rng() * (pick.max - pick.min + 1));
      }
      const res = applyAction(s, action, p.id);
      assert.ok(!('error' in res), '随机合法行动必须成功');
      s = res as GameState;
      if (s.street !== 'complete') {
        assert.equal(sumChips(s) + sumTotalBet(s), TOTAL, `第 ${h} 手第 ${guard} 步 Σ(chips+totalBet) 守恒`);
      }
    }
    assert.equal(s.street, 'complete', `第 ${h} 手应可结算`);
    assert.equal(s.players.reduce((a, p) => a + p.chips, 0), TOTAL, `第 ${h} 手结束 Σ(chips) 守恒`);
    s0 = s;
  }
});

test('e) 上限封顶：达到 maxRaisesPerStreet 后 raiseCapped=true，禁止再加注', () => {
  const C = (rank: number, suit: 's' | 'h' | 'd' | 'c'): Card => ({ rank, suit });
  const base: GameState = {
    roomId: 'r',
    players: [
      { id: 'p0', nickname: 'A', chips: 2000, holeCards: [C(14, 's'), C(13, 's')], status: 'active', betThisRound: 100, totalBetThisHand: 100, seat: 0, isBot: false },
      { id: 'p1', nickname: 'B', chips: 2000, holeCards: [C(14, 'h'), C(13, 'h')], status: 'active', betThisRound: 100, totalBetThisHand: 100, seat: 1, isBot: false },
      { id: 'p2', nickname: 'C', chips: 2000, holeCards: [C(14, 'd'), C(13, 'd')], status: 'active', betThisRound: 100, totalBetThisHand: 100, seat: 2, isBot: false },
    ],
    deck: [],
    board: [C(2, 'c'), C(3, 'd'), C(4, 's'), C(5, 'h'), C(7, 'c')],
    street: 'flop',
    pots: [],
    currentBet: 100,
    minRaise: 100,
    toAct: 0,
    button: 2,
    smallBlind: 5,
    bigBlind: 10,
    handNumber: 1,
    actionSeq: 0,
    version: 0,
    numToAct: 3,
    raiseCapped: false,
    isFullRaise: false,
    fullRaiseCount: 0,
    maxRaisesPerStreet: 2,
  };
  // A 完整加注到 200（count=1，未达上限）
  const s1 = applyAction(base, { type: 'raise', amount: 200 }, 'p0') as GameState;
  assert.equal(s1.fullRaiseCount, 1);
  assert.equal(s1.raiseCapped, false);
  // B 完整加注到 400（delta=200>=100，count=2）→ 达到上限，封顶
  const s2 = applyAction(s1, { type: 'raise', amount: 400 }, 'p1') as GameState;
  assert.equal(s2.fullRaiseCount, 2);
  assert.equal(s2.raiseCapped, true, '达到 maxRaisesPerStreet=2 后必须封顶');
  // C 不能再 raise/bet（只能 call/fold/allIn）
  const legalC = getLegalActions(s2, 'p2');
  assert.ok(
    !legalC.some((l) => l.type === 'raise' || l.type === 'bet'),
    '封顶后 C 不能再加注/下注',
  );
});
