/*!
 * 七王五二三 —— 界面渲染层
 */
(function (root) {
  'use strict';
  var R = root.QWRules;

  var AV_COLORS = [
    'linear-gradient(160deg,#ffb36b,#f2762c)', 'linear-gradient(160deg,#8fd8ff,#3a91d8)',
    'linear-gradient(160deg,#c3a6ff,#7a4fd8)', 'linear-gradient(160deg,#9fe6b8,#2fa568)',
    'linear-gradient(160deg,#ffa8c4,#e04f81)', 'linear-gradient(160deg,#ffe08a,#e0a52c)',
    'linear-gradient(160deg,#a8e8e0,#2f9d94)', 'linear-gradient(160deg,#c9d6ff,#5b73c4)'
  ];
  var AV_FACE = ['🐯', '🐼', '🦊', '🐸', '🐰', '🐵', '🐧', '🐨'];

  // 座位布局：rel = (seat - you + n) % n，rel0 为自己
  var LAYOUT = {
    2: [[16, 84], [50, 15]],
    3: [[16, 84], [85, 34], [15, 34]],
    4: [[16, 84], [87, 44], [50, 14], [13, 44]],
    5: [[16, 86], [89, 55], [75, 17], [25, 17], [11, 55]],
    6: [[16, 86], [90, 58], [81, 22], [50, 13], [19, 22], [10, 58]]
  };

  var UI = {
    handlers: {},
    sel: {},          // 选中的牌 id
    hintIdx: 0,
    pengIdx: 0,
    lastHandSig: '',
    lastTableSig: '',
    lastPassSig: '',
    view: null,
    meta: {},
    toastTimer: null
  };

  UI.init = function (handlers) {
    this.handlers = handlers || {};
    var self = this;
    document.getElementById('handArea').addEventListener('click', function (e) {
      var el = e.target.closest('.card');
      if (!el) return;
      var id = el.getAttribute('data-id');
      if (self.sel[id]) delete self.sel[id]; else self.sel[id] = 1;
      self.updateSel();
    });
    document.getElementById('btnQuit').onclick = function () {
      self.confirm('确定退出当前对局？', function () { self.handlers.onQuit && self.handlers.onQuit(); });
    };
    document.getElementById('btnLog').onclick = function () { self.showLog(); };
    document.getElementById('modalMask').addEventListener('click', function (e) {
      if (e.target === this) UI.hideModal();
    });
  };

  // ---------- 卡牌 ----------
  UI.cardHTML = function (id, mini) {
    var cls = mini ? 'card-mini' : 'card';
    if (R.isRed(id)) cls += ' red';
    if (R.pointOf(id) > 0) cls += ' point';
    if (R.isJoker(id)) {
      cls += ' jk';
      var t = id === 'BJ' ? '大王' : '小王';
      return '<div class="' + cls + '" data-id="' + id + '"><span class="r">' + t + '</span><span class="big">' + (id === 'BJ' ? '🃏' : '🂿') + '</span></div>';
    }
    var r = R.rankOf(id), s = R.SUIT_SYM[R.suitOf(id)];
    return '<div class="' + cls + '" data-id="' + id + '"><span class="r">' + r + '</span><span class="s">' + s + '</span><span class="big">' + s + '</span></div>';
  };

  UI.cardsHTML = function (ids, mini) {
    return (ids || []).map(function (c) { return UI.cardHTML(c, mini); }).join('');
  };

  // ---------- 主渲染 ----------
  UI.render = function (view, meta) {
    if (!view) return;
    this.view = view;
    if (meta) this.meta = meta;
    var n = view.n, you = view.you;

    document.getElementById('infoRound').textContent = view.roundNo;
    document.getElementById('infoDeck').textContent = view.deckCount;
    document.getElementById('infoPoints').textContent = view.tablePoints;
    document.getElementById('infoMode').textContent = this.meta.modeText || '单机';
    var mySeat = view.seats[you] || { name: '玩家', score: 0 };
    document.getElementById('myName').textContent = mySeat.name;
    document.getElementById('myScore').textContent = mySeat.score;

    this.renderSeats(view);
    this.renderHand(view);
    this.renderActions(view);

    if (view.phase === 'over' && view.result && !this._resultShown) {
      this._resultShown = true;
      var self = this;
      setTimeout(function () { self.showResult(view); }, 700);
    }
    if (view.phase === 'playing') this._resultShown = false;
  };

  UI.pos = function (n, rel) {
    var L = LAYOUT[n] || LAYOUT[3];
    return L[rel] || [50, 50];
  };

  UI.renderSeats = function (view) {
    var n = view.n, you = view.you, layer = document.getElementById('seatsLayer');
    var lastPlay = {};
    view.table.forEach(function (t) { lastPlay[t.seat] = t; });
    var sig = JSON.stringify(view.table.map(function (t) { return t.seat + ':' + t.cards.join('') + t.kind; }))
      + '|' + JSON.stringify(view.seats.map(function (s) { return [s.handCount, s.score, s.isTurn, s.finished, s.rank, s.connected, s.auto]; }))
      + '|' + view.passes.join(',') + '|' + (view.top ? view.top.seat : '-') + '|' + (view.deadline || 0);
    if (sig === this.lastSeatSig) return;
    this.lastSeatSig = sig;

    var html = '';
    for (var seat = 0; seat < n; seat++) {
      var p = view.seats[seat];
      var rel = (seat - you + n) % n;
      var pt = this.pos(n, rel);
      var cls = 'seat' + (p.isTurn ? ' turn' : '') + (p.finished ? ' done' : '');
      var badge = '';
      if (p.finished) badge = '<span class="badge">第' + p.rank + '名</span>';
      else if (p.isAI) badge = '<span class="badge gray">AI</span>';
      else if (p.auto) badge = '<span class="badge gray">托管</span>';
      else if (p.connected === false) badge = '<span class="badge gray">离线</span>';
      var timer = '';
      if (p.isTurn && view.deadline && view.turnTotal) {
        var left = Math.max(0, Math.min(1, (view.deadline - Date.now()) / (view.turnTotal * 1000)));
        timer = '<div class="timer-bar"><i style="width:' + (left * 100).toFixed(0) + '%"></i></div>';
      }
      html += '<div class="' + cls + '" style="left:' + pt[0] + '%;top:' + pt[1] + '%">'
        + '<div class="seat-inner" style="position:relative">' + badge
        + '<div class="avatar" style="background:' + AV_COLORS[p.avatar % 8] + '">' + AV_FACE[p.avatar % 8] + '</div>'
        + '<div class="nm">' + esc(p.name) + (seat === you ? '（你）' : '') + '</div>'
        + '<div class="st"><span class="cnt">🂠' + p.handCount + '</span><span>💰' + p.score + '</span></div>'
        + timer
        + '</div></div>';

      // 出的牌
      var lp = lastPlay[seat];
      var cx, cy;
      if (rel === 0) { cx = 50; cy = 74; }
      else { cx = 50 + (pt[0] - 50) * 0.42; cy = 50 + (pt[1] - 50) * 0.42; }
      if (lp) {
        var isWin = view.top && view.top.seat === seat;
        html += '<div class="played' + (isWin ? ' win' : '') + '" style="left:' + cx + '%;top:' + cy + '%">'
          + this.cardsHTML(lp.cards, true) + '</div>';
      }
      // 气泡
      var bx = 50 + (pt[0] - 50) * 0.7, by = 50 + (pt[1] - 50) * 0.7;
      if (rel === 0) { bx = 50; by = 88; }
      if (view.passes.indexOf(seat) >= 0 && !lp) {
        html += '<div class="bubble" style="left:' + bx + '%;top:' + by + '%">不要</div>';
      } else if (lp && lp.kind === 'peng' && view.top && view.top.seat === seat) {
        html += '<div class="bubble peng" style="left:' + bx + '%;top:' + by + '%">碰！</div>';
      } else if (lp && lp.kind === 'bomb' && view.top && view.top.seat === seat) {
        html += '<div class="bubble bomb" style="left:' + bx + '%;top:' + by + '%">' + esc(lp.name) + '</div>';
      } else if (view.passes.indexOf(seat) >= 0 && lp) {
        html += '<div class="bubble" style="left:' + bx + '%;top:' + by + '%">不要</div>';
      }
    }
    layer.innerHTML = html;
  };

  UI.renderHand = function (view) {
    var hand = view.hand || [];
    var sig = hand.join(',');
    var area = document.getElementById('handArea');
    if (sig !== this.lastHandSig) {
      this.lastHandSig = sig;
      // 清理已不在手上的选中
      var self = this;
      Object.keys(this.sel).forEach(function (id) { if (hand.indexOf(id) < 0) delete self.sel[id]; });
      area.innerHTML = this.cardsHTML(hand, false);
      this.hintIdx = 0; this.pengIdx = 0;
    }
    this.updateSel();
  };

  UI.updateSel = function () {
    var area = document.getElementById('handArea');
    var self = this;
    Array.prototype.forEach.call(area.querySelectorAll('.card'), function (el) {
      var id = el.getAttribute('data-id');
      el.classList.toggle('sel', !!self.sel[id]);
    });
  };

  UI.selected = function () {
    return Object.keys(this.sel);
  };

  UI.clearSel = function () { this.sel = {}; this.updateSel(); };

  UI.setSel = function (cards) {
    this.sel = {};
    (cards || []).forEach(function (c) { UI.sel[c] = 1; });
    this.updateSel();
  };

  UI.renderActions = function (view) {
    var area = document.getElementById('actionArea');
    var self = this;
    if (view.phase === 'over') {
      area.innerHTML = '<button class="act-btn" id="aResult">查看结算</button>';
      document.getElementById('aResult').onclick = function () { self.showResult(view); };
      return;
    }
    var me = view.seats[view.you];
    if (me && me.finished) {
      area.innerHTML = '<div class="wait-tip">你已出完手牌（第 ' + me.rank + ' 名），等待其他玩家…</div>';
      return;
    }
    if (view.turn !== view.you || !view.legal) {
      var who = view.seats[view.turn] ? view.seats[view.turn].name : '';
      area.innerHTML = '<div class="wait-tip">等待 <b style="color:#ffe08a">' + esc(who) + '</b> 出牌…</div>';
      return;
    }
    var legal = view.legal;
    var pengs = (legal.plays || []).filter(function (p) { return p.kind === 'peng'; });
    var html = '<button class="act-btn gray" id="aHint">提示</button>';
    if (pengs.length) html += '<button class="act-btn peng" id="aPeng">碰</button>';
    html += '<button class="act-btn gray" id="aPass"' + (legal.canPass ? '' : ' disabled') + '>不出</button>';
    html += '<button class="act-btn" id="aPlay">出牌</button>';
    area.innerHTML = html;

    document.getElementById('aHint').onclick = function () {
      var list = (legal.plays || []);
      if (!list.length) { self.toast('没有能管上的牌'); return; }
      var p = list[self.hintIdx % list.length];
      self.hintIdx++;
      self.setSel(p.cards);
      self.toast(p.name + (p.kind === 'peng' ? '（碰）' : ''), 700);
    };
    if (pengs.length) {
      document.getElementById('aPeng').onclick = function () {
        var p = pengs[self.pengIdx % pengs.length];
        self.pengIdx++;
        self.setSel(p.cards);
        self.toast('碰 ' + R.labelList(p.cards) + '（再点出牌确认）', 1200);
      };
    }
    document.getElementById('aPass').onclick = function () {
      if (!legal.canPass) { self.toast('首出必须出牌'); return; }
      self.clearSel();
      self.handlers.onPass && self.handlers.onPass();
    };
    document.getElementById('aPlay').onclick = function () {
      var cards = self.selected();
      if (!cards.length) { self.toast('请先选牌'); self.shake(); return; }
      var check = self.precheck(cards, view);
      if (!check.ok) { self.toast(check.msg); self.shake(); return; }
      self.handlers.onPlay && self.handlers.onPlay(cards);
      self.clearSel();
    };
  };

  UI.precheck = function (cards, view) {
    var combo = R.parseCombo(cards);
    if (!combo) return { ok: false, msg: '不是合法牌型' };
    if (!view.top) return { ok: true };
    if (R.canBeat(view.top ? R.parseCombo(view.top.cards) : null, combo)) return { ok: true };
    if (R.isPengMove(cards, R.parseCombo(view.top.cards))) return { ok: true };
    return { ok: false, msg: '管不住上家的 ' + R.labelList(view.top.cards) };
  };

  UI.shake = function () {
    var h = document.getElementById('handArea');
    h.classList.remove('shake');
    void h.offsetWidth;
    h.classList.add('shake');
  };

  UI.toast = function (msg, ms) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 1500);
  };

  UI.centerHint = function (msg, ms) {
    var c = document.getElementById('centerHint');
    c.textContent = msg;
    c.classList.add('show');
    clearTimeout(this._chTimer);
    this._chTimer = setTimeout(function () { c.classList.remove('show'); }, ms || 1600);
  };

  UI.showModal = function (html) {
    document.getElementById('modalBox').innerHTML = html;
    document.getElementById('modalMask').classList.add('show');
  };
  UI.hideModal = function () { document.getElementById('modalMask').classList.remove('show'); };

  UI.confirm = function (msg, onYes) {
    this.showModal('<h3>提示</h3><div class="rules-txt" style="text-align:center;margin-bottom:18px">' + esc(msg) + '</div>'
      + '<div class="btn-row"><button class="ghost-btn" id="mNo">取消</button><button class="big-btn gold slim" id="mYes">确定</button></div>');
    document.getElementById('mNo').onclick = function () { UI.hideModal(); };
    document.getElementById('mYes').onclick = function () { UI.hideModal(); onYes && onYes(); };
  };

  UI.showResult = function (view) {
    var ranks = view.result.ranks;
    var html = '<h3>🏆 对局结束</h3>';
    ranks.forEach(function (r) {
      html += '<div class="rk' + (r.rank === 1 ? ' top' : '') + (r.seat === view.you ? ' me' : '') + '">'
        + '<span class="no">' + r.rank + '</span>'
        + '<span class="rn">' + esc(r.name) + (r.seat === view.you ? '（你）' : '') + (r.isAI ? ' <span style="opacity:.5;font-size:12px">AI</span>' : '') + '</span>'
        + '<span class="rs">' + r.score + ' 分</span></div>';
    });
    var me = ranks.filter(function (r) { return r.seat === view.you; })[0];
    html += '<div class="rules-txt" style="text-align:center;margin-top:10px">你的名次：第 ' + (me ? me.rank : '-') + ' 名 · 收分 ' + (me ? me.score : 0) + '</div>';
    html += '<div class="btn-row"><button class="ghost-btn" id="rHome">返回大厅</button><button class="big-btn gold slim" id="rAgain">再来一局</button></div>';
    this.showModal(html);
    var self = this;
    document.getElementById('rHome').onclick = function () { UI.hideModal(); self.handlers.onQuit && self.handlers.onQuit(); };
    document.getElementById('rAgain').onclick = function () { UI.hideModal(); self.handlers.onAgain && self.handlers.onAgain(); };
  };

  UI.showLog = function () {
    var ev = (this.view && this.view.events) || [];
    var html = '<h3>战况</h3><div class="log-list">';
    ev.slice().reverse().forEach(function (e) { html += '<div class="li">' + esc(e.text) + '</div>'; });
    if (!ev.length) html += '<div class="li">暂无记录</div>';
    html += '</div><div class="btn-row"><button class="ghost-btn" onclick="QWUI.hideModal()">关闭</button></div>';
    this.showModal(html);
  };

  UI.resetTable = function () {
    this.sel = {}; this.hintIdx = 0; this.pengIdx = 0;
    this.lastHandSig = ''; this.lastSeatSig = ''; this._resultShown = false;
    document.getElementById('handArea').innerHTML = '';
    document.getElementById('seatsLayer').innerHTML = '';
    document.getElementById('actionArea').innerHTML = '';
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  UI.esc = esc;

  root.QWUI = UI;
})(window);
