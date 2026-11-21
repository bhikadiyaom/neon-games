// Neon Blitz - side-view platform shooter server (no dependencies, just Node.js)
// Run: node server.js   then open http://<this-pc-ip>:3005   (online: started by hub.js, one process per room)
// Movement is simulated by each player's browser (smooth, no lag) and validated here. The server owns health,
// bullets, damage, pickups, scoring, bots and the match flow.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const NB = require('./public/shared.js');

const PORT = Number(process.env.PORT) || 3005;
const { T, HW, HH } = NB;
const MAX_HUMANS = 8;

// ---------- Weapons ----------
const WEAPONS = [
  { name: 'Blaster', dmg: 16, rate: 0.13, speed: 1150, spread: 0.025, life: 1.0, pellets: 1, ammo: 0 },
  { name: 'Shotgun', dmg: 10, rate: 0.75, speed: 1000, spread: 0.17, life: 0.4, pellets: 6, ammo: 8 },
  { name: 'Sniper', dmg: 70, rate: 1.05, speed: 2600, spread: 0, life: 0.9, pellets: 1, ammo: 5 },
  { name: 'Rocket', dmg: 65, rate: 0.9, speed: 720, spread: 0, life: 2.0, pellets: 1, ammo: 4, splash: 90 },
];
const MAX_HP = 100, RESPAWN = 2.5, SHIELD = 2, HEALTH_PACK = 40;
const TEAM_COLORS = { red: '#ff3d5a', blue: '#2f9bff' };
const COLORS = ['#00e5ff', '#ff3d81', '#ffd400', '#7cff4f', '#b388ff', '#ff8a3d', '#4dffd2', '#ff5252', '#7aa2ff', '#ffa6c9', '#c6ff4d', '#ff9de2'];

// ---------- Settings (host dashboard) ----------
const DEFAULTS = { mode: 'ffa', map: -1, scoreLimit: 15, timeLimit: 5, bots: 3, difficulty: 'normal' }; // map -1 = rotate through all 4
const LIMITS = { map: [-1, 3], scoreLimit: [3, 50], timeLimit: [0, 15], bots: [0, 8] };
const MODES = ['ffa', 'tdm'], DIFFS = ['easy', 'normal', 'hard'];
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const PERSIST = !process.env.NO_PERSIST;
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
const players = new Map();
const bullets = [];
let pickups = [];
const teamScore = { red: 0, blue: 0 };
const match = { over: false, winner: null, restartIn: 0, timeLeft: 0, map: 0, rot: 0 };
let map = NB.getMap(0);
const events = [];
let nextId = 1, nextBullet = 1;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const tdm = () => settings.mode === 'tdm';
const colorOf = p => tdm() ? TEAM_COLORS[p.team] : p.color;
const enemies = (a, b) => a !== b && (!tdm() || a.team !== b.team);
const humanCount = t => [...players.values()].filter(p => !p.bot && (!t || p.team === t)).length;
const smallerTeam = () => { const r = humanCount('red'), b = humanCount('blue'); return r === b ? (Math.random() < 0.5 ? 'red' : 'blue') : r < b ? 'red' : 'blue'; };

