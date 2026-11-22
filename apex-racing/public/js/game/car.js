// Vehicle physics (runs in the browser, fixed 240 Hz step). Rigid body + 4 raycast suspensions + tyre model
// (normalised combined slip, magic-formula shape, load sensitivity, surface grip), implicit wheel spin,
// engine torque curve, gearbox, limited-slip differential, brakes with bias, ABS / traction control,
// aero drag + downforce, barrier and ground collisions with proper impulses.
// Car frame: +z forward, +x LEFT, +y up; origin at the centre of mass.
import { ground, locate, halfWidth, pointAt, VERGE } from './trackcore.js';

export const DT = 1 / 240;
const G = 9.81, RHO = 1.225;

export const SPECS = {
  // GT class
  vanta:  { name: 'Vanta GT',    cls: 'gt',    mass: 1260, cgH: 0.37, wb: 2.64, trackW: 1.72, front: 0.45, R: 0.345, mu: 1.45, kappaPk: 0.10, alphaPk: 0.13,
    torque: [[1000, 300], [2500, 420], [4000, 520], [5500, 575], [6800, 560], [7800, 505], [8300, 470]], redline: 8200, idle: 1000,
    gears: [3.15, 2.25, 1.73, 1.40, 1.17, 1.00], final: 3.55, cdA: 0.74, clA: 1.9, aeroFront: 0.44, brakeT: 3400, brakeBias: 0.62,
    k: [82000, 76000], damp: [6200, 5600], arb: [42000, 30000], steerMax: 0.52, lsd: 180 },
  brenna: { name: 'Brenna GTS',  cls: 'gt',    mass: 1420, cgH: 0.38, wb: 2.75, trackW: 1.72, front: 0.52, R: 0.35, mu: 1.42, kappaPk: 0.11, alphaPk: 0.14,
    torque: [[1000, 380], [2000, 560], [3500, 680], [5000, 700], [6200, 640], [7000, 560], [7400, 500]], redline: 7200, idle: 900,
    gears: [2.95, 2.05, 1.55, 1.24, 1.03, 0.86], final: 3.3, cdA: 0.80, clA: 1.5, aeroFront: 0.42, brakeT: 3600, brakeBias: 0.6,
    k: [88000, 80000], damp: [6800, 6000], arb: [46000, 26000], steerMax: 0.5, lsd: 240 },
  // Hyper class
  aurex:  { name: 'Aurex X9',    cls: 'hyper', mass: 1180, cgH: 0.34, wb: 2.70, trackW: 1.76, front: 0.43, R: 0.355, mu: 1.56, kappaPk: 0.10, alphaPk: 0.12,
    torque: [[1000, 360], [2500, 520], [4500, 700], [6000, 760], [7500, 740], [8500, 680], [9100, 620]], redline: 9000, idle: 1100,
    gears: [3.3, 2.4, 1.86, 1.5, 1.25, 1.07, 0.94], final: 3.4, cdA: 0.82, clA: 3.4, aeroFront: 0.43, brakeT: 4200, brakeBias: 0.6,
    k: [110000, 100000], damp: [7400, 6800], arb: [52000, 38000], steerMax: 0.48, lsd: 210 },
  nyx:    { name: 'Nyx Spectre', cls: 'hyper', mass: 1050, cgH: 0.33, wb: 2.58, trackW: 1.72, front: 0.42, R: 0.35, mu: 1.54, kappaPk: 0.09, alphaPk: 0.11,
    torque: [[1000, 330], [3000, 520], [5000, 680], [6500, 720], [8000, 690], [9000, 640], [9600, 600]], redline: 9500, idle: 1200,
    gears: [3.4, 2.5, 1.92, 1.55, 1.29, 1.1, 0.96], final: 3.6, cdA: 0.76, clA: 2.8, aeroFront: 0.45, brakeT: 3900, brakeBias: 0.58,
    k: [100000, 92000], damp: [6600, 6200], arb: [40000, 34000], steerMax: 0.5, lsd: 150 },
};
// grip and rolling resistance per surface: asphalt, kerb, run-off grass, rough terrain
const GRIP = [1.0, 0.94, 0.62, 0.55], ROLL = [0.014, 0.02, 0.09, 0.13];

