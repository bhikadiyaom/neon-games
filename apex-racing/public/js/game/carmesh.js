// Procedural GT car (phase 2 version; phase 3 replaces it with the full hero model). Car frame: +z forward,
// +x left, +y up, origin at the centre of mass. Parts are split by material so every car is a handful of
// instanced draws: paint, carbon, glass, dark trim, tail lights, head lights, tyre, rim, brake disc.
import { MeshBuilder, box, cylinder } from '../render/meshes.js';
import { mat } from '../render/scene.js';
import { mul, trs } from '../engine/math.js';
import { poseMatrix } from './car.js';

const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const interp = (tbl, z) => { for (let i = 1; i < tbl.length; i++) if (z <= tbl[i][0]) { const [z0, a] = tbl[i - 1], [z1, b] = tbl[i], t = (z - z0) / (z1 - z0), s = t * t * (3 - 2 * t); return a.map((v, k) => v + (b[k] - v) * s); } return tbl[tbl.length - 1][1]; };

// Loft a closed-bottom shape through cross-sections. ring(z) returns half-section points from bottom centre
// to top centre (x >= 0); the other half is mirrored.
function loft(zs, ring, yOff = 0) {
  const m = new MeshBuilder(), rows = zs.map(z => { const half = ring(z); return [...half.map(p => [p[0], p[1]]), ...half.slice(0, -1).reverse().map(p => [-p[0], p[1]])].map(p => [p[0], p[1] + yOff, z]); });
  const R = rows.length, C = rows[0].length;
  // smooth normals from the grid (central differences)
  const P = (r, c) => rows[Math.max(0, Math.min(R - 1, r))][((c % C) + C) % C];
  // normals = (along the ring) x (along the length); one global sign so the roof faces up
  const N = rows.map((row, r) => row.map((p, c) => {
    const a = P(r, c + 1), b = P(r, c - 1), f = P(r + 1, c), g = P(r - 1, c);
    const du = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dv = [f[0] - g[0], f[1] - g[1], f[2] - g[2]];
    return [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]];
  }));
  const mid = Math.floor(R / 2), top = rows[mid].reduce((bi, p, c, arr) => p[1] > arr[bi][1] ? c : bi, 0);
  const sgn = N[mid][top][1] < 0 ? -1 : 1;
  const idx = rows.map((row, r) => row.map((p, c) => { const n = N[r][c], l = Math.hypot(...n) || 1; return m.vert(p, n.map(v => sgn * v / l), [c / C, r / R]); }));
  for (let r = 0; r < R - 1; r++) for (let c = 0; c < C - 1; c++) m.quad(idx[r][c], idx[r][c + 1], idx[r + 1][c + 1], idx[r + 1][c]);
  // end caps
  for (const r of [0, R - 1]) { const ctr = m.vert([0, rows[r].reduce((s, p) => s + p[1], 0) / C, rows[r][0][2]], [0, 0, r ? 1 : -1], [0.5, 0.5]); for (let c = 0; c < C - 1; c++) m.tri(ctr, idx[r][c], idx[r][c + 1]); }
  return m.orient();
}
function merge(target, src, model) {
  const base = target.v.length / 8, M = model;
  for (let k = 0; k < src.v.length; k += 8) {
    const x = src.v[k], y = src.v[k + 1], z = src.v[k + 2], nx = src.v[k + 3], ny = src.v[k + 4], nz = src.v[k + 5];
    const p = [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]];
    let n = [M[0] * nx + M[4] * ny + M[8] * nz, M[1] * nx + M[5] * ny + M[9] * nz, M[2] * nx + M[6] * ny + M[10] * nz]; const l = Math.hypot(...n) || 1; n = n.map(v => v / l);
    target.vert(p, n, [src.v[k + 6], src.v[k + 7]]);
  }
  for (const i of src.i) target.i.push(base + i);
  return target;
}

