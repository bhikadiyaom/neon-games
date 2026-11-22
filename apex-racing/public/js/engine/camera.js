// Camera: reverse-Z infinite perspective, keeps last frame's matrices (for motion vectors / TAA later).
import { perspectiveRevZ, lookAt, mul, invert, sub, norm } from './math.js';

export class Camera {
  constructor() {
    this.pos = [0, 2, -10]; this.target = [0, 1, 0]; this.up = [0, 1, 0];
    this.fov = 55 * Math.PI / 180; this.near = 0.1; this.aspect = 16 / 9;
    this.jitter = [0, 0];
    this.view = new Float32Array(16); this.proj = new Float32Array(16);
    this.viewProj = new Float32Array(16); this.invViewProj = new Float32Array(16); this.prevViewProj = new Float32Array(16);
    this.first = true;
  }
  update(width, height) {
    this.aspect = width / Math.max(1, height);
    this.prevViewProj.set(this.viewProj);
    lookAt(this.pos, this.target, this.up, this.view);
    perspectiveRevZ(this.fov, this.aspect, this.near, this.jitter[0], this.jitter[1], this.proj);
    mul(this.proj, this.view, this.viewProj);
    invert(this.viewProj, this.invViewProj);
    if (this.first) { this.prevViewProj.set(this.viewProj); this.first = false; }
  }
  forward() { return norm(sub(this.target, this.pos)); }
}
