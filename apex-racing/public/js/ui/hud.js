// Race HUD (DOM, crisp at any resolution): place + lap boxes, timing panel with sectors, gear / speed /
// RPM bar + LED shift lights, start lights, minimap, messages, pause menu and results.
import { fmt, fmtS } from '../game/race.js';
import { sfx } from './audio.js';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Hud {
  constructor() {
    const el = $('hud');
    el.innerHTML = `
      <div class="hbox" id="hPos"><div class="lbl">PLACE</div><div class="big"><b id="hPlace">1</b><small id="hOf">/1</small></div></div>
      <div class="hbox dark" id="hLap"><div class="lbl">LAP</div><div class="big"><b id="hLapN">1</b><small id="hLaps">/3</small></div></div>
      <div class="htime" id="hTime"><div class="row1"><span>TIME</span><b id="hCur">0:00.000</b></div>
        <div class="row2"><span>LAST</span><i id="hLast">-:--.---</i></div><div class="row2"><span>BEST</span><i id="hBest">-:--.---</i></div>
        <div class="secs"><div id="hS0"><span>S1</span><i>-</i><u></u></div><div id="hS1"><span>S2</span><i>-</i><u></u></div><div id="hS2"><span>S3</span><i>-</i><u></u></div></div></div>
      <canvas id="hMap" width="300" height="300"></canvas>
      <div class="hspeed"><div class="leds" id="hLeds">${'<i></i>'.repeat(12)}</div>
        <div class="gs"><div class="gear"><b id="hGear">1</b><span>GEAR</span></div><div class="spd"><b id="hSpd">0</b><span id="hUnit">KM/H</span></div></div>
        <div class="rpm"><i id="hRpm"></i></div><div class="rpmlbl"><span>REVS &times; 1000</span><span id="hRpmN">0.0</span></div></div>
      <div class="lights" id="hLights">${'<i></i>'.repeat(5)}</div>
      <div class="hmsg" id="hMsg"></div>
      <div class="hhint" id="hHint">Arrows / WASD drive &middot; Space handbrake &middot; C camera &middot; R reset &middot; Esc pause</div>
      <div class="overlay" id="hPause"><div class="ocard"><h2>PAUSED</h2><div class="olist" id="hPauseList"></div></div></div>
      <div class="overlay" id="hResults"><div class="ocard wide"><h2 id="hResTitle">RESULTS</h2><div id="hResBody"></div><div class="olist" id="hResList"></div></div></div>`;
    this.el = el; this.leds = [...$('hLeds').children]; this.lightEls = [...$('hLights').children];
    this.map = $('hMap').getContext('2d'); this.msgT = 0; this.overlay = null; this.sel = 0; this.items = []; this.lastDom = 0;
  }
  show(on) { this.el.classList.toggle('on', on); }
  setupMap(tr) {
    // the minimap is drawn as seen from above: +x is the driver's left, so x is mirrored on screen
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < tr.n; i++) { minX = Math.min(minX, tr.x[i]); maxX = Math.max(maxX, tr.x[i]); minZ = Math.min(minZ, tr.z[i]); maxZ = Math.max(maxZ, tr.z[i]); }
    const size = 300, pad = 22, sc = (size - pad * 2) / Math.max(maxX - minX, maxZ - minZ);
    const ox = (size - (maxX - minX) * sc) / 2, oz = (size - (maxZ - minZ) * sc) / 2;
    this.mapXY = (x, z) => [size - (ox + (x - minX) * sc), size - (oz + (z - minZ) * sc)];
    const path = new Path2D();
    for (let i = 0; i <= tr.n; i += 2) { const [a, b] = this.mapXY(tr.x[i % tr.n], tr.z[i % tr.n]); i ? path.lineTo(a, b) : path.moveTo(a, b); }
    path.closePath(); this.mapPath = path; this.tr = tr;
  }
  message(text, ms = 1800, cls = '') { const m = $('hMsg'); m.textContent = text; m.className = 'hmsg on ' + cls; this.msgT = performance.now() + ms; }
  event(e, s) {
    if (e.type === 'light') { this.lightEls.forEach((l, i) => l.classList.toggle('on', i < e.n)); $('hLights').classList.add('show'); sfx.light(); }
    else if (e.type === 'go') { this.lightEls.forEach(l => l.classList.remove('on')); this.message('GO!', 1200, 'go'); sfx.go(); setTimeout(() => $('hLights').classList.remove('show'), 900); }
    else if (e.type === 'sector') { const c = $('hS' + e.k); c.querySelector('i').textContent = fmtS(e.t); c.className = e.color; }
    else if (e.type === 'lap') { this.message(e.valid ? (e.pb ? 'NEW PERSONAL BEST  ' : 'LAP  ') + fmt(e.t) : 'LAP NOT COUNTED (TRACK LIMITS)', 2600, e.pb ? 'pb' : ''); if (e.pb) sfx.select(); }
    else if (e.type === 'finallap') this.message('FINAL LAP', 2000);
    else if (e.type === 'invalid') this.message('TRACK LIMITS: LAP INVALID', 1800, 'warn');
    else if (e.type === 'wrongway') this.message('WRONG WAY', 1800, 'warn');
    else if (e.type === 'lapstart') this.message('TIMED LAP STARTED', 1400);
    else if (e.type === 'nolap') this.message('LAP NOT COUNTED (MISSED A SECTOR)', 1800, 'warn');
    if (e.type === 'lap') for (let k = 0; k < 3; k++) setTimeout(() => { const c = $('hS' + k); if (c) { c.className = ''; c.querySelector('i').textContent = '-'; } }, 3000);
  }
  // s = session, car = Car, me = { color }, units = 'kmh' | 'mph'
  update(now, s, car, others = [], opts = {}) {
    if (this.msgT && now > this.msgT) { $('hMsg').className = 'hmsg'; this.msgT = 0; }
    // LEDs: green / amber / red, all blue at the limiter
    const rl = car.spec.redline, f = (car.rpm - rl * 0.55) / (rl * 0.42), lit = Math.max(0, Math.min(12, Math.round(f * 12)));
    const lim = car.limiter || car.rpm > rl - 60;
    this.leds.forEach((l, i) => { l.className = lim ? 'b' : i < lit ? (i < 5 ? 'g' : i < 9 ? 'a' : 'r') : ''; });
    $('hRpm').style.width = Math.min(100, car.rpm / rl * 100).toFixed(1) + '%';
    if (now - this.lastDom > 33) {
      this.lastDom = now;
      const v = Math.abs(car.speed) * 3.6 * (opts.units === 'mph' ? 0.6214 : 1);
      $('hSpd').textContent = Math.round(v); $('hUnit').textContent = opts.units === 'mph' ? 'MPH' : 'KM/H';
      $('hGear').textContent = car.gear === -1 ? 'R' : car.gear === 0 ? 'N' : car.gear;
      $('hRpmN').textContent = (car.rpm / 1000).toFixed(1);
      $('hCur').textContent = fmt(s.currentLapTime());
      $('hLast').textContent = fmt(s.lastLap); $('hBest').textContent = fmt(s.bestLap ?? s.allTime.lap);
      $('hLapN').textContent = Math.max(1, Math.min(s.lap, s.laps)); $('hLaps').textContent = s.laps === Infinity ? '' : '/' + s.laps;
      $('hLap').style.display = s.mode === 'trial' && !s.crossed ? 'none' : '';
      $('hPlace').textContent = opts.place || 1; $('hOf').textContent = '/' + (opts.of || 1);
      this.drawMap(car, others, opts.color || '#ff2d55');
    }
  }
  drawMap(car, others, color) {
    const g = this.map; if (!this.mapPath) return;
    g.clearRect(0, 0, 300, 300);
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 13; g.stroke(this.mapPath);
    g.strokeStyle = '#f4f6ff'; g.lineWidth = 7; g.stroke(this.mapPath);
    const st = this.tr, i0 = Math.round(this.tr.def.startS / st.ds) % st.n, [sx, sy] = this.mapXY(st.x[i0], st.z[i0]);
    g.fillStyle = '#111'; g.fillRect(sx - 6, sy - 2, 12, 4);
    for (const o of others) this.dot(o.x, o.z, o.color, 7);
    this.dot(car.pos[0], car.pos[2], color, 9, true);
  }
  dot(x, z, color, r, me) { const g = this.map, [a, b] = this.mapXY(x, z); g.beginPath(); g.arc(a, b, r, 0, 7); g.fillStyle = color; g.fill(); g.lineWidth = me ? 3 : 2; g.strokeStyle = '#fff'; g.stroke(); }

  // ---------- pause / results menus (keyboard, mouse, gamepad) ----------
  openMenu(id, items) {
    this.overlay = id; this.items = items; this.sel = 0;
    const list = $(id === 'hPause' ? 'hPauseList' : 'hResList');
    list.innerHTML = items.map((it, i) => `<button data-i="${i}">${esc(it.label)}</button>`).join('');
    list.querySelectorAll('button').forEach(b => { b.onmouseenter = () => { this.sel = +b.dataset.i; this.paintMenu(); }; b.onclick = () => { this.sel = +b.dataset.i; this.menuKey('enter'); }; });
    $('hPause').classList.toggle('on', id === 'hPause'); $('hResults').classList.toggle('on', id === 'hResults');
    this.paintMenu();
  }
  closeMenu() { this.overlay = null; $('hPause').classList.remove('on'); $('hResults').classList.remove('on'); }
  paintMenu() { const list = $(this.overlay === 'hPause' ? 'hPauseList' : 'hResList'); [...list.children].forEach((b, i) => b.classList.toggle('sel', i === this.sel)); }
  menuKey(k) {
    if (!this.overlay) return false;
    if (k === 'up' || k === 'down') { this.sel = (this.sel + (k === 'up' ? -1 : 1) + this.items.length) % this.items.length; sfx.move(); this.paintMenu(); }
    else if (k === 'enter') { sfx.select(); const it = this.items[this.sel]; it.run(); }
    else if (k === 'back' && this.overlay === 'hPause') { sfx.back(); this.items[0].run(); }
    return true;
  }
  results(s, carName) {
    const rows = s.laptimes.map((l, i) => `<tr class="${l.valid ? '' : 'inv'}${l.t === s.bestLap ? ' best' : ''}"><td>Lap ${i + 1}</td><td>${fmt(l.t)}</td><td>${l.valid ? (l.t === s.bestLap ? 'best' : '') : 'invalid'}</td></tr>`).join('');
    $('hResTitle').textContent = s.mode === 'trial' ? 'TIME TRIAL' : 'RACE FINISHED';
    $('hResBody').innerHTML = `<div class="rsum"><div><span>TOTAL</span><b>${s.finishTime ? fmt(s.finishTime) : '-'}</b></div><div><span>BEST LAP</span><b>${fmt(s.bestLap)}</b></div><div><span>ALL-TIME BEST</span><b>${fmt(s.allTime.lap)}</b></div><div><span>CAR</span><b>${esc(carName)}</b></div></div><table class="rtab">${rows}</table>`;
  }
}