function loadMap(i) {
  match.map = ((i % 4) + 4) % 4; map = NB.getMap(match.map);
  pickups = [
    ...map.weapons.map(s => ({ x: s.x, y: s.y, kind: 'w', w: 1 + Math.floor(Math.random() * 3), active: true, timer: 0 })),
    ...map.health.map(s => ({ x: s.x, y: s.y, kind: 'h', w: 0, active: true, timer: 0 })),
  ];
}
function spawnPoint(p) {
  let best = map.spawns[0], bestScore = -1e9;
  for (const s of map.spawns) {
    let d = 1e9, seen = false;
    for (const q of players.values()) {
      if (q === p || !q.alive || !enemies(p, q)) continue;
      const dd = Math.hypot(q.x - s.x, q.y - s.y); d = Math.min(d, dd);
      if (dd < 700 && NB.los(map, s.x, s.y, q.x, q.y)) seen = true;
    }
    const score = Math.min(d, 900) - (seen ? 400 : 0) + Math.random() * 120;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}
function respawn(p) {
  const s = spawnPoint(p);
  Object.assign(p, { x: s.x, y: s.y, vx: 0, vy: 0, a: 0, hp: MAX_HP, alive: true, shield: SHIELD, cooldown: 0, firing: 0, weapon: 0, ammo: 0 });
  p.body = NB.newBody(s.x, s.y);
  p.seq = (p.seq || 0) + 1;       // tells the client to teleport to the new spawn
  p.lastPos = 0; p.rejected = 0; p.lastHit = null;
  if (p.ai) { p.ai.tgt = null; p.ai.ex = null; p.ai.path = null; }
}
function newPlayer(name, bot, team) {
  const used = new Set([...players.values()].map(s => s.color));
  const p = { id: nextId++, name, bot: !!bot, team: team || 'red', color: COLORS.find(c => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)],
    score: 0, deaths: 0, respawnT: 0, input: { fire: false }, ai: bot ? { tgt: null, look: 0, react: 0, jit: 0, fireOn: false, dir: 1, dirT: 0, jumpCd: 0, goal: null, ex: null, path: null, repath: 0, vis: false } : null };
  respawn(p); players.set(p.id, p);
  return p;
}
const rosterMsg = () => JSON.stringify({ t: 'roster', players: [...players.values()].map(p => ({ id: p.id, name: p.name, color: colorOf(p), team: p.team, bot: p.bot })) });
function sendRoster() { broadcast(rosterMsg()); }

// ---------- Combat ----------
function die(victim, killer, w, void_) {
  victim.alive = false; victim.hp = 0; victim.respawnT = RESPAWN; victim.deaths++;
  if (!killer && victim.lastHit && Date.now() - victim.lastHit.t < 4000) killer = players.get(victim.lastHit.by) || null;
  if (killer && killer !== victim) { killer.score++; if (tdm()) teamScore[killer.team]++; }
  events.push({ kind: 'kill', k: killer ? killer.id : 0, v: victim.id, kn: killer ? killer.name : '', vn: victim.name, kc: killer ? colorOf(killer) : '#fff', vc: colorOf(victim), w: void_ ? -1 : w, x: Math.round(victim.x), y: Math.round(victim.y) });
}
function damage(victim, attacker, dmg, w, x, y) {
  victim.hp -= dmg; victim.lastHit = { by: attacker.id, t: Date.now() };
  events.push({ kind: 'hit', to: victim.id, by: attacker.id, dmg: Math.round(dmg), x: Math.round(x), y: Math.round(y) });
  if (victim.hp <= 0) die(victim, attacker, w);
}
function fire(p) {
  const w = WEAPONS[p.weapon];
  p.cooldown = w.rate; p.firing = 0.1;
  if (w.ammo && --p.ammo <= 0) { p.weapon = 0; p.ammo = 0; }
  events.push({ kind: 'shot', id: p.id, w: WEAPONS.indexOf(w), x: Math.round(p.x), y: Math.round(p.y), a: +p.a.toFixed(3) });
  for (let i = 0; i < w.pellets; i++) {
    const a = p.a + (Math.random() * 2 - 1) * w.spread, c = Math.cos(a), s = Math.sin(a);
    bullets.push({ id: nextBullet++, x: p.x + c * 20, y: p.y - 2 + s * 20, vx: c * w.speed, vy: s * w.speed, owner: p.id, w: WEAPONS.indexOf(w), life: w.life });
  }
}
function explode(b, x, y) {
  const w = WEAPONS[b.w], owner = players.get(b.owner);
  events.push({ kind: 'boom', x: Math.round(x), y: Math.round(y), r: w.splash });
  for (const q of players.values()) {
    if (!q.alive) continue;
    const dx = q.x - x, dy = q.y - 4 - y, d = Math.hypot(dx, dy);
    if (d > w.splash + HH) continue;
    const f = 1 - clamp(d / (w.splash + HH), 0, 1), self = q === owner;
    if (owner && (self || enemies(owner, q))) {
      if (q.shield <= 0 || self) {
        if (!self && q.shield > 0) continue;
        const dmg = Math.max(8, w.dmg * f) * (self ? 0.5 : 1);
        if (owner) { q.hp -= dmg; q.lastHit = { by: owner.id, t: Date.now() }; events.push({ kind: 'hit', to: q.id, by: owner.id, dmg: Math.round(dmg), x: Math.round(q.x), y: Math.round(q.y) }); if (q.hp <= 0) die(q, owner, b.w); }
      }
      const n = d || 1; events.push({ kind: 'kb', id: q.id, vx: Math.round(dx / n * 700 * f), vy: Math.round((dy / n * 700 - 200) * f) });   // rocket jumps!
    }
  }
}
function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i], w = WEAPONS[b.w], owner = players.get(b.owner);
    b.life -= dt; let dead = b.life <= 0, hitAt = null;
    const steps = Math.ceil(Math.hypot(b.vx, b.vy) * dt / 8);
    for (let s = 0; s < steps && !dead; s++) {
      b.x += b.vx * dt / steps; b.y += b.vy * dt / steps;
      if (NB.tileAt(map, Math.floor(b.x / T), Math.floor(b.y / T)) === NB.SOLID) { dead = true; hitAt = [b.x, b.y]; break; }
      if (!owner) continue;
      for (const q of players.values()) {
        if (!q.alive || q.shield > 0 || !enemies(owner, q)) continue;
        if (Math.abs(q.x - b.x) < HW + 3 && Math.abs(q.y - b.y) < HH + 3) {
          dead = true; hitAt = [b.x, b.y];
          if (!w.splash) damage(q, owner, w.dmg, b.w, b.x, b.y);
          break;
        }
      }
    }
    if (b.y > NB.MH * T + 200 || b.x < -50 || b.x > NB.MW * T + 50) dead = true;
    if (dead) {
      if (w.splash && (hitAt || b.life <= 0)) explode(b, hitAt ? hitAt[0] : b.x, hitAt ? hitAt[1] : b.y);
      else if (hitAt) events.push({ kind: 'spark', x: Math.round(hitAt[0]), y: Math.round(hitAt[1]) });
      bullets.splice(i, 1);
    }
  }
}

