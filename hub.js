// Neon Arcade hub: landing page + private rooms for Neon Arena, Neon Strike and Neon Blitz.
// Every room is its own game-server process (the same server.js files used on the LAN), so one room
// crashing or lagging never affects another. The hub proxies HTTP + WebSocket to the right room.
// No npm packages needed.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 8;          // each room is one small Node process (~40 MB)
const IDLE_MINUTES = Number(process.env.ROOM_IDLE_MINUTES) || 10; // empty rooms are closed after this long
const GAMES = {
  arena:  { title: 'Neon Arena',  dir: __dirname },
  strike: { title: 'Neon Strike', dir: path.join(__dirname, 'fps-strike') },
  blitz:  { title: 'Neon Blitz',  dir: path.join(__dirname, 'neon-blitz') },
};
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I so codes are easy to read out loud
const rooms = new Map();   // code -> { code, game, port, key, child, created, emptySince, humans }
let nextPort = 4100;

const code4 = () => Array.from(crypto.randomBytes(4), b => ALPHABET[b % ALPHABET.length]).join('');
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

// ---------- room lifecycle ----------
function waitForPort(port, tries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = n => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => { s.destroy(); n <= 0 ? reject(new Error('room did not start')) : setTimeout(() => attempt(n - 1), 150); });
    };
    attempt(tries);
  });
}
async function createRoom(game) {
  let code; do code = code4(); while (rooms.has(code));
  const port = nextPort++; if (nextPort > 4999) nextPort = 4100;
  const key = crypto.randomBytes(12).toString('hex');
  const g = GAMES[game];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: g.dir, stdio: 'ignore',
    env: { ...process.env, PORT: String(port), ADMIN_KEY: key, PUBLIC_MODE: '1', NO_PERSIST: '1' },
  });
  const room = { code, game, port, key, child, created: Date.now(), emptySince: Date.now(), humans: 0 };
  rooms.set(code, room);
  child.on('exit', () => rooms.delete(code));
  try { await waitForPort(port); } catch (e) { closeRoom(room); throw e; }
  return room;
}
function closeRoom(room) { rooms.delete(room.code); try { room.child.kill(); } catch {} }

// every 20 s ask each room how many people are in it; close rooms that stay empty
setInterval(() => {
  for (const room of rooms.values()) {
    http.get({ port: room.port, path: '/api/settings', timeout: 3000 }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => {
        try { room.humans = JSON.parse(b).humans || 0; } catch { return; }
        if (room.humans > 0) room.emptySince = 0;
        else if (!room.emptySince) room.emptySince = Date.now();
        if (room.emptySince && Date.now() - room.emptySince > IDLE_MINUTES * 60000) closeRoom(room);
      });
    }).on('error', () => {}).on('timeout', function () { this.destroy(); });
  }
}, 20000).unref();

// light abuse protection: max 4 room creations per IP per minute
const createLog = new Map();
function allowCreate(ip) {
  const now = Date.now(), list = (createLog.get(ip) || []).filter(t => now - t < 60000);
  if (list.length >= 4) return false;
  list.push(now); createLog.set(ip, list); return true;
}

// ---------- proxy ----------
const roomPath = url => { const m = /^\/r\/([A-Za-z0-9]{4})(\/.*)?$/.exec(url); return m ? { code: m[1].toUpperCase(), rest: m[2] || '/' } : null; };
function notFoundPage(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="background:#07080f;color:#e8ecff;font-family:system-ui;text-align:center;padding-top:20vh"><h1>Room not found</h1><p>It may have closed after everyone left.</p><p><a style="color:#00e5ff" href="/">Back to the lobby</a></p>');
}

const server = http.createServer((req, res) => {
  const [url, query = ''] = req.url.split('?');
  const r = roomPath(url);
  if (r) {
    const room = rooms.get(r.code);
    if (!room) return notFoundPage(res);
    if (!url.endsWith('/') && r.rest === '/') { res.writeHead(301, { Location: `/r/${r.code}/${query ? '?' + query : ''}` }); return res.end(); }
    const up = http.request({ port: room.port, path: r.rest + (query ? '?' + query : ''), method: req.method, headers: { ...req.headers, 'x-forwarded-for': clientIp(req) } }, pr => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
    up.on('error', () => { if (!res.headersSent) notFoundPage(res); else res.end(); });
    return req.pipe(up);
  }
  if (url === '/' || url === '/index.html') {
    return fs.readFile(path.join(__dirname, 'landing.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('landing.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(data);
    });
  }
  if (url === '/api/rooms' && req.method === 'POST') {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res, 415, { error: 'JSON only' });
    let body = ''; req.on('data', d => { body += d; if (body.length > 1024) req.destroy(); });
    req.on('end', async () => {
      let game; try { game = JSON.parse(body).game; } catch { return sendJson(res, 400, { error: 'Bad JSON' }); }
      if (!GAMES[game]) return sendJson(res, 400, { error: 'Unknown game' });
      if (rooms.size >= MAX_ROOMS) return sendJson(res, 503, { error: 'All rooms are busy right now. Try again in a few minutes.' });
      if (!allowCreate(clientIp(req))) return sendJson(res, 429, { error: 'Too many rooms created. Wait a minute.' });
      try { const room = await createRoom(game); sendJson(res, 200, { code: room.code, game, url: `/r/${room.code}/`, admin: room.key }); }
      catch { sendJson(res, 500, { error: 'Could not start the room. Try again.' }); }
    });
    return;
  }
  const m = /^\/api\/rooms\/([A-Za-z0-9]{4})$/.exec(url);
  if (m && req.method === 'GET') {
    const room = rooms.get(m[1].toUpperCase());
    return room ? sendJson(res, 200, { code: room.code, game: room.game, title: GAMES[room.game].title, humans: room.humans }) : sendJson(res, 404, { error: 'No such room' });
  }
  if (url === '/api/status') return sendJson(res, 200, { rooms: rooms.size, max: MAX_ROOMS });
  res.writeHead(404); res.end('Not found');
});

// WebSocket upgrade: open a TCP connection to the room and pipe the raw bytes both ways
server.on('upgrade', (req, sock, head) => {
  const r = roomPath(req.url.split('?')[0]);
  const room = r && rooms.get(r.code);
  if (!room) { sock.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return sock.destroy(); }
  const up = net.connect(room.port, '127.0.0.1', () => {
    let headers = `${req.method} ${r.rest} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(headers + '\r\n'); if (head && head.length) up.write(head);
    sock.pipe(up); up.pipe(sock);
  });
  const end = () => { sock.destroy(); up.destroy(); };
  up.on('error', end); sock.on('error', end); up.on('close', end); sock.on('close', end);
  sock.setNoDelay(true); up.setNoDelay(true);
});

process.on('exit', () => { for (const r of rooms.values()) try { r.child.kill(); } catch {} });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  NEON ARCADE hub is running on port ${PORT}`);
  console.log(`  Open http://localhost:${PORT}   (rooms: max ${MAX_ROOMS}, empty rooms close after ${IDLE_MINUTES} min)\n`);
});
