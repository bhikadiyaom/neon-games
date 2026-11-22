// node apex-racing/test/server.test.js : tests the REAL server.js over real HTTP + WebSocket on a random port.
process.env.NO_PERSIST = '1';
process.env.ADMIN_KEY = 'k'.repeat(24);
delete process.env.PUBLIC_MODE;
const S = require('../server.js');
const APEX = require('../public/shared/apex-shared.js');
const zlib = require('zlib');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  FAIL:', msg); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`); ws.binaryType = 'arraybuffer';
  const c = { ws, json: [], bin: [], open: new Promise(r => ws.onopen = r), closed: false };
  ws.onmessage = e => typeof e.data === 'string' ? c.json.push(JSON.parse(e.data)) : c.bin.push(e.data);
  ws.onclose = () => { c.closed = true; };
  c.send = o => ws.send(typeof o === 'string' || o instanceof ArrayBuffer ? o : JSON.stringify(o));
  c.last = t => [...c.json].reverse().find(m => m.t === t);
  return c;
}
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(15); } return false; };

(async () => {
  await new Promise(r => S.server.listen(0, '127.0.0.1', r));
  const port = S.server.address().port, base = `http://127.0.0.1:${port}`;

  // ---------- shared settings rules ----------
  const n = APEX.normalizeSettings({ laps: '12', ai: 3.6, weather: 'snow', qualifying: true, map: true, time: 'night', bogus: 1 });
  ok(n.laps === 10 && n.ai === 4 && n.weather === 'auto' && n.qualifying === true && n.map === 0 && n.time === 'night' && !('bogus' in n), 'normalizeSettings clamps, rounds and rejects bad values ' + JSON.stringify(n));
  ok(APEX.cleanName('<script>alert(1)</script>') === 'scriptalert1scri', 'names are sanitised and capped at 16 characters');
  ok(APEX.cleanColor('#ABCDEF', '#000000') === '#abcdef' && APEX.cleanColor('red', '#000000') === '#000000', 'livery colours validated');
  // binary codec round trip
  const st = { x: 1234.56, y: -3.21, z: 99.99, qx: 0, qy: 0.7071, qz: 0, qw: 0.7071, vx: 83.3, vy: -1, vz: 12.5, steer: -0.5, throttle: 1, brake: 0.25, gear: 4, rpm: 7800, flags: 5, lap: 2, dist: 4567.89, seq: 70000 };
  const back = APEX.decodeState(APEX.encodeState(st));
  ok(Math.abs(back.x - st.x) < 0.006 && Math.abs(back.z - st.z) < 0.006 && Math.abs(back.qy - 0.7071) < 0.001 && Math.abs(back.vx - 83.3) < 0.006 && back.gear === 4 && back.rpm === 7800 && back.lap === 2 && Math.abs(back.dist - 4567.89) < 0.006 && back.seq === (70000 & 0xffff), 'car state survives binary encoding ' + JSON.stringify(back));
  ok(APEX.encodeState(st).byteLength === 1 + APEX.CAR_BYTES && APEX.CAR_BYTES === 40, 'car state is 41 bytes on the wire');
  const nanState = APEX.decodeState(APEX.encodeState({ x: NaN, y: Infinity, qw: NaN }));
  ok(Number.isFinite(nanState.x) && Number.isFinite(nanState.y) && Math.abs(nanState.qw - 1) < 1e-3, 'NaN/Infinity never reach the wire');
  const snapRT = APEX.decodeSnapshot(APEX.encodeSnapshot(123456, [{ id: 3, s: st }, { id: 9, s: { x: 1 } }]));
  ok(snapRT && snapRT.time === 123456 && snapRT.cars.length === 2 && snapRT.cars[0].id === 3 && snapRT.cars[1].s.x === 1, 'snapshot round trip');
  ok(APEX.decodeSnapshot(new Uint8Array([2, 0, 0, 0, 0, 5]).buffer) === null, 'truncated snapshot rejected');

  // ---------- HTTP: page, static files, caching, compression ----------
  let r = await fetch(base + '/');
  let html = await r.text();
  ok(r.status === 200 && r.headers.get('cache-control') === 'no-store' && /text\/html/.test(r.headers.get('content-type')), 'GET / is HTML with no-store');
  ok(html.includes('<script type="importmap">') && /src="js\/main\.js\?v=[0-9a-f]{12}"/.test(html), 'index has an import map and hashed script URLs');
  const mainHash = /js\/main\.js\?v=([0-9a-f]{12})/.exec(html)[1];
  r = await fetch(base + '/js/main.js?v=' + mainHash);
  ok(r.status === 200 && /immutable/.test(r.headers.get('cache-control')) && /javascript/.test(r.headers.get('content-type')), 'hashed file is cached for a year');
  ok(r.headers.get('content-encoding') === 'br' || r.headers.get('content-encoding') === 'gzip', 'served compressed (' + r.headers.get('content-encoding') + ')');
  const etag = r.headers.get('etag');
  r = await fetch(base + '/js/main.js', { headers: { 'If-None-Match': etag } });
  ok(r.status === 304, 'ETag revalidation gives 304');
  r = await fetch(base + '/js/main.js');
  ok(r.headers.get('cache-control') === 'no-cache', 'unhashed URL must revalidate');
  for (const bad of ['/../server.js', '/%2e%2e/server.js', '/server.js', '/public/index.html', '/js/../../server.js', '/settings.json']) {
    r = await fetch(base + bad); ok(r.status === 404, 'not served: ' + bad + ' -> ' + r.status);
  }
  r = await fetch(base + '/', { method: 'DELETE' }); ok(r.status === 405, 'DELETE refused');
  // brotli body decodes to the original file
  const raw = S.files.get('/js/engine/gpu.js');
  ok(raw.br && zlib.brotliDecompressSync(raw.br).equals(raw.raw), 'brotli copy matches the source');

  // ---------- settings API + host check ----------
  r = await fetch(base + '/api/settings'); let j = await r.json();
  ok(j.isHost === true && j.humans === 0 && j.settings.laps === 3 && j.limits.laps[1] === 10 && j.defaults && j.options.weather.includes('rain'), 'GET settings (loopback LAN = host) ' + JSON.stringify({ isHost: j.isHost, humans: j.humans }));
  r = await fetch(base + '/api/settings', { headers: { 'X-Forwarded-For': '8.8.8.8' } }); j = await r.json();
  ok(j.isHost === false, 'behind a proxy the IP is never trusted');
  r = await fetch(base + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '8.8.8.8' }, body: '{"laps":5}' });
  ok(r.status === 403 && S.settings.laps === 3, 'non-host POST refused');
  r = await fetch(base + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '8.8.8.8', 'X-Admin-Key': 'k'.repeat(23) + 'x' }, body: '{"laps":5}' });
  ok(r.status === 403, 'wrong admin key refused');
  r = await fetch(base + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Admin-Key': 'k'.repeat(24) }, body: '{"laps":5}' });
  ok(r.status === 415, 'non-JSON body refused');

  // ---------- WebSocket lobby ----------
  const a = client(port), b = client(port); await a.open; await b.open;
  a.send({ t: 'join', name: 'Alice<>', car: 'nyx', livery: '#00ff00' });
  b.send({ t: 'join', name: 'Bob', car: 'nope', livery: 'javascript:1' });
  await until(() => a.last('welcome') && b.last('welcome') && a.json.filter(m => m.t === 'roster').some(m => m.players.length === 2));
  const wa = a.last('welcome'), wb = b.last('welcome');
  ok(wa && wa.id > 0 && !wa.spectator && wa.settings && wa.settings.laps === 3, 'welcome with id + settings');
  const ro = a.json.filter(m => m.t === 'roster').pop();
  const pA = ro.players.find(p => p.id === wa.id), pB = ro.players.find(p => p.id === wb.id);
  ok(pA.name === 'Alice' && pA.car === 'nyx' && pA.livery === '#00ff00', 'join profile cleaned and kept ' + JSON.stringify(pA));
  ok(pB.car === 'vanta' && /^#[0-9a-f]{6}$/.test(pB.livery) && pB.num !== pA.num, 'bad car/livery replaced, unique car numbers');
  r = await fetch(base + '/api/settings'); j = await r.json(); ok(j.humans === 2, 'humans counts connected racers (' + j.humans + ')');
  // host change is pushed to everyone
  r = await fetch(base + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '1.2.3.4', 'X-Admin-Key': 'k'.repeat(24) }, body: JSON.stringify({ laps: 7, map: 2, weather: 'rain' }) });
  j = await r.json();
  ok(r.status === 200 && j.settings.laps === 7 && j.settings.map === 2 && j.isHost === true, 'host with key can change settings through the proxy');
  await until(() => b.last('settings') && b.last('settings').settings.laps === 7);
  ok(b.last('settings') && b.last('settings').settings.weather === 'rain', 'settings broadcast to clients');
  // ping/pong
  a.send({ t: 'ping', c: 42.5 }); await until(() => a.last('pong'));
  ok(a.last('pong').c === 42.5 && Number.isFinite(a.last('pong').s), 'pong echoes client time + server time');
  // profile change
  a.send({ t: 'profile', car: 'aurex', livery: '#123456' });
  await until(() => b.json.filter(m => m.t === 'roster').pop().players.some(p => p.id === wa.id && p.car === 'aurex'));
  ok(b.json.filter(m => m.t === 'roster').pop().players.find(p => p.id === wa.id).livery === '#123456', 'profile change broadcast');

  // ---------- binary car states -> snapshots ----------
  a.send(APEX.encodeState({ x: 10, y: 0.5, z: 20, qw: 1, vx: 30, lap: 1, dist: 12 }));
  await sleep(30); S.loop();
  await until(() => b.bin.length > 0);
  const snap = APEX.decodeSnapshot(b.bin[b.bin.length - 1]);
  ok(snap && snap.cars.some(c => c.id === wa.id && Math.abs(c.s.x - 10) < 0.01 && Math.abs(c.s.vx - 30) < 0.01), 'binary state relayed in the snapshot');
  // teleport is refused, normal motion accepted
  const pa = S.players.get(wa.id);
  a.send(APEX.encodeState({ x: 5000, y: 0, z: 20, qw: 1 })); await sleep(40);
  ok(Math.abs(pa.state.x - 10) < 0.01, 'teleport refused');
  a.send(APEX.encodeState({ x: 12, y: 0.5, z: 20, qw: 1, vx: 30 })); await sleep(40);
  ok(Math.abs(pa.state.x - 12) < 0.01, 'normal motion accepted');
  a.send(APEX.encodeState({ x: 12, y: 0.5, z: 20, qw: 1, vx: 300 })); await sleep(40);
  ok(Math.abs(pa.state.vx - 30) < 0.01, 'impossible speed refused');
  // junk is ignored, the connection survives
  a.send('x'.repeat(2000)); a.send('{not json'); a.send(new Uint8Array([1, 2, 3]).buffer); await sleep(40);
  ok(!a.closed && S.players.has(wa.id), 'junk ignored without crashing');
  // rate limit: a flood does not get through
  const before = S.players.get(wa.id).stateAt;
  for (let i = 0; i < 300; i++) a.send({ t: 'ping', c: i });
  await sleep(300);
  ok(a.json.filter(m => m.t === 'pong').length < 120, 'message flood is rate limited (' + a.json.filter(m => m.t === 'pong').length + ' pongs)');

  // ---------- full room: extra people become spectators ----------
  const more = [];
  for (let i = 0; i < 7; i++) { const c = client(port); await c.open; c.send({ t: 'join', name: 'P' + i }); more.push(c); }
  await until(() => more.every(c => c.last('welcome')));
  ok(S.players.size === 8, 'room holds 8 racers (' + S.players.size + ')');
  const spec = more.filter(c => c.last('welcome').spectator);
  ok(spec.length === 1 && spec[0].last('welcome').reason === 'room full', '9th person joins as spectator');
  // leaving frees the slot
  b.ws.close(); await until(() => S.players.size === 7);
  ok(S.players.size === 7, 'leaving frees the slot');

  // ---------- cost of one server tick with 8 racers ----------
  for (const p of S.players.values()) p.state = { x: Math.random() * 100, y: 0, z: Math.random() * 100, qx: 0, qy: 0, qz: 0, qw: 1, vx: 50, vy: 0, vz: 0, steer: 0, throttle: 1, brake: 0, gear: 5, rpm: 7000, flags: 0, lap: 1, dist: 500, seq: 1 };
  S.players.set(250, { id: 250, name: 'x', car: 'vanta', livery: '#ffffff', num: 99, state: [...S.players.values()][0].state });
  const N = 4000, t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) S.loop();
  const usPerTick = Number(process.hrtime.bigint() - t0) / 1000 / N;
  S.players.delete(250);
  console.log(`  server tick with 8 racers + ${S.clients.size} sockets: ${usPerTick.toFixed(1)} microseconds (20 ticks/s = ${(usPerTick * 20 / 1e4).toFixed(3)}% of one CPU core)`);
  ok(usPerTick < 500, 'tick is cheap');

  for (const c of [a, ...more]) try { c.ws.close(); } catch {}
  await sleep(100);
  S.server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