// ---- tiny quaternion / vector helpers (arrays) ----
const qRot = (q, v) => {      // rotate v by unit quaternion q = [x, y, z, w]: v + 2w(q x v) + 2 q x (q x v)
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]), ty = 2 * (q[2] * v[0] - q[0] * v[2]), tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [v[0] + q[3] * tx + (q[1] * tz - q[2] * ty), v[1] + q[3] * ty + (q[2] * tx - q[0] * tz), v[2] + q[3] * tz + (q[0] * ty - q[1] * tx)];
};
const qConj = q => [-q[0], -q[1], -q[2], q[3]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const qFromYaw = yaw => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerpCurve = (c, x) => { if (x <= c[0][0]) return c[0][1]; for (let i = 1; i < c.length; i++) if (x <= c[i][0]) { const [x0, y0] = c[i - 1], [x1, y1] = c[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); } return c[c.length - 1][1]; };

export class Car {
  constructor(specId, track) {
    this.specId = SPECS[specId] ? specId : 'vanta'; this.spec = SPECS[this.specId]; this.tr = track;
    const s = this.spec;
    this.halfL = 2.28; this.halfW = 0.98;
    const L = 4.5, W = 1.95, H = 1.05;
    this.Ib = [s.mass / 12 * (H * H + L * L) * 0.85, s.mass / 12 * (W * W + L * L) * 0.9, s.mass / 12 * (W * W + H * H) * 0.8];   // pitch, yaw, roll
    const zf = s.wb * (1 - s.front), zr = -s.wb * s.front, x = s.trackW / 2;
    this.rest = 0.26; this.travel = 0.17;
    const anchorY = -(s.cgH - s.R) + this.rest - 0.03;
    // wheel order: FL, FR, RL, RR
    this.wheels = [[x, zf, true], [-x, zf, true], [x, zr, false], [-x, zr, false]].map(([wx, wz, front]) => ({
      anchor: [wx, anchorY, wz], front, comp: 0, compPrev: 0, w: 0, spin: 0, load: 0, contact: false, kind: 0, slipX: 0, slipY: 0, steer: 0, hint: -1,
    }));
    this.assists = { abs: 1, tc: 1 };       // 0 off, 1 low, 2 full
    this.manual = false;
    this.reset(0, 0);
  }

  // place on the track at distance s, lateral u, facing along the track
  reset(s, u, heading = null) {
    const p = pointAt(this.tr, s, u), yaw = heading ?? p.heading, sp = this.spec;
    this.pos = [p.x, p.y + sp.cgH + 0.02, p.z]; this.vel = [0, 0, 0]; this.q = qFromYaw(yaw); this.av = [0, 0, 0];
    this.prevPos = this.pos.slice(); this.prevQ = this.q.slice();
    for (const w of this.wheels) { w.comp = w.compPrev = -1; w.w = 0; w.hint = p.i; }
    this.gear = 1; this.rpm = sp.idle; this.shiftT = 0; this.limiter = false; this.steer = 0; this.speed = 0;
    this.hint = p.i; this.tcCut = 1; this.upsideT = 0; this.offTrack = 0; this.hits = 0; this.lastHit = 0; this.revT = 0;
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  }

  local(v) { return qRot(this.q, v); }
  toLocal(v) { return qRot(qConj(this.q), v); }
  invI(vw) { const l = this.toLocal(vw); return this.local([l[0] / this.Ib[0], l[1] / this.Ib[1], l[2] / this.Ib[2]]); }
  pointVel(p) { const r = [p[0] - this.pos[0], p[1] - this.pos[1], p[2] - this.pos[2]], c = cross(this.av, r); return [this.vel[0] + c[0], this.vel[1] + c[1], this.vel[2] + c[2]]; }
  // impulse J at world point p
  impulse(p, J) {
    const m = this.spec.mass, r = [p[0] - this.pos[0], p[1] - this.pos[1], p[2] - this.pos[2]];
    for (let k = 0; k < 3; k++) this.vel[k] += J[k] / m;
    const dw = this.invI(cross(r, J)); for (let k = 0; k < 3; k++) this.av[k] += dw[k];
  }
  // collision impulse against a surface with normal n at point p (restitution e, friction mu)
  contactImpulse(p, n, e, mu) {
    const v = this.pointVel(p), vn = dot(v, n);
    if (vn >= 0) return 0;
    const r = [p[0] - this.pos[0], p[1] - this.pos[1], p[2] - this.pos[2]], rn = cross(r, n);
    const k = 1 / this.spec.mass + dot(cross(this.invI(rn), r), n);
    const j = -(1 + e) * vn / k;
    this.impulse(p, [n[0] * j, n[1] * j, n[2] * j]);
    const v2 = this.pointVel(p), vt = [v2[0] - n[0] * dot(v2, n), v2[1] - n[1] * dot(v2, n), v2[2] - n[2] * dot(v2, n)], vtl = Math.hypot(...vt);
    if (vtl > 1e-3) {
      const t = vt.map(c => c / vtl), rt = cross(r, t), kt = 1 / this.spec.mass + dot(cross(this.invI(rt), r), t);
      const jt = Math.min(vtl / kt, mu * j);
      this.impulse(p, [-t[0] * jt, -t[1] * jt, -t[2] * jt]);
    }
    return j;
  }

  engineTorque(rpm, throttle) {
    const s = this.spec;
    if (rpm >= s.redline) { this.limiter = true; return -30; }
    this.limiter = false;
    const t = lerpCurve(s.torque, rpm) * throttle;
    const brake = (1 - throttle) * (25 + rpm * 0.012);       // engine braking
    return t - brake;
  }

  step(dt = DT) {
    const s = this.spec, inp = this.input, tr = this.tr, m = s.mass;
    this.prevPos = this.pos.slice(); this.prevQ = this.q.slice();
    const up = this.local([0, 1, 0]), fwd = this.local([0, 0, 1]), left = this.local([1, 0, 0]);
    const vFwd = dot(this.vel, fwd); this.speed = vFwd;
    const F = [0, -G * m, 0], T = [0, 0, 0];
    const addForce = (f, p) => { F[0] += f[0]; F[1] += f[1]; F[2] += f[2]; const r = [p[0] - this.pos[0], p[1] - this.pos[1], p[2] - this.pos[2]], t = cross(r, f); T[0] += t[0]; T[1] += t[1]; T[2] += t[2]; };

    // steering: less lock at speed, smooth
    const lock = s.steerMax / (1 + Math.abs(vFwd) / 28);
    this.steer += clamp(inp.steer * lock - this.steer, -2.2 * dt * 2, 2.2 * dt * 2);

    // gearbox (auto unless manual), reverse when stopped and holding brake
    if (this.shiftT > 0) this.shiftT -= dt;
    const nG = s.gears.length;
    let throttle = inp.throttle, brake = inp.brake;
    if (this.gear === -1) { if (inp.throttle > 0.1 && vFwd > -0.5) this.gear = 1; else { throttle = inp.brake; brake = inp.throttle; } }
    else if (!this.manual && Math.abs(vFwd) < 0.8 && inp.brake > 0.3 && inp.throttle < 0.05) { this.revT += dt; if (this.revT > 0.35) { this.gear = -1; this.revT = 0; } }
    else this.revT = 0;
    const ratio = this.gear === -1 ? -3.0 : s.gears[Math.max(0, this.gear - 1)];
    const driven = [2, 3];                                   // rear-wheel drive
    const wheelW = (this.wheels[2].w + this.wheels[3].w) / 2;
    let rpm = Math.abs(wheelW * ratio * s.final) * 60 / (2 * Math.PI);
    // clutch slip at low speed: the engine can rev above the wheels
    const launch = s.idle + 3200 * throttle;
    const clutch = 1;                                       // a slipping clutch still passes the engine's torque
    rpm = Math.max(rpm, Math.min(launch, s.redline - 100), s.idle);
    this.rpm += (rpm - this.rpm) * Math.min(1, dt * 30);
    if (!this.manual && this.gear > 0 && this.shiftT <= 0) {
      if (this.rpm > s.redline - 250 && this.gear < nG) { this.gear++; this.shiftT = 0.11; }
      else if (this.gear > 1) {
        const lower = Math.abs(wheelW * s.gears[this.gear - 2] * s.final) * 60 / (2 * Math.PI);
        if (lower < s.redline - 1400 && (this.rpm < s.redline * 0.55 || (brake > 0.4 && lower < s.redline - 700))) { this.gear--; this.shiftT = 0.09; this.downshift = true; }
      }
    }
    // traction control trims the throttle when the rear wheels spin up
    // traction control watches the rear tyres' combined slip (spin + sideways), 1 = at the grip peak
    const rearSlip = Math.max(this.wheels[2].sl || 0, this.wheels[3].sl || 0);
    if (this.assists.tc) {
      const thr = this.assists.tc === 2 ? 0.85 : 0.98;
      const target = rearSlip > thr ? Math.max(0.05, 1 - (rearSlip - thr) * (this.assists.tc === 2 ? 3 : 2)) : 1;
      this.tcCut += (target - this.tcCut) * Math.min(1, dt * (target < this.tcCut ? 60 : 6));
      throttle *= this.tcCut;
    } else this.tcCut = 1;
    let engT = this.shiftT > 0 ? 0 : this.engineTorque(this.rpm, throttle);
    if (this.gear === 0) engT = 0;
    const wheelRpm = Math.abs(wheelW * ratio * s.final) * 60 / (2 * Math.PI);
    if (throttle < 0.05 && wheelRpm < s.idle * 1.2) engT = 0;            // clutch open when rolling slowly off throttle
    const driveT = engT * ratio * s.final * 0.9 * clutch;
    // limited-slip differential: equal split + a locking torque against the speed difference
    const lock2 = clamp((this.wheels[2].w - this.wheels[3].w) * s.lsd, -Math.abs(driveT) * 0.4 - 150, Math.abs(driveT) * 0.4 + 150);

    for (let k = 0; k < 4; k++) {
      const w = this.wheels[k];
      const a = this.local(w.anchor), aw = [this.pos[0] + a[0], this.pos[1] + a[1], this.pos[2] + a[2]];
      const g = ground(tr, aw[0], aw[2], w.hint); w.hint = g.i; w.kind = g.kind;
      const n = [g.nx, g.ny, g.nz], down = [-up[0], -up[1], -up[2]];
      const denom = dot(n, down);
      const reach = this.rest + s.R;
      let t = denom < -0.2 ? (dot(n, [aw[0], g.y, aw[2]]) - dot(n, aw)) / denom : Infinity;
      w.compPrev = w.comp;
      if (!(t < reach)) { w.contact = false; w.comp = w.compPrev < 0 ? -1 : 0; w.load = 0; w.slipX = w.slipY = w.sl = 0; w.w *= 0.999; continue; }
      t = Math.max(t, 0);
      w.contact = true;
      w.comp = Math.min(reach - t, this.travel + 0.05);
      if (w.compPrev < 0) w.compPrev = w.comp;                        // first contact after a reset: no damper kick
      // damper speed from the mount point's motion relative to the ground plane (no finite-difference noise)
      const va = this.pointVel(aw), axle = w.front ? 0 : 1, cv = dot(va, n) / denom;
      let Fs = s.k[axle] * w.comp + s.damp[axle] * cv * (cv > 0 ? 1 : 1.4);
      if (w.comp > this.travel) Fs += (w.comp - this.travel) * 400000;          // bump stop
      // anti-roll bar
      const other = this.wheels[k ^ 1];
      Fs += s.arb[axle] * (w.comp - other.comp);
      Fs = Math.max(0, Fs);
      w.load = Fs;
      const cp = [aw[0] + down[0] * t, aw[1] + down[1] * t, aw[2] + down[2] * t];
      addForce([up[0] * Fs, up[1] * Fs, up[2] * Fs], cp);

      // wheel frame on the ground
      w.steer = w.front ? this.steer : 0;
      const wf0 = this.local([Math.sin(w.steer), 0, Math.cos(w.steer)]);
      let wf = [wf0[0] - n[0] * dot(wf0, n), wf0[1] - n[1] * dot(wf0, n), wf0[2] - n[2] * dot(wf0, n)]; const wl = Math.hypot(...wf); wf = wf.map(c => c / wl);
      const ws = cross(n, wf);
      const vp = this.pointVel(cp), vx = dot(vp, wf), vy = dot(vp, ws);
      // tyre: normalised combined slip through a magic-formula shaped curve
      const Fz0 = m * G / 4, mu = s.mu * GRIP[g.kind] * (w.front ? 1 : 1.10) * (1 - 0.07 * (Fs / Fz0 - 1));
      const D = Math.max(0, mu * Fs), vref = Math.max(Math.abs(vx), 4);
      let Tw = 0, Tb = 0;
      if (driven.includes(k)) Tw = driveT / 2 + (k === 2 ? -lock2 : lock2);
      Tb = brake * s.brakeT * (w.front ? s.brakeBias : 1 - s.brakeBias) * 2;
      if (!w.front && inp.handbrake) Tb += inp.handbrake * 2600;
      const Iw = 1.3;
      const slips = ww => { const kx = (ww * s.R - vx) / vref, ay = Math.atan2(vy, vref); return [kx, ay]; };
      let [kx, ay] = slips(w.w);
      // ABS: let off the brake on a wheel that starts to lock
      if (this.assists.abs && Tb > 0) {       // ABS: brake torque capped near what the tyre can take, eased off if it locks anyway
        Tb = Math.min(Tb, s.R * D * (this.assists.abs === 2 ? 0.98 : 1.08) + 60);
        if (kx < -s.kappaPk * (this.assists.abs === 2 ? 1.3 : 1.8)) Tb *= 0.6;
      }
      const sx = kx / s.kappaPk, sy = ay / s.alphaPk, sl = Math.hypot(sx, sy);
      const fmag = sl > 1e-6 ? Math.sin(1.5 * Math.atan(1.732 * sl)) : 0;
      let Fx = sl > 1e-6 ? D * fmag * sx / sl : 0, Fy = sl > 1e-6 ? -D * fmag * sy / sl : 0;
      // implicit wheel spin (stable at any speed): linearise Fx around the current spin rate
      const Gk = D * 2.6 / s.kappaPk * s.R / vref * (sl < 1 ? 1 - 0.85 * sl : 0.15);
      const denomW = Iw + dt * s.R * Gk;
      let w1 = w.w + dt * (Tw - s.R * Fx) / denomW;
      const db = dt * Tb / denomW;
      if (Math.abs(w1) <= db) w1 = 0; else w1 -= Math.sign(w1) * db;
      Fx += Gk * (w1 - w.w);
      const fl = Math.hypot(Fx / (D || 1), Fy / (D || 1));
      if (fl > 1) { Fx /= fl; Fy /= fl; }
      w.w = w1; w.spin += w.w * dt;
      w.slipX = Math.abs(kx); w.slipY = Math.abs(ay); w.sl = sl; w.slide = Math.max(0, sl - 0.9);
      // rolling resistance
      const rr = ROLL[g.kind] * Fs * Math.tanh(vx * 2);
      addForce([wf[0] * (Fx - rr) + ws[0] * Fy, wf[1] * (Fx - rr) + ws[1] * Fy, wf[2] * (Fx - rr) + ws[2] * Fy], cp);
    }
    // aero: drag along the velocity, downforce split front/rear
    const sp2 = dot(this.vel, this.vel), spd = Math.sqrt(sp2);
    if (spd > 0.1) { const d = 0.5 * RHO * s.cdA * spd; addForce([-this.vel[0] * d, -this.vel[1] * d, -this.vel[2] * d], this.pos); }
    const df = 0.5 * RHO * s.clA * vFwd * vFwd;
    const fA = this.local([0, -0.1, s.wb * (1 - s.front)]), rA = this.local([0, -0.1, -s.wb * s.front]);
    addForce([-up[0] * df * s.aeroFront, -up[1] * df * s.aeroFront, -up[2] * df * s.aeroFront], [this.pos[0] + fA[0], this.pos[1] + fA[1], this.pos[2] + fA[2]]);
    addForce([-up[0] * df * (1 - s.aeroFront), -up[1] * df * (1 - s.aeroFront), -up[2] * df * (1 - s.aeroFront)], [this.pos[0] + rA[0], this.pos[1] + rA[1], this.pos[2] + rA[2]]);

    // stability assist (with TC on): damp only the yaw rate beyond what the steering asks for (oversteer)
    if (this.assists.tc && Math.abs(vFwd) > 6) {
      const rDes = vFwd * Math.tan(this.steer) / s.wb, r = dot(this.av, up), ex = r - rDes;
      if (Math.sign(ex) === Math.sign(r) && Math.abs(r) > Math.abs(rDes)) {
        const tq = -clamp(ex * (this.assists.tc === 2 ? 7000 : 4500), -6000, 6000);
        T[0] += up[0] * tq; T[1] += up[1] * tq; T[2] += up[2] * tq;
      }
    }
    // integrate (semi-implicit Euler)
    for (let k = 0; k < 3; k++) this.vel[k] += F[k] / m * dt;
    const dw = this.invI(T); for (let k = 0; k < 3; k++) this.av[k] += dw[k] * dt;
    for (let k = 0; k < 3; k++) this.av[k] *= 0.9995;
    for (let k = 0; k < 3; k++) this.pos[k] += this.vel[k] * dt;
    const [ax, ay2, az] = this.av, q = this.q;
    const dq = [ax * q[3] + ay2 * q[2] - az * q[1], ay2 * q[3] + az * q[0] - ax * q[2], az * q[3] + ax * q[1] - ay2 * q[0], -ax * q[0] - ay2 * q[1] - az * q[2]];
    for (let k = 0; k < 4; k++) q[k] += 0.5 * dq[k] * dt;
    const ql = Math.hypot(...q); for (let k = 0; k < 4; k++) q[k] /= ql;

    this.collide();
  }

  // barriers (armco along both sides) + body vs ground (if the car rolls)
  collide() {
    const tr = this.tr, pts = [[this.halfW, -0.15, this.halfL], [-this.halfW, -0.15, this.halfL], [this.halfW, -0.15, -this.halfL], [-this.halfW, -0.15, -this.halfL], [0, -0.15, this.halfL + 0.05], [0, -0.15, -this.halfL - 0.05]];
    const q0 = locate(tr, this.pos[0], this.pos[2], this.hint); this.hint = q0.i;
    const near = Math.abs(q0.u) > halfWidth(tr, q0.i, q0.t) + VERGE - 3.2;        // only check corners near a barrier
    for (const lp of near ? pts : []) {
      const p = this.local(lp); p[0] += this.pos[0]; p[1] += this.pos[1]; p[2] += this.pos[2];
      const q = locate(tr, p[0], p[2], this.hint), lim = halfWidth(tr, q.i, q.t) + VERGE + 0.3;
      if (Math.abs(q.u) > lim) {
        const sgn = Math.sign(q.u), j = tr.wrap(q.i + 1), lx = tr.Lh[q.i * 2] * (1 - q.t) + tr.Lh[j * 2] * q.t, lz = tr.Lh[q.i * 2 + 1] * (1 - q.t) + tr.Lh[j * 2 + 1] * q.t;
        const n = [-sgn * lx, 0, -sgn * lz], depth = Math.abs(q.u) - lim;
        this.pos[0] += n[0] * depth; this.pos[2] += n[2] * depth;
        const jn = this.contactImpulse(p, n, 0.25, 0.35);
        if (jn > 1500) { this.hits++; this.lastHit = jn; }
      }
    }
    // body corners vs ground: the car can roll over and land without falling through the world
    const upY = this.local([0, 1, 0])[1];
    if (upY > 0.85 && this.wheels.every(w => w.contact)) return;                  // upright on four wheels: body can't touch
    const corners = [[0.95, -0.32, 2.2], [-0.95, -0.32, 2.2], [0.95, -0.32, -2.2], [-0.95, -0.32, -2.2], [0.85, 0.6, 0.3], [-0.85, 0.6, 0.3], [0.85, 0.5, -1.2], [-0.85, 0.5, -1.2]];
    for (const lp of corners) {
      const p = this.local(lp); p[0] += this.pos[0]; p[1] += this.pos[1]; p[2] += this.pos[2];
      const g = ground(tr, p[0], p[2], this.hint);
      if (p[1] < g.y) {
        const n = [g.nx, g.ny, g.nz];
        this.pos[1] += (g.y - p[1]) * g.ny;
        this.contactImpulse(p, n, 0.1, 0.6);
      }
    }
  }

  // called once per frame with the frame time; returns true if the car should be reset (upside down / stuck)
  watch(dt) {
    const up = this.local([0, 1, 0]);
    this.upsideT = up[1] < 0.3 ? this.upsideT + dt : 0;
    return this.upsideT > 2.5;
  }
  shift(d) { const n = this.spec.gears.length; if (this.shiftT > 0) return; const g = clamp(this.gear + d, -1, n); if (g !== this.gear && g !== 0) { this.gear = g; this.shiftT = 0.08; this.manual = true; } }

  // interpolated pose for rendering
  pose(alpha) {
    const p = this.prevPos.map((v, k) => v + (this.pos[k] - v) * alpha), a = this.prevQ, b = this.q;
    const sgn = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
    const q = [0, 1, 2, 3].map(k => a[k] + (b[k] * sgn - a[k]) * alpha), ql = Math.hypot(...q);
    return { pos: p, q: q.map(v => v / ql) };
  }
}

// rotation matrix (column-major 4x4) from pose
export function poseMatrix(pos, q, out = new Float32Array(16)) {
  const [x, y, z, w] = q;
  out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y + z * w); out[2] = 2 * (x * z - y * w); out[3] = 0;
  out[4] = 2 * (x * y - z * w); out[5] = 1 - 2 * (x * x + z * z); out[6] = 2 * (y * z + x * w); out[7] = 0;
  out[8] = 2 * (x * z + y * w); out[9] = 2 * (y * z - x * w); out[10] = 1 - 2 * (x * x + y * y); out[11] = 0;
  out[12] = pos[0]; out[13] = pos[1]; out[14] = pos[2]; out[15] = 1;
  return out;
}
