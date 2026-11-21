// Neon Arena - LAN multiplayer server (no dependencies, just Node.js)
// Run: node server.js   then open http://<this-pc-ip>:3000 on each computer.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;

// ---------- World ----------
const W = 1600, H = 1000;
const WALLS = [
  [300, 200, 40, 250], [1260, 550, 40, 250],
  [700, 150, 200, 40], [700, 810, 200, 40],
  [450, 600, 220, 40], [930, 360, 220, 40],
  [150, 760, 160, 40], [1290, 200, 160, 40],
  [780, 450, 40, 100],
];
const PICKUP_SPOTS = [[120, 120], [1480, 880], [800, 80], [800, 920], [520, 480], [1080, 520]];
const TEAM_COLORS = { red: '#ff3d5a', blue: '#2f9bff' };

const PLAYER_R = 18, BULLET_SPEED = 720, BULLET_R = 4;
const FIRE_COOLDOWN = 0.22, DAMAGE = 20, RESPAWN = 2.5, MAX_HP = 100;

// ---------- Settings (changed from the dashboard by the host) ----------
const DEFAULTS = {
  mode: 'zone',        // 'zone' = Zone Battle (kills + capture zone), 'tdm' = Team Deathmatch (kills only)
  bots: 0,             // 0 = multiplayer only; 1-8 = that many AI bots (solo practice / filler)
  difficulty: 'normal',
  playerSpeed: 290,    // movement speed
  zoneBoost: 20,       // % extra speed while standing inside the zone
  captureTime: 6,      // seconds one team needs alone in the zone
  zoneRadius: 110,
  zonePoints: 5,
  scoreLimit: 30,      // first team to reach this many points wins the match (0 = no limit)
};
const LIMITS = {
  bots: [0, 8], playerSpeed: [200, 450], zoneBoost: [0, 60],
  captureTime: [3, 20], zoneRadius: [70, 200], zonePoints: [1, 20], scoreLimit: [0, 200],
};
const MODES = ['zone', 'tdm'], DIFFS = ['easy', 'normal', 'hard'];
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

// ---------- State ----------
const players = new Map(); // id -> player (humans and bots)
const bullets = [];
const pickups = PICKUP_SPOTS.map(([x, y]) => ({ x, y, active: true, timer: 0 }));
let nextId = 1, nextBullet = 1;
const events = [];

// Teams are fixed: Red vs Blue. A human's team is set when they join and never changes.
const colorOf = p => TEAM_COLORS[p.team];
const humanCount = t => [...players.values()].filter(p => !p.bot && (!t || p.team === t)).length;
const smallerTeam = () => {
  const r = humanCount('red'), b = humanCount('blue');
  return r === b ? (Math.random() < 0.5 ? 'red' : 'blue') : r < b ? 'red' : 'blue';
};
const enemies = (a, b) => a.team !== b.team;

function circleRect(cx, cy, r, [x, y, w, h]) {
  const nx = Math.max(x, Math.min(cx, x + w)), ny = Math.max(y, Math.min(cy, y + h));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}
function hitsWall(x, y, r) {
  if (x < r || y < r || x > W - r || y > H - r) return true;
  return WALLS.some(w => circleRect(x, y, r, w));
}
// Push a circle out of any wall it overlaps, so players slide along walls and around corners
// instead of getting caught on them.
function pushOut(p) {
  for (let pass = 0; pass < 2; pass++) {
    for (const [x, y, w, h] of WALLS) {
      const nx = Math.max(x, Math.min(p.x, x + w)), ny = Math.max(y, Math.min(p.y, y + h));
      const dx = p.x - nx, dy = p.y - ny, d2 = dx * dx + dy * dy;
      if (d2 >= PLAYER_R * PLAYER_R) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        p.x = nx + (dx / d) * PLAYER_R; p.y = ny + (dy / d) * PLAYER_R;
      } else { // centre is inside the wall: leave by the nearest side
        const l = p.x - x, r = x + w - p.x, t = p.y - y, b = y + h - p.y, m = Math.min(l, r, t, b);
        if (m === l) p.x = x - PLAYER_R; else if (m === r) p.x = x + w + PLAYER_R;
        else if (m === t) p.y = y - PLAYER_R; else p.y = y + h + PLAYER_R;
      }
    }
    p.x = Math.max(PLAYER_R, Math.min(W - PLAYER_R, p.x));
    p.y = Math.max(PLAYER_R, Math.min(H - PLAYER_R, p.y));
  }
}