function updatePlayer(p, dt) {
  if (!p.alive) { if ((p.respawnT -= dt) <= 0 && !match.over) respawn(p); return; }
  if (p.bot) botThink(p, dt);
  p.shield = Math.max(0, p.shield - dt); p.cooldown = Math.max(0, p.cooldown - dt); p.firing = Math.max(0, p.firing - dt);
  if (p.y > NB.MH * T + 60) { die(p, null, 0, true); return; }                        // fell into the pit
  if (p.input.fire && p.cooldown <= 0 && !match.over) fire(p);
  for (const k of pickups) {
    if (!k.active || Math.abs(k.x - p.x) > 26 || Math.abs(k.y - p.y) > 30) continue;
    if (k.kind === 'h') { if (p.hp >= MAX_HP) continue; p.hp = Math.min(MAX_HP, p.hp + HEALTH_PACK); k.timer = 14; }
    else { p.weapon = k.w; p.ammo = WEAPONS[k.w].ammo; k.timer = 18; }
    k.active = false; events.push({ kind: 'pick', id: p.id, what: k.kind, x: Math.round(k.x), y: Math.round(k.y) });
  }
}

// ---------- Bots ----------
const DIFF = {
  easy: { err: 0.16, react: 0.6, fire: 0.5, turn: 5 },
  normal: { err: 0.07, react: 0.35, fire: 0.75, turn: 9 },
  hard: { err: 0.025, react: 0.15, fire: 1.0, turn: 16 },
};
const BOT_NAMES = ['Rex', 'Nova', 'Blaze', 'Ghost', 'Vex', 'Titan', 'Raven', 'Jinx'];
const angleDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

