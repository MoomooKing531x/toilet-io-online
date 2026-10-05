/* TOILET.IO multiplayer server
 * - Serves the game files (HTML + images) over HTTP
 * - Relays player state / shots over WebSocket on the SAME port
 * Run: node server.js   (or double-click start.bat)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 9009;
const ROOT = __dirname;
const INDEX = 'index.html';
const MAX_PLAYERS = 50;          // Reduced for better performance on free tier
const TICK_MS = 33;            // ~30 state broadcasts / second (faster for smoother gameplay)
const IDLE_KICK_MS = 20000;    // no state from a joined player for this long -> removed
const WORLD = { w: 2200 * 2, h: 1500 * 2 };  // Smaller world for better performance

const MIME = {
  '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.txt': 'text/plain; charset=utf-8',
};

/* ---------------- static file server ---------------- */
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/') p = '/' + INDEX;
  const file = path.normalize(path.join(ROOT, p));
  const ext = path.extname(file).toLowerCase();
  if (!file.startsWith(ROOT + path.sep) || !MIME[ext] || file.includes('node_modules')) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    // Enable caching for static assets to reduce load
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': cacheControl });
    res.end(data);
  });
});

/* ---------------- tiny dependency-free WebSocket (RFC 6455) ---------------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 262144;

class Sock {
  constructor(socket) {
    this.socket = socket; this.readyState = 1; this.buf = Buffer.alloc(0);
    this.frag = null; this.handlers = {}; this.isAlive = true;
    socket.setNoDelay(true);
    socket.on('data', d => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => { try { socket.destroy(); } catch (e) {} });
  }
  on(ev, fn) { this.handlers[ev] = fn; }
  _emit(ev, a) { if (this.handlers[ev]) this.handlers[ev](a); }
  _closed() { if (this.readyState !== 3) { this.readyState = 3; this._emit('close'); } }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (!masked || len > MAX_PAYLOAD) return this.terminate();   // clients must mask; cap size
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this._frame(0xA, payload); continue; }       // ping -> pong
      if (op === 0xA) { this._emit('pong'); continue; }
      if (op === 0x1 || op === 0x0) {
        if (op === 0x1) this.frag = [];
        if (!this.frag) continue;
        this.frag.push(payload);
        if (this.frag.reduce((n, p) => n + p.length, 0) > MAX_PAYLOAD) return this.terminate();
        if (fin) { const msg = Buffer.concat(this.frag).toString('utf8'); this.frag = null; this._emit('message', msg); }
      }
    }
  }
  _frame(op, payload) {
    if (this.readyState !== 1 && op !== 0x8) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    try { this.socket.write(Buffer.concat([head, payload])); } catch (e) {}
  }
  send(str) { this._frame(0x1, Buffer.from(str, 'utf8')); }
  ping() { this._frame(0x9, Buffer.alloc(0)); }
  close() { if (this.readyState === 1) { this._frame(0x8, Buffer.alloc(0)); this.readyState = 2; } try { this.socket.end(); } catch (e) {} }
  terminate() { this.readyState = 3; try { this.socket.destroy(); } catch (e) {} this._closed2(); }
  _closed2() { this._emit('close'); this.handlers = {}; }
}

/* ---------------- game relay ---------------- */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  onConnection(new Sock(socket));
});
let nextId = 1;
let hostId = null;         // client that simulates bots + pickups for everyone
let botsCache = [];        // last bot snapshot (kept while nobody is playing)
let pfCache = null;        // last full pickup snapshot
const clients = new Map(); // id -> { ws, id, joined, name, color, state, lastState, dirty, alive, msgs, windowStart }

const num = (v, lo, hi, d = 0) => (typeof v === 'number' && isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : d;
const cleanName = n => String(n == null ? 'Player' : n).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || 'Player';
const cleanColor = c => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) ? c : '#f4f7f6';

function sendTo(c, obj) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); }
function broadcast(obj, exceptId) {
  const data = JSON.stringify(obj);
  for (const c of clients.values()) if (c.id !== exceptId && c.ws.readyState === 1) c.ws.send(data);
}
const playingCount = () => { let n = 0; for (const c of clients.values()) if (c.joined) n++; return n; };
const pushCount = () => broadcast({ t: 'count', n: playingCount() });

function removeFromGame(c) {
  if (!c.joined) return;
  c.joined = false; c.state = null;
  broadcast({ t: 'leave', id: c.id }, c.id);
  pushCount();
}