function spawnPoint(team) {
  // Red spawns on the left third, Blue on the right third.
  const [x0, x1] = team === 'red' ? [60, W * 0.3] : [W * 0.7, W - 60];
  let best = null, bestDist = -1;
  for (let i = 0; i < 40; i++) {
    const x = x0 + Math.random() * (x1 - x0), y = 60 + Math.random() * (H - 120);
    if (hitsWall(x, y, PLAYER_R + 6)) continue;
    let d = Infinity;
    for (const p of players.values()) if (p.alive && p.team !== team) d = Math.min(d, Math.hypot(p.x - x, p.y - y));
    if (d > bestDist) { bestDist = d; best = { x, y }; }
  }
  return best || { x: (x0 + x1) / 2, y: 80 };
}
function respawn(p) {
  const s = spawnPoint(p.team);
  Object.assign(p, { x: s.x, y: s.y, hp: MAX_HP, alive: true, shield: 1.5, cooldown: 0 });
}

// ---------- Capture zone ----------
// Stand in the zone with no enemy inside until the ring fills. It then reappears at a
// random place anywhere on the map.
const zone = { x: 800, y: 500, side: null, progress: 0, contested: false };
const teamBonus = { red: 0, blue: 0 }; // zone points earned by each team

function pickZoneSpot(prev) {
  const m = settings.zoneRadius + 20; // keep the whole circle on the map
  for (let i = 0; i < 300; i++) {
    const x = m + Math.random() * (W - 2 * m), y = m + Math.random() * (H - 2 * m);
    if (WALLS.some(w => circleRect(x, y, PLAYER_R + 30, w))) continue; // centre must be in the open
    if (prev && Math.hypot(x - prev.x, y - prev.y) < 450) continue;     // and well away from the last spot
    return { x, y };
  }
  return { x: 1000, y: 520 };
}
function resetZone() {
  Object.assign(zone, pickZoneSpot(null), { side: null, progress: 0, contested: false });
  teamBonus.red = 0; teamBonus.blue = 0;
}

function updateZone(dt) {
  if (settings.mode !== 'zone') { zone.side = null; zone.progress = 0; zone.contested = false; return; }
  const R = settings.zoneRadius, T = settings.captureTime;
  const sides = new Set();
  for (const p of players.values()) {
    if (p.alive && Math.hypot(p.x - zone.x, p.y - zone.y) < R) sides.add(p.team);
  }
  zone.contested = sides.size > 1; // both teams inside: progress is frozen
  if (sides.size === 1) {
    const [side] = sides;
    if (zone.side === side || zone.side === null) {
      zone.side = side;
      zone.progress += dt / T;
    } else { // the other team was building progress: wear it down first
      zone.progress -= dt / T * 1.5;
      if (zone.progress <= 0) { zone.side = side; zone.progress = 0; }
    }
    if (zone.progress >= 1) {
      teamBonus[side] += settings.zonePoints;
      events.push({ kind: 'capture', name: side.toUpperCase(), color: TEAM_COLORS[side], points: settings.zonePoints });
      zone.side = null; zone.progress = 0;
      Object.assign(zone, pickZoneSpot(zone)); // reappears at a random spot anywhere on the map
    }
  } else if (sides.size === 0 && zone.side !== null) { // abandoned: progress slowly fades
    zone.progress -= dt / T * 0.3;
    if (zone.progress <= 0) { zone.side = null; zone.progress = 0; }
  }
}

// ---------- Bots (solo practice / filler players) ----------
const BOT_NAMES = ['Nova', 'Blitz', 'Echo', 'Rogue', 'Viper', 'Pixel', 'Drift', 'Onyx'];
const DIFF = {
  easy:   { err: 0.35, fire: 0.5, think: 0.35 },
  normal: { err: 0.17, fire: 0.8, think: 0.2 },
  hard:   { err: 0.06, fire: 1.0, think: 0.1 },
};

function addBot() {
  const used = new Set([...players.values()].filter(p => p.bot).map(p => p.name));
  const name = 'Bot ' + (BOT_NAMES.find(n => !used.has('Bot ' + n)) || nextId);
  const p = {
    id: nextId++, name, team: 'red', bot: true, angle: 0, score: 0, deaths: 0, respawnTimer: 0,
    input: { up: false, down: false, left: false, right: false, shoot: false, a: 0 },
    ai: { t: 0, fire: false, err: 0, target: null, lastX: 0, lastY: 0, wantsMove: false, detour: 0, dir: 1 },
  };
  players.set(p.id, p);
  return p;
}

