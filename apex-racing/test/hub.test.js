// node apex-racing/test/hub.test.js : starts the real hub.js, creates a Neon Apex GP room through the API,
// loads it through the /r/CODE/ proxy, connects a WebSocket through the proxy, and measures the room's memory.
const { spawn, spawnSync, execSync } = require('child_process');
const path = require('path');
const APEX = require('../public/shared/apex-shared.js');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  FAIL:', msg); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 3600 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${PORT}`;

function rssOf(pid) {        // resident memory of a process, in MB
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`).toString();
      const kb = Number((/"([\d,.\s]+) K"/.exec(out) || [])[1].replace(/[^\d]/g, ''));
      return kb / 1024;
    }
    return Number(execSync(`ps -o rss= -p ${pid}`).toString()) / 1024;
  } catch { return NaN; }
}
function roomPids() {        // node processes started as "node server.js": [{ pid, ppid }]
  if (process.platform !== 'win32') {
    return execSync('ps -eo pid=,ppid=,args=').toString().split('\n').filter(l => /node\S*\s+server\.js\s*$/.test(l)).map(l => { const [pid, ppid] = l.trim().split(/\s+/).map(Number); return { pid, ppid }; });
  }
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { '' + $_.ProcessId + '|' + $_.ParentProcessId + '|' + $_.CommandLine }";
  const out = spawnSync('powershell', ['-NoProfile', '-Command', ps]).stdout.toString();
  return out.split(/\r?\n/).filter(l => /node(\.exe)?"?\s+server\.js\s*$/.test(l)).map(l => ({ pid: Number(l.split('|')[0]), ppid: Number(l.split('|')[1]) }));
}

(async () => {
  const hub = spawn(process.execPath, ['hub.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(base + '/api/status')).ok; } catch { await sleep(100); } }
    ok(up, 'hub starts');
    const lobby = await (await fetch(base + '/')).text();
    ok(lobby.includes('data-game="apex"') && lobby.includes('pvApex'), 'lobby has the Neon Apex GP card with a live preview');

    let r = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game: 'apex' }) });
    const room = await r.json();
    ok(r.status === 200 && /^[A-Z2-9]{4}$/.test(room.code) && room.admin && room.url === `/r/${room.code}/`, 'room created ' + JSON.stringify({ code: room.code, url: room.url }));
    r = await fetch(base + '/api/rooms/' + room.code); const info = await r.json();
    ok(info.game === 'apex' && info.title === 'Neon Apex GP', 'room lookup says Neon Apex GP');

    r = await fetch(base + room.url, { headers: { 'Accept-Encoding': 'br, gzip' } }); const html = await r.text();
    ok(r.status === 200 && html.includes('Neon Apex') && r.headers.get('cache-control') === 'no-store', 'game page loads through /r/CODE/');
    const mainUrl = /src="(js\/main\.js\?v=[0-9a-f]+)"/.exec(html)[1];
    r = await fetch(base + room.url + mainUrl);
    ok(r.status === 200 && /immutable/.test(r.headers.get('cache-control')), 'module loads relative to /r/CODE/ with long cache');
    r = await fetch(base + `/r/${room.code}`, { redirect: 'manual' });
    ok(r.status === 301 && r.headers.get('location') === `/r/${room.code}/`, 'missing slash redirects');

    r = await fetch(base + room.url + 'api/settings'); let s = await r.json();
    ok(s.isHost === false && s.game === 'apex-racing', 'through the proxy a visitor is NOT host');
    r = await fetch(base + room.url + 'api/settings', { headers: { 'X-Admin-Key': room.admin } }); s = await r.json();
    ok(s.isHost === true, 'the room creator (admin key) IS host');
    r = await fetch(base + room.url + 'api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': room.admin }, body: '{"map":1,"laps":5}' });
    s = await r.json(); ok(s.settings.map === 1 && s.settings.laps === 5, 'host changes settings through the proxy');

    // WebSocket through the hub proxy
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${room.url}`); ws.binaryType = 'arraybuffer';
    const msgs = []; let bins = 0;
    ws.onmessage = e => typeof e.data === 'string' ? msgs.push(JSON.parse(e.data)) : bins++;
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ t: 'join', name: 'Remote', car: 'brenna', livery: '#ff00aa' }));
    ws.send(APEX.encodeState({ x: 1, y: 0, z: 2, qw: 1 }));
    for (let i = 0; i < 40 && !(msgs.some(m => m.t === 'welcome') && bins > 0); i++) await sleep(50);
    ok(msgs.some(m => m.t === 'welcome' && m.id > 0), 'WebSocket joins through the proxy');
    ok(bins > 0, 'binary snapshots arrive through the proxy');
    r = await fetch(base + room.url + 'api/settings'); s = await r.json();
    ok(s.humans === 1, 'room reports 1 human to the hub');

    // memory of the room process (Render free plan: 512 MB for everything)
    await sleep(500);
    const kids = roomPids().filter(k => k.ppid === hub.pid);
    const mb = kids.length ? rssOf(kids[0].pid) : NaN;
    console.log(`  room process memory: ${Number.isFinite(mb) ? mb.toFixed(1) + ' MB' : 'could not measure'} (hub: ${rssOf(hub.pid).toFixed(1)} MB)`);
    ok(!Number.isFinite(mb) || mb < 60, 'room process stays under 60 MB');
    ws.close();
  } finally {
    // on Windows killing the hub does not run its cleanup, so stop its room processes too
    try { for (const k of roomPids()) if (k.ppid === hub.pid) process.kill(k.pid); } catch {}
    hub.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
