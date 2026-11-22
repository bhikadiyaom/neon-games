// Procedural hero GT car with 3 levels of detail. Car frame: +z forward, +x LEFT, +y up, origin at the centre
// of mass. Everything is generated from a handful of section tables, so all four cars share one generator and
// differ by their wheelbase, track, wheel size and stance. Parts are split by material so each car is a
// handful of instanced draws.
import { MeshBuilder, box, cylinder } from '../render/meshes.js';
import { mat } from '../render/scene.js';
import { mul, trs } from '../engine/math.js';
import { poseMatrix } from './car.js';

export const K = { PAINT: 5, GLASS: 6, CARBON: 7, TYRE: 8, BRUSHED: 9 };
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const interp = (tbl, z) => { if (z <= tbl[0][0]) return tbl[0][1]; for (let i = 1; i < tbl.length; i++) if (z <= tbl[i][0]) { const [z0, a] = tbl[i - 1], [z1, b] = tbl[i], t = (z - z0) / (z1 - z0), s = t * t * (3 - 2 * t); return a.map((v, k) => v + (b[k] - v) * s); } return tbl[tbl.length - 1][1]; };
// Catmull-Rom through 2D control points, `per` samples per segment (open curve)
function spline2(pts, per) {
  const out = [], n = pts.length, P = i => pts[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n - 1; i++) for (let k = 0; k < per; k++) {
    const t = k / per, t2 = t * t, t3 = t2 * t, p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    out.push([0, 1].map(j => 0.5 * (2 * p1[j] + (p2[j] - p0[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (3 * p1[j] - p0[j] - 3 * p2[j] + p3[j]) * t3)));
  }
  out.push(pts[n - 1]);
  return out;
}

// Loft a closed shell through cross-sections. ring(z) returns the half section from bottom centre to top centre
// (x >= 0); it is mirrored to the other side. uv = (along the length 0..1, around the ring 0..1).
function loft(zs, ring, per, z0, z1) {
  const m = new MeshBuilder(), rows = zs.map(z => { const half = spline2(ring(z), per); return [...half, ...half.slice(0, -1).reverse().map(p => [-p[0], p[1]])].map(p => [p[0], p[1], z]); });
  const R = rows.length, C = rows[0].length;
  const P = (r, c) => rows[Math.max(0, Math.min(R - 1, r))][Math.max(0, Math.min(C - 1, c))];
  const N = rows.map((row, r) => row.map((p, c) => {
    const a = P(r, c + 1), b = P(r, c - 1), f = P(r + 1, c), g = P(r - 1, c);
    const du = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dv = [f[0] - g[0], f[1] - g[1], f[2] - g[2]];
    return [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]];
  }));
  const mid = Math.floor(R / 2), top = Math.floor(C / 2), sgn = N[mid][top][1] < 0 ? -1 : 1;
  const idx = rows.map((row, r) => row.map((p, c) => { const n = N[r][c], l = Math.hypot(...n) || 1; return m.vert(p, n.map(v => sgn * v / l), [(p[2] - z0) / (z1 - z0), c / (C - 1)]); }));
  for (let r = 0; r < R - 1; r++) for (let c = 0; c < C - 1; c++) m.quad(idx[r][c], idx[r][c + 1], idx[r + 1][c + 1], idx[r + 1][c]);
  for (const r of [0, R - 1]) { const cy = rows[r].reduce((s, p) => s + p[1], 0) / C, ctr = m.vert([0, cy, rows[r][0][2]], [0, 0, r ? 1 : -1], [r ? 1 : 0, 0.5]); for (let c = 0; c < C - 1; c++) m.tri(ctr, idx[r][c], idx[r][c + 1]); }
  return m.orient();
}
// lathe around the x axis: profile = [[radius, x], ...] across the part
function lathe(profile, seg, uvV) {
  const m = new MeshBuilder(), rows = [];
  for (let i = 0; i <= seg; i++) {
    const a = i / seg * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), row = [];
    profile.forEach(([r, x], k) => {
      const prev = profile[Math.max(0, k - 1)], next = profile[Math.min(profile.length - 1, k + 1)];
      let nr = -(next[1] - prev[1]), nx = next[0] - prev[0]; const l = Math.hypot(nr, nx) || 1; nr /= l; nx /= l;
      if (nr < 0 && r > 0.3) { nr = -nr; nx = -nx; }
      row.push(m.vert([x, r * ca, r * sa], [nx, nr * ca, nr * sa], [i / seg, uvV(k, r, x)]));
    });
    rows.push(row);
  }
  for (let i = 0; i < seg; i++) for (let k = 0; k < profile.length - 1; k++) m.quad(rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]);
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
// cambered wing element: an airfoil section extruded along x, tilted by aoa (radians, nose down < 0)
function wing(span, chord, thick, seg, aoa) {
  const top = [], bot = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, x = (1 - Math.cos(t * Math.PI)) / 2;
    const yt = 5 * thick * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4), camber = 0.05 * Math.sin(x * Math.PI);
    top.push([x, camber + yt]); bot.push([x, camber - yt]);
  }
  const ring = [...top, ...bot.slice(1, -1).reverse()];
  const ca = Math.cos(aoa), sa = Math.sin(aoa);
  const pts = ring.map(([u, v]) => { const z = (0.5 - u) * chord, y = v * chord; return [y * ca + z * sa, z * ca - y * sa]; });   // (y, z)
  const cy = pts.reduce((s, p) => s + p[0], 0) / pts.length, cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const m = new MeshBuilder(), cols = [];
  for (const xs of [-span / 2, span / 2]) cols.push(pts.map((p, k) => {
    const a = pts[(k - 1 + pts.length) % pts.length], b = pts[(k + 1) % pts.length];
    let ny = -(b[1] - a[1]), nz = b[0] - a[0]; const l = Math.hypot(ny, nz) || 1; ny /= l; nz /= l;
    if (ny * (p[0] - cy) + nz * (p[1] - cz) < 0) { ny = -ny; nz = -nz; }
    return m.vert([xs, p[0], p[1]], [0, ny, nz], [xs > 0 ? 1 : 0, k / pts.length]);
  }));
  for (let k = 0; k < pts.length; k++) m.quad(cols[0][k], cols[0][(k + 1) % pts.length], cols[1][(k + 1) % pts.length], cols[1][k]);
  return m.orient();
}
function sphereMesh(lat, lon) {
  const m = new MeshBuilder();
  for (let y = 0; y <= lat; y++) for (let x = 0; x <= lon; x++) { const th = y / lat * Math.PI, ph = x / lon * Math.PI * 2, n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]; m.vert(n.map(v => v * 0.5), n, [x / lon, y / lat]); }
  for (let y = 0; y < lat; y++) for (let x = 0; x < lon; x++) { const a = y * (lon + 1) + x; m.quad(a, a + lon + 1, a + lon + 2, a + 1); }
  return m.orient();
}