// Keep the bot count equal to settings.bots and split bots between the teams so the
// total team sizes (humans + bots) stay as even as possible.
function balanceBots() {
  const bots = [...players.values()].filter(p => p.bot);
  while (bots.length > settings.bots) {
    const b = bots.pop();
    players.delete(b.id);
    for (let i = bullets.length - 1; i >= 0; i--) if (bullets[i].owner === b.id) bullets.splice(i, 1);
  }
  while (bots.length < settings.bots) bots.push(addBot());
  let r = humanCount('red'), b = humanCount('blue');
  for (const bot of bots) {
    const team = r <= b ? 'red' : 'blue';
    if (team === 'red') r++; else b++;
    if (bot.team !== team || !bot.x) { bot.team = team; respawn(bot); }
  }
}

function hasLOS(ax, ay, bx, by) {
  const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 16);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (hitsWall(ax + (bx - ax) * t, ay + (by - ay) * t, 3)) return false;
  }
  return true;
}

function botThink(p, dt) {
  const a = p.ai, cfg = DIFF[settings.difficulty] || DIFF.normal;
  a.t -= dt;
  if (a.detour > 0) a.detour -= dt;
  if (a.t <= 0) {
    a.t = cfg.think * (0.7 + Math.random() * 0.6);
    // Stuck on a wall? Sidestep for a moment.
    if (a.wantsMove && Math.hypot(p.x - a.lastX, p.y - a.lastY) < 6) { a.detour = 0.7; a.dir = Math.random() < 0.5 ? 1 : -1; }
    a.lastX = p.x; a.lastY = p.y;

    let tgt = null, td = Infinity;
    for (const q of players.values()) {
      if (!q.alive || q.team === p.team) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < td) { td = d; tgt = q; }
    }
    const los = !!tgt && td < 700 && hasLOS(p.x, p.y, tgt.x, tgt.y);
    const zoneOn = settings.mode === 'zone';

    let pk = null;
    if (p.hp < 45) { let best = 700; for (const k of pickups) if (k.active) { const d = Math.hypot(k.x - p.x, k.y - p.y); if (d < best) { best = d; pk = k; } } }

    let mx = 0, my = 0, hold = false;
    if (pk) { mx = pk.x - p.x; my = pk.y - p.y; }                                  // low health: grab a health pack
    else if (zoneOn && !(los && td < 260)) {                                         // go and hold the zone
      const dz = Math.hypot(zone.x - p.x, zone.y - p.y);
      hold = dz < settings.zoneRadius * 0.55;
      if (!hold) { mx = zone.x - p.x; my = zone.y - p.y; }
    } else if (tgt && td > 300) { mx = tgt.x - p.x; my = tgt.y - p.y; }              // chase
    if (!mx && !my && tgt) { mx = -(tgt.y - p.y) * a.dir; my = (tgt.x - p.x) * a.dir; } // otherwise strafe around the target
    if (a.detour > 0) { const t = mx; mx = -my * a.dir; my = t * a.dir; }

    const len = Math.hypot(mx, my);
    a.wantsMove = len > 1e-3 && !hold;
    if (len > 1e-3) { mx /= len; my /= len; }
    p.input.left = mx < -0.38; p.input.right = mx > 0.38; p.input.up = my < -0.38; p.input.down = my > 0.38;

    a.target = los ? tgt : null;
    a.err = (Math.random() * 2 - 1) * cfg.err;
    a.fire = los && Math.random() < cfg.fire;
    if (!a.target && len > 1e-3) p.input.a = Math.atan2(my, mx); // look where we are going
  }
  const t = a.target;
  if (t && t.alive && players.has(t.id)) {
    p.input.a = Math.atan2(t.y - p.y, t.x - p.x) + a.err;
    p.input.shoot = a.fire;
  } else p.input.shoot = false;
}

// ---------- Match (win at a score limit) ----------
const RESTART_DELAY = 10; // seconds the winner screen stays up before a new match starts
const match = { over: false, winner: null, restartIn: 0, mvp: null };

const teamScore = t => teamBonus[t] + [...players.values()].reduce((n, p) => n + (p.team === t ? p.score : 0), 0);

function checkWin() {
  const L = settings.scoreLimit;
  if (!L || match.over) return;
  const r = teamScore('red'), b = teamScore('blue');
  if ((r < L && b < L) || r === b) return; // nobody there yet, or tied: play on until someone leads
  const winner = r > b ? 'red' : 'blue';
  const top = [...players.values()].sort((a, c) => c.score - a.score)[0];
  Object.assign(match, {
    over: true, winner, restartIn: RESTART_DELAY,
    mvp: top && top.score > 0 ? { name: top.name, score: top.score, team: top.team } : null,
  });
  bullets.length = 0;
  events.push({ kind: 'win', name: winner.toUpperCase(), color: TEAM_COLORS[winner] });
  console.log(`* ${winner.toUpperCase()} wins ${Math.max(r, b)} - ${Math.min(r, b)}`);
}

