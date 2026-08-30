/*!
 * 七王五二三 —— 对局引擎（状态机，前后端共用）
 * 单机模式在浏览器内运行；联机模式在服务端运行。规则完全一致。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./rules.js'));
  } else {
    root.QWEngine = factory(root.QWRules);
  }
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  var HAND_SIZE = 7;

  function Engine(opts) {
    opts = opts || {};
    var players = opts.players || [];
    if (players.length < 2 || players.length > 6) throw new Error('人数需在 2-6 之间');
    this.seed = opts.seed || (Date.now() % 2147483647);
    this.rng = R.mulberry32(this.seed);
    this.n = players.length;
    this.seats = players.map(function (p, i) {
      return {
        seat: i,
        name: p.name || ('玩家' + (i + 1)),
        isAI: !!p.isAI,
        avatar: p.avatar || (i % 8),
        hand: [],
        score: 0,
        won: [],          // 收到的分牌
        finished: false,
        rank: 0,
        connected: p.connected !== false,
        auto: false       // 托管中
      };
    });
    this.deck = R.shuffle(R.createDeck(), this.rng);
    for (var k = 0; k < HAND_SIZE; k++) {
      for (var s = 0; s < this.n; s++) this.seats[s].hand.push(this.deck.pop());
    }
    this.table = [];      // 本轮出牌 [{seat,cards,combo,kind}]
    this.top = null;       // {seat,cards,combo,kind}
    this.passes = [];      // 自 top 之后 pass 的座位
    this.roundNo = 1;
    this.phase = 'playing';
    this.finishOrder = [];
    this.events = [];
    this.result = null;
    this.actionSeq = 0;

    // 起手：持有全场最小牌者先出（通常为方块4/梅花4）
    var minSeat = 0, minP = Infinity, self = this;
    this.seats.forEach(function (p) {
      p.hand.forEach(function (c) {
        var v = R.cardPower(c);
        if (v < minP) { minP = v; minSeat = p.seat; }
      });
    });
    this.turn = minSeat;
    this.leader = minSeat;
    this.firstCard = null;
    this.seats[minSeat].hand.forEach(function (c) {
      if (R.cardPower(c) === minP) self.firstCard = c;
    });
    this.log('start', '发牌完毕，' + this.seats[minSeat].name + ' 手握最小牌 ' + R.label(this.firstCard) + '，先出');
  }

  Engine.prototype.log = function (type, text, extra) {
    var e = { id: ++this.actionSeq, type: type, text: text };
    if (extra) for (var k in extra) e[k] = extra[k];
    this.events.push(e);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    return e;
  };

  Engine.prototype.alivePlayers = function () {
    return this.seats.filter(function (p) { return !p.finished; });
  };

  // 可行动的座位：未打完名次 且 手上有牌
  Engine.prototype.canAct = function (seat) {
    var p = this.seats[seat];
    return !p.finished && p.hand.length > 0;
  };

  // 下一个可行动者（不含 from 自己）
  Engine.prototype.nextActor = function (from) {
    for (var i = 1; i < this.n; i++) {
      var s = (from + i) % this.n;
      if (this.canAct(s)) return s;
    }
    return -1;
  };
  // 从 from 开始（含 from）找任意可行动者
  Engine.prototype.anyActorFrom = function (from) {
    for (var i = 0; i < this.n; i++) {
      var s = (from + i) % this.n;
      if (this.canAct(s)) return s;
    }
    return -1;
  };

  Engine.prototype.tablePoints = function () {
    var t = 0, self = this;
    this.table.forEach(function (x) { t += R.pointsOf(x.cards); });
    return t;
  };

  /** 合法动作 */
  Engine.prototype.legalFor = function (seat) {
    if (this.phase !== 'playing' || this.turn !== seat || !this.canAct(seat)) return null;
    var p = this.seats[seat];
    var plays = R.legalPlays(p.hand, this.top ? this.top.combo : null);
    return {
      mustPlay: !this.top,
      canPass: !!this.top,
      plays: plays.map(function (x) {
        return { cards: x.cards, kind: x.kind, name: x.combo.name, type: x.combo.type };
      })
    };
  };

  /**
   * 执行动作
   * action = {seat, type:'play'|'pass', cards?:[]}
   */
  Engine.prototype.apply = function (action) {
    if (this.phase !== 'playing') return { ok: false, error: '对局已结束' };
    if (!action || typeof action.seat !== 'number') return { ok: false, error: '动作无效' };
    if (action.seat !== this.turn) return { ok: false, error: '还没轮到你' };
    var p = this.seats[action.seat];
    if (!this.canAct(action.seat)) return { ok: false, error: '当前不可行动' };

    if (action.type === 'pass') {
      if (!this.top) return { ok: false, error: '本轮首出不能过牌' };
      this.passes.push(action.seat);
      this.log('pass', p.name + ' 不要', { seat: action.seat });
      this.advance();
      return { ok: true };
    }

    if (action.type !== 'play') return { ok: false, error: '未知动作' };
    var cards = (action.cards || []).slice();
    if (!cards.length) return { ok: false, error: '请选择要出的牌' };
    // 必须都在手上
    for (var i = 0; i < cards.length; i++) {
      if (p.hand.indexOf(cards[i]) < 0) return { ok: false, error: '手上没有这张牌' };
    }
    var combo = R.parseCombo(cards);
    if (!combo) return { ok: false, error: '不是合法牌型' };

    var kind = 'play';
    if (this.top) {
      if (R.canBeat(this.top.combo, combo)) {
        kind = combo.bomb ? 'bomb' : 'play';
      } else if (R.isPengMove(cards, this.top.combo)) {
        kind = 'peng';
      } else {
        return { ok: false, error: '管不住上家的牌' };
      }
    } else if (combo.bomb) {
      kind = 'bomb';
    }

    // 移除手牌
    cards.forEach(function (c) {
      var idx = p.hand.indexOf(c);
      if (idx >= 0) p.hand.splice(idx, 1);
    });
    var entry = { seat: action.seat, cards: combo.cards.slice(), combo: combo, kind: kind };
    this.table.push(entry);
    this.top = entry;
    this.passes = [];

    var desc = p.name + (kind === 'peng' ? ' 碰！' : (kind === 'bomb' ? ' 炸！' : ' 出')) + ' ' + R.labelList(combo.cards);
    this.log(kind === 'peng' ? 'peng' : (kind === 'bomb' ? 'bomb' : 'play'), desc, { seat: action.seat, cards: combo.cards.slice() });

    this.advance();
    return { ok: true };
  };

  /** 推进轮次；必要时结算一轮 */
  Engine.prototype.advance = function () {
    // 只剩一人未打完 -> 结束
    if (this.alivePlayers().length <= 1) return this.finish();

    if (!this.top) {
      var f = this.anyActorFrom(this.turn);
      if (f < 0) return this.settleRound();
      this.turn = f;
      return;
    }
    // 还没表态、且能出牌的玩家（本轮最大者除外）
    var pending = [];
    for (var s = 0; s < this.n; s++) {
      if (s === this.top.seat) continue;
      if (!this.canAct(s)) continue;
      if (this.passes.indexOf(s) >= 0) continue;
      pending.push(s);
    }
    if (!pending.length) return this.settleRound();
    for (var i = 1; i <= this.n; i++) {
      var t = (this.turn + i) % this.n;
      if (pending.indexOf(t) >= 0) { this.turn = t; return; }
    }
    return this.settleRound();
  };

  /** 一轮结束：最大者收分 -> 全体补牌 -> 判定出完 */
  Engine.prototype.settleRound = function () {
    var self = this;
    var winnerSeat = this.top ? this.top.seat : this.leader;
    var winner = this.seats[winnerSeat];
    var pool = [];
    this.table.forEach(function (x) {
      x.cards.forEach(function (c) { if (R.pointOf(c) > 0) pool.push(c); });
    });
    var gained = R.pointsOf(pool);
    if (gained > 0) {
      winner.score += gained;
      winner.won = winner.won.concat(pool);
      this.log('collect', winner.name + ' 收走 ' + gained + ' 分（' + R.labelList(R.sortHand(pool)) + '）', { seat: winnerSeat, points: gained, cards: pool.slice() });
    } else {
      this.log('collect', winner.name + ' 拿下本轮（无分牌）', { seat: winnerSeat, points: 0 });
    }

    // 补牌：从本轮赢家开始顺时针补至 7 张
    var drawn = [];
    for (var i = 0; i < this.n && this.deck.length > 0; i++) {
      var s = (winnerSeat + i) % this.n;
      var pl = this.seats[s];
      if (pl.finished) continue;
      var got = 0;
      while (pl.hand.length < HAND_SIZE && this.deck.length > 0) {
        pl.hand.push(this.deck.pop());
        got++;
      }
      if (got > 0) drawn.push(pl.name + '+' + got);
    }
    if (drawn.length) this.log('draw', '补牌：' + drawn.join('、') + '（牌堆剩 ' + this.deck.length + '）', { deck: this.deck.length });
    else if (this.deck.length === 0) this.log('draw', '牌堆已空，进入决胜阶段！', { deck: 0 });

    // 判定谁出完了（牌堆空且手牌为 0）
    this.seats.forEach(function (pl) {
      if (!pl.finished && pl.hand.length === 0 && self.deck.length === 0) {
        pl.finished = true;
        pl.rank = self.finishOrder.length + 1;
        self.finishOrder.push(pl.seat);
        self.log('finish', pl.name + ' 打完手牌，第 ' + pl.rank + ' 名！', { seat: pl.seat, rank: pl.rank });
      }
    });

    this.table = [];
    this.top = null;
    this.passes = [];
    this.roundNo++;

    if (this.alivePlayers().length <= 1) return this.finish();

    // 新一轮首出：本轮赢家；若已出完则顺移
    var lead = this.anyActorFrom(winnerSeat);
    if (lead < 0) return this.finish();
    this.leader = lead;
    this.turn = lead;
    this.log('round', '第 ' + this.roundNo + ' 轮，' + this.seats[lead].name + ' 先出', { seat: lead });
  };

  Engine.prototype.finish = function () {
    if (this.phase === 'over') return;
    var self = this;
    // 剩下的人按手牌数、分数排名次
    var rest = this.seats.filter(function (p) { return !p.finished; });
    rest.sort(function (a, b) {
      return a.hand.length - b.hand.length || b.score - a.score;
    });
    rest.forEach(function (p) {
      p.finished = true;
      p.rank = self.finishOrder.length + 1;
      self.finishOrder.push(p.seat);
    });
    this.phase = 'over';
    var ranks = this.seats.slice().sort(function (a, b) { return a.rank - b.rank; }).map(function (p) {
      return { seat: p.seat, name: p.name, rank: p.rank, score: p.score, isAI: p.isAI };
    });
    var champ = ranks[0];
    this.result = { ranks: ranks, championSeat: champ.seat };
    this.log('over', '对局结束！第一名：' + champ.name + '（' + champ.score + ' 分）');
  };

  /** 座位视角的脱敏视图 */
  Engine.prototype.viewFor = function (seat) {
    var self = this;
    var me = this.seats[seat];
    return {
      you: seat,
      n: this.n,
      seed: this.seed,
      phase: this.phase,
      turn: this.turn,
      leader: this.leader,
      roundNo: this.roundNo,
      deckCount: this.deck.length,
      tablePoints: this.tablePoints(),
      passes: this.passes.slice(),
      seats: this.seats.map(function (p) {
        return {
          seat: p.seat, name: p.name, isAI: p.isAI, avatar: p.avatar,
          handCount: p.hand.length, score: p.score,
          finished: p.finished, rank: p.rank,
          connected: p.connected, auto: p.auto,
          isTurn: self.turn === p.seat && self.phase === 'playing'
        };
      }),
      hand: me ? R.sortHand(me.hand) : [],
      table: this.table.map(function (x) {
        return { seat: x.seat, cards: x.cards.slice(), name: x.combo.name, kind: x.kind };
      }),
      top: this.top ? { seat: this.top.seat, cards: this.top.cards.slice(), name: this.top.combo.name, kind: this.top.kind } : null,
      legal: this.legalFor(seat),
      events: this.events.slice(-10),
      result: this.result
    };
  };

  Engine.prototype.snapshot = function () {
    return {
      seed: this.seed, phase: this.phase, turn: this.turn, leader: this.leader,
      roundNo: this.roundNo, deck: this.deck.slice(),
      seats: this.seats.map(function (p) { return JSON.parse(JSON.stringify(p)); }),
      table: this.table.map(function (x) { return { seat: x.seat, cards: x.cards.slice(), kind: x.kind }; })
    };
  };

  return { Engine: Engine, HAND_SIZE: HAND_SIZE };
});