// ---- navigation graph: which standing tiles connect, found by simulating runs/jumps/drops with the REAL physics ----
const navCache = [];
const standable = (m, tx, ty) => { const a = NB.tileAt(m, tx, ty), b = NB.tileAt(m, tx, ty + 1); return a === NB.AIR && (b === NB.SOLID || b === NB.THIN) && NB.tileAt(m, tx, ty - 1) !== NB.SOLID && NB.tileAt(m, tx, ty - 2) !== NB.SOLID; };
function buildNav(m) {
  if (navCache[m.index]) return navCache[m.index];
  const W = m.W, H = m.H, nodes = new Map(), key = (tx, ty) => ty * W + tx;
  for (let ty = 2; ty < H; ty++) for (let tx = 1; tx < W - 1; tx++) if (standable(m, tx, ty)) nodes.set(key(tx, ty), { tx, ty, k: key(tx, ty), edges: new Map() });
  for (const n of nodes.values()) {
    for (const d of [-1, 1]) { const o = nodes.get(key(n.tx + d, n.ty)); if (o) n.edges.set(o.k, { to: o.k, dir: d, pre: 0, hold: 0, drop: false, walk: true, cost: 1 }); }       // plain walking
    const simulate = (dir, pre, hold, drop, dx) => {          // returns {k, time} of the first landing, or null (void / never lands)
      const body = NB.newBody((n.tx + .5) * T + dx, (n.ty + 1) * T - HH);
      for (let k = 0; k < 6; k++) NB.step(m, body, {}, NB.DT);
      let air = false;
      for (let k = 0; k < 150; k++) {
        const t = k / 60, jumping = hold > 0 && t >= pre && t < pre + hold;
        NB.step(m, body, { l: dir < 0, r: dir > 0, u: jumping, d: drop && k < 4 }, NB.DT);
        if (body.y > H * T) return null;
        if (!body.ground) air = true;
        else if (air) { const o = nodes.get(key(Math.floor(body.x / T), Math.floor((body.y + HH - 1) / T))); return o ? { k: o.k, time: k } : null; }
      }
      return null;
    };
    for (const dir of [-1, 1]) for (const pre of [0, 0.25, 0.5]) for (const hold of [0, 0.15, 0.6]) for (const drop of [false, true]) {
      if (drop && (hold || pre)) continue;
      const r = simulate(dir, pre, hold, drop, 0);
      if (!r || r.k === n.k) continue;
      // only keep moves that still land on the same spot when started 3 px off-centre (bots are never pixel-perfect)
      const l = simulate(dir, pre, hold, drop, -3), rr = simulate(dir, pre, hold, drop, 3);
      if (!l || !rr || l.k !== r.k || rr.k !== r.k) continue;
      const cost = 2 + r.time / 30, old = n.edges.get(r.k);
      if (!old || old.cost > cost) n.edges.set(r.k, { to: r.k, dir, pre, hold, drop, cost });
    }
  }
  return (navCache[m.index] = { nodes, key });
}
function standNode(nav, m, x, y, scanDown) {
  const tx = Math.floor(x / T), ty0 = Math.floor((y + HH - 1) / T);
  for (let k = 0; k <= (scanDown ? 14 : 0); k++) { const n = nav.nodes.get(nav.key(tx, ty0 + k)); if (n) return n; }
  return null;
}
function findPath(nav, from, to) {                              // breadth-first over the edge graph (cheap: a few hundred nodes)
  if (from.k === to.k) return [];
  const prev = new Map([[from.k, null]]), q = [from];
  for (let i = 0; i < q.length; i++) {
    const n = q[i];
    for (const e of n.edges.values()) {
      if (prev.has(e.to)) continue; prev.set(e.to, { n, e });
      if (e.to === to.k) { const out = []; for (let c = prev.get(e.to); c; c = prev.get(c.n.k)) out.push({ from: c.n.k, ...c.e }); return out.reverse(); }
      q.push(nav.nodes.get(e.to));
    }
  }
  return null;
}

