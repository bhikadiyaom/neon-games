// Title menu + right-hand sheet (Room, Garage, Options, Credits). Keyboard, mouse and gamepad all drive the
// same focus model: the left menu or the rows inside the sheet.
import { sfx, unlockAudio } from './audio.js';
const APEX = globalThis.APEX;
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const LIVERIES = ['#c8102e', '#ff3d81', '#00e5ff', '#7a4dff', '#ffd400', '#7cff4f', '#ff8a3d', '#f2f2f2', '#1b1d2a', '#0a5cff'];
const LABELS = {
  difficulty: { rookie: 'Rookie', pro: 'Pro', elite: 'Elite' }, weather: { auto: 'Map default', clear: 'Clear', rain: 'Rain' },
  time: { auto: 'Map default', day: 'Day', sunset: 'Sunset', night: 'Night' }, assists: { any: 'Player choice', off: 'Off', low: 'Low', full: 'Full' },
  carClass: { any: 'Any', gt: 'GT only', hyper: 'Hyper only' },
};

let toastT = 0;
export function toast(text) { const t = $('toast'); t.textContent = text; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }

export class Menu {
  constructor({ net, options, profile, onOptions, onProfile, code }) {
    this.net = net; this.options = options; this.profile = profile; this.onOptions = onOptions; this.onProfile = onProfile; this.code = code;
    this.items = [
      { id: 'race', label: 'Race', soon: true }, { id: 'trial', label: 'Time trial', soon: true },
      { id: 'room', label: 'Room & track' }, { id: 'garage', label: 'Garage' }, { id: 'options', label: 'Options' }, { id: 'credits', label: 'Credits' },
    ];
    this.sel = 0; this.focus = 'menu'; this.page = 'room'; this.rows = []; this.rowSel = 0;
    const m = $('menu');
    m.innerHTML = this.items.map((it, i) => `<button data-i="${i}">${esc(it.label)}${it.soon ? '<span class="soon">NEXT UPDATE</span>' : ''}</button>`).join('');
    m.querySelectorAll('button').forEach(b => {
      b.onmouseenter = () => { if (this.sel !== +b.dataset.i) { this.sel = +b.dataset.i; this.focus = 'menu'; sfx.move(); this.paint(); } };
      b.onclick = () => { unlockAudio(); this.sel = +b.dataset.i; this.activate(); };
    });
    for (const ev of ['roster', 'settings', 'status', 'welcome']) net.addEventListener(ev, () => { if (this.page === 'room') this.renderSheet(true); });
    this.paint(); this.renderSheet();
  }

  paint() {
    $('menu').querySelectorAll('button').forEach((b, i) => b.classList.toggle('sel', i === this.sel && (this.focus === 'menu' || this.items[i].id === this.page)));
    this.rows.forEach((r, i) => r.el.classList.toggle('sel', this.focus === 'sheet' && i === this.rowSel));
  }
  activate() {
    const it = this.items[this.sel];
    if (it.soon) { sfx.deny(); toast(it.id === 'race' ? 'Racing arrives in the next update. Set up your room and garage now!' : 'Time trial arrives in the next update.'); return; }
    sfx.select();
    this.page = it.id; this.renderSheet();
    if (this.rows.length) { this.focus = 'sheet'; this.rowSel = 0; }
    this.paint();
  }

  // ---------- input ----------
  key(k) {
    unlockAudio();
    if (this.focus === 'menu') {
      if (k === 'up' || k === 'down') { this.sel = (this.sel + (k === 'up' ? -1 : 1) + this.items.length) % this.items.length; sfx.move(); this.paint(); }
      else if (k === 'enter' || k === 'right') this.activate();
      else if (k === 'back' && this.page !== 'room') { sfx.back(); this.page = 'room'; this.renderSheet(); this.paint(); }
    } else {
      const r = this.rows[this.rowSel];
      if (k === 'up' || k === 'down') { if (this.rows.length) { this.rowSel = (this.rowSel + (k === 'up' ? -1 : 1) + this.rows.length) % this.rows.length; sfx.move(); this.paint(); this.rows[this.rowSel].el.scrollIntoView({ block: 'nearest' }); } }
      else if ((k === 'left' || k === 'right') && r && r.change) { if (r.change(k === 'left' ? -1 : 1) !== false) sfx.change(); else sfx.deny(); }
      else if (k === 'enter' && r) { if (r.press) r.press(); else if (r.change) r.change(1); sfx.select(); }
      else if (k === 'back') { sfx.back(); this.focus = 'menu'; this.paint(); }
    }
  }

