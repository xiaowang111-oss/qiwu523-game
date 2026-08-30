/*!
 * 七王五二三 —— AI 决策（启发式）
 * 关注点：清牌效率、炸弹时机、分牌争夺、碰的取舍
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./rules.js'));
  } else {
    root.QWAI = factory(root.QWRules);
  }
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  function bombRanksInHand(hand) {
    var g = R.groupByRank(hand);
    var set = {};
    Object.keys(g).forEach(function (r) { if (g[r].length >= 3) set[r] = g[r].length; });
    if (hand.indexOf('BJ') >= 0 && hand.indexOf('LJ') >= 0) set['__joker'] = 2;
    return set;
  }

  // 出这手牌是否会拆掉自己的炸弹
  function breakPenalty(cards, hand) {
    var bombs = bombRanksInHand(hand);
    var used = {};
    cards.forEach(function (c) {
      var r = R.rankOf(c);
      used[r] = (used[r] || 0) + 1;
    });
    var pen = 0;
    Object.keys(used).forEach(function (r) {
      if (bombs[r] && used[r] < bombs[r]) pen += 160 * used[r];
    });
    // 拆王炸
    if (bombs.__joker) {
      var jk = cards.filter(function (c) { return R.isJoker(c); }).length;
      if (jk === 1) pen += 200;
    }
    return pen;
  }

  function comboOf(cards) { return R.parseCombo(cards); }

  // 出牌代价：越低越应该先出
  function costOf(play, hand, ctx) {
    var combo = comboOf(play.cards);
    if (!combo) return 99999;
    var c = 0;
    switch (combo.type) {
      case 'straight':
        c = 40 - combo.len * 8 + combo.top * 0.6;
        break;
      case 'single':
        c = R.POWER[R.rankOf(combo.cards[0])] * 3;
        break;
      case 'pair':
        c = 12 + R.POWER[R.rankOf(combo.cards[0])] * 4;
        break;
      case 'triple':
        c = 220 + R.POWER[R.rankOf(combo.cards[0])] * 2;
        break;
      case 'jokerbomb':
        c = 340;
        break;
      case 'quad':
        c = 400 + (R.rankOf(combo.cards[0]) === '7' ? 60 : 0);
        break;
      default:
        c = 200;
    }
    c += breakPenalty(play.cards, hand);
    // 主动出牌时，别把分牌白送给别人
    if (ctx.lead) c += R.pointsOf(play.cards) * 2.5;
    // 碰很划算：用同点小牌抢下台面
    if (play.kind === 'peng') {
      c -= 45;
      if (play.cards.length === 2) c -= 25; // 升级成对子，更难被管
    }
    // 残局时更愿意打出去
    if (ctx.myCount <= 3) c -= combo.size * 12;
    return c;
  }

  /**
   * @param view 引擎 viewFor(seat) 的结果
   * @returns {{type:'play',cards:[]}|{type:'pass'}}
   */
  function chooseAction(view, opts) {
    opts = opts || {};
    var level = opts.level || 'normal';
    var legal = view.legal;
    if (!legal) return null;
    var plays = (legal.plays || []).slice();
    if (!plays.length) return { type: 'pass' };

    var hand = view.hand.slice();
    var myCount = hand.length;
    var deck = view.deckCount;
    var lead = !view.top;
    var ctx = { lead: lead, myCount: myCount, deck: deck };

    // 危险局：牌堆空了且有人快出完
    var danger = false, minOther = 99;
    view.seats.forEach(function (s) {
      if (s.seat === view.you || s.finished) return;
      if (s.handCount < minOther) minOther = s.handCount;
    });
    if (deck === 0 && minOther <= 2) danger = true;

    // 一手走完：直接打
    var finisher = null;
    plays.forEach(function (p) {
      if (p.cards.length === myCount) {
        if (!finisher || p.cards.length > finisher.cards.length) finisher = p;
      }
    });
    if (finisher && deck === 0) return { type: 'play', cards: finisher.cards };

    plays.forEach(function (p) { p._cost = costOf(p, hand, ctx); });
    plays.sort(function (a, b) { return a._cost - b._cost; });

    if (lead) {
      // 主动出牌：优先便宜的牌型；但别第一手就丢炸弹
      var pick = plays[0];
      for (var i = 0; i < plays.length; i++) {
        var cb = comboOf(plays[i].cards);
        if (cb && cb.bomb && myCount > 3 && !danger) continue;
        pick = plays[i];
        break;
      }
      // 轻松难度：偶尔犯错，随机挑一手便宜牌
      if (level === 'easy' && Math.random() < 0.3) {
        var cheap = plays.filter(function (p) { var c = comboOf(p.cards); return c && !c.bomb; });
        if (cheap.length) pick = cheap[Math.floor(Math.random() * Math.min(3, cheap.length))];
      }
      return { type: 'play', cards: pick.cards };
    }

    // 跟牌：算划不划算
    var gain = view.tablePoints || 0;
    var threshold = 26 + gain * 2.6;
    if (myCount <= 3) threshold += 60;
    if (danger) threshold += 260;
    if (deck === 0) threshold += 40;
    // 台面是上家「碰」出来的，压回去价值更高
    if (view.top && view.top.kind === 'peng') threshold += 25;
    // 难度调节：高手更敢压、轻松更保守
    if (level === 'hard') threshold *= 1.4;
    else if (level === 'easy') threshold *= 0.7;

    var best = plays[0];
    // 轻松难度：有时候明明能管却不出
    if (level === 'easy' && Math.random() < 0.22 && myCount > 2) return { type: 'pass' };
    if (best._cost <= threshold) {
      return { type: 'play', cards: best.cards };
    }
    // 手牌很少时，宁可拆牌也要走
    if (myCount <= 2 && deck === 0) return { type: 'play', cards: best.cards };
    return { type: 'pass' };
  }

  return { chooseAction: chooseAction, costOf: costOf };
});