function botThink(b, dt) {
  const a = b.ai, cfg = DIFF[settings.difficulty] || DIFF.normal, body = b.body, nav = buildNav(map);
  if ((a.look -= dt) <= 0) {                                    // pick a target a few times per second
    a.look = 0.2; const prev = a.tgt; a.tgt = null; let bd = 1e9, bestVis = false;
    for (const q of players.values()) {
      if (!q.alive || !enemies(b, q)) continue;
      const d = Math.hypot(q.x - b.x, q.y - b.y), vis = d < 950 && NB.los(map, b.x, b.y - 4, q.x, q.y - 4);
      if ((vis && !bestVis) || (vis === bestVis && d < bd)) { bd = d; a.tgt = q; bestVis = vis; }
    }
    a.vis = bestVis; if (a.tgt && a.tgt !== prev) a.react = cfg.react;
    a.jit = (Math.random() * 2 - 1) * cfg.err; a.fireOn = Math.random() < cfg.fire;
    a.goal = null;                                              // goals: health when hurt, a better gun when holding the blaster
    if (b.hp < 45) { let g = 1e9; for (const k of pickups) if (k.active && k.kind === 'h') { const d = Math.hypot(k.x - b.x, k.y - b.y); if (d < g) { g = d; a.goal = k; } } }
    else if (b.weapon === 0 && !a.vis) { let g = 900; for (const k of pickups) if (k.active && k.kind === 'w') { const d = Math.hypot(k.x - b.x, k.y - b.y); if (d < g) { g = d; a.goal = k; } } }
  }
  const t = a.tgt && a.tgt.alive ? a.tgt : null;
  const dest = a.goal && a.goal.active ? a.goal : t;
  const inp = { l: 0, r: 0, u: 0, d: 0 };
  const floorAt = (x, k) => { const tt = NB.tileAt(map, Math.floor(x / T), Math.floor((b.y + HH) / T) + k); return tt === NB.SOLID || tt === NB.THIN; };
  const floorAhead = dir => { for (let k = 0; k <= 4; k++) if (floorAt(b.x + dir * 30, k)) return true; return false; };
  const flat = t => { const x0 = Math.min(b.x, t.x), x1 = Math.max(b.x, t.x); for (let x = x0; x <= x1; x += 24) { let f = false; for (let k = 0; k <= 4 && !f; k++) f = floorAt(x, k); if (!f) return false; } return true; };
  const engage = dest && dest === t && a.vis && Math.abs(t.y - b.y) < 100 && flat(t);
  a.jumpCd -= dt;
  if (engage) {                                                 // face-to-face: strafe, keep a good distance, never walk into a gap
    a.ex = null; a.path = null;
    const dx = t.x - b.x, adx = Math.abs(dx), keep = b.weapon === 1 ? 140 : b.weapon === 2 ? 520 : 280;
    if ((a.dirT -= dt) <= 0) { a.dirT = 0.6 + Math.random() * 1.1; a.dir = Math.random() < 0.5 ? 1 : -1; }
    if (adx > keep + 30) { if (dx > 0) inp.r = 1; else inp.l = 1; }
    else if (adx < keep - 60) { const d = dx > 0 ? -1 : 1; if (floorAhead(d) || !body.ground) { if (d > 0) inp.r = 1; else inp.l = 1; } }
    else { if (!floorAhead(a.dir) && body.ground) a.dir = -a.dir; if (a.dir > 0) inp.r = 1; else inp.l = 1; }
    const mv = inp.r ? 1 : inp.l ? -1 : 0;
    if (a.jumpCd <= 0 && body.ground && ((mv && NB.hits(map, b.x + mv * 14, b.y, 1e9, false)) || Math.random() < 0.008)) { inp.u = 1; a.jumpCd = 0.5; }
  } else if (dest) {                                            // travel: follow the pre-computed route (jumps, drops, pads)
    const goalNode = standNode(nav, map, dest.x, dest.y, true), cur = body.ground ? standNode(nav, map, b.x, b.y, false) : null;
    if (a.ex) {
      const e = a.ex.e; a.ex.t += dt;
      const jumping = e.hold > 0 && a.ex.t >= e.pre && a.ex.t < e.pre + e.hold;
      inp.l = e.dir < 0 ? 1 : 0; inp.r = e.dir > 0 ? 1 : 0; inp.u = jumping ? 1 : 0; inp.d = e.drop && a.ex.t < 0.07 ? 1 : 0;
      if (!body.ground) a.ex.air = true;
      if ((body.ground && a.ex.air && a.ex.t > 0.1) || a.ex.t > 2.5) { a.ex = null; a.path = null; a.repath = 0; }
    } else if (cur && goalNode) {
      if (!a.path || (a.repath -= dt) <= 0 || (a.path.length && a.path[0].from !== cur.k && !a.path.some(s => s.from === cur.k))) { a.path = findPath(nav, cur, goalNode); a.repath = 0.6; }
      if (a.path && a.path.length) {
        while (a.path.length && a.path[0].from !== cur.k) { const i = a.path.findIndex(s => s.from === cur.k); if (i < 0) { a.path = null; break; } a.path.splice(0, i); }
        const e = a.path && a.path[0];
        if (e) {
          const cx = (cur.tx + .5) * T, off = cx - b.x;
          if (Math.abs(off) > 3 && !e.walk) { if (off > 0) inp.r = 1; else inp.l = 1; }       // line up on the tile centre, then start the move
          else if (!e.walk && Math.abs(body.vx) > 20) { /* brake: the route was recorded from a standstill */ }
          else { a.ex = { e, t: 0, air: false }; inp.l = e.dir < 0 ? 1 : 0; inp.r = e.dir > 0 ? 1 : 0; }
          
        }
      } else if (a.path && a.path.length === 0 && dest) { const dx = dest.x - b.x; if (Math.abs(dx) > 10) { if (dx > 0) inp.r = 1; else inp.l = 1; } }
      else if (!a.path && a.jumpCd <= 0) { if (Math.random() < 0.5) inp.r = 1; else inp.l = 1; }          // no route found: wander a little
    } else if (!body.ground) { const dx = dest.x - b.x; if (Math.abs(dx) > 20) { if (dx > 0) inp.r = 1; else inp.l = 1; } }   // steer in the air
  } else { a.ex = null; if ((a.dirT -= dt) <= 0) { a.dirT = 1 + Math.random() * 2; a.dir = Math.random() < 0.5 ? 1 : -1; } if (floorAhead(a.dir)) { if (a.dir > 0) inp.r = 1; else inp.l = 1; } else a.dir = -a.dir; }
  NB.step(map, body, inp, dt);
  b.x = body.x; b.y = body.y; b.vx = body.vx; b.vy = body.vy;
  const want = t ? Math.atan2(t.y - 4 - (b.y - 2), t.x - b.x) + a.jit : (inp.r ? 0 : inp.l ? Math.PI : b.a);   // aim
  const diff = angleDiff(want, b.a); b.a += clamp(diff, -cfg.turn * dt, cfg.turn * dt);
  if (t) a.react -= dt;
  const range = b.weapon === 1 ? 420 : 1100;
  b.input.fire = !!t && a.vis && a.react <= 0 && a.fireOn && Math.abs(angleDiff(want, b.a)) < 0.1 && Math.hypot(t.x - b.x, t.y - b.y) < range;
}
function ensureBots() {
  const bots = [...players.values()].filter(p => p.bot);
  while (bots.length > settings.bots) players.delete(bots.pop().id);
  while (bots.length < settings.bots) {
    const used = new Set(bots.map(b => b.name));
    bots.push(newPlayer('Bot ' + (BOT_NAMES.find(n => !used.has('Bot ' + n)) || nextId), true));
  }
  let r = humanCount('red'), b = humanCount('blue');           // keep teams balanced
  for (const bot of bots) {
    const team = r <= b ? 'red' : 'blue'; if (team === 'red') r++; else b++;
    if (bot.team !== team) { bot.team = team; if (tdm()) respawn(bot); }
  }
  sendRoster();
}