// ---------- Simulation ----------
const TICK = 1 / 60;
let tickCount = 0;

function update(dt) {
  if (match.over) { // winner screen: everything is frozen until the next match starts
    if ((match.restartIn -= dt) <= 0) resetRound();
    return;
  }
  for (const p of players.values()) {
    if (!p.alive) {
      p.respawnTimer -= dt;
      if (p.respawnTimer <= 0) respawn(p);
      continue;
    }
    if (p.bot) botThink(p, dt);
    const i = p.input;
    let mx = (i.right ? 1 : 0) - (i.left ? 1 : 0), my = (i.down ? 1 : 0) - (i.up ? 1 : 0);
    const len = Math.hypot(mx, my);
    if (len) { mx /= len; my /= len; }
    // Standing inside the capture zone gives a speed boost (Zone Battle only).
    const boosted = settings.mode === 'zone' && Math.hypot(p.x - zone.x, p.y - zone.y) < settings.zoneRadius;
    const speed = settings.playerSpeed * (boosted ? 1 + settings.zoneBoost / 100 : 1);
    p.x += mx * speed * dt; p.y += my * speed * dt;
    pushOut(p);
    p.angle = Number.isFinite(i.a) ? i.a : p.angle;
    p.cooldown -= dt;
    p.shield = Math.max(0, p.shield - dt);
    if (i.shoot && p.cooldown <= 0) {
      p.cooldown = FIRE_COOLDOWN;
      const bx = p.x + Math.cos(p.angle) * (PLAYER_R + 8), by = p.y + Math.sin(p.angle) * (PLAYER_R + 8);
      if (!hitsWall(bx, by, BULLET_R)) {
        bullets.push({ id: nextBullet++, x: bx, y: by, vx: Math.cos(p.angle) * BULLET_SPEED, vy: Math.sin(p.angle) * BULLET_SPEED, owner: p.id, life: 1.6, bounces: 0, color: colorOf(p) });
      }
    }
    for (const k of pickups) {
      if (k.active && p.hp < MAX_HP && Math.hypot(k.x - p.x, k.y - p.y) < PLAYER_R + 14) {
        p.hp = Math.min(MAX_HP, p.hp + 40); k.active = false; k.timer = 10;
      }
    }
  }

  for (const k of pickups) if (!k.active && (k.timer -= dt) <= 0) k.active = true;
  updateZone(dt);

  for (let b = bullets.length - 1; b >= 0; b--) {
    const s = bullets[b];
    s.life -= dt;
    // Move per axis so we can bounce off walls once.
    const nx = s.x + s.vx * dt;
    if (hitsWall(nx, s.y, BULLET_R)) { s.vx = -s.vx; s.bounces++; } else s.x = nx;
    const ny = s.y + s.vy * dt;
    if (hitsWall(s.x, ny, BULLET_R)) { s.vy = -s.vy; s.bounces++; } else s.y = ny;
    let dead = s.life <= 0 || s.bounces > 1;
    if (!dead) {
      const shooter = players.get(s.owner);
      for (const p of players.values()) {
        // Bullets never hurt you or your teammates, only the other team.
        if (!p.alive || p.id === s.owner || (shooter && !enemies(shooter, p))) continue;
        if (Math.hypot(p.x - s.x, p.y - s.y) < PLAYER_R + BULLET_R) {
          dead = true;
          if (p.shield > 0) break;
          p.hp -= DAMAGE;
          if (p.hp <= 0) {
            p.alive = false; p.hp = 0; p.deaths++; p.respawnTimer = RESPAWN;
            if (shooter) shooter.score++;
            events.push({ kind: 'kill', killer: shooter ? shooter.name : '?', victim: p.name, kc: shooter ? colorOf(shooter) : '#fff', vc: colorOf(p) });
          }
          break;
        }
      }
    }
    if (dead) bullets.splice(b, 1);
  }
  checkWin();
}

