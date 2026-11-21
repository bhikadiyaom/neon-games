// Neon Strike - LAN first-person shooter server (no dependencies, just Node.js)
// Run: node server.js   then open http://<this-pc-ip>:3000 on each computer.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;

// ---------- Map (1 unit = 1 grid cell) ----------
// 1/2/3 = wall types (different colours), . = floor, H = health pack
const MAP = [
  '111111111111111111111111',
  '1.....1..........1.....1',
  '1.....1....H.....1.....1',
  '1..2.............1..3..1',
  '1.....1..........1.....1',
  '1111.111...22...11111.11',
  '1......................1',
  '1.3...2222....2222...3.1',
  '1.....2..........2.....1',
  '1.....2....H.....2.....1',
  '1.....2..........2.....1',
  '1.3...2222....2222...3.1',
  '1......................1',
  '1111.111...33...11111.11',
  '1.....1..........1.....1',
  '1..3.............1..2..1',
  '1.....1....H.....1.....1',
  '1.....1..........1.....1',
  '1111.111..........111.11',
  '1......................1',
  '1..2..222......222..3..1',
  '1......................1',
  '1.....1..........1.....1',
  '111111111111111111111111',
];
const MH = MAP.length, MW = MAP[0].length;
const grid = MAP.map(r => [...r].map(c => '123'.includes(c) ? +c : 0));
const HEALTH_SPOTS = [];
const OPEN = [];
MAP.forEach((row, y) => [...row].forEach((c, x) => { if (c === 'H') HEALTH_SPOTS.push([x + 0.5, y + 0.5]); if (grid[y][x] === 0) OPEN.push([x, y]); }));

const isWall = (cx, cy) => cx < 0 || cy < 0 || cx >= MW || cy >= MH || grid[cy][cx] !== 0;
const PLAYER_R = 0.3, HIT_R = 0.34;
function blocked(x, y, r) {
  for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++)
    for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
      if (!isWall(cx, cy)) continue;
      const nx = Math.max(cx, Math.min(x, cx + 1)), ny = Math.max(cy, Math.min(y, cy + 1));
      if ((x - nx) ** 2 + (y - ny) ** 2 < r * r) return true;
    }
  return false;
}
function moveCircle(p, dx, dy) {
  if (!blocked(p.x + dx, p.y, PLAYER_R)) p.x += dx;
  if (!blocked(p.x, p.y + dy, PLAYER_R)) p.y += dy;
}
// Distance along a ray to the first wall (grid DDA).
function castRay(x, y, ang, maxd) {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  let mx = Math.floor(x), my = Math.floor(y);
  const ddx = Math.abs(1 / (dx || 1e-9)), ddy = Math.abs(1 / (dy || 1e-9));
  let sx, sy, sdx, sdy;
  if (dx < 0) { sx = -1; sdx = (x - mx) * ddx; } else { sx = 1; sdx = (mx + 1 - x) * ddx; }
  if (dy < 0) { sy = -1; sdy = (y - my) * ddy; } else { sy = 1; sdy = (my + 1 - y) * ddy; }
  let dist = 0;
  while (dist < maxd) {
    if (sdx < sdy) { dist = sdx; sdx += ddx; mx += sx; } else { dist = sdy; sdy += ddy; my += sy; }
    if (isWall(mx, my)) return dist;
  }
  return maxd;
}

// ---------- Weapons ----------
const WEAPONS = [
  { name: 'Rifle',   dmg: 14, rate: 0.11, mag: 30, reload: 1.6, pellets: 1, spread: 0.02,  range: 40, falloff: 0 },
  { name: 'Shotgun', dmg: 13, rate: 0.85, mag: 6,  reload: 2.2, pellets: 7, spread: 0.09,  range: 14, falloff: 0.7 },
  { name: 'Sniper',  dmg: 80, rate: 1.25, mag: 5,  reload: 2.6, pellets: 1, spread: 0.002, range: 60, falloff: 0 },
];
const MAX_HP = 100, RESPAWN = 3, SHIELD = 2;
const TEAM_COLORS = { red: '#ff3d5a', blue: '#2f9bff' };
const COLORS = ['#00e5ff', '#ff3d81', '#ffd400', '#7cff4f', '#b388ff', '#ff8a3d', '#4dffd2', '#ff5252', '#7aa2ff', '#ffa6c9'];