export function buildCarMeshes(S, id, spec) {
  if (S.pool.has('carPaint_' + id)) return;
  const B = box(), Cy = cylinder(24);
  // body: [z, [half width upper, bottom y, shoulder y, top y]]; wheel arches are cut from the real axle positions
  const sec = [
    [-2.32, [0.80, -0.20, 0.06, 0.16]], [-2.2, [0.92, -0.26, 0.08, 0.22]], [-1.75, [0.99, -0.30, 0.07, 0.25]], [-1.0, [0.98, -0.31, 0.05, 0.22]],
    [-0.4, [0.95, -0.31, 0.03, 0.18]], [0.4, [0.95, -0.31, 0.02, 0.13]], [1.0, [0.97, -0.31, 0.01, 0.08]], [1.6, [0.98, -0.31, -0.01, 0.03]],
    [2.0, [0.95, -0.31, -0.04, -0.02]], [2.2, [0.86, -0.32, -0.09, -0.08]], [2.32, [0.72, -0.33, -0.16, -0.15]],
  ];
  const zF = spec.wb * (1 - spec.front), zR = -spec.wb * spec.front, wy = -(spec.cgH - spec.R) + 0.01, ar = spec.R + 0.045;
  const arch = z => { let h = -1; for (const za of [zF, zR]) { const d = (z - za) / (ar + 0.05); if (Math.abs(d) < 1) h = Math.max(h, wy + ar * Math.sqrt(1 - d * d)); } return h; };
  const zs = []; for (let z = -2.32; z <= 2.3201; z += 0.05) zs.push(Math.min(z, 2.32));
  const body = loft(zs, z => {
    const [wu, yb, ys0, yt] = interp(sec, z), ah = arch(z);
    if (ah < 0) {           // plain side panel
      const ys = ys0;
      return [[0, yb], [wu * 0.9, yb], [wu * 0.95, yb + 0.06], [wu * 0.965, ys - 0.12], [wu * 0.985, ys - 0.06], [wu, ys - 0.02], [wu, ys], [wu * 0.985, ys + 0.03], [wu * 0.9, (ys + yt) / 2 + 0.03], [wu * 0.7, yt - 0.005], [wu * 0.35, yt], [0, yt]];
    }
    const lip = Math.max(ah, yb + 0.08), ys = Math.max(ys0, lip + 0.07), inner = 0.62;
    return [[0, yb], [inner * 0.95, yb], [inner, yb + 0.06], [inner, lip - 0.01], [wu * 0.97, lip], [wu, Math.min(ys, lip + 0.05)], [wu, ys], [wu * 0.985, ys + 0.03], [wu * 0.9, (ys + yt) / 2 + 0.03], [wu * 0.7, yt - 0.005], [wu * 0.35, yt], [0, yt]]
  });
  // greenhouse (glass) and roof (paint)
  const cab = [[-1.15, [0.62, 0.20, 0.20]], [-0.85, [0.70, 0.22, 0.46]], [-0.4, [0.74, 0.18, 0.62]], [0.05, [0.76, 0.15, 0.66]], [0.45, [0.78, 0.10, 0.56]], [0.95, [0.82, 0.05, 0.10]]];
  const czs = []; for (let z = -1.15; z <= 0.9501; z += 0.07) czs.push(Math.min(z, 0.95));
  const glass = loft(czs, z => { const [w, yb, yt] = interp(cab, z); return [[0, yb], [w, yb], [w * 0.92, yb + (yt - yb) * 0.45], [w * 0.78, yt - 0.03], [w * 0.5, yt], [0, yt]]; });
  const roof = loft(czs.filter(z => z > -0.55 && z < 0.4), z => { const [w, , yt] = interp(cab, z); return [[0, yt - 0.02], [w * 0.72, yt - 0.02], [w * 0.72, yt + 0.012], [w * 0.4, yt + 0.022], [0, yt + 0.022]]; });

  const paint = merge(merge(new MeshBuilder(), body, trs([0, 0, 0])), roof, trs([0, 0, 0]));
  // mirrors and wing main plane are body colour
  for (const sx of [1, -1]) merge(paint, B, trs([sx * 0.95, 0.32, 0.72], 0, 0, 0, [0.16, 0.09, 0.14]));
  merge(paint, B, trs([0, 0.64, -2.06], 0, -0.08, 0, [1.86, 0.035, 0.36]));
  const carbon = new MeshBuilder();
  merge(carbon, B, trs([0, -0.315, 2.24], 0, 0, 0, [1.9, 0.03, 0.32]));        // splitter
  merge(carbon, B, trs([0, -0.25, -2.22], 0, 0.12, 0, [1.6, 0.06, 0.36]));       // diffuser
  for (let k = -3; k <= 3; k++) merge(carbon, B, trs([k * 0.22, -0.2, -2.24], 0, 0.12, 0, [0.02, 0.14, 0.34]));
  for (const sx of [1, -1]) {
    merge(carbon, B, trs([sx * 0.94, 0.62, -2.06], 0, 0, 0, [0.025, 0.3, 0.46]));  // wing endplates
    merge(carbon, B, trs([sx * 0.42, 0.44, -1.98], 0, 0.2, 0, [0.03, 0.34, 0.12])); // pylons
    merge(carbon, B, trs([sx * 0.9, -0.29, 0.05], 0, 0, 0, [0.12, 0.05, 2.0]));    // side skirts
  }
  const dark = new MeshBuilder();
  merge(dark, B, trs([0, -0.12, 2.3], 0, 0, 0, [0.9, 0.12, 0.04]));             // grille
  for (const sx of [1, -1]) merge(dark, Cy, trs([sx * 0.2, -0.2, -2.3], 0, Math.PI / 2, 0, [0.11, 0.14, 0.11]));   // exhausts
  merge(dark, B, trs([0, 0.07, -2.31], 0, 0, 0, [1.55, 0.13, 0.03]));          // rear panel behind the lights
  const tail = new MeshBuilder();
  merge(tail, B, trs([0, 0.07, -2.33], 0, 0, 0, [1.45, 0.035, 0.02]));          // full-width light bar
  for (const sx of [1, -1]) merge(tail, B, trs([sx * 0.56, 0.07, -2.33], 0, 0, 0, [0.36, 0.08, 0.025]));
  const head = new MeshBuilder();
  for (const sx of [1, -1]) merge(head, B, trs([sx * 0.66, -0.03, 2.2], sx * 0.35, 0, 0, [0.34, 0.06, 0.06]));
  S.mesh('carPaint_' + id, paint.orient()); S.mesh('carGlass_' + id, glass); S.mesh('carCarbon_' + id, carbon.orient()); S.mesh('carDark_' + id, dark.orient());
  S.mesh('carTail_' + id, tail.orient()); S.mesh('carHead_' + id, head.orient());
  if (S.pool.has('tyre')) return;
  // wheels: tyre (sidewall + tread), rim with 5 spokes, brake disc. Axis = x.
  const tyre = merge(new MeshBuilder(), Cy, trs([0, 0, 0], 0, 0, Math.PI / 2, [0.69, 0.27, 0.69]));
  const rim = merge(new MeshBuilder(), Cy, trs([0, 0, 0], 0, 0, Math.PI / 2, [0.48, 0.25, 0.48]));
  for (let k = 0; k < 5; k++) merge(rim, B, trs([0.13, 0, 0], 0, k / 5 * Math.PI * 2, 0, [0.04, 0.42, 0.06]));
  const disc = merge(new MeshBuilder(), Cy, trs([0, 0, 0], 0, 0, Math.PI / 2, [0.38, 0.03, 0.38]));
  S.mesh('tyre', tyre.orient()); S.mesh('rim', rim.orient()); S.mesh('disc', disc.orient());
}