function snapshot() {
  return JSON.stringify({
    t: 'state',
    mode: settings.mode,
    limit: settings.scoreLimit,
    match: match.over ? { winner: match.winner, restartIn: +Math.max(0, match.restartIn).toFixed(1), mvp: match.mvp } : null,
    zone: settings.mode === 'zone'
      ? { x: Math.round(zone.x), y: Math.round(zone.y), r: settings.zoneRadius, progress: +zone.progress.toFixed(3), color: zone.side ? TEAM_COLORS[zone.side] : null, contested: zone.contested }
      : null,
    teamScores: { red: teamScore('red'), blue: teamScore('blue') },
    players: [...players.values()].map(p => ({
      id: p.id, name: p.name, color: colorOf(p), team: p.team, bot: !!p.bot, x: Math.round(p.x), y: Math.round(p.y),
      a: +p.angle.toFixed(3), hp: p.hp, alive: p.alive, score: p.score, deaths: p.deaths,
      shield: p.shield > 0, respawn: p.alive ? 0 : +p.respawnTimer.toFixed(1),
    })),
    bullets: bullets.map(b => [b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), b.color]),
    pickups: pickups.map(k => k.active ? 1 : 0),
    events: events.splice(0),
  });
}

// The match only runs while at least one human is connected.
const humansPresent = () => { for (const c of clients) if (c.player) return true; return false; };
setInterval(() => {
  if (!humansPresent()) return;
  update(TICK);
  if (++tickCount % 2 === 0) broadcast(snapshot());
}, 1000 * TICK);

// Applies a settings change (already authorised by the caller).
function applySettings(patch) {
  const prev = { ...settings };
  Object.assign(settings, normalize(patch, settings));
  if (settings.mode !== prev.mode || settings.zoneRadius !== prev.zoneRadius) {
    Object.assign(zone, pickZoneSpot(zone), { side: null, progress: 0, contested: false });
  }
  balanceBots();
  if (JSON.stringify(prev) !== JSON.stringify(settings)) {
    saveSettings();
    if (humansPresent()) events.push({ kind: 'settings' });
    console.log('* settings changed:', JSON.stringify(settings));
  }
}

// When the last human leaves, the next group starts a fresh round.
function resetRound() {
  resetZone();
  bullets.length = 0;
  Object.assign(match, { over: false, winner: null, restartIn: 0, mvp: null });
  for (const p of players.values()) { p.score = 0; p.deaths = 0; respawn(p); }
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
    // Honour the team the player picked unless that would make the human teams uneven.
    const other = m.team === 'red' ? 'blue' : 'red';
    const wanted = m.team === 'red' || m.team === 'blue';
    const team = wanted && humanCount(m.team) <= humanCount(other) ? m.team : smallerTeam();
    const first = !humansPresent();
    const p = { id: nextId++, name, team, angle: 0, score: 0, deaths: 0, input: {}, respawnTimer: 0 };
    respawn(p);
    players.set(p.id, p);
    c.player = p;
    if (first) resetRound();
    balanceBots(); // bots fill up the teams around the humans
    sendFrame(c.sock, JSON.stringify({ t: 'welcome', id: p.id, team, W, H, walls: WALLS, pickups: PICKUP_SPOTS, playerR: PLAYER_R }));
    events.push({ kind: 'join', name, color: colorOf(p), team });
    console.log(`+ ${name} joined team ${team} (${humanCount()} human${humanCount() === 1 ? '' : 's'}, ${settings.bots} bots)`);
  } else if (m.t === 'input' && c.player) {
    c.player.input = { up: !!m.up, down: !!m.down, left: !!m.left, right: !!m.right, shoot: !!m.shoot, a: Number(m.a) };
  }
}

function dropClient(c) {
  if (!clients.delete(c)) return;
  if (c.player) {
    players.delete(c.player.id);
    for (let i = bullets.length - 1; i >= 0; i--) if (bullets[i].owner === c.player.id) bullets.splice(i, 1);
    events.push({ kind: 'leave', name: c.player.name, color: colorOf(c.player) });
    console.log(`- ${c.player.name} left (${humanCount()} human${humanCount() === 1 ? '' : 's'})`);
    if (!humansPresent()) resetRound(); else balanceBots();
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
const settingsPayload = req => ({ settings, isHost: isHost(req), defaults: DEFAULTS, limits: LIMITS, humans: humanCount() });

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

resetZone();
balanceBots();

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  NEON ARENA server is running!\n');
  console.log(`  On this PC:        http://localhost:${PORT}`);
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
  for (const ip of addrs) console.log(`  Your colleague:    http://${ip}:${PORT}`);
  if (!addrs.length) console.log('  (No network address found - is the cable/Wi-Fi connected?)');
  console.log('\n  Game settings can be changed from the dashboard on THIS PC (press Esc in game).');
  console.log('  Keep this window open while you play. Ctrl+C to stop.\n');
});
