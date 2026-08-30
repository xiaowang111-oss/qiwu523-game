/*!
 * 七王五二三 —— 单机模式控制器（本地引擎 + AI）
 */
(function (root) {
  'use strict';
  var R = root.QWRules, E = root.QWEngine, AI = root.QWAI;

  var AI_NAMES = ['小虎', '阿福', '花花', '老K', '青蛙', '闷墩', '大聪明', '铁蛋', '幺鸡', '皮皮'];

  var Local = {
    eng: null, you: 0, level: 'normal', busy: false, opts: null, timer: null
  };

  Local.start = function (opts) {
    this.opts = opts;
    this.level = opts.level || 'normal';
    var names = R.shuffle(AI_NAMES);
    var players = [{ name: opts.name || '玩家', isAI: false, avatar: 0 }];
    for (var i = 1; i < opts.count; i++) {
      players.push({ name: names[i - 1], isAI: true, avatar: i % 8 });
    }
    this.eng = new E.Engine({ players: players });
    this.you = 0;
    this.busy = false;
    root.QWUI.resetTable();
    this.push();
    var self = this;
    setTimeout(function () { self.step(); }, 600);
  };

  Local.restart = function () { if (this.opts) this.start(this.opts); };

  Local.push = function () {
    if (!this.eng) return;
    root.QWApp.renderView(this.eng.viewFor(this.you), { modeText: '单机 · ' + this.levelText() });
  };

  Local.levelText = function () {
    return this.level === 'easy' ? '轻松' : (this.level === 'hard' ? '高手' : '普通');
  };

  Local.step = function () {
    var self = this;
    clearTimeout(this.timer);
    if (!this.eng || this.eng.phase !== 'playing') { this.push(); return; }
    var seat = this.eng.turn;
    var p = this.eng.seats[seat];
    if (!p.isAI) { this.busy = false; this.push(); return; }
    this.busy = true;
    this.push();
    var view = this.eng.viewFor(seat);
    var act = AI.chooseAction(view, { level: this.level });
    var delay = 620 + Math.random() * 520;
    if (act && act.type === 'play' && act.cards && act.cards.length >= 3) delay += 260;
    this.timer = setTimeout(function () {
      var res = self.eng.apply({ seat: seat, type: act.type, cards: act.cards });
      if (!res.ok) {
        // 兜底：随便出一手合法牌，绝不卡死
        var lg = self.eng.legalFor(seat);
        if (lg && lg.plays && lg.plays.length) self.eng.apply({ seat: seat, type: 'play', cards: lg.plays[0].cards });
        else if (lg && lg.canPass) self.eng.apply({ seat: seat, type: 'pass' });
      }
      self.push();
      self.step();
    }, delay);
  };

  Local.play = function (cards) {
    if (!this.eng || this.eng.phase !== 'playing') return;
    var res = this.eng.apply({ seat: this.you, type: 'play', cards: cards });
    if (!res.ok) { root.QWUI.toast(res.error); root.QWUI.shake(); return; }
    this.push();
    this.step();
  };

  Local.pass = function () {
    if (!this.eng || this.eng.phase !== 'playing') return;
    var res = this.eng.apply({ seat: this.you, type: 'pass' });
    if (!res.ok) { root.QWUI.toast(res.error); return; }
    this.push();
    this.step();
  };

  Local.stop = function () { clearTimeout(this.timer); this.eng = null; };

  root.QWLocal = Local;
})(window);
