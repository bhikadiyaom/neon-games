// Race session (local): start lights, laps, sectors, best times, track limits, finish.
// Phase 5 moves the authoritative copy of this to the server for online races.
import { store } from '../net.js';

export class RaceSession {
  constructor({ tr, def, laps, mode, carId }) {
    this.tr = tr; this.def = def; this.mode = mode; this.laps = mode === 'trial' ? Infinity : laps; this.carId = carId;
    this.L = tr.length; this.bounds = def.sectors.map(f => f * tr.length);
    this.state = mode === 'trial' ? 'racing' : 'countdown';
    this.clock = 0; this.countT = 0; this.lights = 0; this.holdT = 1.2 + Math.random() * 1.6;
    this.lap = mode === 'trial' ? 0 : 1; this.lapStart = 0; this.lastLap = null; this.bestLap = null; this.laptimes = [];
    this.sector = 0; this.sectorStart = 0; this.cur = [null, null, null]; this.last = [null, null, null];
    this.sessionBest = [null, null, null]; this.crossed = false; this.valid = true; this.prevD = null; this.events = [];
    this.key = `best.${def.id}.${carId}`;
    this.allTime = store.get(this.key, { lap: null, sectors: [null, null, null] });
    this.finishTime = null; this.offT = 0; this.wrongT = 0;
  }
  emit(e) { this.events.push(e); }
  d(s) { return ((s - this.def.startS) % this.L + this.L) % this.L; }        // metres past the start line
  // dt: frame time; s: car's lap distance; wheelsOff: all four wheels off the track
  update(dt, s, wheelsOff, forwardSpeed) {
    if (this.state === 'countdown') {
      this.countT += dt;
      const n = Math.min(5, Math.floor(this.countT - 0.8));
      if (n > this.lights) { this.lights = n; this.emit({ type: 'light', n }); }
      if (this.countT > 0.8 + 5 + this.holdT) { this.state = 'racing'; this.lights = 0; this.clock = 0; this.lapStart = 0; this.sectorStart = 0; this.emit({ type: 'go' }); }
      return;
    }
    if (this.state !== 'racing') { this.clock += dt; return; }
    this.clock += dt;
    const d = this.d(s), pd = this.prevD; this.prevD = d;
    if (pd === null) return;
    const step = d - pd;
    // track limits: all four wheels off the track for a moment invalidates the lap
    this.offT = wheelsOff ? this.offT + dt : 0;
    if (this.offT > 0.35 && this.valid && this.timing()) { this.valid = false; this.emit({ type: 'invalid' }); }
    // wrong way
    this.wrongT = forwardSpeed > 3 && step < -0.05 && step > -40 ? this.wrongT + dt : Math.max(0, this.wrongT - dt * 2);
    if (this.wrongT > 1.5 && !this.wrongShown) { this.wrongShown = true; this.emit({ type: 'wrongway' }); }
    if (this.wrongT === 0) this.wrongShown = false;
    // start/finish line, forwards
    if (pd > this.L - 60 && d < 60) this.crossLine();
    else if (pd < 60 && d > this.L - 60) { this.sector = -1; }                // crossed backwards: this lap cannot count
    // sector lines
    for (let k = 0; k < 2; k++) if (this.sector === k && pd < this.bounds[k] && d >= this.bounds[k] && step < 40) this.closeSector(k);
  }
  timing() { return this.mode !== 'trial' || this.crossed; }
  closeSector(k) {
    const t = this.clock - this.sectorStart; this.sectorStart = this.clock; this.cur[k] = t; this.sector = k + 1;
    if (this.timing()) this.emit({ type: 'sector', k, t, color: this.colorFor(k, t) });
  }
  colorFor(k, t) {
    if (!this.valid) return 'invalid';
    const all = this.allTime.sectors[k];
    if (all === null || t < all) return 'purple';
    const sb = this.sessionBest[k];
    return sb === null || t < sb ? 'green' : 'yellow';
  }
  crossLine() {
    if (!this.crossed) {           // first crossing after the grid / pit exit: lap 1 timing starts here
      this.crossed = true; this.lap = 1; this.lapStart = this.clock; this.sectorStart = this.clock; this.sector = 0; this.valid = true; this.cur = [null, null, null];
      if (this.mode === 'trial') this.emit({ type: 'lapstart' });
      return;
    }
    if (this.sector !== 2) { this.sector = 0; this.lapStart = this.clock; this.sectorStart = this.clock; this.valid = true; this.emit({ type: 'nolap' }); return; }
    const t3 = this.clock - this.sectorStart; this.cur[2] = t3;
    const lapT = this.clock - this.lapStart, valid = this.valid;
    const colors = this.cur.map((t, k) => this.colorFor(k, t));
    this.emit({ type: 'sector', k: 2, t: t3, color: colors[2] });
    let pb = false;
    if (valid) {
      for (let k = 0; k < 3; k++) {
        if (this.sessionBest[k] === null || this.cur[k] < this.sessionBest[k]) this.sessionBest[k] = this.cur[k];
        if (this.allTime.sectors[k] === null || this.cur[k] < this.allTime.sectors[k]) this.allTime.sectors[k] = this.cur[k];
      }
      if (this.bestLap === null || lapT < this.bestLap) this.bestLap = lapT;
      if (this.allTime.lap === null || lapT < this.allTime.lap) { this.allTime.lap = lapT; pb = true; }
      store.set(this.key, this.allTime);
    }
    this.laptimes.push({ t: lapT, valid });
    this.lastLap = lapT; this.last = this.cur.slice(); this.cur = [null, null, null];
    this.emit({ type: 'lap', t: lapT, valid, pb, lap: this.lap });
    this.lapStart = this.clock; this.sectorStart = this.clock; this.sector = 0; this.valid = true;
    if (this.lap >= this.laps) { this.state = 'finished'; this.finishTime = this.clock; this.emit({ type: 'finish', t: this.clock }); }
    else { this.lap++; if (this.lap === this.laps) this.emit({ type: 'finallap' }); }
  }
  currentLapTime() { return this.state === 'racing' && this.timing() ? this.clock - this.lapStart : this.state === 'finished' ? this.lastLap : 0; }
}

export const fmt = t => { if (t === null || t === undefined || !isFinite(t)) return '-:--.---'; const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`; };
export const fmtS = t => t === null || t === undefined ? '-' : t.toFixed(3);