  // ---------- sheet pages ----------
  renderSheet(keepFocus) {
    const s = $('sheet'), prevSel = this.rowSel;
    this.rows = [];
    s.innerHTML = this['page_' + this.page]();
    s.querySelectorAll('.row').forEach((el, i) => {
      const r = this.rows[i]; if (!r) return; r.el = el;
      el.onmouseenter = () => { if (this.focus !== 'sheet' || this.rowSel !== i) { this.focus = 'sheet'; this.rowSel = i; this.paint(); } };
      el.querySelectorAll('[data-d]').forEach(b => b.onclick = e => { e.stopPropagation(); unlockAudio(); if (r.change && r.change(+b.dataset.d) !== false) sfx.change(); else sfx.deny(); });
      el.querySelectorAll('[data-set]').forEach(b => b.onclick = e => { e.stopPropagation(); unlockAudio(); r.set && r.set(b.dataset.set); sfx.change(); });
      if (r.bind) r.bind(el);
    });
    const copy = s.querySelector('#copyLink');
    if (copy) copy.onclick = async () => { const i = s.querySelector('#invite'); try { await navigator.clipboard.writeText(i.value); } catch { i.select(); document.execCommand('copy'); } copy.textContent = 'COPIED'; setTimeout(() => copy.textContent = 'COPY', 1400); };
    if (keepFocus) this.rowSel = Math.min(prevSel, Math.max(0, this.rows.length - 1));
    if (!this.rows.length && this.focus === 'sheet') this.focus = 'menu';
    this.paint();
  }
  row(label, valueHtml, opts = {}) { this.rows.push(opts); return `<div class="row${opts.ro ? ' ro' : ''}"><label>${esc(label)}</label><div class="val">${valueHtml}</div></div>`; }
  stepRow(label, text, change, ro) { return this.row(label, `<button class="arrow" data-d="-1">&#9664;</button><span class="v">${esc(text)}</span><button class="arrow" data-d="1">&#9654;</button>`, { change: ro ? () => false : change, ro }); }

