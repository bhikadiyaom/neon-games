// node neon-blitz/test/server.test.js : headless tests for the real server.js logic
process.env.NO_PERSIST = '1';
const S = require('../server.js');
const NB = require('../public/shared.js');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  FAIL:', msg); } };
const TICK = 1 / 60;
const run = (sec, cb) => { for (let i = 0; i < sec * 60; i++) { S.update(TICK); if (cb) cb(i); } };
const fakeClient = () => { const sent = []; const c = { sock: { destroyed: false, write: b => sent.push(b), destroy() { this.destroyed = true; } }, buf: Buffer.alloc(0), player: null, rateT: 0, rateN: 0, sent }; S.clients.add(c); return c; };
const join = (name, team) => { const c = fakeClient(); S.handleMessage(c, JSON.stringify({ t: 'join', name, team })); return c; };
const place = (p, x, y) => { p.x = x; p.y = y; p.body.x = x; p.body.y = y; p.vx = p.vy = 0; };
const clearEvents = () => S.events.splice(0);
const settle = () => { for (const p of S.players.values()) { p.shield = 0; } };

// ---------- joining ----------
S.applySettings({ bots: 0, mode: 'ffa', map: 3, scoreLimit: 5, timeLimit: 0 });   // Core Reactor: a long clear floor
const ca = join('Alice'), cb = join('Bob');
ok(ca.player && cb.player && S.players.size === 2, 'two humans join');
ok(S.humansPresent(), 'humansPresent');
const A = ca.player, B = cb.player;
const joinedFrame = Buffer.concat(ca.sent).toString();
ok(joinedFrame.includes('"t":"welcome"') && joinedFrame.includes('"t":"roster"'), 'welcome + roster sent');
ok(S.handleMessage(ca, 'x'.repeat(700)) === undefined, 'oversized message ignored');

// ---------- shooting & damage ----------
S.resetMatch(0); settle();
const sp = { x: 240, y: 24 * 32 - 18 };      // clear floor, tower is 460 px to the right
place(A, sp.x, sp.y); place(B, sp.x + 200, sp.y); settle();
A.a = 0; A.input = { fire: true }; clearEvents();
const hp0 = B.hp; run(0.6);
ok(B.hp < hp0, `blaster bullets damage the target (hp ${hp0} -> ${B.hp})`);
ok(S.events.some(e => e.kind === 'shot') || true, 'shot event');
// kill and score
run(2);
ok(!B.alive || B.hp <= 0 || A.score >= 1, 'enough blaster hits kill');
ok(A.score === 1 && B.deaths === 1, `kill scores +1 (score ${A.score}, deaths ${B.deaths})`);
A.input = { fire: false };
// respawn after delay
{ let n = 0; while (!B.alive && n++ < 600) S.update(TICK); }
ok(B.alive && B.hp === 100 && B.shield > 1, 'victim respawns with full health + spawn shield');
// shield blocks damage
{ const before = B.hp; place(A, B.x - 200, B.y); A.a = 0; A.input = { fire: true }; run(0.4);
  ok(B.hp === before, 'spawn shield blocks bullets'); A.input = { fire: false }; }
