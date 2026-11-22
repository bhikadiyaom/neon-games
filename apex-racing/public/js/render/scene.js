// Scene building: collects static instances, groups them by (mesh, 160 m cell, casts-shadow) so each group is
// one instanced draw with a bounding sphere for frustum culling, and reserves room for per-frame (dynamic)
// instances such as cars and start lights.
import { MeshPool } from './meshes.js';
export const INST_FLOATS = 28;    // mat4 + base(4) + pbr(4) + emit(4)

export const mat = (r, g, b, metal = 0, rough = 0.5, coat = 0, kind = 0) => ({ base: [r, g, b, 1], pbr: [metal, rough, coat, kind] });
export const KIND = { STD: 0, TRACK: 1, TERRAIN: 2, CROWD: 3, FOLIAGE: 4 };

export class SceneBuilder {
  constructor() { this.pool = new MeshPool(); this.items = []; this.cell = 320; }
  mesh(name, mb) { return this.pool.has(name) ? this.pool.get(name) : this.pool.add(name, mb); }
  // opts: { shadow: true, emit: [r,g,b,strength], group: string (own draw, e.g. a terrain tile) }
  add(meshName, model, m, opts = {}) {
    this.items.push({ mesh: meshName, model, base: m.base, pbr: m.pbr, emit: opts.emit || [0, 0, 0, 0], shadow: opts.shadow !== false, group: opts.group || null });
  }
  build(gpu, dynamicCapacity = 1024) {
    const pool = this.pool, cs = this.cell;
    for (const it of this.items) {
      const m = it.model, mesh = pool.get(it.mesh);
      if (!mesh) throw new Error('unknown mesh ' + it.mesh);
      const c = mesh.center, sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
      it.wc = [m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12], m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13], m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14]];
      it.wr = mesh.radius * Math.max(sx, sy, sz);
      it.key = it.mesh + '|' + (it.group || (Math.floor(it.wc[0] / cs) + ',' + Math.floor(it.wc[2] / cs))) + '|' + (it.shadow ? 1 : 0);
    }
    this.items.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const n = this.items.length, data = new Float32Array((n + dynamicCapacity) * INST_FLOATS), draws = [];
    this.items.forEach((it, i) => {
      const o = i * INST_FLOATS;
      data.set(it.model, o); data.set(it.base, o + 16); data.set(it.pbr, o + 20); data.set(it.emit, o + 24);
      const last = draws[draws.length - 1];
      if (last && last.key === it.key) { last.count++; last.members.push(it); }
      else draws.push({ key: it.key, mesh: pool.get(it.mesh), first: i, count: 1, shadow: it.shadow, members: [it] });
    });
    for (const d of draws) {         // bounding sphere of the whole group
      let cx = 0, cy = 0, cz = 0; for (const it of d.members) { cx += it.wc[0]; cy += it.wc[1]; cz += it.wc[2]; }
      cx /= d.count; cy /= d.count; cz /= d.count;
      let r = 0; for (const it of d.members) r = Math.max(r, Math.hypot(it.wc[0] - cx, it.wc[1] - cy, it.wc[2] - cz) + it.wr);
      d.center = [cx, cy, cz]; d.radius = r; delete d.members;
    }
    pool.upload(gpu);
    const instBuf = gpu.bufferWith(data, GPUBufferUsage.STORAGE, 'instances');
    let tris = 0; for (const d of draws) tris += d.mesh.indexCount / 3 * d.count;
    return { pool, instBuf, draws, dynBase: n, dynCap: dynamicCapacity, instances: n, staticTris: Math.round(tris) };
  }
}

// 6 frustum planes from a view-projection matrix (WebGPU clip space, z in [0, 1]); works for reverse-Z too
export function frustumPlanes(m, out = []) {
  const row = r => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const P = [r3.map((v, i) => v + r0[i]), r3.map((v, i) => v - r0[i]), r3.map((v, i) => v + r1[i]), r3.map((v, i) => v - r1[i]), r2, r3.map((v, i) => v - r2[i])];
  for (let k = 0; k < 6; k++) { const p = P[k], l = Math.hypot(p[0], p[1], p[2]) || 1; out[k] = [p[0] / l, p[1] / l, p[2] / l, p[3] / l]; }
  return out;
}
export function sphereVisible(planes, c, r) {
  for (const p of planes) if (p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] < -r) return false;
  return true;
}