// ---------- Settings (host dashboard) ----------
const DEFAULTS = { mode: 'dm', scoreLimit: 20, bots: 0, difficulty: 'normal', speedPct: 100, radar: 1 }; // radar 1 = minimap shows every enemy
const LIMITS = { scoreLimit: [0, 100], bots: [0, 8], speedPct: [60, 160], radar: [0, 1] };
const MODES = ['dm', 'tdm'], DIFFS = ['easy', 'normal', 'hard'];
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const PERSIST = !process.env.NO_PERSIST;   // online rooms start from the defaults and never touch settings.json
function normalize(src, base) {
  const out = { ...base };
  if (!src || typeof src !== 'object') return out;
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const n = Number(src[k]);
    if (src[k] !== undefined && src[k] !== null && src[k] !== '' && Number.isFinite(n)) out[k] = Math.max(lo, Math.min(hi, Math.round(n)));
  }
  if (MODES.includes(src.mode)) out.mode = src.mode;
  if (DIFFS.includes(src.difficulty)) out.difficulty = src.difficulty;
  return out;
}
const settings = { ...DEFAULTS };
if (PERSIST) try { Object.assign(settings, normalize(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')), DEFAULTS)); } catch { /* first run */ }
function saveSettings() { if (!PERSIST) return; try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch { /* read-only folder: fine */ } }
const BASE_SPEED = 3.4;
const speedNow = () => BASE_SPEED * settings.speedPct / 100;

// ---------- State ----------
const players = new Map();
const pickups = HEALTH_SPOTS.map(([x, y]) => ({ x, y, active: true, timer: 0 }));
const teamKills = { red: 0, blue: 0 };
const match = { over: false, winner: null, restartIn: 0 };
const events = [];
let nextId = 1;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const angleDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const tdm = () => settings.mode === 'tdm';
const colorOf = p => tdm() ? TEAM_COLORS[p.team] : p.color;
const enemies = (a, b) => a !== b && (!tdm() || a.team !== b.team);
const humanCount = t => [...players.values()].filter(p => !p.bot && (!t || p.team === t)).length;
const smallerTeam = () => {
  const r = humanCount('red'), b = humanCount('blue');
  return r === b ? (Math.random() < 0.5 ? 'red' : 'blue') : r < b ? 'red' : 'blue';
};
const teamTotal = t => [...players.values()].filter(p => p.team === t).length;

function spawnPoint(p) {
  let best = OPEN[0], bestScore = -1e9;
  for (let i = 0; i < 30; i++) {
    const [cx, cy] = OPEN[Math.floor(Math.random() * OPEN.length)];
    const x = cx + 0.5, y = cy + 0.5;
    let d = 99, seen = false;
    for (const q of players.values()) {
      if (q === p || !q.alive || !enemies(p, q)) continue;
      const dd = Math.hypot(q.x - x, q.y - y);
      d = Math.min(d, dd);
      if (dd < 20 && castRay(x, y, Math.atan2(q.y - y, q.x - x), dd) >= dd - 0.3) seen = true;
    }
    const score = d - (seen ? 12 : 0);
    if (score > bestScore) { bestScore = score; best = [cx, cy]; }
  }
  return { x: best[0] + 0.5, y: best[1] + 0.5 };
}
function respawn(p) {
  const s = spawnPoint(p);
  Object.assign(p, { x: s.x, y: s.y, a: Math.random() * Math.PI * 2, hp: MAX_HP, alive: true, shield: SHIELD, cooldown: 0, reloading: 0, firing: 0, weapon: 0 });
  p.ammo = WEAPONS.map(w => w.mag);
  p.seq = (p.seq || 0) + 1; // tells the client to teleport to the new spawn
  p.lastPos = 0; p.rejected = 0;
  if (p.ai) { p.ai.path = null; p.ai.tgt = null; }
}
function newPlayer(name, bot, team) {
  const used = new Set([...players.values()].map(s => s.color));
  const p = {
    id: nextId++, name, bot: !!bot, team: team || 'red', color: COLORS.find(c => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)],
    score: 0, deaths: 0, respawnT: 0, rejected: 0, lastPos: 0, input: { fire: false, w: 0, rl: 0 }, lastRl: 0, ai: bot ? { look: 0, tgt: null, react: 0, jit: 0, fireOn: false, path: null, repath: 0, strafe: 1, strafeT: 0, moveAng: 0, stuck: 0 } : null,
  };
  respawn(p);
  players.set(p.id, p);
  return p;
}

// ---------- Combat ----------
function startReload(p) {
  const w = WEAPONS[p.weapon];
  if (p.reloading > 0 || p.ammo[p.weapon] >= w.mag) return;
  p.reloading = w.reload;
}
function die(victim, killer, w) {
  victim.alive = false; victim.hp = 0; victim.respawnT = RESPAWN; victim.deaths++;
  if (killer) {
    killer.score++;
    if (tdm()) teamKills[killer.team]++;
  }
  events.push({ kind: 'kill', killer: killer ? killer.name : '?', victim: victim.name, kc: killer ? colorOf(killer) : '#fff', vc: colorOf(victim), w: WEAPONS[w].name, kid: killer ? killer.id : 0, vid: victim.id });
}
function shoot(p) {
  const w = WEAPONS[p.weapon];
  p.ammo[p.weapon]--; p.cooldown = w.rate; p.firing = 0.12;
  events.push({ kind: 'shot', id: p.id, x: +p.x.toFixed(2), y: +p.y.toFixed(2), w: p.weapon });
  for (let i = 0; i < w.pellets; i++) {
    const ang = p.a + (Math.random() * 2 - 1) * w.spread;
    const wallD = castRay(p.x, p.y, ang, w.range);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let best = null, bt = wallD;
    for (const q of players.values()) {
      if (!q.alive || q.shield > 0 || !enemies(p, q)) continue;
      const ox = q.x - p.x, oy = q.y - p.y, t = ox * dx + oy * dy;
      if (t < 0 || t > bt) continue;
      const px = ox - t * dx, py = oy - t * dy;
      if (px * px + py * py < HIT_R * HIT_R) { best = q; bt = t; }
    }
    if (!best) continue;
    const dmg = Math.round(w.dmg * (1 - w.falloff * clamp(bt / w.range, 0, 1)));
    best.hp -= dmg;
    const killed = best.hp <= 0;
    events.push({ kind: 'hit', from: p.id, to: best.id, dmg, kill: killed });
    if (killed) die(best, p, p.weapon);
  }
}

function updatePlayer(p, dt) {
  if (!p.alive) {
    if ((p.respawnT -= dt) <= 0) respawn(p);
    return;
  }
  if (p.bot) botThink(p, dt);
  p.shield = Math.max(0, p.shield - dt);
  p.cooldown = Math.max(0, p.cooldown - dt);
  p.firing = Math.max(0, p.firing - dt);
  const inp = p.input;
  if (Number.isInteger(inp.w) && inp.w >= 0 && inp.w < WEAPONS.length && inp.w !== p.weapon) { p.weapon = inp.w; p.reloading = 0; p.cooldown = 0.35; }
  if (p.reloading > 0 && (p.reloading -= dt) <= 0) { p.reloading = 0; p.ammo[p.weapon] = WEAPONS[p.weapon].mag; }
  if (inp.rl !== p.lastRl) { p.lastRl = inp.rl; startReload(p); }
  if (inp.fire && p.cooldown <= 0 && p.reloading <= 0 && !match.over) {
    if (p.ammo[p.weapon] > 0) shoot(p); else startReload(p);
  }
  for (const k of pickups) {
    if (k.active && p.hp < MAX_HP && Math.hypot(k.x - p.x, k.y - p.y) < 0.6) { p.hp = Math.min(MAX_HP, p.hp + 40); k.active = false; k.timer = 15; events.push({ kind: 'pickup', id: p.id }); }
  }
}

// ---------- Bots ----------
const DIFF = {
  easy:   { turn: 2.2, err: 0.16, react: 0.7, fire: 0.55 },
  normal: { turn: 3.8, err: 0.08, react: 0.4, fire: 0.8 },
  hard:   { turn: 6.5, err: 0.03, react: 0.18, fire: 1.0 },
};
const BOT_NAMES = ['Rex', 'Nova', 'Blaze', 'Ghost', 'Vex', 'Titan', 'Raven', 'Jinx'];

function bfs(sx, sy, gx, gy) {
  const prev = new Int16Array(MW * MH).fill(-2);
  const start = sy * MW + sx, goal = gy * MW + gx;
  const q = [start]; prev[start] = -1;
  for (let i = 0; i < q.length; i++) {
    const cur = q[i];
    if (cur === goal) break;
    const cx = cur % MW, cy = (cur / MW) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (isWall(nx, ny) || prev[ny * MW + nx] !== -2) continue;
      prev[ny * MW + nx] = cur; q.push(ny * MW + nx);
    }
  }
  if (prev[goal] === -2) return [];
  const out = [];
  for (let c = goal; c !== start; c = prev[c]) out.push([c % MW, (c / MW) | 0]);
  return out.reverse();
}

function botThink(b, dt) {
  const a = b.ai, cfg = DIFF[settings.difficulty] || DIFF.normal;
  // look for the nearest visible enemy a few times per second
  if ((a.look -= dt) <= 0) {
    a.look = 0.12;
    const prev = a.tgt;
    a.tgt = null; let bd = 1e9;
    for (const q of players.values()) {
      if (!q.alive || !enemies(b, q)) continue;
      const d = Math.hypot(q.x - b.x, q.y - b.y);
      if (d > 22 || d >= bd) continue;
      if (castRay(b.x, b.y, Math.atan2(q.y - b.y, q.x - b.x), d) >= d - 0.3) { bd = d; a.tgt = q; }
    }
    if (a.tgt && a.tgt !== prev) a.react = cfg.react;
    a.jit = (Math.random() * 2 - 1) * cfg.err;
    a.fireOn = Math.random() < cfg.fire;
  }
  const t = a.tgt && a.tgt.alive ? a.tgt : null;
  const dist = t ? Math.hypot(t.x - b.x, t.y - b.y) : 0;

  // weapon choice by range
  if (t) { const want = dist < 5 ? 1 : dist > 18 ? 2 : 0; if (want !== b.input.w) b.input.w = want; }
  if (b.ammo[b.weapon] === 0 && b.reloading <= 0) startReload(b);

  // movement
  let moveAng = null, speed = speedNow() * 0.85;
  if ((a.strafeT -= dt) <= 0) { a.strafeT = 0.8 + Math.random() * 1.2; a.strafe = Math.random() < 0.5 ? 1 : -1; }
  if (t && dist < 10) { moveAng = Math.atan2(t.y - b.y, t.x - b.x) + a.strafe * Math.PI / 2; speed *= 0.7; }
  else {
    if (!a.path || !a.path.length || (a.repath -= dt) <= 0 || a.stuck > 0.6) {
      let goal = null;
      if (b.hp < 45) { let bd = 1e9; for (const k of pickups) if (k.active) { const d = Math.hypot(k.x - b.x, k.y - b.y); if (d < bd) { bd = d; goal = [Math.floor(k.x), Math.floor(k.y)]; } } }
      if (!goal) goal = t ? [Math.floor(t.x), Math.floor(t.y)] : OPEN[Math.floor(Math.random() * OPEN.length)];
      a.path = bfs(Math.floor(b.x), Math.floor(b.y), goal[0], goal[1]);
      a.repath = 5 + Math.random() * 4; a.stuck = 0;
    }
    if (a.path.length) {
      const [cx, cy] = a.path[0], tx = cx + 0.5, ty = cy + 0.5;
      if (Math.hypot(tx - b.x, ty - b.y) < 0.22) a.path.shift();
      else moveAng = Math.atan2(ty - b.y, tx - b.x);
    }
  }
  if (moveAng !== null) {
    const ox = b.x, oy = b.y;
    moveCircle(b, Math.cos(moveAng) * speed * dt, Math.sin(moveAng) * speed * dt);
    a.stuck = Math.hypot(b.x - ox, b.y - oy) < speed * dt * 0.25 ? a.stuck + dt : 0;
    a.moveAng = moveAng;
  }

  // aiming
  const desired = t ? Math.atan2(t.y - b.y, t.x - b.x) + a.jit : (moveAng !== null ? moveAng : b.a);
  const diff = angleDiff(desired, b.a);
  b.a += clamp(diff, -cfg.turn * dt, cfg.turn * dt);
  if (t) a.react -= dt;
  b.input.fire = !!t && a.react <= 0 && a.fireOn && Math.abs(angleDiff(desired, b.a)) < 0.12 && dist < WEAPONS[b.weapon].range;
}

function ensureBots() {
  const bots = [...players.values()].filter(p => p.bot);
  while (bots.length > settings.bots) players.delete(bots.pop().id);
  while (bots.length < settings.bots) {
    const used = new Set(bots.map(b => b.name));
    bots.push(newPlayer('Bot ' + (BOT_NAMES.find(n => !used.has('Bot ' + n)) || nextId), true));
  }
  // split bots so each team's total size is as even as possible
  let r = humanCount('red'), b = humanCount('blue');
  for (const bot of bots) {
    const team = r <= b ? 'red' : 'blue';
    if (team === 'red') r++; else b++;
    if (bot.team !== team) { bot.team = team; if (tdm()) respawn(bot); }
  }
}

// ---------- Match ----------
const RESTART_DELAY = 10;
function checkWin() {
  const L = settings.scoreLimit;
  if (!L || match.over) return;
  let winner = null;
  if (tdm()) {
    if (teamKills.red >= L || teamKills.blue >= L) winner = { team: teamKills.red >= teamKills.blue ? 'red' : 'blue' };
    if (teamKills.red === teamKills.blue) winner = null;
  } else {
    const top = [...players.values()].sort((a, b) => b.score - a.score)[0];
    if (top && top.score >= L) winner = { name: top.name, color: top.color, id: top.id };
  }
  if (!winner) return;
  Object.assign(match, { over: true, winner, restartIn: RESTART_DELAY });
  events.push({ kind: 'win', text: winner.team ? winner.team.toUpperCase() + ' TEAM' : winner.name, color: winner.team ? TEAM_COLORS[winner.team] : winner.color });
  console.log('* match over, winner:', winner.team || winner.name);
}
function resetMatch() {
  teamKills.red = 0; teamKills.blue = 0;
  Object.assign(match, { over: false, winner: null, restartIn: 0 });
  for (const k of pickups) { k.active = true; k.timer = 0; }
  for (const p of players.values()) { p.score = 0; p.deaths = 0; respawn(p); }
}

// ---------- Simulation ----------
const TICK = 1 / 60;
let tickCount = 0;
function update(dt) {
  if (match.over) { if ((match.restartIn -= dt) <= 0) resetMatch(); return; }
  for (const p of players.values()) updatePlayer(p, dt);
  for (const k of pickups) if (!k.active && (k.timer -= dt) <= 0) k.active = true;
  checkWin();
}

function snapshot() {
  return JSON.stringify({
    t: 'state', mode: settings.mode, limit: settings.scoreLimit, speed: +speedNow().toFixed(2), radar: settings.radar,
    match: match.over ? { winner: match.winner, restartIn: +Math.max(0, match.restartIn).toFixed(1) } : null,
    teamKills,
    players: [...players.values()].map(p => ({
      id: p.id, name: p.name, color: colorOf(p), team: p.team, bot: p.bot, x: +p.x.toFixed(2), y: +p.y.toFixed(2), a: +p.a.toFixed(2),
      hp: p.hp, alive: p.alive, score: p.score, deaths: p.deaths, w: p.weapon, am: p.ammo[p.weapon], rl: +p.reloading.toFixed(1),
      sh: p.shield > 0, f: p.firing > 0, rs: p.alive ? 0 : +Math.max(0, p.respawnT).toFixed(1), seq: p.seq,
    })),
    pickups: pickups.map(k => k.active ? 1 : 0),
    events: events.splice(0),
  });
}

const humansPresent = () => { for (const c of clients) if (c.player) return true; return false; };
setInterval(() => {
  if (!humansPresent()) return; // the match only runs while a human is connected
  update(TICK);
  if (++tickCount % 2 === 0) broadcast(snapshot());
}, 1000 * TICK);

function applySettings(patch) {
  const prev = { ...settings };
  Object.assign(settings, normalize(patch, settings));
  if (settings.mode !== prev.mode) {
    ensureBots();
    if (humansPresent()) resetMatch();
  } else ensureBots();
  if (JSON.stringify(prev) !== JSON.stringify(settings)) {
    saveSettings();
    if (humansPresent()) events.push({ kind: 'settings' });
    console.log('* settings changed:', JSON.stringify(settings));
  }
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

function handleMessage(c, text) {
  let m; try { m = JSON.parse(text); } catch { return; }
  if (m.t === 'join' && !c.player) {
    const name = String(m.name || 'Player').replace(/[^\w \-]/g, '').trim().slice(0, 14) || 'Player';
    const other = m.team === 'red' ? 'blue' : 'red';
    const wanted = m.team === 'red' || m.team === 'blue';
    const team = wanted && humanCount(m.team) <= humanCount(other) ? m.team : smallerTeam();
    const first = !humansPresent();
    const p = newPlayer(name, false, team);
    c.player = p;
    if (first) resetMatch();
    ensureBots();
    sendFrame(c.sock, JSON.stringify({ t: 'welcome', id: p.id, team, map: MAP, health: HEALTH_SPOTS, weapons: WEAPONS.map(w => ({ name: w.name, mag: w.mag, reload: w.reload, rate: w.rate })) }));
    events.push({ kind: 'join', name, color: colorOf(p) });
    console.log(`+ ${name} joined${tdm() ? ' team ' + team : ''} (${humanCount()} human${humanCount() === 1 ? '' : 's'}, ${settings.bots} bots)`);
  } else if (m.t === 's' && c.player && c.player.alive && !match.over) {
    const p = c.player, x = Number(m.x), y = Number(m.y), a = Number(m.a);
    if (Number.isFinite(x) && Number.isFinite(y) && !blocked(x, y, PLAYER_R - 0.02)) {
      // Movement is decided by the client (smooth, no lag). Reject impossible jumps, but allow more
      // distance after a gap in messages (lag spike, background tab) and always re-sync after a while.
      const now = Date.now(), gap = Math.min(2, (now - (p.lastPos || now)) / 1000);
      const ok = Math.hypot(x - p.x, y - p.y) <= 1.5 + 8 * gap;
      if (ok || ++p.rejected > 15) { p.x = x; p.y = y; p.rejected = 0; p.lastPos = now; }
    }
    if (Number.isFinite(a)) p.a = a;
    p.input = { fire: !!m.fire, w: Number.isInteger(m.w) ? m.w : p.weapon, rl: Number(m.rl) || 0 };
  }
}

function dropClient(c) {
  if (!clients.delete(c)) return;
  if (c.player) {
    players.delete(c.player.id);
    events.push({ kind: 'leave', name: c.player.name, color: colorOf(c.player) });
    console.log(`- ${c.player.name} left`);
    ensureBots();
    if (!humansPresent()) resetMatch();
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
// ADMIN_KEY (environment variable): on an online server nobody is "the host PC", so the owner opens the game
// with ?admin=THE_KEY once and can then change settings. Behind a proxy (X-Forwarded-For) the address is never trusted.
const ADMIN_KEY = process.env.ADMIN_KEY || '';
function isHost(req) {
  const key = String(req.headers['x-admin-key'] || '');
  if (ADMIN_KEY && key.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY))) return true;
  if (req.headers['x-forwarded-for'] || req.headers['forwarded'] || process.env.PUBLIC_MODE) return false;
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
const settingsPayload = req => ({ game: 'neon-strike', settings, isHost: isHost(req), defaults: DEFAULTS, limits: LIMITS, humans: humanCount() });

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

ensureBots();

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  NEON STRIKE server is running!\n');
  console.log(`  On this PC:        http://localhost:${PORT}`);
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
  for (const ip of addrs) console.log(`  Your colleague:    http://${ip}:${PORT}`);
  if (!addrs.length) console.log('  (No network address found - is the cable/Wi-Fi connected?)');
  console.log('\n  Settings can be changed from the dashboard on THIS PC (press Esc in game).');
  console.log('  Keep this window open while you play. Ctrl+C to stop.\n');
});