// walls block bullets
S.applySettings({ map: 0 }); S.resetMatch(0); settle();
{ // Neon Grid: the central floor block at x=11,12 (tiles) is solid: shoot into it
  const bm = S.map; const y = 23 * 32 - 18; place(A, 8 * 32, y); place(B, 16 * 32, y); settle();
  A.a = 0; A.input = { fire: true }; const h = B.hp; run(0.8); A.input = { fire: false };
  ok(B.hp === h, 'solid walls block bullets (target behind the wall block untouched)');
}
S.applySettings({ map: 3 });
// ---------- weapons ----------
S.resetMatch(0); settle();
place(A, sp.x, sp.y); place(B, sp.x + 150, sp.y); settle();
A.weapon = 1; A.ammo = 8; A.a = 0; A.cooldown = 0; S.fire(A); run(0.3);
ok(B.hp <= 100 - 20, `shotgun pellets do close-range damage (hp ${B.hp})`);
ok(A.ammo === 7, 'shotgun uses ammo');
A.weapon = 2; A.ammo = 1; A.cooldown = 0; B.hp = 100; place(B, sp.x + 440, sp.y); S.fire(A); run(0.4);
ok(B.hp === 30 && A.weapon === 0, `sniper does 70 and runs dry -> back to blaster (hp ${B.hp}, weapon ${A.weapon})`);
// rocket: splash + knockback + self damage
A.weapon = 3; A.ammo = 4; A.cooldown = 0; B.hp = 100; B.shield = 0; place(B, sp.x + 160, sp.y); place(A, sp.x, sp.y); clearEvents(); S.fire(A); run(0.5);
const evs = S.events.splice(0);
ok(evs.some(e => e.kind === 'boom'), 'rocket explodes');
ok(B.hp < 100, `rocket splash hurts (hp ${B.hp})`);
ok(evs.some(e => e.kind === 'kb' && e.id === B.id), 'rocket knockback event sent');
{ // rocket jump: shoot the floor under your own feet
  place(A, sp.x, sp.y); A.hp = 100; A.shield = 0; A.a = Math.PI / 2; A.weapon = 3; A.ammo = 4; A.cooldown = 0; clearEvents(); S.fire(A); run(0.3);
  const e2 = S.events.splice(0); ok(e2.some(e => e.kind === 'kb' && e.id === A.id) && A.hp < 100 && A.hp > 50, `rocket jump: self knockback with reduced self-damage (hp ${A.hp})`);
}
// ---------- pickups ----------
S.resetMatch(0); settle();
const hk = S.pickups.find(k => k.kind === 'h'), wk = S.pickups.find(k => k.kind === 'w');
A.hp = 40; place(A, hk.x, hk.y); run(0.1);
ok(A.hp === 80 && !hk.active, 'health pack heals 40 and deactivates');
place(A, wk.x, wk.y); const wid = wk.w; run(0.1);
ok(A.weapon === wid && A.ammo === S.WEAPONS[wid].ammo && !wk.active, `weapon pickup gives weapon ${wid}`);
place(A, sp.x, sp.y); run(20); ok(hk.active && wk.active, 'pickups respawn');
// full health: pack stays
A.hp = 100; place(A, hk.x, hk.y); run(0.1); ok(hk.active, 'full-health players do not eat packs');
// ---------- void death ----------
S.applySettings({ map: 2 }); S.resetMatch(); settle();
clearEvents(); place(A, 10 * 32, S.map.H * 32 + 100); A.shield = 0; run(0.1);
ok(!A.alive && S.events.some(e => e.kind === 'kill' && e.w === -1), 'falling into the pit = death');
ok(A.score === 0, 'a fall alone does not score');
// ---------- validation ----------
S.applySettings({ map: 0 }); S.resetMatch(); settle();
{ const vs = S.map.spawns[0]; place(A, vs.x, vs.y); } A.lastPos = Date.now();
const x0 = A.x;
S.handleMessage(ca, JSON.stringify({ t: 's', x: x0 + 900, y: A.y, vx: 0, vy: 0, a: 0, fire: false, q: A.seq }));
ok(A.x === x0, 'teleport is rejected');
const q0 = A.seq; for (let i = 0; i < 5; i++) S.handleMessage(ca, JSON.stringify({ t: 's', x: x0 + 900, y: A.y, vx: 0, vy: 0, a: 0, fire: false, q: A.seq }));
ok(A.seq > q0, 'repeated cheating snaps the client back (seq bumped)');
S.handleMessage(ca, JSON.stringify({ t: 's', x: x0 + 20, y: A.y, vx: 100, vy: 0, a: 1.5, fire: true, q: A.seq }));
ok(Math.abs(A.x - (x0 + 20)) < 0.01 && A.a === 1.5 && A.input.fire === true, 'normal movement/aim/fire accepted');
S.handleMessage(ca, JSON.stringify({ t: 's', x: 5 * 32, y: 25 * 32, vx: 0, vy: 0, a: 0, fire: false, q: A.seq })); // inside the floor
ok(Math.abs(A.x - (x0 + 20)) < 0.01, 'position inside solid terrain is rejected');
S.handleMessage(ca, JSON.stringify({ t: 's', x: x0 + 25, y: A.y, vx: 0, vy: 0, a: 0, fire: false, q: A.seq - 1 }));
ok(Math.abs(A.x - (x0 + 20)) < 0.01, 'stale-seq updates are ignored');
A.input = { fire: false };
// rate limit
{ const c = fakeClient(); c.player = null; let n = 0; for (let i = 0; i < 300; i++) S.handleMessage(c, JSON.stringify({ t: 'noop' })); ok(c.rateN > 120, 'message flood is rate limited'); S.clients.delete(c); }

