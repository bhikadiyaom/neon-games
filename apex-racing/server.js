// Neon Apex GP - racing room server (no dependencies, just Node.js)
// Run: node server.js   then open http://127.0.0.1:3006   (online: started by hub.js, one process per room)
//
// Design (free-plan friendly): every browser simulates and renders its OWN car. This server only owns the
// race state (lobby, settings, later: start lights, checkpoints, laps, positions, penalties), sanity-checks what
// clients send, and relays compact BINARY car snapshots at 20 Hz. No physics runs here, so one room costs
// almost no CPU and about 40 MB of memory (most of it is Node itself).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');
const APEX = require('./public/shared/apex-shared.js');

const PORT = Number(process.env.PORT) || 3006;
const SNAP_HZ = 20;
const MAX_CLIENTS = 24;              // racers + spectators
const LIVERY = ['#c8102e', '#00e5ff', '#ff3d81', '#ffd400', '#7cff4f', '#7a4dff', '#ff8a3d', '#f2f2f2'];

// ---------- settings (host dashboard) ----------
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const PERSIST = !process.env.NO_PERSIST;
const settings = { ...APEX.DEFAULTS };
if (PERSIST) try { Object.assign(settings, APEX.normalizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')), APEX.DEFAULTS)); } catch { /* first run */ }
function saveSettings() { if (!PERSIST) return; try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch { /* read-only folder: fine */ } }

// ---------- state ----------
const clients = new Set();            // { sock, buf, player, spectator, rate... }
const players = new Map();            // id -> { id, name, car, livery, num, state, stateAt, rejects }
const race = { phase: 'lobby' };      // lobby -> (phase 5: grid, countdown, race, results)
let nextId = 1;
const startedAt = Date.now();
const serverMs = () => (Date.now() - startedAt) >>> 0;

const humanCount = () => players.size;
const rosterMsg = () => JSON.stringify({ t: 'roster', phase: race.phase, players: [...players.values()].map(p => ({ id: p.id, name: p.name, car: p.car, livery: p.livery, num: p.num })), spectators: [...clients].filter(c => c.spectator).length });
function freeNumber() { const used = new Set([...players.values()].map(p => p.num)); for (const n of [7, 12, 23, 31, 4, 55, 61, 90, 3, 18, 27, 44]) if (!used.has(n)) return n; return 2 + Math.floor(Math.random() * 97); }

function addPlayer(m) {
  const used = new Set([...players.values()].map(p => p.livery));
  const p = {
    id: nextId++, name: APEX.cleanName(m.name), car: APEX.CARS[APEX.carIndex(m.car)].id,
    livery: APEX.cleanColor(m.livery, LIVERY.find(c => !used.has(c)) || LIVERY[0]), num: freeNumber(),
    state: null, stateAt: 0, rejects: 0,
  };
  if (nextId > 250) nextId = 1;   // ids go on the wire as one byte
  players.set(p.id, p);
  return p;
}

// Sanity check for a client's own car. Phase 1: finite numbers, sane speed, no teleports.
// (Phase 5/6 adds checkpoint order and track-limit rules.)
const MAX_SPEED = 120;            // m/s (432 km/h): nothing in the game is faster
function acceptState(p, s, now) {
  const vals = [s.x, s.y, s.z, s.vx, s.vy, s.vz];
  if (!vals.every(Number.isFinite)) return false;
  if (Math.hypot(s.vx, s.vy, s.vz) > MAX_SPEED) return false;
  if (p.state) {
    const gap = Math.min(2, Math.max(0.001, (now - p.stateAt) / 1000));
    const d = Math.hypot(s.x - p.state.x, s.y - p.state.y, s.z - p.state.z);
    if (d > 5 + MAX_SPEED * gap * 1.25) { if (++p.rejects < 10) return false; }   // after 10 in a row accept (respawn/reset)
  }
  p.rejects = 0; p.state = s; p.stateAt = now;
  return true;
}

function snapshot() {
  const cars = [];
  for (const p of players.values()) if (p.state) cars.push({ id: p.id, s: p.state });
  return APEX.encodeSnapshot(serverMs(), cars);
}
let tick = 0;
function loop() {
  tick++;
  if (!clients.size) return;
  const snap = snapshot();
  if (new DataView(snap).getUint8(5) > 0) broadcastBin(Buffer.from(snap));
}

function applySettings(patch) {
  const prev = JSON.stringify(settings);
  Object.assign(settings, APEX.normalizeSettings(patch, settings));
  if (JSON.stringify(settings) !== prev) {
    saveSettings();
    broadcast(JSON.stringify({ t: 'settings', settings }));
    console.log('* settings changed:', JSON.stringify(settings));
  }
}

// ---------- minimal WebSocket (RFC 6455): text + binary frames ----------
function frame(op, data) {
  let header;
  if (data.length < 126) header = Buffer.from([0x80 | op, data.length]);
  else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  return Buffer.concat([header, data]);
}
function sendText(c, str) { if (!c.sock.destroyed) c.sock.write(frame(0x1, Buffer.from(str))); }
function sendBin(c, buf) { if (!c.sock.destroyed) c.sock.write(frame(0x2, buf)); }
function broadcast(str) { const f = frame(0x1, Buffer.from(str)); for (const c of clients) if (!c.sock.destroyed) c.sock.write(f); }
function broadcastBin(buf) { const f = frame(0x2, buf); for (const c of clients) if (!c.sock.destroyed && c.sock.writableLength < 256 * 1024) c.sock.write(f); }

function rateOk(c) {
  const now = Date.now();
  if (now - c.rateT > 1000) { c.rateT = now; c.rateN = 0; }
  return ++c.rateN <= 90;           // 90 messages per second is far above what an honest client sends (~35)
}
function handleMessage(c, text) {
  if (text.length > 1024 || !rateOk(c)) return;
  let m; try { m = JSON.parse(text); } catch { return; }
  if (!m || typeof m !== 'object') return;
  if (m.t === 'join' && !c.player && !c.spectator) {
    if (humanCount() >= APEX.MAX_RACERS || race.phase !== 'lobby') {
      c.spectator = true;
      sendText(c, JSON.stringify({ t: 'welcome', id: 0, spectator: true, settings, reason: race.phase !== 'lobby' ? 'race running' : 'room full' }));
      sendText(c, rosterMsg());
      return;
    }
    const p = addPlayer(m); c.player = p;
    sendText(c, JSON.stringify({ t: 'welcome', id: p.id, spectator: false, settings, num: p.num, livery: p.livery }));
    broadcast(rosterMsg());
    console.log(`+ ${p.name} joined (${humanCount()} racer${humanCount() === 1 ? '' : 's'})`);
  } else if (m.t === 'ping') {
    sendText(c, JSON.stringify({ t: 'pong', c: Number(m.c) || 0, s: serverMs() }));
  } else if (m.t === 'profile' && c.player) {    // change car / livery / name while in the lobby
    const p = c.player;
    if (m.car !== undefined) p.car = APEX.CARS[APEX.carIndex(m.car)].id;
    if (m.livery !== undefined) p.livery = APEX.cleanColor(m.livery, p.livery);
    if (m.name !== undefined) p.name = APEX.cleanName(m.name);
    broadcast(rosterMsg());
  }
}
function handleBinary(c, buf) {
  if (!rateOk(c) || !c.player) return;
  const s = APEX.decodeState(buf);
  if (s) acceptState(c.player, s, Date.now());
}
function dropClient(c) {
  if (!clients.delete(c)) return;
  if (c.player) {
    players.delete(c.player.id);
    console.log(`- ${c.player.name} left`);
    broadcast(rosterMsg());
  } else if (c.spectator) broadcast(rosterMsg());
  c.sock.destroy();
}
function onData(c, chunk) {
  c.buf = c.buf.length ? Buffer.concat([c.buf, chunk]) : chunk;
  while (c.buf.length >= 2) {
    const fin = c.buf[0] & 0x80, op = c.buf[0] & 0x0f, masked = c.buf[1] & 0x80;
    let len = c.buf[1] & 0x7f, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
    if (len > 4096 || !masked || !fin) return dropClient(c);      // browsers always mask and never fragment tiny frames
    const maskOff = off; off += 4;
    if (c.buf.length < off + len) return;
    const payload = Buffer.from(c.buf.subarray(off, off + len));
    for (let i = 0; i < len; i++) payload[i] ^= c.buf[maskOff + (i & 3)];
    c.buf = c.buf.subarray(off + len);
    if (op === 0x1) handleMessage(c, payload.toString('utf8'));
    else if (op === 0x2) handleBinary(c, payload);
    else if (op === 0x8) return dropClient(c);
    else if (op === 0x9) { if (!c.sock.destroyed) c.sock.write(frame(0xA, payload)); }
  }
}

// ---------- host check ----------
const ADMIN_KEY = process.env.ADMIN_KEY || '';
function isHost(req) {
  const key = String(req.headers['x-admin-key'] || '');
  if (ADMIN_KEY && key.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY))) return true;
  if (req.headers['x-forwarded-for'] || req.headers['forwarded'] || process.env.PUBLIC_MODE) return false;
  const strip = a => String(a || '').replace(/^::ffff:/, ''), from = strip(req.socket.remoteAddress);
  if (from === '127.0.0.1' || from === '::1') return true;
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (strip(a.address) === from) return true;
  return false;
}

