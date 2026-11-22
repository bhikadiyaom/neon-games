// Procedural meshes. Vertex = position(3) normal(3) uv(2) floats. All meshes share one vertex and one index
// buffer (MeshPool), so a draw is just an index range.
export class MeshBuilder {
  constructor() { this.v = []; this.i = []; }
  vert(p, n, uv) { this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1]); return this.v.length / 8 - 1; }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  // Make every triangle face the way its vertex normals point (counter-clockwise = front), whatever order it was built in.
  orient() {
    const V = this.v, I = this.i;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 8, b = I[k + 1] * 8, c = I[k + 2] * 8;
      const e1 = [V[b] - V[a], V[b + 1] - V[a + 1], V[b + 2] - V[a + 2]], e2 = [V[c] - V[a], V[c + 1] - V[a + 1], V[c + 2] - V[a + 2]];
      const gn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const vn = [V[a + 3] + V[b + 3] + V[c + 3], V[a + 4] + V[b + 4] + V[c + 4], V[a + 5] + V[b + 5] + V[c + 5]];
      if (gn[0] * vn[0] + gn[1] * vn[1] + gn[2] * vn[2] < 0) { const t = I[k + 1]; I[k + 1] = I[k + 2]; I[k + 2] = t; }
    }
    return this;
  }
}

export function plane(size, seg = 1) {
  const m = new MeshBuilder(), h = size / 2;
  for (let z = 0; z <= seg; z++) for (let x = 0; x <= seg; x++) m.vert([-h + size * x / seg, 0, -h + size * z / seg], [0, 1, 0], [x / seg, z / seg]);
  for (let z = 0; z < seg; z++) for (let x = 0; x < seg; x++) { const a = z * (seg + 1) + x; m.quad(a, a + 1, a + seg + 2, a + seg + 1); }
  return m.orient();
}
// unit cube from -0.5 to 0.5
export function box() {
  const m = new MeshBuilder();
  const faces = [[[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];
  for (const [n, u, v] of faces) {
    const c = n.map(x => x * 0.5), p = (su, sv) => [c[0] + (u[0] * su + v[0] * sv) * 0.5, c[1] + (u[1] * su + v[1] * sv) * 0.5, c[2] + (u[2] * su + v[2] * sv) * 0.5];
    const a = m.vert(p(-1, -1), n, [0, 1]), b = m.vert(p(1, -1), n, [1, 1]), cc = m.vert(p(1, 1), n, [1, 0]), d = m.vert(p(-1, 1), n, [0, 0]);
    m.quad(a, b, cc, d);
  }
  return m.orient();
}
export function sphere(lat = 24, lon = 48) {
  const m = new MeshBuilder();
  for (let y = 0; y <= lat; y++) {
    const th = y / lat * Math.PI;
    for (let x = 0; x <= lon; x++) {
      const ph = x / lon * Math.PI * 2, n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      m.vert(n.map(v => v * 0.5), n, [x / lon, y / lat]);
    }
  }
  for (let y = 0; y < lat; y++) for (let x = 0; x < lon; x++) { const a = y * (lon + 1) + x; m.quad(a, a + lon + 1, a + lon + 2, a + 1); }
  return m.orient();
}
// cylinder along Y, radius 0.5, height 1, centred
export function cylinder(seg = 32) {
  const m = new MeshBuilder();
  for (let i = 0; i <= seg; i++) {
    const a = i / seg * Math.PI * 2, n = [Math.cos(a), 0, Math.sin(a)];
    m.vert([n[0] * 0.5, -0.5, n[2] * 0.5], n, [i / seg, 1]); m.vert([n[0] * 0.5, 0.5, n[2] * 0.5], n, [i / seg, 0]);
  }
  for (let i = 0; i < seg; i++) m.quad(i * 2, i * 2 + 2, i * 2 + 3, i * 2 + 1);
  for (const s of [-1, 1]) {
    const c = m.vert([0, s * 0.5, 0], [0, s, 0], [0.5, 0.5]), first = m.v.length / 8;
    for (let i = 0; i <= seg; i++) { const a = i / seg * Math.PI * 2; m.vert([Math.cos(a) * 0.5, s * 0.5, Math.sin(a) * 0.5], [0, s, 0], [0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5]); }
    for (let i = 0; i < seg; i++) m.tri(c, first + i, first + i + 1);
  }
  return m.orient();
}

export class MeshPool {
  constructor() { this.meshes = new Map(); this.v = []; this.i = []; }
  add(name, mb) {
    const baseVertex = this.v.length / 8, firstIndex = this.i.length;
    for (const x of mb.v) this.v.push(x);
    for (const x of mb.i) this.i.push(x);
    // local bounding sphere (for culling)
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < mb.v.length; k += 8) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], mb.v[k + a]); hi[a] = Math.max(hi[a], mb.v[k + a]); }
    const center = [0, 1, 2].map(a => (lo[a] + hi[a]) / 2);
    let radius = 0; for (let k = 0; k < mb.v.length; k += 8) radius = Math.max(radius, Math.hypot(mb.v[k] - center[0], mb.v[k + 1] - center[1], mb.v[k + 2] - center[2]));
    const mesh = { name, firstIndex, indexCount: mb.i.length, baseVertex, center, radius };
    this.meshes.set(name, mesh); return mesh;
  }
  has(name) { return this.meshes.has(name); }
  upload(gpu) {
    this.vbuf = gpu.bufferWith(new Float32Array(this.v), GPUBufferUsage.VERTEX, 'mesh-vertices');
    this.ibuf = gpu.bufferWith(new Uint32Array(this.i), GPUBufferUsage.INDEX, 'mesh-indices');
    this.v = this.i = null;
  }
  get(name) { return this.meshes.get(name); }
}