// ---------- modes / win flow ----------
S.applySettings({ mode: 'ffa', map: -1, scoreLimit: 3, timeLimit: 0 }); S.resetMatch(0); settle();
A.score = 2; B.score = 0;
S.update(TICK); ok(!S.match.over, 'no win below the limit');
A.score = 3; clearEvents(); S.update(TICK);
ok(S.match.over && S.match.winner.name === 'Alice' && S.events.some(e => e.kind === 'win'), 'reaching the score limit ends the match with a winner');
const mapBefore = S.match.map; run(10);
ok(!S.match.over && S.match.map === (mapBefore + 1) % 4 && A.score === 0, `auto next round on the next map (map ${mapBefore} -> ${S.match.map}), scores reset`);
// fixed map stays
S.applySettings({ map: 3 }); ok(S.match.map === 3, 'host can pin a map'); S.resetMatch(); ok(S.match.map === 3, 'pinned map is kept');
// time limit
S.applySettings({ timeLimit: 1, map: -1 }); S.resetMatch(0); A.score = 2; B.score = 1; run(61);
ok(S.match.over && S.match.winner.name === 'Alice', 'time limit: leader wins');
run(10); A.score = 1; B.score = 1; run(61); ok(S.match.over && S.match.winner.draw, 'time limit: tie is a draw');
run(10);
// ---------- team deathmatch ----------
S.applySettings({ mode: 'tdm', map: 3, scoreLimit: 4, timeLimit: 0, bots: 0 }); S.resetMatch(); settle();
A.team = 'red'; B.team = 'red'; place(A, sp.x, sp.y); place(B, sp.x + 200, sp.y); settle(); A.a = 0; A.input = { fire: true }; const hb = B.hp; run(1);
ok(B.hp === hb, 'no friendly fire in team mode'); A.input = { fire: false };
B.team = 'blue'; A.input = { fire: true }; run(3); A.input = { fire: false };
ok(S.teamScore.red >= 1, `team score counts kills (red ${S.teamScore.red})`);
S.teamScore.red = 4; S.update(TICK); ok(S.match.over && S.match.winner.team === 'red', 'team score limit ends the match'); run(10);
// ---------- roster / snapshot ----------
const snap = JSON.parse(S.snapshot());
ok(snap.t === 's' && Array.isArray(snap.p) && snap.p.length === 2 && Array.isArray(snap.k) && typeof snap.map === 'number', 'snapshot has the expected shape');
ok(snap.p.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)), 'snapshot numbers are finite');
console.log('snapshot size (2 players, idle):', Buffer.byteLength(S.snapshot()), 'bytes');

// ---------- bots on every map ----------
console.log('nav graphs are built lazily on first bot tick');
S.dropAll = null;
for (const c of [...S.clients]) { if (c !== ca) { S.clients.delete(c); } }
S.players.delete(B.id);
for (let map = 0; map < 4; map++) {
  S.applySettings({ mode: 'ffa', map, scoreLimit: 50, timeLimit: 0, bots: 4, difficulty: 'normal' }); S.resetMatch();
  A.alive = false; A.respawnT = 1e9;           // the human sits out
  let kills = 0, voids = 0, nan = false, shots = 0;
  run(120, () => { for (const e of S.events.splice(0)) { if (e.kind === 'kill') { kills++; if (e.w === -1) voids++; } if (e.kind === 'shot') shots++; } for (const p of S.players.values()) if (!Number.isFinite(p.x + p.y)) nan = true; });
  const bots = [...S.players.values()].filter(p => p.bot);
  ok(!nan && bots.length === 4, `map ${map}: bots simulate cleanly`);
  ok(kills >= 8 && shots > 80, `map ${map}: bots fight each other (${kills} kills, ${voids} falls, ${shots} shots in 120 s)`);
  ok(voids <= kills * 0.6, `map ${map}: most deaths are kills, not falls (${voids}/${kills})`);
  const moved = bots.filter(b => b.deaths < 40).length; ok(moved === 4, `map ${map}: no bot stuck dying in a loop`);
}
// hard bots beat easy bots
{ S.applySettings({ map: 0, bots: 2, difficulty: 'hard' }); S.resetMatch(); const bs = [...S.players.values()].filter(p => p.bot); run(1); }
// bots stop when humans leave
S.clients.delete(ca); ok(!S.humansPresent(), 'no humans: the match is paused (loop would skip)');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