// ---------- static files: whitelist built at start, hashed, compressed once, served from memory ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.bin': 'application/octet-stream', '.wasm': 'application/wasm' };
const TEXTY = new Set(['.html', '.js', '.css', '.json', '.svg']);
const files = new Map();   // url path ('/js/main.js') -> { type, raw, gz, br, etag, hash }
function walk(dir, base = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base + '/' + e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), rel);
    else if (MIME[path.extname(e.name)]) files.set(rel, { file: path.join(dir, e.name), ext: path.extname(e.name) });
  }
}
function pack(f, raw) {
  f.raw = raw; f.type = MIME[f.ext];
  f.hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
  f.etag = '"' + f.hash + '"';
  if (TEXTY.has(f.ext) && raw.length > 512) {
    f.gz = zlib.gzipSync(raw, { level: 9 });
    f.br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
  } else { f.gz = f.br = null; }
}
function loadStatic() {
  files.clear(); walk(PUBLIC);
  for (const [url, f] of files) if (url !== '/index.html') pack(f, fs.readFileSync(f.file));
  // index.html: every local script/style gets ?v=<content hash> (so it can be cached forever), and an import map
  // does the same for ES-module imports inside the scripts. Relative URLs keep working under /r/CODE/.
  const imports = {};
  for (const [url, f] of files) if (f.ext === '.js' && url.startsWith('/js/')) imports['.' + url] = '.' + url + '?v=' + f.hash;
  let html = fs.readFileSync(files.get('/index.html').file, 'utf8');
  html = html.replace('<!--IMPORTMAP-->', '<script type="importmap">' + JSON.stringify({ imports }) + '</script>');
  html = html.replace(/(src|href)="((?:js|shared|css)\/[^"?]+)"/g, (all, attr, p) => { const f = files.get('/' + p); return f ? `${attr}="${p}?v=${f.hash}"` : all; });
  pack(files.get('/index.html'), Buffer.from(html));
}
loadStatic();

