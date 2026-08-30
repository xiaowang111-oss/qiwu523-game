/*!
 * 七王五二三 —— 联机服务端（零依赖：Node 内置 http + SSE）
 * 启动: node server.js  然后浏览器访问 http://localhost:8123
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const R = require('./public/js/rules.js');
const { Engine } = require('./public/js/engine.js');
const AI = require('./public/js/ai.js');

const PORT = parseInt(process.env.PORT || '8123', 10);
const PUB = path.join(__dirname, 'public');
const TURN_SECONDS = 25;          // 真人思考时限
const MATCH_WAIT_MS = 45000;      // 快速匹配等待上限
const DEAD_MS = 5 * 60 * 1000;    // 房间闲置回收
const AI_NAMES = ['小虎', '阿福', '花花', '老K', '青蛙', '闷墩', '大聪明', '铁蛋'];

/** @type {Map<string, Room>} */
const rooms = new Map();

// ---------------- 工具 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json'
};

// 收集局域网 IPv4 地址（供手机同 WiFi 访问）
function lanAddresses() {
  const out = [];
  const nets = require('os').networkInterfaces();
  Object.keys(nets).forEach(k => (nets[k] || []).forEach(a => {
    if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }));
  return out;
}

function json(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function newCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}
function safeName(s, fb) {
  s = String(s == null ? '' : s).replace(/[<>&"'\r\n]/g, '').trim();
  return (s || fb || '玩家').slice(0, 8);
}
function log(...a) { console.log('[' + new Date().toLocaleTimeString('zh-CN') + ']', ...a); }

// ---------------- 房间 ----------------
class Room {
  constructor(opts) {
    this.code = newCode();
    this.size = Math.max(2, Math.min(6, opts.size || 3));
    this.mode = opts.mode || 'room';     // room | match
    this.isPublic = opts.isPublic !== false;
    this.status = 'waiting';             // waiting | playing
    this.hostPid = opts.hostPid;
    this.players = [];                   // {pid,name,isAI,seat,res,alive,auto,timeouts,lastSeen}
    this.engine = null;
    this.deadline = 0;
    this.turnTotal = 0;
    this.timerAuto = null;
    this.timerMatch = null;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    rooms.set(this.code, this);
  }

  humanPlayers() { return this.players.filter(p => !p.isAI); }
  byPid(pid) { return this.players.find(p => p.pid === pid); }
  bySeat(seat) { return this.players.find(p => p.seat === seat); }

  addPlayer(pid, name, isAI) {
    if (this.players.length >= this.size) return null;
    const p = {
      pid: pid, name: safeName(name, 'AI'), isAI: !!isAI,
      seat: this.players.length, res: null, alive: !isAI, auto: false, timeouts: 0, lastSeen: Date.now()
    };
    this.players.push(p);
    if (!this.hostPid && !isAI) this.hostPid = pid;
    this.updatedAt = Date.now();
    return p;
  }

  removePlayer(pid) {
    const i = this.players.findIndex(p => p.pid === pid);
    if (i < 0) return;
    const p = this.players[i];
    if (this.status === 'playing') {
      // 游戏中离开 -> 交给 AI 托管，保持牌局完整
      p.alive = false; p.auto = true;
      if (p.res) { try { p.res.end(); } catch (e) { } p.res = null; }
      if (this.engine) this.engine.seats[p.seat].auto = true, this.engine.seats[p.seat].connected = false;
    } else {
      if (p.res) { try { p.res.end(); } catch (e) { } }
      this.players.splice(i, 1);
      this.players.forEach((x, k) => { x.seat = k; });
      if (this.hostPid === pid) {
        const h = this.humanPlayers()[0];
        this.hostPid = h ? h.pid : null;
      }
    }
    this.updatedAt = Date.now();
    if (!this.humanPlayers().some(p => p.alive) && this.status !== 'playing') this.destroyLater();
    this.broadcast();
  }

  destroyLater() {
    if (this.humanPlayers().length === 0) this.destroy();
  }
  destroy() {
    clearTimeout(this.timerAuto); clearTimeout(this.timerMatch);
    this.players.forEach(p => { if (p.res) { try { p.res.end(); } catch (e) { } } });
    rooms.delete(this.code);
    log('房间', this.code, '已销毁');
  }

  publicInfo() {
    return {
      code: this.code, size: this.size, mode: this.mode, status: this.status,
      matchDeadline: this.mode === 'match' && this.status === 'waiting' ? this.createdAt + MATCH_WAIT_MS : 0,
      players: this.players.map(p => ({
        pid: p.pid, name: p.name, isAI: p.isAI, host: p.pid === this.hostPid, alive: p.alive
      }))
    };
  }

  send(p, obj) {
    if (!p.res) return;
    try { p.res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { p.alive = false; p.res = null; }
  }

  broadcast() {
    if (this.status === 'playing' && this.engine) {
      this.players.forEach(p => {
        if (p.isAI || !p.res) return;
        const view = this.engine.viewFor(p.seat);
        view.deadline = this.deadline;
        view.turnTotal = this.turnTotal;
        view.roomCode = this.code;
        this.send(p, { t: 'view', view: view });
      });
    } else {
      const info = this.publicInfo();
      this.players.forEach(p => { if (!p.isAI && p.res) this.send(p, { t: 'room', room: info }); });
    }
  }

  // ---------- 开局 ----------
  startGame(fillAI) {
    if (this.status === 'playing') return { error: '对局已经开始' };
    let humans = this.players.filter(p => !p.isAI).length;
    if (this.players.length < 2 && !fillAI) return { error: '至少需要 2 名玩家' };
    if (fillAI) {
      const used = this.players.map(p => p.name);
      const pool = AI_NAMES.filter(n => used.indexOf(n) < 0);
      let k = 0;
      while (this.players.length < this.size) {
        this.addPlayer('ai_' + this.code + '_' + (k + 1), pool[k % pool.length] || ('AI' + (k + 1)), true);
        k++;
      }
    }
    if (this.players.length < 2) return { error: '至少需要 2 名玩家' };
    clearTimeout(this.timerMatch);
    this.engine = new Engine({
      players: this.players.map((p, i) => ({ name: p.name, isAI: p.isAI, avatar: i % 8, connected: p.alive }))
    });
    this.players.forEach(p => { p.auto = false; p.timeouts = 0; });
    this.status = 'playing';
    this.updatedAt = Date.now();
    log('房间', this.code, '开局', this.players.map(p => p.name + (p.isAI ? '(AI)' : '')).join('/'));
    this.broadcast();
    this.schedule();
    return { ok: true };
  }

  again(pid) {
    if (pid !== this.hostPid) return { error: '等待房主开始下一局' };
    if (this.status === 'playing' && this.engine && this.engine.phase !== 'over') return { error: '本局还没结束' };
    this.status = 'waiting';
    this.engine = null;
    // 离线的真人清出去
    this.players = this.players.filter(p => p.isAI || p.alive);
    this.players.forEach((p, k) => { p.seat = k; });
    if (this.players.length < 2) { this.broadcast(); return { ok: true, waiting: true }; }
    return this.startGame(false);
  }

  // ---------- 回合驱动 ----------
  schedule() {
    clearTimeout(this.timerAuto);
    if (this.status !== 'playing' || !this.engine) return;
    if (this.engine.phase !== 'playing') {
      this.deadline = 0; this.turnTotal = 0;
      this.broadcast();
      return;
    }
    const seat = this.engine.turn;
    const p = this.bySeat(seat);
    const bot = !p || p.isAI || p.auto || !p.alive;
    const delay = bot ? (700 + Math.random() * 500) : TURN_SECONDS * 1000;
    this.deadline = Date.now() + delay;
    this.turnTotal = bot ? 0 : TURN_SECONDS;
    this.broadcast();
    this.timerAuto = setTimeout(() => this.autoAct(seat), delay);
  }

  autoAct(seat) {
    if (this.status !== 'playing' || !this.engine || this.engine.phase !== 'playing') return;
    if (this.engine.turn !== seat) return;
    const p = this.bySeat(seat);
    const view = this.engine.viewFor(seat);
    let act = null;
    try { act = AI.chooseAction(view, { level: 'normal' }); } catch (e) { act = null; }
    if (!act) act = { type: 'pass' };
    let res = this.engine.apply({ seat: seat, type: act.type, cards: act.cards });
    if (!res.ok) {
      const lg = this.engine.legalFor(seat);
      if (lg && lg.plays && lg.plays.length) this.engine.apply({ seat: seat, type: 'play', cards: lg.plays[0].cards });
      else if (lg && lg.canPass) this.engine.apply({ seat: seat, type: 'pass' });
    }
    if (p && !p.isAI) {
      p.timeouts++;
      if (p.timeouts >= 2 && !p.auto) {
        p.auto = true;
        if (this.engine) this.engine.seats[seat].auto = true;
      }
    }
    this.schedule();
  }

  act(pid, action) {
    if (this.status !== 'playing' || !this.engine) return { error: '不在对局中' };
    const p = this.byPid(pid);
    if (!p) return { error: '你不在这个房间' };
    if (this.engine.turn !== p.seat) return { error: '还没轮到你' };
    const res = this.engine.apply({ seat: p.seat, type: action.type, cards: action.cards });
    if (!res.ok) return { error: res.error };
    p.timeouts = 0;
    if (p.auto) { p.auto = false; this.engine.seats[p.seat].auto = false; }
    this.schedule();
    return { ok: true };
  }

  attach(pid, res) {
    const p = this.byPid(pid);
    if (!p) return false;
    if (p.res) { try { p.res.end(); } catch (e) { } }
    p.res = res; p.alive = true; p.lastSeen = Date.now();
    if (this.engine) { this.engine.seats[p.seat].connected = true; }
    if (this.status === 'playing' && this.engine) {
      const view = this.engine.viewFor(p.seat);
      view.deadline = this.deadline; view.turnTotal = this.turnTotal; view.roomCode = this.code;
      this.send(p, { t: 'view', view: view });
    } else {
      this.send(p, { t: 'room', room: this.publicInfo() });
    }
    this.broadcast();
    return true;
  }
}

// 快速匹配等待到点
function armMatchTimer(room) {
  clearTimeout(room.timerMatch);
  room.timerMatch = setTimeout(() => {
    if (room.status !== 'waiting') return;
    if (room.humanPlayers().filter(p => p.alive).length === 0) { room.destroy(); return; }
    log('房间', room.code, '匹配超时，AI 补位开局');
    room.startGame(true);
  }, Math.max(1000, room.createdAt + MATCH_WAIT_MS - Date.now()));
}

// ---------------- HTTP ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;

  // 跨域预检（手机离线文件连本机服务时需要）
  if (req.method === 'OPTIONS' && p.startsWith('/api/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // SSE
  if (p === '/api/stream') {
    const code = u.searchParams.get('code'), pid = u.searchParams.get('pid');
    const room = rooms.get(code);
    if (!room || !room.byPid(pid)) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('no room');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': connected\n\n');
    room.attach(pid, res);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) { } }, 20000);
    req.on('close', () => {
      clearInterval(hb);
      const pl = room.byPid(pid);
      if (pl && pl.res === res) {
        pl.res = null; pl.alive = false;
        if (room.engine) room.engine.seats[pl.seat] && (room.engine.seats[pl.seat].connected = false);
        if (room.status === 'playing') { pl.auto = true; if (room.engine) room.engine.seats[pl.seat].auto = true; }
        room.broadcast();
        if (room.status === 'playing') room.schedule();
      }
    });
    return;
  }

  if (p === '/api/rooms') {
    const list = [];
    rooms.forEach(r => {
      if (!r.isPublic) return;
      list.push({ code: r.code, size: r.size, count: r.players.length, status: r.status, mode: r.mode });
    });
    return json(res, { rooms: list.slice(0, 30) });
  }

  if (p === '/api/lan') {
    return json(res, { port: PORT, lan: lanAddresses() });
  }

  if (p === '/api/room') {
    const room = rooms.get(u.searchParams.get('code'));
    const pid = u.searchParams.get('pid');
    if (!room || !room.byPid(pid)) return json(res, { ok: false });
    return json(res, { ok: true, room: room.publicInfo() });
  }

  if (p.startsWith('/api/')) {
    if (req.method !== 'POST') return json(res, { error: '方法不支持' }, 405);
    const body = await readBody(req);
    const pid = String(body.pid || '').slice(0, 40);
    if (!pid) return json(res, { error: '缺少身份标识' });

    if (p === '/api/create') {
      const room = new Room({ size: body.size, mode: 'room', isPublic: body.isPublic, hostPid: pid });
      room.addPlayer(pid, body.name, false);
      log('创建房间', room.code, '人数', room.size);
      return json(res, { ok: true, code: room.code });
    }

    if (p === '/api/join') {
      const room = rooms.get(String(body.code || ''));
      if (!room) return json(res, { error: '房间不存在' });
      const exist = room.byPid(pid);
      if (exist) return json(res, { ok: true, code: room.code });
      if (room.status === 'playing') return json(res, { error: '该房间已开局' });
      if (room.players.length >= room.size) return json(res, { error: '房间已满' });
      room.addPlayer(pid, body.name, false);
      room.broadcast();
      if (room.mode === 'match' && room.players.length >= room.size) room.startGame(false);
      return json(res, { ok: true, code: room.code });
    }

    if (p === '/api/match') {
      const size = Math.max(2, Math.min(6, parseInt(body.size, 10) || 3));
      let target = null;
      rooms.forEach(r => {
        if (target) return;
        if (r.mode === 'match' && r.status === 'waiting' && r.size === size && r.players.length < r.size && !r.byPid(pid)) target = r;
      });
      if (!target) {
        target = new Room({ size: size, mode: 'match', isPublic: true, hostPid: pid });
        armMatchTimer(target);
        log('新建匹配房', target.code, size, '人');
      }
      if (!target.byPid(pid)) target.addPlayer(pid, body.name, false);
      target.broadcast();
      if (target.players.length >= target.size) target.startGame(false);
      return json(res, { ok: true, code: target.code });
    }

    const room = rooms.get(String(body.code || ''));
    if (!room) return json(res, { error: '房间不存在' });

    if (p === '/api/start') {
      if (pid !== room.hostPid) return json(res, { error: '只有房主可以开始' });
      return json(res, room.startGame(!!body.fillAI));
    }
    if (p === '/api/again') return json(res, room.again(pid));
    if (p === '/api/action') {
      const r = room.act(pid, body.action || {});
      return json(res, r);
    }
    if (p === '/api/leave') {
      room.removePlayer(pid);
      return json(res, { ok: true });
    }
    if (p === '/api/ping') {
      const pl = room.byPid(pid);
      if (pl) pl.lastSeen = Date.now();
      room.updatedAt = Date.now();
      return json(res, { ok: true });
    }
    return json(res, { error: '未知接口' }, 404);
  }

  // 静态文件
  let rel = decodeURIComponent(p);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUB, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUB)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// 闲置房间回收
setInterval(() => {
  const now = Date.now();
  rooms.forEach(r => {
    const anyAlive = r.players.some(p => !p.isAI && p.alive);
    if (!anyAlive && now - r.updatedAt > DEAD_MS) r.destroy();
    if (r.status === 'playing' && r.engine && r.engine.phase === 'over' && now - r.updatedAt > DEAD_MS) r.destroy();
  });
}, 60000);

function listen(port, tries) {
  server.listen(port, () => {
    log('七王五二三 服务已启动');
    log('  本机访问:  http://localhost:' + port);
    const nets = require('os').networkInterfaces();
    Object.keys(nets).forEach(k => (nets[k] || []).forEach(a => {
      if (a.family === 'IPv4' && !a.internal) log('  局域网访问: http://' + a.address + ':' + port);
    }));
    log('  联机玩法: 同一 WiFi 下的手机/电脑打开上面的局域网地址即可');
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) {
      log('端口 ' + port + ' 被占用，尝试 ' + (port + 1));
      setTimeout(() => listen(port + 1, tries - 1), 200);
    } else {
      console.error(e);
      process.exit(1);
    }
  });
}
listen(PORT, 12);
