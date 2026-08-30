/*!
 * 七王五二三 —— 联机客户端（SSE 接收 + POST 发送，零依赖）
 */
(function (root) {
  'use strict';

  var Net = {
    pid: null, code: null, es: null, room: null, view: null,
    base: '', heartbeat: null, retry: 0, closedByUser: false
  };

  // 离线单文件 / 跨设备时，可手动指定服务器地址（如 http://192.168.1.3:8123）
  try { var _sb = localStorage.getItem('qw_server'); if (_sb) Net.base = _sb; } catch (e) {}
  Net.setBase = function (u) {
    u = (u || '').trim().replace(/\/+$/, '');
    Net.base = u;
    try { localStorage.setItem('qw_server', u); } catch (e) {}
  };
  Net._url = function (p) { return Net.base ? (Net.base + p) : p; };

  Net.ensurePid = function () {
    if (this.pid) return this.pid;
    try {
      this.pid = localStorage.getItem('qw_pid');
    } catch (e) { }
    if (!this.pid) {
      this.pid = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      try { localStorage.setItem('qw_pid', this.pid); } catch (e) { }
    }
    return this.pid;
  };

  Net.post = function (path, body) {
    return fetch(Net._url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  };

  Net.get = function (path) {
    return fetch(Net._url(path)).then(function (r) { return r.json(); });
  };

  Net.create = function (name, size, isPublic) {
    return this.post('/api/create', { pid: this.ensurePid(), name: name, size: size, isPublic: isPublic !== false });
  };
  Net.join = function (name, code) {
    return this.post('/api/join', { pid: this.ensurePid(), name: name, code: code });
  };
  Net.match = function (name, size) {
    return this.post('/api/match', { pid: this.ensurePid(), name: name, size: size });
  };
  Net.rooms = function () { return this.get('/api/rooms'); };
  Net.startGame = function (fillAI) {
    return this.post('/api/start', { pid: this.ensurePid(), code: this.code, fillAI: !!fillAI });
  };
  Net.again = function () { return this.post('/api/again', { pid: this.ensurePid(), code: this.code }); };
  Net.leave = function () {
    var p = this.code ? this.post('/api/leave', { pid: this.ensurePid(), code: this.code }) : Promise.resolve({});
    this.disconnect();
    return p;
  };
  Net.action = function (act) {
    return this.post('/api/action', { pid: this.ensurePid(), code: this.code, action: act })
      .then(function (r) {
        if (r && r.error) root.QWUI.toast(r.error);
        return r;
      });
  };

  Net.connect = function (code) {
    this.disconnect();
    this.code = code;
    this.closedByUser = false;
    var self = this;
    try { sessionStorage.setItem('qw_room', code); } catch (e) { }
    var url = Net._url('/api/stream?code=' + encodeURIComponent(code) + '&pid=' + encodeURIComponent(this.ensurePid()));
    var es = new EventSource(url);
    this.es = es;
    es.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      self.handle(msg);
    };
    es.onerror = function () {
      if (self.closedByUser) return;
      root.QWApp.netHint('连接中断，正在重连…');
    };
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(function () {
      if (!self.code) return;
      self.post('/api/ping', { pid: self.pid, code: self.code }).catch(function () { });
    }, 12000);
  };

  Net.disconnect = function () {
    this.closedByUser = true;
    if (this.es) { try { this.es.close(); } catch (e) { } this.es = null; }
    clearInterval(this.heartbeat);
    this.code = null;
    try { sessionStorage.removeItem('qw_room'); } catch (e) { }
  };

  Net.handle = function (msg) {
    if (!msg || !msg.t) return;
    if (msg.t === 'room') {
      this.room = msg.room;
      root.QWApp.onRoom(msg.room);
    } else if (msg.t === 'view') {
      this.view = msg.view;
      root.QWApp.onNetView(msg.view);
    } else if (msg.t === 'err') {
      root.QWUI.toast(msg.msg || '出错了');
    } else if (msg.t === 'kick') {
      root.QWUI.toast(msg.msg || '你已离开房间');
      this.disconnect();
      root.QWApp.go('onlineLobby');
    } else if (msg.t === 'ping') {
      /* 保活 */
    }
  };

  root.QWNet = Net;
})(window);