function serveStatic(req, res, url, query) {
  if (process.env.APEX_DEV && (url === '/' || url === '/index.html')) loadStatic();   // developer mode: pick up edits on reload
  const f = files.get(url === '/' ? '/index.html' : url);
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  const headers = { 'Content-Type': f.type, ETag: f.etag, Vary: 'Accept-Encoding', 'X-Content-Type-Options': 'nosniff' };
  if (url === '/' || url === '/index.html') headers['Cache-Control'] = 'no-store';
  else if (new URLSearchParams(query).get('v') === f.hash) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  else headers['Cache-Control'] = 'no-cache';
  if (headers['Cache-Control'] !== 'no-store' && req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); return res.end(); }
  const ae = String(req.headers['accept-encoding'] || '');
  let body = f.raw;
  if (f.br && /\bbr\b/.test(ae)) { body = f.br; headers['Content-Encoding'] = 'br'; }
  else if (f.gz && /\bgzip\b/.test(ae)) { body = f.gz; headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------- HTTP ----------
function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
const settingsPayload = req => ({ game: 'apex-racing', settings, isHost: isHost(req), defaults: APEX.DEFAULTS, limits: APEX.LIMITS, options: APEX.OPTIONS, humans: humanCount(), phase: race.phase,
  maps: APEX.MAPS.map(m => m.name), cars: APEX.CARS.map(c => c.name) });

const server = http.createServer((req, res) => {
  const [url, query = ''] = req.url.split('?');
  if (url === '/api/settings') {
    if (req.method === 'GET') return sendJson(res, 200, settingsPayload(req));
    if (req.method === 'POST') {
      if (!isHost(req)) return sendJson(res, 403, { error: 'Only the host can change settings.' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res, 415, { error: 'JSON only' });
      let body = ''; req.on('data', d => { body += d; if (body.length > 4096) req.destroy(); });
      req.on('end', () => { let patch; try { patch = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Bad JSON' }); } applySettings(patch); sendJson(res, 200, settingsPayload(req)); });
      return;
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url, query);
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || clients.size >= MAX_CLIENTS) { sock.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return sock.destroy(); }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { sock, buf: Buffer.alloc(0), player: null, spectator: false, rateT: 0, rateN: 0 };
  clients.add(c);
  sock.on('data', d => onData(c, d)); sock.on('close', () => dropClient(c)); sock.on('error', () => dropClient(c));
});

if (require.main === module) {
  setInterval(loop, 1000 / SNAP_HZ);
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  NEON APEX GP server is running!\n');
    console.log(`  On this PC:   http://127.0.0.1:${PORT}`);
    console.log('  (WebGPU needs Chrome or Edge, and http://127.0.0.1 or https. A LAN IP over plain http will not work.)\n');
  });
} else module.exports = { server, settings, players, clients, race, handleMessage, handleBinary, onData, dropClient, applySettings, isHost, acceptState, snapshot, loop, files, loadStatic, serveStatic, frame };