function onConnection(ws, opts) {
  opts = opts || {};
  if (clients.size >= MAX_PLAYERS) { ws.close(); return; }
  const c = { ws, id: nextId++, joined: false, name: 'Player', color: '#f4f7f6', state: null, dirty: false,
              lastState: 0, ready: false, msgs: 0, windowStart: Date.now(), alive: true };
  clients.set(c.id, c);
  if (opts.internal) { c.internal = true; c.ready = true; hostId = c.id; }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  sendTo(c, { t: 'welcome', id: c.id, n: playingCount() });
  if (!c.internal && hostId) sendTo(c, { t: 'host', id: hostId });
  // tell the newcomer who is already playing
  for (const o of clients.values()) if (o.joined && o.id !== c.id) {
    sendTo(c, { t: 'join', id: o.id, name: o.name, color: o.color });
    if (o.state) sendTo(c, { t: 's', p: [o.state] });
  }

  ws.on('message', (raw) => {
    // crude flood protection: max 200 msgs / second
    const now = Date.now();
    if (now - c.windowStart > 1000) { c.windowStart = now; c.msgs = 0; }
    if (++c.msgs > 200) return;

    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'hello': {
        c.ready = true;
        if (c.internal) { broadcast({ t: 'host', id: hostId }, c.id); sendTo(c, { t: 'host', id: hostId, bots: botsCache, pf: pfCache || undefined }); break; }
        sendTo(c, { t: 'host', id: hostId, pf: pfCache || undefined });
        break;
      }
      case 'bots':
        if (c.id !== hostId || !Array.isArray(m.b) || m.b.length > 300) return;
        botsCache = m.b; broadcast({ t: 'bots', b: m.b }, c.id);
        break;
      case 'pfull':
        if (c.id !== hostId || !m.pf) return;
        pfCache = m.pf; broadcast({ t: 'pfull', pf: m.pf }, c.id);
        break;
      case 'padd': case 'pdel':
        if (c.id !== hostId) return;
        broadcast({ t: m.t, p: m.p }, c.id);
        break;
      case 'eat': {
        const h = clients.get(hostId);
        if (h && h !== c && typeof m.pid === 'string' && m.pid.length < 24) sendTo(h, { t: 'eat', pid: m.pid, by: c.id });
        break;
      }
      case 'botdied':
        if (c.id !== hostId) return;
        broadcast({ t: 'kill', victim: String(m.victim).slice(0, 24), vname: cleanName(m.vname), vxp: num(m.vxp, 0, 1e9),
          killer: (typeof m.killer === 'number' || typeof m.killer === 'string') ? m.killer : null,
          kname: m.killer != null ? cleanName(m.kname) : null }, c.id);
        break;

      case 'join':
        c.name = cleanName(m.name); c.color = cleanColor(m.color);
        c.joined = true; c.state = null; c.lastState = now;
        broadcast({ t: 'join', id: c.id, name: c.name, color: c.color }, c.id);
        pushCount();
        break;

      case 'leave':
        removeFromGame(c);
        break;

      case 's': {
        if (!c.joined || !Array.isArray(m.a) || m.a.length < 15) return;
        const a = m.a;
        c.state = [c.id,
          num(a[1], 0, WORLD.w), num(a[2], 0, WORLD.h), num(a[3], -7, 7), num(a[4], 1, 999), num(a[5], 0, 9999),
          a[6] ? 1 : 0, num(a[7], 0, 100), a[8] ? 1 : 0, num(a[9], -1, 10000), num(a[10], 0, 60000), a[11] ? 1 : 0,
          num(a[12], 0, 1e9), num(a[13], 0, 1e6), num(a[14], 0, 1e9)];
        c.dirty = true; c.lastState = now;
        break;
      }

      case 'fire': {
        if (!m.pr || (!c.joined && !(c.id === hostId && typeof m.o === 'string'))) return;
        const q = m.pr;
        const pr = {
          x: num(q.x, -500, WORLD.w + 500), y: num(q.y, -500, WORLD.h + 500),
          vx: num(q.vx, -4000, 4000), vy: num(q.vy, -4000, 4000),
          d: num(q.d, 0, 500), l: num(q.l, 0, 10), sz: num(q.sz, 0, 100),
          ty: q.ty === 'mega' ? 'mega' : 'piss', ch: q.ch ? 1 : 0, rf: q.rf ? 1 : 0,
          col: cleanColor(q.col), an: num(q.an, -7, 7),
        };
        const msg = { t: 'fire', id: c.id, pr };
        if (typeof m.o === 'string' && c.id === hostId) msg.o = m.o.slice(0, 24);
        broadcast(msg, c.id);
        break;
      }

      case 'emote':
        if (!c.joined || !['happy', 'mad', 'laugh', 'cry'].includes(m.e)) return;
        broadcast({ t: 'emote', id: c.id, e: m.e }, c.id);
        break;

      case 'died': {
        if (!c.joined) return;
        let killer = null, kname = null;
        if (typeof m.killer === 'number') { const k = clients.get(m.killer); if (k && k.joined && k.id !== c.id) { killer = k.id; kname = k.name; } }
        else if (typeof m.killer === 'string') { killer = m.killer.slice(0, 24); kname = cleanName(m.kname); }
        broadcast({ t: 'kill', victim: c.id, vname: c.name, vxp: num(m.vxp, 0, 1e9), killer, kname }, c.id);
        break;
      }
    }
  });

  ws.on('close', () => { removeFromGame(c); clients.delete(c.id); c.ready = false; });
}

// batched state broadcast
setInterval(() => {
  const now = Date.now();
  const batch = [];
  for (const c of clients.values()) {
    if (c.joined && now - c.lastState > IDLE_KICK_MS) { removeFromGame(c); continue; }
    if (c.joined && c.dirty && c.state) { batch.push(c.state); c.dirty = false; }
  }
  if (batch.length) broadcast({ t: 's', p: batch });
}, TICK_MS);

// drop dead connections
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.ws.isAlive) { c.ws.terminate(); continue; }
    c.ws.isAlive = false; c.ws.ping();
  }
}, 15000);

const headless = require('./headless');
server.listen(PORT, '0.0.0.0', () => {
  headless.start(path.join(ROOT, INDEX), onConnection);
  console.log('\n  TOILET.IO server running\n');
  console.log('  This PC:      http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log('  Same network: http://' + i.address + ':' + PORT);
  console.log('\n  Press Ctrl+C to stop.\n');
});
