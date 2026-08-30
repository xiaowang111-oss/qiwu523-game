/*!
 * 七王五二三 / 七鬼五二三 —— 规则引擎（前后端共用）
 * 单牌大小: 7 > 大王 > 小王 > 5 > 2 > 3 > A > K > Q > J > 10 > 9 > 8 > 6 > 4
 * 同点比花色: 黑桃 > 红桃 > 梅花 > 方块
 * 炸弹: 四张7 > 王炸 > 其他四张 > 三张 > 任意普通牌型
 * 顺子: >=3 张自然连续(3..A)，仅同长度可比
 * 分牌: 5=5分, 10=10分, K=10分, 全场共 100 分
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QWRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SUIT_POWER = { D: 1, C: 2, H: 3, S: 4 };
  var SUIT_SYM = { S: '\u2660', H: '\u2665', C: '\u2663', D: '\u2666' };
  var SUIT_NAME = { S: '黑桃', H: '红桃', C: '梅花', D: '方块' };
  var SUITS = ['S', 'H', 'C', 'D'];
  var NORMAL_RANKS = ['4', '6', '8', '9', '10', 'J', 'Q', 'K', 'A', '3', '2', '5', '7'];

  // 单牌强度（越大越强）
  var POWER = {
    '4': 1, '6': 2, '8': 3, '9': 4, '10': 5, 'J': 6, 'Q': 7, 'K': 8,
    'A': 9, '3': 10, '2': 11, '5': 12, 'LJ': 13, 'BJ': 14, '7': 15
  };
  // 顺子自然序
  var SEQ = {
    '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
  };
  var SEQ_REV = {};
  Object.keys(SEQ).forEach(function (r) { SEQ_REV[SEQ[r]] = r; });

  var POINTS = { '5': 5, '10': 10, 'K': 10 };
  var TOTAL_POINTS = 100;

  function isJoker(id) { return id === 'BJ' || id === 'LJ'; }
  function rankOf(id) { return isJoker(id) ? id : id.slice(1); }
  function suitOf(id) { return isJoker(id) ? '' : id.charAt(0); }
  function suitPower(id) { return isJoker(id) ? 5 : (SUIT_POWER[id.charAt(0)] || 0); }
  function cardPower(id) { return POWER[rankOf(id)] * 10 + suitPower(id); }
  function pointOf(id) { return POINTS[rankOf(id)] || 0; }
  function pointsOf(ids) {
    var s = 0;
    for (var i = 0; i < (ids || []).length; i++) s += pointOf(ids[i]);
    return s;
  }
  function isRed(id) {
    if (id === 'BJ') return true;
    if (id === 'LJ') return false;
    var s = suitOf(id);
    return s === 'H' || s === 'D';
  }
  function faceOf(id) {
    if (id === 'BJ') return '大王';
    if (id === 'LJ') return '小王';
    return rankOf(id);
  }
  function label(id) {
    if (isJoker(id)) return faceOf(id);
    return SUIT_SYM[suitOf(id)] + rankOf(id);
  }
  function labelCN(id) {
    if (isJoker(id)) return faceOf(id);
    return SUIT_NAME[suitOf(id)] + rankOf(id);
  }
  function labelList(ids) {
    return (ids || []).map(label).join(' ');
  }

  function createDeck() {
    var deck = [];
    for (var s = 0; s < SUITS.length; s++) {
      for (var r = 0; r < NORMAL_RANKS.length; r++) deck.push(SUITS[s] + NORMAL_RANKS[r]);
    }
    deck.push('BJ');
    deck.push('LJ');
    return deck; // 54 张
  }

  // 可复现随机
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    rng = rng || Math.random;
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function sortHand(ids) {
    return (ids || []).slice().sort(function (a, b) { return cardPower(a) - cardPower(b); });
  }
  // 按顺子自然序排（展示顺子时更直观）
  function sortSeq(ids) {
    return (ids || []).slice().sort(function (a, b) {
      var x = SEQ[rankOf(a)] || 99, y = SEQ[rankOf(b)] || 99;
      return x - y || suitPower(a) - suitPower(b);
    });
  }

  /**
   * 解析牌型
   * @returns {null|{type,cards,size,bomb,bombRank,key,name}}
   * type: single | pair | triple | quad | jokerbomb | straight
   */
  function parseCombo(ids) {
    if (!ids || !ids.length) return null;
    var cards = sortHand(ids);
    var n = cards.length;
    var i;
    // 去重检查（同一张牌不能重复出）
    var seen = {};
    for (i = 0; i < n; i++) {
      if (seen[cards[i]]) return null;
      seen[cards[i]] = 1;
    }
    var ranks = cards.map(rankOf);
    var uniqRanks = ranks.filter(function (r, k) { return ranks.indexOf(r) === k; });

    // 王炸：大王 + 小王
    if (n === 2 && ranks.indexOf('BJ') >= 0 && ranks.indexOf('LJ') >= 0) {
      return { type: 'jokerbomb', cards: ['BJ', 'LJ'], size: 2, bomb: true, bombRank: 300, key: 300, name: '王炸' };
    }
    if (n === 1) {
      return { type: 'single', cards: cards, size: 1, bomb: false, bombRank: 0, key: cardPower(cards[0]), name: '单牌' };
    }
    if (uniqRanks.length === 1) {
      var r0 = uniqRanks[0];
      if (isJoker(cards[0])) return null; // 单副牌不会出现两张同样的王
      var maxSuit = Math.max.apply(null, cards.map(suitPower));
      if (n === 2) {
        return { type: 'pair', cards: cards, size: 2, bomb: false, bombRank: 0, key: POWER[r0] * 10 + maxSuit, name: '对子' };
      }
      if (n === 3) {
        var br3 = 100 + POWER[r0];
        return { type: 'triple', cards: cards, size: 3, bomb: true, bombRank: br3, key: br3, name: '三张炸(' + r0 + ')' };
      }
      if (n === 4) {
        var br4 = (r0 === '7') ? 400 : (200 + POWER[r0]);
        return { type: 'quad', cards: cards, size: 4, bomb: true, bombRank: br4, key: br4, name: (r0 === '7' ? '四个7·天炸' : '四张炸(' + r0 + ')') };
      }
      return null;
    }
    // 顺子：>=3 张，点数各异且自然连续，不含王
    if (n >= 3 && uniqRanks.length === n) {
      var hasJoker = false;
      for (i = 0; i < n; i++) if (isJoker(cards[i])) hasJoker = true;
      if (!hasJoker) {
        var vals = cards.map(function (c) { return SEQ[rankOf(c)]; }).sort(function (a, b) { return a - b; });
        var ok = true;
        for (i = 1; i < vals.length; i++) if (vals[i] !== vals[i - 1] + 1) ok = false;
        if (ok) {
          var top = vals[vals.length - 1];
          return {
            type: 'straight', cards: sortSeq(cards), size: n, bomb: false, bombRank: 0,
            len: n, top: top, key: top, name: n + '张顺子'
          };
        }
      }
    }
    return null;
  }

  /** cur 能否压过 prev */
  function canBeat(prev, cur) {
    if (!cur) return false;
    if (!prev) return true;
    if (cur.bomb && !prev.bomb) return true;
    if (cur.bomb && prev.bomb) return cur.bombRank > prev.bombRank;
    if (prev.bomb && !cur.bomb) return false;
    if (prev.type !== cur.type) return false;
    if (cur.type === 'straight') return cur.len === prev.len && cur.top > prev.top;
    return cur.key > prev.key;
  }

  /** 是否构成「碰」：台面为单牌时，用 1~2 张同点数的牌抢下台面 */
  function isPengMove(ids, top) {
    if (!top || top.type !== 'single') return false;
    if (!ids || ids.length < 1 || ids.length > 2) return false;
    var tr = rankOf(top.cards[0]);
    for (var i = 0; i < ids.length; i++) {
      if (rankOf(ids[i]) !== tr) return false;
    }
    // 单张同点若本身更大，那属于正常跟牌；仍允许走碰通道（效果一致）
    return true;
  }

  /** 列出所有可「碰」的组合 */
  function pengOptions(hand, top) {
    var out = [];
    if (!top || top.type !== 'single') return out;
    var tr = rankOf(top.cards[0]);
    var same = sortHand(hand.filter(function (c) { return rankOf(c) === tr; }));
    if (!same.length) return out;
    for (var i = 0; i < same.length; i++) out.push([same[i]]);
    for (i = 0; i < same.length; i++) {
      for (var j = i + 1; j < same.length; j++) out.push([same[i], same[j]]);
    }
    return out;
  }

  // ---------- 组合枚举（供 AI 与「提示」使用） ----------
  function groupByRank(hand) {
    var g = {};
    hand.forEach(function (c) {
      var r = rankOf(c);
      (g[r] = g[r] || []).push(c);
    });
    Object.keys(g).forEach(function (r) { g[r] = sortHand(g[r]); });
    return g;
  }

  function allStraights(hand) {
    var res = [];
    var byVal = {};
    hand.forEach(function (c) {
      if (isJoker(c)) return;
      var v = SEQ[rankOf(c)];
      (byVal[v] = byVal[v] || []).push(c);
    });
    var vals = Object.keys(byVal).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < vals.length; i++) {
      var chain = [vals[i]];
      for (var j = i + 1; j < vals.length; j++) {
        if (vals[j] === chain[chain.length - 1] + 1) chain.push(vals[j]);
        else break;
      }
      // 从 i 起所有长度 >=3 的前缀
      for (var L = 3; L <= chain.length; L++) {
        var pick = [];
        for (var k = 0; k < L; k++) {
          var arr = byVal[chain[k]];
          // 选花色最小的一张，尽量留大牌
          pick.push(arr[0]);
        }
        res.push(pick);
      }
    }
    return res;
  }

  /** 枚举手牌所有合法牌型（不含碰） */
  function enumerateCombos(hand) {
    var out = [];
    var g = groupByRank(hand);
    hand.forEach(function (c) { out.push([c]); });
    Object.keys(g).forEach(function (r) {
      var arr = g[r];
      if (arr.length >= 2) out.push([arr[0], arr[1]]);
      if (arr.length >= 2 && arr.length >= 3) out.push([arr[0], arr[1], arr[2]]);
      if (arr.length >= 4) out.push([arr[0], arr[1], arr[2], arr[3]]);
      // 对子的其他花色组合（让玩家有更多选择）
      if (arr.length === 3) out.push([arr[1], arr[2]]);
    });
    if (hand.indexOf('BJ') >= 0 && hand.indexOf('LJ') >= 0) out.push(['BJ', 'LJ']);
    allStraights(hand).forEach(function (s) { out.push(s); });
    // 去重
    var seen = {}, res = [];
    out.forEach(function (cs) {
      var combo = parseCombo(cs);
      if (!combo) return;
      var key = combo.type + '|' + sortHand(cs).join(',');
      if (seen[key]) return;
      seen[key] = 1;
      res.push({ cards: sortHand(cs), combo: combo });
    });
    return res;
  }

  /** 能压过 top 的所有出法（含碰），已排序：越弱越前 */
  function legalPlays(hand, top) {
    var res = [];
    var combos = enumerateCombos(hand);
    combos.forEach(function (c) {
      if (!top || canBeat(top, c.combo)) {
        res.push({ cards: c.cards, combo: c.combo, kind: c.combo.bomb ? 'bomb' : 'play' });
      }
    });
    if (top) {
      pengOptions(hand, top).forEach(function (cs) {
        var combo = parseCombo(cs);
        if (!combo) return;
        // 若已作为普通跟牌收录，则不重复
        var dup = res.some(function (r) { return r.cards.join(',') === sortHand(cs).join(','); });
        if (dup) return;
        res.push({ cards: sortHand(cs), combo: combo, kind: 'peng' });
      });
    }
    res.sort(function (a, b) {
      var wa = weightOf(a), wb = weightOf(b);
      return wa - wb;
    });
    return res;
  }

  function weightOf(p) {
    var base = 0;
    switch (p.combo.type) {
      case 'straight': base = 1000 + p.combo.len * 10 + p.combo.top; break;
      case 'single': base = 2000 + p.combo.key; break;
      case 'pair': base = 3000 + p.combo.key; break;
      case 'triple': base = 8000 + p.combo.bombRank; break;
      case 'jokerbomb': base = 9000; break;
      case 'quad': base = 9000 + p.combo.bombRank; break;
      default: base = 5000;
    }
    if (p.kind === 'peng') base -= 500;
    return base;
  }

  return {
    SUIT_POWER: SUIT_POWER, SUIT_SYM: SUIT_SYM, SUIT_NAME: SUIT_NAME, SUITS: SUITS,
    NORMAL_RANKS: NORMAL_RANKS, POWER: POWER, SEQ: SEQ, POINTS: POINTS, TOTAL_POINTS: TOTAL_POINTS,
    isJoker: isJoker, rankOf: rankOf, suitOf: suitOf, suitPower: suitPower, cardPower: cardPower,
    pointOf: pointOf, pointsOf: pointsOf, isRed: isRed, faceOf: faceOf, label: label,
    labelCN: labelCN, labelList: labelList,
    createDeck: createDeck, shuffle: shuffle, mulberry32: mulberry32,
    sortHand: sortHand, sortSeq: sortSeq,
    parseCombo: parseCombo, canBeat: canBeat,
    isPengMove: isPengMove, pengOptions: pengOptions,
    groupByRank: groupByRank, enumerateCombos: enumerateCombos, legalPlays: legalPlays
  };
});
