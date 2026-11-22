// Camera rig: chase (default), far chase, bonnet, roof. Speed widens the field of view and adds a little lag.
import { ground } from './trackcore.js';
export const CAMERAS = ['Chase', 'Far chase', 'Bonnet', 'Roof'];

export class CameraRig {
  constructor(cam, tr) { this.cam = cam; this.tr = tr; this.mode = 0; this.pos = null; this.look = null; this.shakeT = 0; }
  next() { this.mode = (this.mode + 1) % CAMERAS.length; this.pos = null; }
  // pose = { pos, q } (interpolated), car = Car, dt in seconds
  update(car, pose, dt, opts = {}) {
    const cam = this.cam, q = pose.q, p = pose.pos;
    const rot = v => { const [x, y, z, w] = q, tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]); return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)]; };
    const fwd = rot([0, 0, 1]), up = rot([0, 1, 0]);
    const v = Math.max(0, car.speed), kmh = v * 3.6;
    const back = opts.lookBack ? -1 : 1;
    let fh = Math.hypot(fwd[0], fwd[2]) || 1; const ff = [fwd[0] / fh, 0, fwd[2] / fh];
    const mode = this.mode;
    if (mode <= 1) {
      // chase: sits behind and above, follows the car's heading with a short lag (velocity direction when sliding)
      const dist = (mode === 0 ? 5.4 : 8.6) + v * 0.012, h = mode === 0 ? 1.55 : 2.5;
      const want = [p[0] - ff[0] * dist * back, p[1] + h, p[2] - ff[2] * dist * back];
      if (!this.pos) this.pos = want.slice();
      const k = 1 - Math.exp(-dt * (opts.reduced ? 6 : 9)), kv = 1 - Math.exp(-dt * 4);
      for (let i = 0; i < 3; i++) this.pos[i] += (want[i] - this.pos[i]) * (i === 1 ? kv : k);
      // keep the camera at a fixed distance (the lag only swings it around) and above the ground
      const dx = this.pos[0] - p[0], dz = this.pos[2] - p[2], dl = Math.hypot(dx, dz) || 1;
      this.pos[0] = p[0] + dx / dl * dist; this.pos[2] = p[2] + dz / dl * dist;
      const g = ground(this.tr, this.pos[0], this.pos[2], car.hint);
      this.pos[1] = Math.max(this.pos[1], g.y + 0.6);
      cam.pos = this.pos.slice();
      cam.target = [p[0] + ff[0] * 3 * back, p[1] + (mode === 0 ? 0.75 : 0.9), p[2] + ff[2] * 3 * back];
      cam.up = [0, 1, 0];
      cam.fov = (58 + Math.min(14, kmh * 0.05)) * Math.PI / 180;
    } else {
      const off = mode === 2 ? [0, 0.42, 1.0] : [0, 0.98, -0.25];
      const o = rot(off);
      cam.pos = [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
      cam.target = [cam.pos[0] + fwd[0] * 10 * back, cam.pos[1] + fwd[1] * 10 + 0.0, cam.pos[2] + fwd[2] * 10 * back];
      cam.up = up;
      cam.fov = (66 + Math.min(10, kmh * 0.035)) * Math.PI / 180;
      this.pos = null;
    }
    // a touch of high-speed / kerb shake
    if (!opts.reduced && opts.shake) {
      this.shakeT += dt;
      const kerb = car.wheels.some(w => w.kind === 1) ? 1 : 0, amp = (Math.max(0, kmh - 150) / 3000 + kerb * 0.012) * opts.shake;
      cam.pos[1] += Math.sin(this.shakeT * 53) * amp; cam.pos[0] += Math.sin(this.shakeT * 37) * amp * 0.6;
    }
  }
}
