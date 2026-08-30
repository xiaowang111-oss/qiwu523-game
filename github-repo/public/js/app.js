/*!
 * 七王五二三 —— 主控（大厅 / 模式切换 / 事件分发）
 */
(function (root) {
  'use strict';
  var R = root.QWRules, UI = root.QWUI, Local = root.QWLocal, Net = root.QWNet;

  // ---------------- 轻量音效（WebAudio，无需资源文件） ----------------
  var SFX = {
    ctx: null, on: true,
    ac: function () {
      if (!this.on) return null;
      try {
        if (!this.ctx) this.ctx = new (root.AudioContext || root.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
      } catch (e) { this.on = false; return null; }
    },
    beep: function (freq, dur, type, vol, delay) {
      var c = this.ac(); if (!c) return;
      var t0 = c.currentTime + (delay || 0);
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || 'triangle';
      o.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol == null ? 0.12 : vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    },
    slide: function (f1, f2, dur, vol) {
      var c = this.ac(); if (!c) return;
      var t0 = c.currentTime;
      var o = c.createOscillator(), g = c.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f1, t0);
      o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
      g.gain.setValueAtTime(vol == null ? 0.16 : vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    },
    play: function () { this.beep(660, 0.07, 'triangle', 0.09); },
    pass: function () { this.beep(300, 0.09, 'sine', 0.07); },
    peng: function () { this.beep(880, 0.08, 'square', 0.1); this.beep(1180, 0.1, 'square', 0.09, 0.08); },
    bomb: function () { this.slide(420, 60, 0.34, 0.2); },
    coin: function () { [784, 988, 1319].forEach(function (f, i) { SFX.beep(f, 0.1, 'triangle', 0.1, i * 0.075); }); },
    win: function () { [523, 659, 784, 1047].forEach(function (f, i) { SFX.beep(f, 0.18, 'triangle', 0.12, i * 0.12); }); }
  };

  var App = {
    mode: null,        // 'solo' | 'net'
    lastEvId: 0,
    tickTimer: null,
    lastView: null
  };

  // ---------------- 屏幕切换 ----------------
  App.go = function (id) {
    ['lobby', 'soloSetup', 'onlineLobby', 'roomWait', 'game'].forEach(function (s) {
      var el = document.getElementById(s);
      if (el) el.classList.toggle('active', s === id);
    });
    if (id !== 'game') { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (id === 'onlineLobby') this.autoConnectLan();
  };

  function segVal(id) {
    var on = document.querySelector('#' + id + ' button.on');
    return on ? on.getAttribute('data-v') : null;
  }
  function bindSeg(id) {
    var box = document.getElementById(id);
    if (!box) return;
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      Array.prototype.forEach.call(box.querySelectorAll('button'), function (x) { x.classList.remove('on'); });
      b.classList.add('on');
    });
  }

  function getName(inputId) {
    var v = (document.getElementById(inputId).value || '').trim();
    if (!v) v = '玩家' + Math.floor(Math.random() * 900 + 100);
    try { localStorage.setItem('qw_name', v); } catch (e) { }
    return v.slice(0, 8);
  }

  // ---------------- 渲染中转 ----------------
  App.renderView = function (view, meta) {
    this.lastView = view;
    UI.render(view, meta);
    this.flashEvents(view);
    if (view.deadline && !this.tickTimer) {
      var self = this;
      this.tickTimer = setInterval(function () {
        if (self.lastView && self.lastView.deadline) UI.render(self.lastView);
      }, 1000);
    }
  };

  App.flashEvents = function (view) {
    var ev = view.events || [];
    var self = this;
    ev.forEach(function (e) {
      if (e.id <= self.lastEvId) return;
      self.lastEvId = e.id;
      switch (e.type) {
        case 'play': SFX.play(); break;
        case 'pass': SFX.pass(); break;
        case 'peng': SFX.peng(); UI.centerHint('💥 ' + e.text, 1300); break;
        case 'bomb': SFX.bomb(); UI.centerHint('💣 ' + e.text, 1500); break;
        case 'collect':
          if (e.points > 0) { SFX.coin(); UI.centerHint('💰 ' + e.text, 1700); }
          break;
        case 'finish': UI.centerHint('🎉 ' + e.text, 1800); break;
        case 'draw': if (e.deck === 0) UI.centerHint('⚔️ 牌堆已空，决胜阶段！', 1800); break;
        case 'over': SFX.win(); break;
      }
    });
    if (this.lastEvId > 1e9) this.lastEvId = 0;
  };

  // ---------------- 玩家操作分发 ----------------
  function handlers() {
    return {
      onPlay: function (cards) {
        if (App.mode === 'solo') Local.play(cards);
        else Net.action({ type: 'play', cards: cards });
      },
      onPass: function () {
        if (App.mode === 'solo') Local.pass();
        else Net.action({ type: 'pass' });
      },
      onQuit: function () {
        if (App.mode === 'solo') { Local.stop(); App.go('lobby'); }
        else { Net.leave(); App.go('onlineLobby'); }
        UI.hideModal();
      },
      onAgain: function () {
        if (App.mode === 'solo') { App.lastEvId = 0; Local.restart(); }
        else {
          Net.again().then(function (r) {
            if (r && r.error) UI.toast(r.error);
          });
        }
      }
    };
  }

  // ---------------- 联机回调 ----------------
  App.onRoom = function (room) {
    if (room.status === 'playing') return; // 等 view 推送
    this.mode = 'net';
    this.go('roomWait');
    document.getElementById('roomCode').textContent = room.code;
    var me = room.players.filter(function (p) { return p.pid === Net.pid; })[0];
    var isHost = me && me.host;
    var html = '';
    room.players.forEach(function (p) {
      html += '<div class="rp' + (p.host ? ' host' : '') + '">' + UI.esc(p.name)
        + '<span class="tagline">' + (p.host ? '房主' : (p.isAI ? 'AI' : '玩家')) + (p.pid === Net.pid ? ' · 你' : '') + '</span></div>';
    });
    for (var i = room.players.length; i < room.size; i++) {
      html += '<div class="rp slot">空位<span class="tagline">等待加入</span></div>';
    }
    document.getElementById('roomPlayers').innerHTML = html;
    document.getElementById('roomStatus').textContent =
      (room.mode === 'match' ? '匹配中' : '房间') + ' · ' + room.players.length + ' / ' + room.size + ' 人'
      + (room.players.length >= 2 ? '（已可开局）' : '（至少 2 人）');
    document.getElementById('btnStartRoom').style.display = isHost ? '' : 'none';
    document.getElementById('btnFillAI').style.display = (isHost && room.players.length < room.size) ? '' : 'none';
    document.getElementById('btnStartRoom').disabled = room.players.length < 2;
    document.getElementById('roomHint').textContent = isHost
      ? '你是房主：满 2 人即可开局，也可让 AI 补满空位'
      : '等待房主开始游戏…';
  };

  App.onNetView = function (view) {
    this.mode = 'net';
    var g = document.getElementById('game');
    if (!g.classList.contains('active')) {
      UI.resetTable();
      this.lastEvId = 0;
      this.go('game');
    }
    this.renderView(view, { modeText: '联机 · 房间 ' + (Net.code || '') });
  };

  var _hintTimer = null;
  App.netHint = function (msg) {
    var el = document.getElementById('netHint');
    if (el) el.textContent = msg || '';
    if (_hintTimer) { clearTimeout(_hintTimer); _hintTimer = null; }
    if (msg) _hintTimer = setTimeout(function () { if (el) el.textContent = ''; }, 4000);
  };

  App.refreshRooms = function () {
    var box = document.getElementById('roomList');
    if (!box) return;
    if (location.protocol === 'file:' && !Net.base) {
      box.innerHTML = '<div class="empty">离线文件：联机需先在上方填写电脑服务器地址</div>';
      return;
    }
    Net.rooms().then(function (r) {
      var list = (r && r.rooms) || [];
      if (!list.length) { box.innerHTML = '<div class="empty">暂无公开房间，创建一个吧</div>'; return; }
      box.innerHTML = list.map(function (x) {
        return '<div class="room-item"><span>房间 <b style="color:#ffd977">' + x.code + '</b> · '
          + x.count + '/' + x.size + ' 人 · ' + (x.status === 'playing' ? '游戏中' : '等待中') + '</span>'
          + '<button class="mini-btn" data-code="' + x.code + '"' + (x.status === 'playing' || x.count >= x.size ? ' disabled' : '') + '>加入</button></div>';
      }).join('');
    }).catch(function () {
      box.innerHTML = '<div class="empty">联机服务未连接（单机模式可正常游玩）</div>';
    });
  };

  // 手机离线文件打开时，自动探测局域网内运行游戏的电脑，免去手动填地址
  App.autoConnectLan = function () {
    var box = document.getElementById('roomList');
    if (location.protocol !== 'file:') { this.refreshRooms(); return; }
    if (Net.base) { this.refreshRooms(); return; }
    if (box) box.innerHTML = '<div class="empty">正在自动查找你的电脑…</div>';
    var self = this;
    this.discoverLan(function (base) {
      Net.setBase(base);
      var sa = document.getElementById('serverAddr');
      if (sa) sa.value = base;
      self.netHint('已自动找到电脑：' + base);
      self.refreshRooms();
    }, function () {
      if (box) box.innerHTML = '<div class="empty">未找到电脑。请确认电脑已启动游戏，并手动在「服务器地址」填写，例如 http://192.168.1.3:8123</div>';
    });
  };

  App.discoverLan = function (onFound, onFail) {
    var segs = ['192.168.1', '192.168.0', '192.168.31', '192.168.2', '10.0.0'];
    var candidates = [];
    segs.forEach(function (s) { for (var i = 1; i <= 25; i++) candidates.push('http://' + s + '.' + i + ':8123'); });
    ['192.168.1.1', '192.168.0.1', '10.0.0.1', '192.168.31.1'].forEach(function (ip) { candidates.push('http://' + ip + ':8123'); });
    if (!candidates.length) { onFail && onFail(); return; }
    var found = false, checked = 0, total = candidates.length;
    function consider(ok) {
      if (found) return;
      checked++;
      if (ok) { found = true; return; }
      if (checked >= total) onFail && onFail();
    }
    candidates.forEach(function (base) {
      if (found) return;
      var ctrl = ('AbortController' in window) ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) try { ctrl.abort(); } catch (e) {} }, 450);
      fetch(base + '/api/lan', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { clearTimeout(timer); return r.ok ? r.json() : (consider(false), null); })
        .then(function (d) { if (d && d.lan) { found = true; onFound(base); } else if (d === null) { /* counted */ } else consider(false); })
        .catch(function () { clearTimeout(timer); consider(false); });
    });
    setTimeout(function () { if (!found) onFail && onFail(); }, 5000);
  };

  // ---------------- 规则说明 ----------------
  var RULES_HTML = '<h3>七王五二三 · 规则</h3><div class="rules-txt">'
    + '<h4>基础</h4>一副 54 张牌，2-6 人，每人 7 张，其余作牌堆。开局由手持<b>全场最小牌</b>（如 ♦4/♣4）的玩家先出，此后每轮由上一轮收牌者先出。'
    + '<h4>单牌大小</h4><code>7 &gt; 大王 &gt; 小王 &gt; 5 &gt; 2 &gt; 3 &gt; A &gt; K &gt; Q &gt; J &gt; 10 &gt; 9 &gt; 8 &gt; 6 &gt; 4</code><br>同点数比花色：<code>♠ &gt; ♥ &gt; ♣ &gt; ♦</code>'
    + '<h4>牌型</h4>单牌、对子（同点 2 张）、顺子（≥3 张自然连续，最小 3-4-5，最大 Q-K-A，仅同长度可比）。<br>炸弹体系：<code>四个7 &gt; 王炸 &gt; 其他四张 &gt; 三张 &gt; 任意普通牌型</code>。三张与四张都算炸弹，可压任何非炸弹牌型。'
    + '<h4>碰</h4>台面是<b>单牌</b>时，手上有<b>同点数</b>的牌即可「碰」：<br>· 用 1 张同点牌碰 → 台面换成你这张，后续需更大的单牌才能管；<br>· 用 2 张同点牌碰 → 台面升级为对子，后续要更大的对子才能管，管不住就是你的。<br>碰不要求比原牌大，这是碰的特权；炸弹依然可以压。'
    + '<h4>收分与补牌</h4>一轮中其他人全部「不出」后，本轮出牌最大者收走桌面所有分牌：<code>5 = 5 分，10 = 10 分，K = 10 分</code>（全场共 100 分）。随后从收牌者开始，所有人补牌至 7 张。'
    + '<h4>胜负</h4>牌堆耗尽后，先出完手牌者为第一名，其余继续厮杀，直至剩下最后一人为末名。收分为荣誉分，名次为最终排名。'
    + '</div><div class="btn-row"><button class="ghost-btn" onclick="QWUI.hideModal()">明白了</button></div>';

  // ---------------- 初始化 ----------------
  App.init = function () {
    UI.init(handlers());

    Array.prototype.forEach.call(document.querySelectorAll('[data-go]'), function (b) {
      b.onclick = function () { App.go(b.getAttribute('data-go')); };
    });
    document.getElementById('btnRules').onclick = function () { UI.showModal(RULES_HTML); };

    // 联机服务器地址（手机离线文件连电脑时用）
    function needServer() {
      if (location.protocol === 'file:' && !Net.base) {
        App.netHint('请先在上方「服务器地址」填写电脑局域网地址，如 http://192.168.1.3:8123');
        return false;
      }
      return true;
    }
    var sa = document.getElementById('serverAddr');
    if (sa) {
      sa.value = Net.base || '';
      var syncServer = function () { Net.setBase(sa.value); App.netHint(''); };
      sa.addEventListener('change', syncServer);
      sa.addEventListener('input', syncServer);
    }

    // 大厅：「手机同 WiFi 玩」局域网地址助手
    (function () {
      var box = document.getElementById('phoneHelp');
      var urlEl = document.getElementById('phoneUrl');
      var btn = document.getElementById('btnCopyPhone');
      if (!box || !urlEl) return;
      fetch('/api/lan').then(function (r) { return r.json(); }).then(function (d) {
        if (!d || !d.lan || !d.lan.length) return;
        var u = 'http://' + d.lan[0] + ':' + d.port;
        urlEl.textContent = u;
        box.style.display = '';
        btn.onclick = function () {
          var done = function () { btn.textContent = '已复制 ✓'; setTimeout(function () { btn.textContent = '复制地址'; }, 1500); };
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(u).then(done, function () { fallbackCopy(u); done(); });
          else { fallbackCopy(u); done(); }
        };
      }).catch(function () { /* 单机/离线时不显示 */ });
      function fallbackCopy(t) {
        try {
          var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta);
          ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        } catch (e) { }
      }
    })();

    ['soloCount', 'soloLevel', 'matchCount', 'createCount'].forEach(bindSeg);

    var saved = '';
    try { saved = localStorage.getItem('qw_name') || ''; } catch (e) { }
    if (saved) {
      document.getElementById('soloName').value = saved;
      document.getElementById('netName').value = saved;
    }

    // 单机
    document.getElementById('btnStartSolo').onclick = function () {
      App.mode = 'solo';
      App.lastEvId = 0;
      SFX.ac();
      var cfg = {
        name: getName('soloName'),
        count: parseInt(segVal('soloCount') || '3', 10),
        level: segVal('soloLevel') || 'normal'
      };
      App.go('game');
      Local.start(cfg);
    };

    // 联机：创建
    document.getElementById('btnCreate').onclick = function () {
      SFX.ac();
      if (!needServer()) return;
      var name = getName('netName'), size = parseInt(segVal('createCount') || '4', 10);
      App.netHint('创建中…');
      Net.create(name, size, true).then(function (r) {
        if (r.error) { App.netHint(r.error); return; }
        App.netHint('');
        Net.connect(r.code);
      }).catch(function () { App.netHint('无法连接服务器：请用浏览器打开 http://localhost:8123（不要用文件预览面板）'); });
    };

    // 联机：加入
    document.getElementById('btnJoin').onclick = function () {
      SFX.ac();
      if (!needServer()) return;
      var code = (document.getElementById('joinCode').value || '').trim();
      if (!/^\d{4}$/.test(code)) { App.netHint('请输入 4 位房间号'); return; }
      var name = getName('netName');
      App.netHint('加入中…');
      Net.join(name, code).then(function (r) {
        if (r.error) { App.netHint(r.error); return; }
        App.netHint('');
        Net.connect(r.code);
      }).catch(function () { App.netHint('无法连接服务器：请用浏览器打开 http://localhost:8123（不要用文件预览面板）'); });
    };

    // 联机：快速匹配
    document.getElementById('btnMatch').onclick = function () {
      SFX.ac();
      if (!needServer()) return;
      var name = getName('netName'), size = parseInt(segVal('matchCount') || '3', 10);
      App.netHint('匹配中…');
      Net.match(name, size).then(function (r) {
        if (r.error) { App.netHint(r.error); return; }
        App.netHint('');
        Net.connect(r.code);
      }).catch(function () { App.netHint('无法连接服务器：请用浏览器打开 http://localhost:8123（不要用文件预览面板）'); });
    };

    document.getElementById('btnRefreshRooms').onclick = function () { App.refreshRooms(); };
    document.getElementById('roomList').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-code]');
      if (!b) return;
      var name = getName('netName');
      Net.join(name, b.getAttribute('data-code')).then(function (r) {
        if (r.error) { App.netHint(r.error); return; }
        Net.connect(r.code);
      });
    });

    // 房间等待
    document.getElementById('btnLeaveRoom').onclick = function () {
      Net.leave(); App.go('onlineLobby');
    };
    document.getElementById('btnStartRoom').onclick = function () {
      Net.startGame(false).then(function (r) { if (r && r.error) UI.toast(r.error); });
    };
    document.getElementById('btnFillAI').onclick = function () {
      Net.startGame(true).then(function (r) { if (r && r.error) UI.toast(r.error); });
    };

    // 断线重连：如果本地记录了房间，尝试恢复
    try {
      var last = sessionStorage.getItem('qw_room');
      if (last) {
        Net.ensurePid();
        Net.get('/api/room?code=' + last + '&pid=' + Net.pid).then(function (r) {
          if (r && r.ok) Net.connect(last);
          else sessionStorage.removeItem('qw_room');
        }).catch(function () { });
      }
    } catch (e) { }

    document.addEventListener('keydown', function (e) {
      if (!document.getElementById('game').classList.contains('active')) return;
      var v = App.lastView;
      if (!v || v.turn !== v.you || !v.legal) return;
      if (e.code === 'Space') { e.preventDefault(); document.getElementById('aPlay') && document.getElementById('aPlay').click(); }
      if (e.code === 'KeyP' || e.code === 'Escape') { document.getElementById('aPass') && document.getElementById('aPass').click(); }
      if (e.code === 'KeyH') { document.getElementById('aHint') && document.getElementById('aHint').click(); }
    });
  };

  root.QWApp = App;
  root.QWSFX = SFX;
  document.addEventListener('DOMContentLoaded', function () { App.init(); });
})(window);