// ---------- the car ----------
export function buildCarMeshes(S, id, spec) {
  if (S.pool.has('carPaint0_' + id)) return;
  const B = box();
  const zF = spec.wb * (1 - spec.front), zR = -spec.wb * spec.front, wy = -(spec.cgH - spec.R) + 0.01, ar = spec.R + 0.055, tw = spec.trackW / 2;
  const ws = (tw + 0.16) / 1.0;                  // body width follows the track so the tyres sit flush with the arches
  const L0 = -2.32, L1 = 2.32;
  // body sections: [z, [plan half width, bottom y, beltline y, deck/hood top y]]
  const sec = [
    [-2.32, [0.78, -0.22, 0.10, 0.18]], [-2.24, [0.90, -0.27, 0.12, 0.24]], [-2.0, [0.985, -0.31, 0.10, 0.27]], [-1.6, [1.0, -0.32, 0.08, 0.27]],
    [-1.1, [0.99, -0.32, 0.06, 0.24]], [-0.6, [0.96, -0.32, 0.04, 0.20]], [0.0, [0.95, -0.32, 0.02, 0.16]], [0.6, [0.955, -0.32, 0.01, 0.12]],
    [1.1, [0.975, -0.32, 0.0, 0.08]], [1.6, [0.985, -0.32, -0.01, 0.05]], [2.0, [0.95, -0.32, -0.04, 0.0]], [2.22, [0.84, -0.33, -0.1, -0.07]], [2.32, [0.66, -0.34, -0.17, -0.15]],
  ].map(([z, v]) => [z, [v[0] * ws, v[1], v[2], v[3]]]);
  const arch = z => { let f = 0, top = -1; for (const za of [zF, zR]) { const d = Math.abs(z - za), ff = 1 - smoothstep(ar - 0.02, ar + 0.05, d); if (ff > f) { f = ff; top = wy + Math.sqrt(Math.max(0, ar * ar - Math.min(d, ar) ** 2)); } } return [f, top]; };
  const ring = z => {
    const [wu, yb, ys, yt] = interp(sec, z), [f, archTop] = arch(z);
    const wl = wu * 0.965 + (0.64 - wu * 0.965) * f, lip = (yb + 0.15) + (Math.max(archTop, yb + 0.15) - (yb + 0.15)) * f;
    const belt = Math.max(ys, lip + 0.07);
    return [[0, yb], [wl * 0.9, yb], [wl, yb + 0.05], [wl, lip - 0.012], [wu * 0.975, lip + 0.004], [wu, Math.min(belt - 0.03, lip + 0.05)], [wu, belt], [wu * 0.965, belt + 0.045], [wu * 0.85, (belt + yt) / 2 + 0.04], [wu * 0.6, yt - 0.004], [wu * 0.28, yt], [0, yt]];
  };
  const steps = [0.0125, 0.055, 0.14], per = [6, 2, 1];
  const zsFor = st => { const a = []; for (let z = L0; z <= L1 + 1e-6; z += st) a.push(Math.min(z, L1)); if (a[a.length - 1] < L1) a.push(L1); return a; };
  // greenhouse (glass) + roof (paint)
  const cab = [[-1.12, [0.6, 0, 0.0]], [-0.95, [0.68, 0, 0.3]], [-0.6, [0.73, 0, 0.58]], [-0.2, [0.75, 0, 0.66]], [0.2, [0.77, 0, 0.66]], [0.55, [0.8, 0, 0.5]], [0.98, [0.84, 0, 0.08]]];
  const deck = z => interp(sec, z)[3];
  const cabRing = z => { const [w, , h] = interp(cab, z), yb = deck(z) - 0.02, yt = yb + h; return [[0, yb], [w, yb], [w * 0.95, yb + h * 0.4], [w * 0.8, yt - 0.04], [w * 0.5, yt], [0, yt]]; };
  for (let lod = 0; lod < 3; lod++) {
    const sfx = lod + '_' + id, Cy = cylinder(lod === 0 ? 20 : 8);
    const paint = loft(zsFor(steps[lod]), ring, per[lod], L0, L1);
    const czs = []; for (let z = -1.12; z <= 0.9801; z += steps[lod] * 1.5) czs.push(Math.min(z, 0.98));
    const glass = loft(czs, cabRing, per[lod], L0, L1);
    const rz = czs.filter(z => z > -0.62 && z < 0.42);
    merge(paint, loft(rz, z => { const [w, , h] = interp(cab, z), yt = deck(z) - 0.02 + h; return [[0, yt - 0.03], [w * 0.62, yt - 0.03], [w * 0.64, yt + 0.004], [w * 0.4, yt + 0.016], [0, yt + 0.016]]; }, per[lod], L0, L1), trs([0, 0, 0]));
    S.mesh('carPaint' + sfx, paint); S.mesh('carGlass' + sfx, glass);
    // carbon aero parts
    const carbon = new MeshBuilder();
    merge(carbon, B, trs([0, -0.33, 2.2], 0, 0, 0, [1.92 * ws, 0.028, 0.34]));                // splitter
    for (const sx of [1, -1]) merge(carbon, B, trs([sx * 0.9 * ws, -0.31, 2.25], 0.15 * sx, 0, 0, [0.02, 0.1, 0.24]));   // splitter fences
    merge(carbon, B, trs([0, -0.255, -2.2], 0, 0.14, 0, [1.62, 0.04, 0.38]));                // diffuser floor
    for (let k = -3; k <= 3; k++) merge(carbon, B, trs([k * 0.22, -0.21, -2.2], 0, 0.14, 0, [0.015, 0.13, 0.36]));   // strakes
    merge(carbon, wing(1.92 * ws, 0.34, 0.12, lod === 0 ? 18 : 8, -0.1), trs([0, 0.66, -2.08]));
    merge(carbon, wing(1.72 * ws, 0.15, 0.1, lod === 0 ? 12 : 6, -0.45), trs([0, 0.74, -2.26]));   // flap
    for (const sx of [1, -1]) {
      merge(carbon, B, trs([sx * 0.97 * ws, 0.67, -2.13], 0, 0, 0, [0.02, 0.36, 0.52]));       // endplates
      merge(carbon, B, trs([sx * 0.4, 0.5, -1.95], 0, -0.25, 0, [0.025, 0.36, 0.1]));        // swan-neck pylons
      merge(carbon, B, trs([sx * 0.93 * ws, -0.3, 0.1], 0, 0, 0, [0.12, 0.05, 2.1]));        // side skirts
      merge(carbon, B, trs([sx * 0.9 * ws, 0.2, 0.7], 0, 0, sx * 0.08, [0.16, 0.085, 0.13]));   // mirror housings
      merge(carbon, B, trs([sx * 0.82 * ws, 0.15, 0.7], 0, 0, sx * 0.5, [0.1, 0.02, 0.05]));     // mirror stalks
      // A-pillars: from the base of the windscreen up to the roof
      { const a = [sx * 0.8, deck(0.95) + 0.02, 0.95], b = [sx * 0.62, deck(0.3) - 0.02 + 0.6, 0.35], len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        merge(carbon, B, trs([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], Math.atan2(b[0] - a[0], b[2] - a[2]), -Math.asin((b[1] - a[1]) / len), 0, [0.05, 0.04, len])); }
    }
    S.mesh('carCarbon' + sfx, carbon.orient());
    // dark trim: grille, intakes, headlight housings, rear panel, bonnet vent
    const dark = new MeshBuilder();
    merge(dark, B, trs([0, -0.15, 2.31], 0, 0, 0, [0.95, 0.12, 0.03]));
    for (const sx of [1, -1]) {
      merge(dark, B, trs([sx * 0.62, -0.2, 2.26], 0, 0, 0, [0.34, 0.1, 0.06]));
      merge(dark, B, trs([sx * 0.995 * ws, 0.02, -0.75], 0, 0, 0, [0.02, 0.14, 0.62]));
      merge(dark, B, trs([sx * 0.66, 0.0, 2.17], sx * 0.34, 0, 0, [0.36, 0.07, 0.07]));
      merge(dark, B, trs([sx * 0.99 * ws, 0.3, 0.74], 0, 0, 0, [0.012, 0.06, 0.11]));          // mirror glass (dark)
    }
    merge(dark, B, trs([0, 0.08, -2.315], 0, 0, 0, [1.6, 0.15, 0.03]));
    merge(dark, B, trs([0, 0.25, 1.15], 0, 0.08, 0, [0.5, 0.01, 0.4]));
    S.mesh('carDark' + sfx, dark.orient());
    const tail = new MeshBuilder();
    for (let k = 0; k < 14; k++) merge(tail, B, trs([(k - 6.5) * 0.105, 0.08, -2.335], 0, 0, 0, [0.085, 0.032, 0.02]));     // segmented light bar
    for (const sx of [1, -1]) merge(tail, B, trs([sx * 0.62, 0.14, -2.33], 0, 0, 0, [0.3, 0.03, 0.02]));
    S.mesh('carTail' + sfx, tail.orient());
    const head = new MeshBuilder();
    for (const sx of [1, -1]) {
      for (const k of [0, 1]) merge(head, Cy, trs([sx * (0.56 + k * 0.13), 0.0, 2.21 - k * 0.04], 0, Math.PI / 2, 0, [0.07, 0.03, 0.07]));   // LED projectors
      merge(head, B, trs([sx * 0.66, -0.045, 2.19], sx * 0.34, 0, 0, [0.34, 0.012, 0.02]));   // running light strip
    }
    S.mesh('carHead' + sfx, head.orient());
    const metal = new MeshBuilder();
    for (const sx of [1, -1]) merge(metal, Cy, trs([sx * 0.19, -0.2, -2.31], 0, Math.PI / 2, 0, [0.12, 0.12, 0.12]));
    S.mesh('carMetal' + sfx, metal.orient());
  }
  // interior (only drawn up close): tub, seat, dash with display, roll cage, steering column, driver
  const inside = new MeshBuilder(), Cy8 = cylinder(10);
  merge(inside, B, trs([0, -0.1, -0.1], 0, 0, 0, [1.5, 0.05, 2.0]));
  merge(inside, B, trs([0.33, 0.05, -0.5], 0, -0.25, 0, [0.48, 0.5, 0.1]));
  merge(inside, B, trs([0.33, -0.05, -0.25], 0, 0, 0, [0.46, 0.1, 0.48]));
  merge(inside, B, trs([0, 0.18, 0.72], 0, -0.3, 0, [1.4, 0.12, 0.32]));
  for (const x of [0.62, -0.62]) merge(inside, Cy8, trs([x, 0.32, -0.75], 0, 0, 0, [0.04, 0.62, 0.04]));
  merge(inside, Cy8, trs([0, 0.62, -0.75], 0, 0, Math.PI / 2, [0.04, 1.24, 0.04]));
  merge(inside, Cy8, trs([0.33, 0.21, 0.45], 0, Math.PI / 2 - 0.35, 0, [0.04, 0.4, 0.04]));
  { // headliner: a dark copy of the roof shell just below it (hides the painted underside from the cockpit)
    const hz = []; for (let z = -0.66; z <= 0.46; z += 0.04) hz.push(z);
    merge(inside, loft(hz, z => { const [w, , h] = interp(cab, z), yt = deck(z) - 0.02 + h; return [[0, yt - 0.075], [w * 0.7, yt - 0.075], [w * 0.72, yt - 0.04], [w * 0.4, yt - 0.034], [0, yt - 0.034]]; }, 2, L0, L1), trs([0, 0, 0]));
  }
  S.mesh('carInside_' + id, inside.orient());
  S.mesh('carDisplay_' + id, merge(new MeshBuilder(), B, trs([0.33, 0.3, 0.6], 0, -0.4, 0, [0.22, 0.12, 0.01])).orient());
  const driver = new MeshBuilder();
  merge(driver, sphereMesh(12, 16), trs([0.33, 0.48, -0.28], 0, 0, 0, [0.27, 0.29, 0.29]));
  merge(driver, B, trs([0.33, 0.2, -0.32], 0, -0.2, 0, [0.42, 0.42, 0.24]));
  merge(driver, B, trs([0.33, 0.06, 0.1], 0, 0.1, 0, [0.36, 0.14, 0.6]));
  S.mesh('carDriver_' + id, driver.orient());
  if (!S.pool.has('steer')) {
    const sw = new MeshBuilder();
    for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2; merge(sw, Cy8, trs([Math.cos(a) * 0.15, Math.sin(a) * 0.12, 0], 0, 0, a, [0.035, 0.066, 0.035])); }
    merge(sw, B, trs([0, 0, 0], 0, 0, 0, [0.2, 0.08, 0.05]));
    S.mesh('steer', sw.orient());
    buildWheelMeshes(S);
  }
}
// wheels for radius 0.345 (scaled per car): tyre with tread grooves + lettered sidewalls, 10-spoke rim,
// centre-lock nut, brake disc and caliper. Axis = x, outer face towards +x.
function buildWheelMeshes(S) {
  const W = 0.15, R = 0.345, rimR = 0.245;
  const prof = [[rimR, -W], [0.29, -W - 0.006], [0.325, -W + 0.004], [R - 0.008, -W + 0.02], [R, -W + 0.045]];
  for (const g of [-0.07, 0, 0.07]) prof.push([R, g - 0.012], [R - 0.007, g - 0.008], [R - 0.007, g + 0.008], [R, g + 0.012]);
  prof.push([R, W - 0.045], [R - 0.008, W - 0.02], [0.325, W - 0.004], [0.29, W + 0.006], [rimR, W]);
  const side = (k, r) => 0.5 + 0.5 * Math.min(1, Math.max(0, (r - rimR) / (R - rimR)));
  const segs = [128, 32, 14];
  for (let lod = 0; lod < 3; lod++) {
    const p = lod === 2 ? [prof[0], [R - 0.01, -W + 0.01], [R, -W + 0.04], [R, W - 0.04], [R - 0.01, W - 0.01], prof[prof.length - 1]] : prof;
    S.mesh('tyre' + lod, lathe(p, segs[lod], (k, r, x) => Math.abs(x) > W - 0.03 ? side(k, r) : 0.25));
    const rim = new MeshBuilder(), Cy = cylinder(Math.max(8, segs[lod] / 2)), B = box();
    merge(rim, lathe([[0.2, -0.12], [rimR, -0.11], [rimR, 0.1], [0.23, 0.13]], Math.max(8, segs[lod] / 2), () => 0.2), trs([0, 0, 0]));   // barrel
    const n = lod === 2 ? 5 : 10;
    for (let k = 0; k < n; k++) merge(rim, B, trs([0.11 + (k % 2) * 0.008, 0, 0], 0, k / n * Math.PI * 2, 0, [0.03, 0.43, 0.045]));   // spokes
    merge(rim, Cy, trs([0.12, 0, 0], 0, 0, Math.PI / 2, [0.11, 0.05, 0.11]));                // hub
    if (lod < 2) merge(rim, cylinder(6), trs([0.15, 0, 0], 0, 0, Math.PI / 2, [0.065, 0.04, 0.065]));   // centre-lock nut
    S.mesh('rim' + lod, rim.orient());
    S.mesh('disc' + lod, merge(new MeshBuilder(), Cy, trs([-0.02, 0, 0], 0, 0, Math.PI / 2, [0.38, 0.032, 0.38])).orient());
    S.mesh('caliper' + lod, merge(new MeshBuilder(), B, trs([0.0, 0.13, 0.08], 0, -0.55, 0, [0.07, 0.1, 0.17])).orient());
  }
}