// ---------- Match ----------
const RESTART_DELAY = 9;
function finish(winner) {
  Object.assign(match, { over: true, winner, restartIn: RESTART_DELAY });
  bullets.length = 0;
  events.push({ kind: 'win', winner });
  console.log('* match over:', winner.draw ? 'draw' : winner.team || winner.name);
}
function checkWin() {
  if (match.over) return;
  const L = settings.scoreLimit, list = [...players.values()];
  if (tdm()) {
    if (teamScore.red >= L || teamScore.blue >= L) return finish({ team: teamScore.red >= teamScore.blue ? 'red' : 'blue', text: (teamScore.red >= teamScore.blue ? 'RED' : 'BLUE') + ' TEAM', color: teamScore.red >= teamScore.blue ? TEAM_COLORS.red : TEAM_COLORS.blue });
  } else {
    const top = list.sort((a, b) => b.score - a.score)[0];
    if (top && top.score >= L) return finish({ id: top.id, name: top.name, text: top.name, color: top.color });
  }
  if (settings.timeLimit > 0 && match.timeLeft <= 0) {
    if (tdm()) {
      if (teamScore.red === teamScore.blue) return finish({ draw: true, text: 'DRAW', color: '#ffffff' });
      const red = teamScore.red > teamScore.blue; return finish({ team: red ? 'red' : 'blue', text: (red ? 'RED' : 'BLUE') + ' TEAM', color: TEAM_COLORS[red ? 'red' : 'blue'] });
    }
    const s = list.sort((a, b) => b.score - a.score);
    if (!s.length || (s[1] && s[1].score === s[0].score)) return finish({ draw: true, text: 'DRAW', color: '#ffffff' });
    finish({ id: s[0].id, name: s[0].name, text: s[0].name, color: s[0].color });
  }
}
function resetMatch(nextMap) {
  teamScore.red = 0; teamScore.blue = 0;
  Object.assign(match, { over: false, winner: null, restartIn: 0, timeLeft: settings.timeLimit * 60 });
  if (settings.map >= 0) loadMap(settings.map);
  else loadMap(nextMap === undefined ? match.map : nextMap);
  bullets.length = 0;
  for (const p of players.values()) { p.score = 0; p.deaths = 0; respawn(p); }
}