// Per-frame instances for one car (body parts + 4 wheels with steer, spin, suspension travel).
export function carInstances(car, alpha, livery, out, opts = {}) {
  const { pos, q } = car.pose(alpha), M = poseMatrix(pos, q), s = car.spec;
  const paint = mat(livery[0], livery[1], livery[2], 0.25, 0.32, 1);
  const braking = car.input.brake > 0.05 && car.gear !== -1, rev = car.gear === -1;
  const tailGlow = braking ? 3.2 : 1.3;
  const id = car.specId;
  out.push({ mesh: 'carPaint_' + id, model: M, ...paint });
  out.push({ mesh: 'carGlass_' + id, model: M, ...mat(0.02, 0.025, 0.03, 0, 0.04, 1) });
  out.push({ mesh: 'carCarbon_' + id, model: M, ...mat(0.025, 0.025, 0.03, 0.2, 0.35, 1) });
  out.push({ mesh: 'carDark_' + id, model: M, ...mat(0.04, 0.04, 0.045, 0.6, 0.45) });
  out.push({ mesh: 'carTail_' + id, model: M, ...mat(0.3, 0.01, 0.01, 0, 0.3), emit: rev ? [1, 1, 1, 3] : [1, 0.02, 0.015, tailGlow] });
  out.push({ mesh: 'carHead_' + id, model: M, ...mat(0.8, 0.8, 0.8, 0, 0.1), emit: [1, 0.92, 0.8, opts.headlights ? 14 : 1.2] });
  const R = s.R;
  car.wheels.forEach((w, k) => {
    const travel = (w.comp < 0 ? 0.03 : w.comp) - car.rest;            // wheel centre = anchor - (rest - comp)
    const local = trs([w.anchor[0] + (w.anchor[0] > 0 ? 0.02 : -0.02), w.anchor[1] + travel, w.anchor[2]], w.steer, 0, 0);
    const spin = trs([0, 0, 0], 0, w.spin, 0, [1, R / 0.345, R / 0.345]);
    const flip = w.anchor[0] > 0 ? trs([0, 0, 0], Math.PI) : null;     // left wheels face outwards
    const L = mul(M, local), W = mul(L, flip ? mul(spin, flip) : spin);
    out.push({ mesh: 'tyre', model: W, ...mat(0.03, 0.03, 0.032, 0, 0.88) });
    out.push({ mesh: 'rim', model: W, ...mat(0.6, 0.6, 0.62, 1, 0.28) });
    const glow = Math.min(1, (car.brakeHeat || 0));
    out.push({ mesh: 'disc', model: mul(L, trs([0, 0, 0], 0, 0, 0, [1, R / 0.345, R / 0.345])), ...mat(0.35, 0.34, 0.33, 1, 0.45), emit: [1, 0.35, 0.05, glow * 6] });
  });
}