// ---------- per-frame instances ----------
const LOD_DIST = [22, 80];
// look = { layer (livery texture layer), helmet [r,g,b], rim [r,g,b], caliper [r,g,b] }
export function carInstances(car, alpha, look, out, opts = {}) {
  const { pos, q } = car.pose(alpha), M = poseMatrix(pos, q), s = car.spec, id = car.specId, key = car.uid || 'car';
  const cp = opts.camPos || pos, dist = Math.hypot(pos[0] - cp[0], pos[1] - cp[1], pos[2] - cp[2]);
  const lod = Math.max(opts.lodBias || 0, dist < LOD_DIST[0] ? 0 : dist < LOD_DIST[1] ? 1 : 2), sfx = lod + '_' + id;
  const braking = car.input.brake > 0.05 && car.gear !== -1, rev = car.gear === -1;
  // shadows never need the full-detail mesh: cascades get the medium one, interior parts cast none
  const shadowOf = mesh => /^(carInside|carDisplay|carDriver|steer|carHead|carTail|caliper)/.test(mesh) ? null : mesh.replace(/0_/, '1_').replace(/^(tyre|rim|disc)0$/, '$11');
  const add = (mesh, model, m, emit, k) => out.push({ mesh, model, ...m, emit, key: key + ':' + k, shadow: shadowOf(mesh) });
  const paint = mat(1, 1, 1, 0.35, 0.3, 1, K.PAINT); paint.base[3] = (look.layer || 0) + 1;
  add('carPaint' + sfx, M, paint, undefined, 'paint');
  add('carGlass' + sfx, M, mat(0.5, 0.55, 0.6, 0, 0.04, 1, K.GLASS), undefined, 'glass');
  add('carCarbon' + sfx, M, mat(0.02, 0.02, 0.022, 0, 0.3, 1, K.CARBON), undefined, 'carbon');
  add('carDark' + sfx, M, mat(0.03, 0.03, 0.035, 0.4, 0.4), undefined, 'dark');
  add('carMetal' + sfx, M, mat(0.75, 0.73, 0.7, 1, 0.3, 0, K.BRUSHED), undefined, 'metal');
  add('carTail' + sfx, M, mat(0.3, 0.01, 0.01, 0, 0.3), rev ? [1, 1, 1, 3] : [1, 0.02, 0.015, braking ? 3.2 : 1.3], 'tail');
  add('carHead' + sfx, M, mat(0.8, 0.8, 0.8, 0, 0.1), [1, 0.92, 0.8, opts.headlights ? 14 : 2.5], 'head');
  if (lod === 0 || (opts.lodBias && dist < LOD_DIST[0])) {
    add('carInside_' + id, M, mat(0.03, 0.03, 0.035, 0.1, 0.7), undefined, 'inside');
    add('carDisplay_' + id, M, mat(0.02, 0.02, 0.02, 0, 0.2), [0.2, 0.8, 1, 1.5], 'display');
    add('carDriver_' + id, M, mat(look.helmet[0], look.helmet[1], look.helmet[2], 0.1, 0.35, 1), undefined, 'driver');
    add('steer', mul(M, trs([0.33, 0.33, 0.52], 0, -0.35, -car.steer * 4.5)), mat(0.03, 0.03, 0.03, 0, 0.6), undefined, 'steer');
  }
  const sc = s.R / 0.345;
  car.wheels.forEach((w, k) => {
    const travel = (w.comp < 0 ? 0.03 : w.comp) - car.rest;            // wheel centre = anchor - (rest - comp)
    const left = w.anchor[0] > 0;
    const local = trs([w.anchor[0] + (left ? 0.02 : -0.02), w.anchor[1] + travel, w.anchor[2]], w.steer + (left ? 0 : Math.PI), 0, 0, [1, sc, sc]);
    const Lm = mul(M, local), Wm = mul(Lm, trs([0, 0, 0], 0, left ? w.spin : -w.spin, 0));
    add('tyre' + lod, Wm, mat(0.03, 0.03, 0.032, 0, 0.86, 0, K.TYRE), undefined, 'tyre' + k);
    add('rim' + lod, Wm, mat(look.rim[0], look.rim[1], look.rim[2], 1, 0.22), undefined, 'rim' + k);
    const heat = Math.min(1, car.brakeHeat ? car.brakeHeat[k] : 0);
    add('disc' + lod, Lm, mat(0.3, 0.29, 0.28, 1, 0.42, 0, K.BRUSHED), [1, 0.32, 0.04, heat * heat * 9], 'disc' + k);
    add('caliper' + lod, Lm, mat(look.caliper[0], look.caliper[1], look.caliper[2], 0, 0.35, 1), undefined, 'cal' + k);
  });
}
