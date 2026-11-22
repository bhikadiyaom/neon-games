// Neon Apex GP - code shared by server.js (require) and the browser (<script src="shared/apex-shared.js">):
// room settings, map + car catalogue, and the compact binary car-state format used on the network.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.APEX = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_RACERS = 8;

  // ---------- catalogue ----------
  const MAPS = [
    { id: 'valmore', name: 'Valmore Hills', blurb: 'Golden-hour hill circuit', time: 'sunset', weather: 'clear', accent: '#ffb347' },
    { id: 'harbor',  name: 'Neon Harbor',   blurb: 'Night street circuit',     time: 'night',  weather: 'rain',  accent: '#00e5ff' },
    { id: 'dune',    name: 'Dune Canyon',   blurb: 'High-speed desert canyon', time: 'day',    weather: 'clear', accent: '#ff9d3d' },
    { id: 'alpine',  name: 'Alpine Pass',   blurb: 'Mountain road, hairpins',  time: 'day',    weather: 'rain',  accent: '#9fd8ff' },
    { id: 'coastal', name: 'Coastal Bay',   blurb: 'Seaside cliffs at sunset', time: 'sunset', weather: 'clear', accent: '#ff6b8b' },
  ];
  const CARS = [
    { id: 'vanta',  name: 'Vanta GT',    cls: 'gt',    blurb: 'Mid-engine all-rounder' },
    { id: 'brenna', name: 'Brenna GTS',  cls: 'gt',    blurb: 'Front-engine torque monster' },
    { id: 'aurex',  name: 'Aurex X9',    cls: 'hyper', blurb: 'Downforce king' },
    { id: 'nyx',    name: 'Nyx Spectre', cls: 'hyper', blurb: 'Light, twitchy, brutal' },
  ];

  // ---------- room settings (host dashboard) ----------
  // type int: [min, max]; type enum: allowed values; type bool.
  const SETTINGS = {
    map:        { type: 'int',  min: 0, max: MAPS.length - 1, def: 0, label: 'Map' },
    laps:       { type: 'int',  min: 1, max: 10, def: 3, label: 'Laps' },
    ai:         { type: 'int',  min: 0, max: MAX_RACERS - 1, def: 5, label: 'AI rivals' },
    difficulty: { type: 'enum', values: ['rookie', 'pro', 'elite'], def: 'pro', label: 'AI difficulty' },
    weather:    { type: 'enum', values: ['auto', 'clear', 'rain'], def: 'auto', label: 'Weather' },
    time:       { type: 'enum', values: ['auto', 'day', 'sunset', 'night'], def: 'auto', label: 'Time of day' },
    assists:    { type: 'enum', values: ['any', 'off', 'low', 'full'], def: 'any', label: 'Assists' },
    carClass:   { type: 'enum', values: ['any', 'gt', 'hyper'], def: 'any', label: 'Car class' },
    qualifying: { type: 'bool', def: false, label: 'Qualifying' },
    collisions: { type: 'bool', def: true, label: 'Collisions' },
  };
  const DEFAULTS = {}, LIMITS = {}, OPTIONS = {};
  for (const [k, d] of Object.entries(SETTINGS)) {
    DEFAULTS[k] = d.def;
    if (d.type === 'int') LIMITS[k] = [d.min, d.max];
    if (d.type === 'enum') OPTIONS[k] = d.values.slice();
  }
  // Returns a clean copy of `base` with every valid field of `src` applied. Unknown or bad fields are ignored.
  function normalizeSettings(src, base) {
    const out = Object.assign({}, base || DEFAULTS);
    if (!src || typeof src !== 'object') return out;
    for (const [k, d] of Object.entries(SETTINGS)) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      const v = src[k];
      if (d.type === 'int') {
        const n = Number(v);
        if (v !== null && v !== '' && typeof v !== 'boolean' && Number.isFinite(n)) out[k] = Math.max(d.min, Math.min(d.max, Math.round(n)));
      } else if (d.type === 'enum') { if (d.values.includes(v)) out[k] = v; }
      else if (d.type === 'bool') { if (typeof v === 'boolean') out[k] = v; }
    }
    return out;
  }

  // ---------- player input sanitising ----------
  const cleanName = n => String(n == null ? '' : n).replace(/[^\w \-.]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Driver';
  const cleanColor = (c, fallback) => /^#[0-9a-fA-F]{6}$/.test(String(c)) ? String(c).toLowerCase() : fallback;
  const carIndex = id => { const i = CARS.findIndex(c => c.id === id); return i < 0 ? 0 : i; };

  // ---------- binary car state ----------
  // One car = CAR_BYTES bytes, little endian. Position in centimetres (int32, +-21 km), rotation as a
  // normalised quaternion in 4 x int16, velocity in cm/s (int16, +-327 m/s), driver inputs and engine
  // state quantised to bytes. Enough for smooth interpolation of remote cars at 20 Hz.
  const CAR_BYTES = 40;
  const MSG = { STATE: 1, SNAPSHOT: 2 };
  const q16 = v => Math.max(-32767, Math.min(32767, Math.round(v)));
  const i32 = v => Math.max(-2147483647, Math.min(2147483647, Math.round(v)));
  const u8 = v => Math.max(0, Math.min(255, Math.round(v)));
  const fin = v => (Number.isFinite(v) ? v : 0);
  function writeCar(dv, o, s) {
    dv.setInt32(o, i32(fin(s.x) * 100), true); dv.setInt32(o + 4, i32(fin(s.y) * 100), true); dv.setInt32(o + 8, i32(fin(s.z) * 100), true);
    let qx = fin(s.qx), qy = fin(s.qy), qz = fin(s.qz), qw = s.qw == null ? 1 : fin(s.qw);
    const ql = Math.hypot(qx, qy, qz, qw) || 1; qx /= ql; qy /= ql; qz /= ql; qw /= ql;
    if (Math.hypot(qx, qy, qz, qw) < 0.5) { qx = qy = qz = 0; qw = 1; }
    dv.setInt16(o + 12, q16(qx * 32767), true); dv.setInt16(o + 14, q16(qy * 32767), true);
    dv.setInt16(o + 16, q16(qz * 32767), true); dv.setInt16(o + 18, q16(qw * 32767), true);
    dv.setInt16(o + 20, q16(fin(s.vx) * 100), true); dv.setInt16(o + 22, q16(fin(s.vy) * 100), true); dv.setInt16(o + 24, q16(fin(s.vz) * 100), true);
    dv.setInt8(o + 26, Math.max(-127, Math.min(127, Math.round(fin(s.steer) * 127))));
    dv.setUint8(o + 27, u8(fin(s.throttle) * 255)); dv.setUint8(o + 28, u8(fin(s.brake) * 255));
    dv.setInt8(o + 29, Math.max(-1, Math.min(9, Math.round(fin(s.gear)))));
    dv.setUint16(o + 30, Math.max(0, Math.min(65535, Math.round(fin(s.rpm)))), true);
    dv.setUint8(o + 32, u8(fin(s.flags)));
    dv.setUint8(o + 33, u8(fin(s.lap)));
    dv.setUint32(o + 34, Math.max(0, Math.min(4294967295, Math.round(fin(s.dist) * 100))), true); // distance along the lap, cm
    dv.setUint16(o + 38, fin(s.seq) & 0xffff, true);
  }
  function readCar(dv, o) {
    return {
      x: dv.getInt32(o, true) / 100, y: dv.getInt32(o + 4, true) / 100, z: dv.getInt32(o + 8, true) / 100,
      qx: dv.getInt16(o + 12, true) / 32767, qy: dv.getInt16(o + 14, true) / 32767, qz: dv.getInt16(o + 16, true) / 32767, qw: dv.getInt16(o + 18, true) / 32767,
      vx: dv.getInt16(o + 20, true) / 100, vy: dv.getInt16(o + 22, true) / 100, vz: dv.getInt16(o + 24, true) / 100,
      steer: dv.getInt8(o + 26) / 127, throttle: dv.getUint8(o + 27) / 255, brake: dv.getUint8(o + 28) / 255,
      gear: dv.getInt8(o + 29), rpm: dv.getUint16(o + 30, true), flags: dv.getUint8(o + 32), lap: dv.getUint8(o + 33),
      dist: dv.getUint32(o + 34, true) / 100, seq: dv.getUint16(o + 38, true),
    };
  }
  const viewOf = buf => buf instanceof ArrayBuffer ? new DataView(buf) : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // client -> server: [u8 MSG.STATE][car]
  function encodeState(s) { const b = new ArrayBuffer(1 + CAR_BYTES), dv = new DataView(b); dv.setUint8(0, MSG.STATE); writeCar(dv, 1, s); return b; }
  function decodeState(buf) { const dv = viewOf(buf); return dv.byteLength === 1 + CAR_BYTES && dv.getUint8(0) === MSG.STATE ? readCar(dv, 1) : null; }
  // server -> client: [u8 MSG.SNAPSHOT][u32 server ms][u8 n] then n x ([u8 id][car])
  function encodeSnapshot(timeMs, cars) {
    const b = new ArrayBuffer(6 + cars.length * (1 + CAR_BYTES)), dv = new DataView(b);
    dv.setUint8(0, MSG.SNAPSHOT); dv.setUint32(1, timeMs >>> 0, true); dv.setUint8(5, cars.length);
    let o = 6; for (const c of cars) { dv.setUint8(o, c.id & 255); writeCar(dv, o + 1, c.s); o += 1 + CAR_BYTES; }
    return b;
  }
  function decodeSnapshot(buf) {
    const dv = viewOf(buf);
    if (dv.byteLength < 6 || dv.getUint8(0) !== MSG.SNAPSHOT) return null;
    const n = dv.getUint8(5); if (dv.byteLength < 6 + n * (1 + CAR_BYTES)) return null;
    const cars = []; let o = 6;
    for (let i = 0; i < n; i++) { cars.push({ id: dv.getUint8(o), s: readCar(dv, o + 1) }); o += 1 + CAR_BYTES; }
    return { time: dv.getUint32(1, true), cars };
  }

  return { MAX_RACERS, MAPS, CARS, SETTINGS, DEFAULTS, LIMITS, OPTIONS, normalizeSettings, cleanName, cleanColor, carIndex,
    CAR_BYTES, MSG, writeCar, readCar, encodeState, decodeState, encodeSnapshot, decodeSnapshot };
});