// ---------- Simulation ----------
const TICK = 1 / 60;
let tickCount = 0;
function update(dt) {
  if (match.over) { if ((match.restartIn -= dt) <= 0) resetMatch(match.map + 1); return; }
  if (settings.timeLimit > 0) match.timeLeft = Math.max(0, match.timeLeft - dt);
  for (const p of players.values()) updatePlayer(p, dt);
  updateBullets(dt);
  for (const k of pickups) if (!k.active && (k.timer -= dt) <= 0) { k.active = true; if (k.kind === 'w') k.w = 1 + Math.floor(Math.random() * 3); }
  checkWin();
}
function snapshot() {
  const r = (v, d) => +v.toFixed(d);
  return JSON.stringify({
    t: 's', mode: settings.mode, limit: settings.scoreLimit, map: match.map, left: settings.timeLimit > 0 ? Math.ceil(match.timeLeft) : -1,
    over: match.over ? { winner: match.winner, in: r(Math.max(0, match.restartIn), 1) } : null, ts: teamScore,
    p: [...players.values()].map(p => ({ i: p.id, x: r(p.x, 1), y: r(p.y, 1), vx: Math.round(p.vx || 0), vy: Math.round(p.vy || 0), a: r(p.a, 2), h: Math.round(p.hp), s: p.score, d: p.deaths, w: p.weapon, m: p.ammo,
      f: (p.alive ? 1 : 0) | (p.shield > 0 ? 2 : 0) | (p.firing > 0 ? 4 : 0) | (p.body && p.body.ground ? 8 : 0), r: p.alive ? 0 : r(Math.max(0, p.respawnT), 1), q: p.seq })),
    b: bullets.map(b => [b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), b.w]),
    k: pickups.map(k => k.active ? (k.kind === 'h' ? 1 : 10 + k.w) : 0),
    e: events.splice(0),
  });
}
const humansPresent = () => { for (const c of clients) if (c.player) return true; return false; };
function loop() {
  if (!humansPresent()) return;           // the match only runs while a human is connected
  update(TICK);
  if (++tickCount % 2 === 0) broadcast(snapshot());
}
function applySettings(patch) {
  const prev = { ...settings };
  Object.assign(settings, normalize(patch, settings));
  ensureBots();
  if (settings.mode !== prev.mode || settings.map !== prev.map || settings.timeLimit !== prev.timeLimit) { if (humansPresent()) resetMatch(); }
  if (JSON.stringify(prev) !== JSON.stringify(settings)) {
    saveSettings(); if (humansPresent()) events.push({ kind: 'settings' });
    console.log('* settings changed:', JSON.stringify(settings));
  }
}

// ---------- Minimal WebSocket (RFC 6455) ----------
const clients = new Set();
function sendFrame(sock, str) {
  if (sock.destroyed) return;
  const data = Buffer.from(str); let header;
  if (data.length < 126) header = Buffer.from([0x81, data.length]);
  else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  sock.write(Buffer.concat([header, data]));
}
function broadcast(str) { for (const c of clients) sendFrame(c.sock, str); }

