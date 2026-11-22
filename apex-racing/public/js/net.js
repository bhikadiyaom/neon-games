// Room connection: WebSocket to the room server (same path as the page, so it works at / and under /r/CODE/),
// JSON for lobby messages, binary for car states. Reconnects by itself. Also the host-only settings API.
const APEX = globalThis.APEX;

export const store = {
  get(k, d) { try { const v = localStorage.getItem('apex.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('apex.' + k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
};

export function roomCode() { const m = /^\/r\/([A-Za-z0-9]{4})\//.exec(location.pathname); return m ? m[1].toUpperCase() : null; }

function adminHeaders() {
  let k = '';
  try {
    const q = new URLSearchParams(location.search).get('admin');
    if (q) { sessionStorage.setItem('apexAdminKey', q); history.replaceState(null, '', location.pathname); }
    k = sessionStorage.getItem('apexAdminKey') || '';
  } catch { /* storage blocked */ }
  return k ? { 'X-Admin-Key': k } : {};
}

export class Net extends EventTarget {
  constructor() {
    super();
    this.ws = null; this.id = 0; this.spectator = false; this.roster = []; this.phase = 'lobby'; this.spectators = 0;
    this.settings = { ...APEX.DEFAULTS }; this.isHost = false;
    this.status = 'connecting'; this.ping = 0; this.clockOffset = 0; this.retry = 0; this.remote = new Map();
    adminHeaders();       // moves ?admin=KEY into sessionStorage and cleans the address bar right away
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async loadSettings() {
    try {
      const r = await fetch('api/settings', { cache: 'no-store', headers: adminHeaders() });
      const j = await r.json();
      this.settings = APEX.normalizeSettings(j.settings, APEX.DEFAULTS); this.isHost = !!j.isHost;
      this.emit('settings');
    } catch { /* offline: keep defaults */ }
  }
  async saveSettings(patch) {
    if (!this.isHost) return false;
    try {
      const r = await fetch('api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', ...adminHeaders() }, body: JSON.stringify(patch) });
      const j = await r.json();
      if (r.ok) { this.settings = APEX.normalizeSettings(j.settings, APEX.DEFAULTS); this.emit('settings'); return true; }
    } catch { /* ignore */ }
    return false;
  }

  connect(profile) {
    this.profile = profile;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${location.pathname}`;
    let ws;
    try { ws = new WebSocket(url); } catch { return this.later(); }
    ws.binaryType = 'arraybuffer';
    this.ws = ws; this.setStatus('connecting');
    ws.onopen = () => {
      this.retry = 0; this.setStatus('online');
      ws.send(JSON.stringify({ t: 'join', name: profile.name, car: profile.car, livery: profile.livery }));
      this.sendPing();
      clearInterval(this.pingT); this.pingT = setInterval(() => this.sendPing(), 2000);
    };
    ws.onmessage = e => typeof e.data === 'string' ? this.onJson(e.data) : this.onBinary(e.data);
    ws.onclose = () => { clearInterval(this.pingT); if (this.ws === ws) { this.ws = null; this.id = 0; this.setStatus('offline'); this.later(); } };
    ws.onerror = () => {};
  }
  later() { const wait = Math.min(8000, 1000 * 2 ** this.retry++); this.reconnectAt = performance.now() + wait; setTimeout(() => { if (!this.ws) this.connect(this.profile); }, wait); }
  setStatus(s) { this.status = s; this.emit('status'); }
  sendPing() { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'ping', c: performance.now() })); }
  sendProfile(p) { Object.assign(this.profile, p); if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'profile', ...p })); }
  sendState(s) { if (this.ws && this.ws.readyState === 1 && this.id && this.ws.bufferedAmount < 16384) this.ws.send(APEX.encodeState(s)); }

  onJson(text) {
    let m; try { m = JSON.parse(text); } catch { return; }
    if (m.t === 'welcome') {
      this.id = m.id; this.spectator = !!m.spectator;
      if (m.settings) this.settings = APEX.normalizeSettings(m.settings, APEX.DEFAULTS);
      this.emit('welcome', m); this.emit('settings');
    } else if (m.t === 'roster') {
      this.roster = m.players || []; this.phase = m.phase; this.spectators = m.spectators || 0; this.emit('roster');
    } else if (m.t === 'settings') {
      this.settings = APEX.normalizeSettings(m.settings, APEX.DEFAULTS); this.emit('settings');
    } else if (m.t === 'pong') {
      const now = performance.now(), rtt = now - m.c;
      this.ping = this.ping ? this.ping * 0.7 + rtt * 0.3 : rtt;
      this.clockOffset = m.s + rtt / 2 - now;          // server ms = performance.now() + clockOffset
      this.emit('status');
    }
  }
  onBinary(buf) {
    const snap = APEX.decodeSnapshot(buf);
    if (!snap) return;
    for (const c of snap.cars) {
      if (c.id === this.id) continue;
      let r = this.remote.get(c.id);
      if (!r) { r = { buf: [] }; this.remote.set(c.id, r); }
      r.buf.push({ t: snap.time, s: c.s });
      if (r.buf.length > 30) r.buf.shift();
    }
    this.emit('snapshot', snap);
  }
}
