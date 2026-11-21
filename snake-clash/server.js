// Snake Clash - LAN multiplayer snake battle (no dependencies, just Node.js)
// Run: node server.js   then open http://<this-pc-ip>:3000 on each computer.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;

// ---------- World ----------
const W = 1600, H = 1000;
const SEG = 8;            // distance between body points
const START_SEGS = 14;    // body points at spawn
const GROW = 0.55;        // extra body points per unit of mass eaten
const MAX_PELLETS = 900;
const COLORS = ['#00e5ff', '#ff3d81', '#ffd400', '#7cff4f', '#b388ff', '#ff8a3d', '#4dffd2', '#ff5252', '#7aa2ff', '#ffa6c9'];
const PELLET_COLORS = ['#00e5ff', '#ff3d81', '#ffd400', '#7cff4f', '#b388ff', '#ff8a3d'];

// ---------- Settings (changed by the host from the dashboard) ----------
const DEFAULTS = { bots: 0, speed: 190, food: 180 };
const LIMITS = { bots: [0, 8], speed: [120, 300], food: [40, 500] };
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

function normalize(src, base) {
  const out = { ...base };
  if (!src || typeof src !== 'object') return out;
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const n = Number(src[k]);
    if (src[k] !== undefined && src[k] !== null && src[k] !== '' && Number.isFinite(n)) out[k] = Math.max(lo, Math.min(hi, Math.round(n)));
  }
  return out;
}
const settings = { ...DEFAULTS };
try { Object.assign(settings, normalize(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')), DEFAULTS)); } catch { /* first run */ }
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch { /* read-only folder: fine */ } }

// ---------- State ----------
const snakes = new Map();   // id -> snake (humans and bots)
const pellets = new Map();  // id -> pellet
let nextId = 1, nextPellet = 1, ambient = 0, foodBudget = 0;
let padd = [], prem = [];   // pellet changes since the last broadcast
const events = [];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const angleDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const radiusOf = s => 9 + Math.min(8, s.pts.length / 45);
const pelletR = v => Math.min(10, 3.5 + v * 1.3);

function addPellet(x, y, v, color, amb) {
  if (pellets.size >= MAX_PELLETS) return;
  const p = { id: nextPellet++, x: Math.round(x), y: Math.round(y), v: +v.toFixed(1), color, amb: !!amb };
  pellets.set(p.id, p);
  if (amb) ambient++;
  padd.push([p.id, p.x, p.y, p.v, p.color]);
}
function removePellet(p) {
  pellets.delete(p.id);
  if (p.amb) ambient--;
  prem.push(p.id);
}
function addAmbient() {
  const big = Math.random() < 0.08;
  addPellet(30 + Math.random() * (W - 60), 30 + Math.random() * (H - 60), big ? 3 : 1,
    PELLET_COLORS[Math.floor(Math.random() * PELLET_COLORS.length)], true);
}
function topUpFood(dt) {
  foodBudget += 40 * dt;
  while (ambient < settings.food && foodBudget >= 1) { addAmbient(); foodBudget--; }
  if (ambient >= settings.food) foodBudget = 0;
}

// ---------- Snakes ----------
function spawn(s) {
  let best = { x: W / 2, y: H / 2 }, bestD = -1;
  for (let i = 0; i < 25; i++) {
    const x = 160 + Math.random() * (W - 320), y = 160 + Math.random() * (H - 320);
    let d = Infinity;
    for (const o of snakes.values()) if (o !== s && o.alive) for (let j = 0; j < o.pts.length; j += 4) d = Math.min(d, Math.hypot(o.pts[j].x - x, o.pts[j].y - y));
    if (d > bestD) { bestD = d; best = { x, y }; }
  }
  s.mass = 0; s.alive = true; s.shield = 2.5; s.boost = false; s.dropAcc = 0;
  s.angle = Math.atan2(H / 2 - best.y, W / 2 - best.x);
  s.input = { a: s.angle, boost: false };
  s.pts = [];
  for (let i = 0; i < START_SEGS; i++) s.pts.push({ x: best.x - Math.cos(s.angle) * SEG * i, y: best.y - Math.sin(s.angle) * SEG * i });
}

function newSnake(name, bot) {
  const used = new Set([...snakes.values()].map(s => s.color));
  const color = COLORS.find(c => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];
  const s = { id: nextId++, name, color, bot: !!bot, mass: 0, kills: 0, deaths: 0, alive: false, respawn: 0, angle: 0, boost: false, dropAcc: 0, shield: 0, pts: [], input: { a: 0, boost: false }, ai: bot ? { t: 0 } : null };
  snakes.set(s.id, s);
  spawn(s);
  return s;
}

function die(s, killer, why) {
  s.alive = false; s.respawn = 3; s.deaths++;
  const n = s.pts.length, drops = Math.ceil(n / 2);
  const v = clamp((s.mass * 0.8 + 8) / drops, 1, 6);
  for (let i = 0; i < n; i += 2) addPellet(s.pts[i].x + (Math.random() - 0.5) * 10, s.pts[i].y + (Math.random() - 0.5) * 10, v, s.color, false);
  if (killer && killer !== s) { killer.kills++; events.push({ kind: 'kill', killer: killer.name, victim: s.name, kc: killer.color, vc: s.color }); }
  else events.push({ kind: 'wall', victim: s.name, vc: s.color });
}

function updateSnake(s, dt) {
  if (!s.alive) { if ((s.respawn -= dt) <= 0) spawn(s); return; }
  if (s.bot) botThink(s, dt);
  const inp = s.input;
  const maxTurn = (s.boost ? 3.4 : 4.6) * dt;
  s.angle += clamp(angleDiff(inp.a, s.angle), -maxTurn, maxTurn);
  s.boost = !!inp.boost && s.mass > 1.5;
  const speed = settings.speed * (s.boost ? 1.75 : 1);
  const head = s.pts[0];
  head.x += Math.cos(s.angle) * speed * dt; head.y += Math.sin(s.angle) * speed * dt;
  if (s.boost) { // boosting burns mass and leaves a trail of pellets
    s.mass = Math.max(0, s.mass - 4 * dt);
    if ((s.dropAcc += dt) >= 0.3) { s.dropAcc = 0; const t = s.pts[s.pts.length - 1]; addPellet(t.x, t.y, 1, s.color, false); }
  }
  s.shield = Math.max(0, s.shield - dt);
  // body follows the head
  for (let i = 1; i < s.pts.length; i++) {
    const a = s.pts[i - 1], b = s.pts[i], dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy);
    if (d > SEG) { const k = (d - SEG) / d; b.x += dx * k; b.y += dy * k; }
  }
  const target = START_SEGS + Math.floor(s.mass * GROW);
  while (s.pts.length < target) { const t = s.pts[s.pts.length - 1]; s.pts.push({ x: t.x, y: t.y }); }
  while (s.pts.length > target && s.pts.length > START_SEGS) s.pts.pop();
  // eat pellets
  const er = radiusOf(s) + 6;
  for (const p of pellets.values()) {
    const dx = p.x - head.x, dy = p.y - head.y, rr = er + pelletR(p.v);
    if (dx * dx + dy * dy < rr * rr) { s.mass += p.v; removePellet(p); }
  }
}

function collisions() {
  const dead = [];
  for (const a of snakes.values()) {
    if (!a.alive || a.shield > 0) continue; // spawn shield: you pass through and can't be hit
    const h = a.pts[0], ra = radiusOf(a);
    if (h.x < ra || h.y < ra || h.x > W - ra || h.y > H - ra) { dead.push([a, null]); continue; }
    outer:
    for (const b of snakes.values()) {
      if (b === a || !b.alive || b.shield > 0) continue;
      const lim = ra * 0.8 + radiusOf(b) * 0.85;
      for (let j = 0; j < b.pts.length; j++) {
        if (Math.hypot(b.pts[j].x - h.x, b.pts[j].y - h.y) < lim) { dead.push([a, b]); break outer; }
      }
    }
  }
  for (const [a, b] of dead) die(a, b); // applied together so head-on crashes kill both
}

// ---------- Bots ----------
const BOT_NAMES = ['Viper', 'Mamba', 'Cobra', 'Python', 'Adder', 'Asp', 'Boa', 'Krait'];

function danger(s, ang) {
  const h = s.pts[0], r = radiusOf(s);
  let d = 0;
  [35, 75, 120].forEach((dist, idx) => {
    const w = 3 - idx, x = h.x + Math.cos(ang) * dist, y = h.y + Math.sin(ang) * dist;
    if (x < 30 || y < 30 || x > W - 30 || y > H - 30) d += 10 * w;
    for (const o of snakes.values()) {
      if (o === s || !o.alive || o.shield > 0) continue;
      const lim = r + radiusOf(o) + 10;
      for (let j = 0; j < o.pts.length; j += 2) if (Math.hypot(o.pts[j].x - x, o.pts[j].y - y) < lim) { d += 10 * w; break; }
    }
  });
  return d;
}

function botThink(s, dt) {
  if ((s.ai.t -= dt) > 0) return;
  s.ai.t = 0.1 + Math.random() * 0.08;
  const h = s.pts[0];
  let best = null, bestScore = Infinity;
  const turnR = settings.speed / 4.6; // tightest circle this snake can turn on
  for (const p of pellets.values()) {
    const d = Math.hypot(p.x - h.x, p.y - h.y);
    if (d > 600) continue;
    if (p.x < 55 || p.y < 55 || p.x > W - 55 || p.y > H - 55) continue; // too close to the deadly border
    // A pellet inside the turning circle can only be orbited, never reached: skip it.
    if (d < turnR * 2.2 && Math.abs(angleDiff(Math.atan2(p.y - h.y, p.x - h.x), s.angle)) > 1.0) continue;
    const score = d - p.v * 25;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  const target = best ? Math.atan2(best.y - h.y, best.x - h.x) : s.angle + (Math.random() - 0.5) * 0.8;
  let ang = target, bestDanger = Infinity;
  for (const off of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, Math.PI]) {
    const dg = danger(s, target + off) + Math.abs(off) * 0.5;
    if (dg < bestDanger) { bestDanger = dg; ang = target + off; }
  }
  s.input.a = ang;
  s.input.boost = false; // boosting widens the turning circle too much for the simple wall/body lookahead
}

function ensureBots() {
  const bots = [...snakes.values()].filter(s => s.bot);
  while (bots.length > settings.bots) snakes.delete(bots.pop().id);
  while (bots.length < settings.bots) {
    const used = new Set(bots.map(b => b.name));
    bots.push(newSnake('Bot ' + (BOT_NAMES.find(n => !used.has('Bot ' + n)) || nextId), true));
  }
}

// ---------- Simulation ----------
const TICK = 1 / 60;
let tickCount = 0;

function update(dt) {
  topUpFood(dt);
  for (const s of snakes.values()) updateSnake(s, dt);
  collisions();
}

function snapshot() {
  const msg = JSON.stringify({
    t: 'state',
    players: [...snakes.values()].map(s => {
      const flat = [];
      if (s.alive) {
        for (let i = 0; i < s.pts.length; i += 2) flat.push(Math.round(s.pts[i].x), Math.round(s.pts[i].y));
        if ((s.pts.length - 1) % 2 !== 0) { const t = s.pts[s.pts.length - 1]; flat.push(Math.round(t.x), Math.round(t.y)); }
      }
      return { id: s.id, name: s.name, color: s.color, bot: s.bot, alive: s.alive, mass: Math.floor(s.mass), kills: s.kills,
        a: +s.angle.toFixed(2), r: +radiusOf(s).toFixed(1), boost: s.boost, shield: s.shield > 0, respawn: s.alive ? 0 : +Math.max(0, s.respawn).toFixed(1), pts: flat };
    }),
    padd, prem, events: events.splice(0),
  });
  padd = []; prem = [];
  return msg;
}

const humansPresent = () => { for (const c of clients) if (c.player) return true; return false; };
setInterval(() => {
  if (!humansPresent()) return; // the game only runs while someone is connected
  update(TICK);
  if (++tickCount % 2 === 0) broadcast(snapshot());
}, 1000 * TICK);

function resetWorld() { for (const s of snakes.values()) { s.kills = 0; s.deaths = 0; spawn(s); } }

function applySettings(patch) {
  const prev = { ...settings };
  Object.assign(settings, normalize(patch, settings));
  if (settings.food < prev.food) { // trim surplus pellets
    for (const p of [...pellets.values()]) { if (ambient <= settings.food) break; if (p.amb) removePellet(p); }
  }
  ensureBots();
  if (JSON.stringify(prev) !== JSON.stringify(settings)) { saveSettings(); console.log('* settings changed:', JSON.stringify(settings)); }
}

// ---------- Minimal WebSocket (RFC 6455) ----------
const clients = new Set();

function sendFrame(sock, str) {
  if (sock.destroyed) return;
  const data = Buffer.from(str);
  let header;
  if (data.length < 126) header = Buffer.from([0x81, data.length]);
  else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  sock.write(Buffer.concat([header, data]));
}
function broadcast(str) { for (const c of clients) sendFrame(c.sock, str); }
const humanCount = () => [...clients].filter(c => c.player).length;

function handleMessage(c, text) {
  let m; try { m = JSON.parse(text); } catch { return; }
  if (m.t === 'join' && !c.player) {
    const name = String(m.name || 'Player').replace(/[^\w \-]/g, '').trim().slice(0, 14) || 'Player';
    const first = !humansPresent();
    const s = newSnake(name, false);
    c.player = s;
    if (first) resetWorld();
    ensureBots();
    sendFrame(c.sock, JSON.stringify({ t: 'welcome', id: s.id, W, H, pellets: [...pellets.values()].map(p => [p.id, p.x, p.y, p.v, p.color]) }));
    events.push({ kind: 'join', name, color: s.color });
    console.log(`+ ${name} joined (${humanCount()} human${humanCount() === 1 ? '' : 's'}, ${settings.bots} bots)`);
  } else if (m.t === 'input' && c.player) {
    const a = Number(m.a);
    if (Number.isFinite(a)) c.player.input = { a, boost: !!m.boost };
  }
}

function dropClient(c) {
  if (!clients.delete(c)) return;
  if (c.player) {
    snakes.delete(c.player.id);
    events.push({ kind: 'leave', name: c.player.name, color: c.player.color });
    console.log(`- ${c.player.name} left (${humanCount()} human${humanCount() === 1 ? '' : 's'})`);
    if (!humansPresent()) resetWorld();
  }
  c.sock.destroy();
}

function onData(c, chunk) {
  c.buf = Buffer.concat([c.buf, chunk]);
  while (c.buf.length >= 2) {
    const op = c.buf[0] & 0x0f, masked = c.buf[1] & 0x80;
    let len = c.buf[1] & 0x7f, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
    if (len > 1 << 16) return dropClient(c);
    const maskOff = off; if (masked) off += 4;
    if (c.buf.length < off + len) return;
    const payload = Buffer.from(c.buf.subarray(off, off + len));
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= c.buf[maskOff + (i & 3)];
    c.buf = c.buf.subarray(off + len);
    if (op === 0x1) handleMessage(c, payload.toString('utf8'));
    else if (op === 0x8) return dropClient(c);
    else if (op === 0x9) { const h = Buffer.from([0x8a, payload.length]); c.sock.write(Buffer.concat([h, payload])); }
  }
}

// ---------- HTTP ----------
// Only the PC running the server (the host) may change settings; everyone else sees them read-only.
function isHost(req) {
  const strip = a => String(a || '').replace(/^::ffff:/, '');
  const from = strip(req.socket.remoteAddress);
  if (from === '127.0.0.1' || from === '::1') return true;
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (strip(a.address) === from) return true;
  return false;
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const settingsPayload = req => ({ game: 'snake-clash', settings, isHost: isHost(req), defaults: DEFAULTS, limits: LIMITS, humans: humanCount() });

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/settings') {
    if (req.method === 'GET') return sendJson(res, 200, settingsPayload(req));
    if (req.method === 'POST') {
      if (!isHost(req)) return sendJson(res, 403, { error: 'Only the host PC can change settings.' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res, 415, { error: 'JSON only' });
      let body = '';
      req.on('data', d => { body += d; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let patch; try { patch = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Bad JSON' }); }
        applySettings(patch);
        sendJson(res, 200, settingsPayload(req));
      });
      return;
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  if (url === '/') {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('index.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  } else { res.writeHead(404); res.end('Not found'); }
});

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { sock, buf: Buffer.alloc(0), player: null };
  clients.add(c);
  sock.on('data', d => onData(c, d));
  sock.on('close', () => dropClient(c));
  sock.on('error', () => dropClient(c));
});

while (ambient < settings.food) addAmbient();
padd = [];
ensureBots();

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  SNAKE CLASH server is running!\n');
  console.log(`  On this PC:        http://localhost:${PORT}`);
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
  for (const ip of addrs) console.log(`  Your colleague:    http://${ip}:${PORT}`);
  if (!addrs.length) console.log('  (No network address found - is the cable/Wi-Fi connected?)');
  console.log('\n  Settings can be changed from the dashboard on THIS PC (press Esc in game).');
  console.log('  Keep this window open while you play. Ctrl+C to stop.\n');
});