function handleMessage(c, text) {
  if (text.length > 600) return;
  const now = Date.now();
  if (now - (c.rateT || 0) > 1000) { c.rateT = now; c.rateN = 0; }
  if (++c.rateN > 120) return;                                  // message rate limit
  let m; try { m = JSON.parse(text); } catch { return; }
  if (!m || typeof m !== 'object') return;
  if (m.t === 'join' && !c.player) {
    if (humanCount() >= MAX_HUMANS) { sendFrame(c.sock, JSON.stringify({ t: 'full' })); return; }
    const name = String(m.name || 'Player').replace(/[^\w \-]/g, '').trim().slice(0, 14) || 'Player';
    const other = m.team === 'red' ? 'blue' : 'red', wanted = m.team === 'red' || m.team === 'blue';
    const team = wanted && humanCount(m.team) <= humanCount(other) ? m.team : smallerTeam();
    const first = !humansPresent();
    const p = newPlayer(name, false, team); c.player = p;
    if (first) resetMatch(Math.floor(Math.random() * 4));
    ensureBots();
    sendFrame(c.sock, JSON.stringify({ t: 'welcome', id: p.id, team, map: match.map, weapons: WEAPONS.map(w => ({ name: w.name, ammo: w.ammo })) }));
    sendFrame(c.sock, rosterMsg());
    events.push({ kind: 'join', name, color: colorOf(p) });
    console.log(`+ ${name} joined (${humanCount()} human${humanCount() === 1 ? '' : 's'}, ${settings.bots} bots)`);
  } else if (m.t === 's' && c.player && c.player.alive && !match.over) {
    const p = c.player, x = Number(m.x), y = Number(m.y), a = Number(m.a);
    if (m.q !== undefined && Number(m.q) !== p.seq) { return; }          // stale: client has not teleported to the latest spawn yet
    if (Number.isFinite(x) && Number.isFinite(y) && !NB.hits(map, x, y, 1e9, false)) {
      // Movement is decided by the browser. Reject impossible jumps (speed hacks / teleports) and send the client back.
      const gap = Math.min(2, (now - (p.lastPos || now)) / 1000), dist = Math.hypot(x - p.x, y - p.y);
      if (dist <= 60 + 1300 * gap) { p.x = x; p.y = y; p.vx = clamp(Number(m.vx) || 0, -1500, 1500); p.vy = clamp(Number(m.vy) || 0, -1500, 1500); p.lastPos = now; p.rejected = 0; if (p.body) { p.body.x = x; p.body.y = y; } }
      else if (++p.rejected > 3) { p.seq++; p.rejected = 0; p.lastPos = now; }          // snap the client back to our position
    }
    if (Number.isFinite(a)) p.a = a;
    p.input = { fire: !!m.fire };
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
    if (len > 4096) return dropClient(c);
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
function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
const settingsPayload = req => ({ game: 'neon-blitz', settings, isHost: isHost(req), defaults: DEFAULTS, limits: LIMITS, humans: humanCount(), maps: NB.MAPS.map(m => m.name) });
const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/shared.js': ['shared.js', 'application/javascript; charset=utf-8'] };   // whitelist: nothing else is served from disk

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
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
  const f = FILES[url];
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, 'public', f[0]), (err, data) => {
    if (err) { res.writeHead(500); return res.end(f[0] + ' missing'); }
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-store' }); res.end(data);
  });
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { sock, buf: Buffer.alloc(0), player: null, rateT: 0, rateN: 0 };
  clients.add(c);
  sock.on('data', d => onData(c, d)); sock.on('close', () => dropClient(c)); sock.on('error', () => dropClient(c));
});

loadMap(0); match.timeLeft = settings.timeLimit * 60;
ensureBots();
if (require.main === module) {
  setInterval(loop, 1000 * TICK);
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  NEON BLITZ server is running!\n');
    console.log(`  On this PC:        http://localhost:${PORT}`);
    const addrs = []; for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
    for (const ip of addrs) console.log(`  Your friends:      http://${ip}:${PORT}`);
    console.log('\n  Settings can be changed from the dashboard on THIS PC (press Esc in game).');
    console.log('  Keep this window open while you play. Ctrl+C to stop.\n');
    for (let i = 0; i < NB.MAPS.length; i++) setTimeout(() => buildNav(NB.getMap(i)), 200 + i * 150);   // bot route graphs, built one map at a time
  });
} else module.exports = { players, bullets, settings, match, teamScore, update, handleMessage, snapshot, applySettings, resetMatch, newPlayer, respawn, ensureBots, fire, WEAPONS, get map() { return map; }, get pickups() { return pickups; }, clients, events, humansPresent };