  page_room() {
    const n = this.net, st = n.status, s = n.settings, host = n.isHost;
    const stTxt = st === 'online' ? `Connected &middot; ${Math.round(n.ping)} ms` : st === 'connecting' ? 'Connecting...' : 'Offline, retrying...';
    const link = this.code ? location.origin + '/r/' + this.code + '/' : location.origin + '/';
    let h = `<h3>ROOM <small>${host ? 'You are the host' : 'Guest'}</small></h3>
      <div class="code">${this.code || 'LOCAL'}</div>
      <div class="status ${st === 'online' ? 'ok' : st === 'offline' ? 'bad' : ''}"><b></b>${stTxt}</div>
      <div class="linkrow"><input id="invite" readonly value="${esc(link)}"><button id="copyLink">COPY</button></div>
      <div class="roster">`;
    for (const p of n.roster) {
      const car = APEX.CARS[APEX.carIndex(p.car)];
      h += `<div class="racer${p.id === n.id ? ' me' : ''}"><i style="background:${esc(p.livery)}"></i><span class="n">${p.num}</span><span>${esc(p.name)}${p.id === n.id ? ' (you)' : ''}</span><span class="c">${esc(car.name)}</span></div>`;
    }
    const aiN = Math.min(s.ai, APEX.MAX_RACERS - n.roster.length);
    if (aiN > 0) h += `<div class="racer"><i style="background:#555a70"></i><span class="n">AI</span><span>${aiN} AI rival${aiN > 1 ? 's' : ''} (${LABELS.difficulty[s.difficulty]})</span><span class="c"></span></div>`;
    if (n.spectators) h += `<div class="note">${n.spectators} watching as spectator${n.spectators > 1 ? 's' : ''}.</div>`;
    h += '</div><h3 style="margin-top:1.4rem">RACE SETTINGS</h3><div class="rows">';
    const set = (k, v) => { this.net.saveSettings({ [k]: v }); };
    const cyc = (k, d) => { const vals = APEX.OPTIONS[k]; set(k, vals[(vals.indexOf(s[k]) + d + vals.length) % vals.length]); };
    const map = APEX.MAPS[s.map];
    h += this.stepRow('Track', map.name, d => set('map', (s.map + d + APEX.MAPS.length) % APEX.MAPS.length), !host);
    h += this.stepRow('Laps', String(s.laps), d => { const v = s.laps + d; if (v < 1 || v > 10) return false; set('laps', v); }, !host);
    h += this.stepRow('AI rivals', String(s.ai), d => { const v = s.ai + d; if (v < 0 || v > 7) return false; set('ai', v); }, !host);
    for (const k of ['difficulty', 'weather', 'time', 'assists', 'carClass']) h += this.stepRow(APEX.SETTINGS[k].label, LABELS[k][s[k]], d => cyc(k, d), !host);
    for (const k of ['qualifying', 'collisions']) h += this.stepRow(APEX.SETTINGS[k].label, s[k] ? 'On' : 'Off', () => set(k, !s[k]), !host);
    h += '</div>';
    h += host ? `<div class="note">Changes reach everyone in the room instantly.</div>` : `<div class="note"><b>Only the host</b> (the person who created the room) can change these.</div>`;
    return h;
  }
  page_garage() {
    const p = this.profile, car = APEX.CARS[APEX.carIndex(p.car)];
    let h = `<h3>GARAGE <small>${esc(car.blurb)}</small></h3><div class="rows">`;
    h += this.row('Driver name', `<input type="text" maxlength="16" value="${esc(p.name)}">`, { bind: el => { const i = el.querySelector('input'); i.onkeydown = e => e.stopPropagation(); i.onchange = () => this.onProfile({ name: APEX.cleanName(i.value) }); } , press: function () { this.el.querySelector('input').focus(); } });
    h += this.stepRow('Car', `${car.name} (${car.cls === 'gt' ? 'GT' : 'Hyper'})`, d => { const i = (APEX.carIndex(p.car) + d + APEX.CARS.length) % APEX.CARS.length; this.onProfile({ car: APEX.CARS[i].id }); this.renderSheet(true); });
    const sw = LIVERIES.map(c => `<button data-set="${c}" class="${c === p.livery ? 'on' : ''}" style="background:${c}"></button>`).join('');
    h += this.row('Livery colour', `<div class="swatches">${sw}<input type="color" value="${esc(p.livery)}"></div>`, {
      change: d => { let i = LIVERIES.indexOf(p.livery); i = (i < 0 ? 0 : i + d + LIVERIES.length) % LIVERIES.length; this.onProfile({ livery: LIVERIES[i] }); this.renderSheet(true); },
      set: c => { this.onProfile({ livery: c }); this.renderSheet(true); },
      bind: el => { const i = el.querySelector('input[type=color]'); i.onchange = () => { this.onProfile({ livery: APEX.cleanColor(i.value, p.livery) }); this.renderSheet(true); }; },
    });
    h += '</div><div class="note">Your car and colour are saved on this computer and shown to everyone in the room. The 3D garage with liveries and decals arrives with the cars update.</div>';
    return h;
  }
  page_options() {
    const o = this.options, presets = ['low', 'medium', 'high', 'ultra'], P = { low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' };
    const set = patch => { this.onOptions(patch); this.renderSheet(true); };
    let h = '<h3>OPTIONS <small>saved on this computer</small></h3><div class="rows">';
    h += this.stepRow('Graphics preset', P[o.preset], d => { const i = presets.indexOf(o.preset) + d; if (i < 0 || i >= presets.length) return false; set({ preset: presets[i] }); });
    h += this.stepRow('Render scale', Math.round(o.renderScale * 100) + '%', d => { const v = Math.round((o.renderScale + d * 0.05) * 100) / 100; if (v < 0.5 || v > 2) return false; set({ renderScale: v }); });
    h += this.stepRow('Dynamic resolution', o.dynamicRes ? 'On (holds 60 FPS)' : 'Off', () => set({ dynamicRes: !o.dynamicRes }));
    h += this.stepRow('Anti-aliasing (MSAA)', o.msaa ? '4x' : 'Off', () => set({ msaa: !o.msaa }));
    h += this.stepRow('Performance stats (F3)', o.stats ? 'On' : 'Off', () => set({ stats: !o.stats }));
    h += this.stepRow('Reduced motion', o.reducedMotion ? 'On' : 'Off', () => set({ reducedMotion: !o.reducedMotion }));
    h += this.stepRow('Sound volume', Math.round(o.volume * 100) + '%', d => { const v = Math.round((o.volume + d * 0.1) * 10) / 10; if (v < 0 || v > 1) return false; set({ volume: v }); });
    h += '</div><div class="note">Presets: Low renders at most 1280 x 720 (laptops with built-in graphics), Medium 1600 x 900, High 1920 x 1080 (60 FPS on a mid-range graphics card), Ultra up to 4K. More options (shadows, reflections, motion blur, controls) arrive with the racing update.</div>';
    return h;
  }
  page_credits() {
    return `<h3>CREDITS</h3><div class="credits">
      <p><b>Neon Apex GP</b> is part of the Neon Arcade. Its 3D engine is written by hand on <b>WebGPU</b>, with no outside code libraries.</p>
      <p>Every track, car, team, driver and sponsor in the game is made up. Any likeness to real ones is a coincidence.</p>
      <p>Tracks, textures and sounds are generated by code, so the whole game downloads in a few hundred kilobytes.</p>
      <p>Fonts: Barlow Condensed, Orbitron and Rajdhani (Google Fonts, Open Font License).</p></div>`;
  }
}
