// Simple driver used for the title-screen attract lap and the physics tests (phase 5 grows it into the AI):
// steers at a point ahead on the racing line, and picks a speed from the curvature ahead and braking distance.
import { locate, pointAt } from './trackcore.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Autopilot {
  constructor(car, tr, opts = {}) {
    this.car = car; this.tr = tr; this.hint = -1;
    this.grip = opts.grip ?? 1.0;          // < 1 drives more carefully
    this.lineK = opts.line ?? 0.85;        // how much of the racing line offset to use
    this.lat = opts.lateral ?? 0;          // extra lateral offset (lanes for multiple cars)
    this.vPrevErr = 0;
  }
  // max speed the car can take a corner of curvature k at (with downforce helping a bit)
  cornerSpeed(k) { const s = this.car.spec, mu = s.mu * 0.8 * this.grip; const kk = Math.max(Math.abs(k), 1e-4); return Math.sqrt(mu * 9.81 / Math.max(kk - mu * 0.5 * 1.225 * s.clA / s.mass, kk * 0.35)); }
  update() {
    const c = this.car, tr = this.tr, q = locate(tr, c.pos[0], c.pos[2], this.hint); this.hint = q.i;
    const v = Math.max(0, c.speed);
    // steering target ahead on the line
    const look = 7 + v * 0.55, s1 = q.s + look, i1 = Math.floor(s1 / tr.ds) % tr.n;
    const tgt = pointAt(tr, s1, tr.line[i1] * this.lineK + this.lat);
    const fwd = c.local([0, 0, 1]), left = c.local([1, 0, 0]);
    const dx = tgt.x - c.pos[0], dz = tgt.z - c.pos[2];
    // pure pursuit: the arc through the target point -> wheel angle -> input (using the car's current steering lock)
    const ang = Math.atan2(dx * left[0] + dz * left[2], dx * fwd[0] + dz * fwd[2]), Ld = Math.hypot(dx, dz);
    const kappa = 2 * Math.sin(ang) / Math.max(Ld, 1), delta = Math.atan(kappa * c.spec.wb);
    const lock = c.spec.steerMax / (1 + v / 28);
    const yawErr = c.av[1] - v * kappa;                       // turning faster than the arc wants -> steer less
    let steer = clamp((delta - yawErr * 0.04) / lock, -1, 1);
    // speed: the slowest of (corner speed at d ahead, plus what we can still brake away before it)
    const brakeA = 9.81 * c.spec.mu * 0.75 * this.grip;
    let vt = 95;
    for (let d = 0; d < 260; d += 6) {
      const i = Math.floor((q.s + d) / tr.ds) % tr.n, vc = this.cornerSpeed(tr.curvS[i]);
      vt = Math.min(vt, Math.sqrt(vc * vc + 2 * brakeA * d));
    }
    const err = vt - v;
    let throttle = clamp(err * 0.35 + 0.15, 0, 1), brake = clamp(-err * 0.25, 0, 1);
    if (err < -1.5) throttle = 0;
    throttle = Math.min(throttle, 1 - Math.min(0.75, Math.abs(steer) * 1.1));     // feed the power in as the wheel straightens
    const rs = Math.max(c.wheels[2].sl || 0, c.wheels[3].sl || 0); if (rs > 0.8) throttle *= clamp(1 - (rs - 0.8) * 4, 0.2, 1);
    c.input.steer = steer; c.input.throttle = throttle; c.input.brake = brake; c.input.handbrake = 0;
    return { q, vt };
  }
}
