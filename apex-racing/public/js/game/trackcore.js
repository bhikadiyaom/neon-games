// Track core: turns a compact track definition (control points + rules) into a sampled centreline with frames,
// and answers "where am I on the track?" queries for physics, timing and placement. Pure JS, no DOM/GPU, so the
// server can load it too (await import()).
//
// Conventions: y is up, the track runs along +s. u is the lateral offset in metres, positive = LEFT of the driving
// direction. Bank > 0 lifts the left side.
export const VERGE = 14;          // grass run-off beyond the kerbs, metres from the road edge... measured from centre: hw + VERGE
export const KERB_W = 1.5;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// centripetal Catmull-Rom between p1 and p2
function catmull(p0, p1, p2, p3, t) {
  const d = (a, b) => Math.max(1e-4, Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5));
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const lerp = (a, b, ta, tb) => a.map((v, i) => (tb - tt) / (tb - ta) * v + (tt - ta) / (tb - ta) * b[i]);
  const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
  const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
  return lerp(B1, B2, t1, t2);
}

export function buildTrack(def) {
  const P = def.points, n0 = P.length, step = def.step || 2;
  // 1. dense sampling of the closed spline in the ground plane (x, z) + width
  const dense = [];
  for (let i = 0; i < n0; i++) {
    const p = k => { const q = P[(i + k + n0) % n0]; return [q[0], q[1], q[2] ?? def.width]; };
    for (let j = 0; j < 64; j++) dense.push(catmull(p(-1), p(0), p(1), p(2), j / 64));
  }
  // 2. arc-length resample at a fixed step
  const cum = [0];
  for (let i = 1; i <= dense.length; i++) { const a = dense[i - 1], b = dense[i % dense.length]; cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const L2d = cum[dense.length], n = Math.round(L2d / step), ds = L2d / n;
  const x = new Float64Array(n), z = new Float64Array(n), w = new Float64Array(n);
  for (let k = 0, j = 0; k < n; k++) {
    const target = k * ds;
    while (cum[j + 1] < target) j++;
    const a = dense[j], b = dense[(j + 1) % dense.length], t = (target - cum[j]) / (cum[j + 1] - cum[j]);
    x[k] = a[0] + (b[0] - a[0]) * t; z[k] = a[1] + (b[1] - a[1]) * t; w[k] = a[2] + (b[2] - a[2]) * t;
  }
  const wrap = i => ((i % n) + n) % n;
  // 3. heading, curvature (signed, + = turning left), smoothed
  const head = new Float64Array(n), curv = new Float64Array(n);
  for (let i = 0; i < n; i++) head[i] = Math.atan2(x[wrap(i + 1)] - x[wrap(i - 1)], z[wrap(i + 1)] - z[wrap(i - 1)]);
  for (let i = 0; i < n; i++) { let d = head[wrap(i + 1)] - head[wrap(i - 1)]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; curv[i] = d / (2 * ds); }
  const boxSmooth = (src, half) => { const out = new Float64Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let k = -half; k <= half; k++) s += src[wrap(i + k)]; out[i] = s / (2 * half + 1); } return out; };
  // heading = atan2(dx, dz): turning LEFT (towards +x when facing +z) increases it, so curvature > 0 = left turn
  const curvS = boxSmooth(curv, Math.max(1, Math.round(10 / ds)));
  // 4. elevation: follow the hills (smoothed hard so the road has no bumps), plus per-definition offset
  const hills = def.hills;
  const yRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) yRaw[i] = hills(x[i], z[i]) + (def.yOffset || 0);
  let y = boxSmooth(yRaw, Math.round(60 / ds)); y = boxSmooth(y, Math.round(40 / ds));
  // 5. banking from curvature: outside of a corner is higher (left turn -> right side up -> bank < 0)
  const bank = new Float64Array(n);
  for (let i = 0; i < n; i++) bank[i] = -clamp(curvS[i] * (def.bankGain ?? 90), -(def.maxBank ?? 0.07), def.maxBank ?? 0.07);
  const bankS = boxSmooth(bank, Math.round(30 / ds));
  // 6. kerbs: on both sides wherever the corner is tighter than kerbRadius (+ a lead-in/out), racing-line hint
  const kerbOn = new Uint8Array(n), kr = def.kerbRadius || 260;
  for (let i = 0; i < n; i++) if (Math.abs(curvS[i]) > 1 / kr) for (let k = -12; k <= 12; k++) kerbOn[wrap(i + k)] = 1;
  const curvWide = boxSmooth(curv, Math.round(45 / ds));
  const line = new Float64Array(n);      // where the rubbered racing line sits (lateral, m): inside at apexes
  for (let i = 0; i < n; i++) line[i] = clamp(curvWide[i] * 900, -1, 1) * (w[i] / 2 - 2);

  // frames: tangent (3D), left (with bank), normal
  const T = new Float32Array(n * 3), Lft = new Float32Array(n * 3), N = new Float32Array(n * 3), Lh = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = wrap(i - 1), b = wrap(i + 1);
    let tx = x[b] - x[a], ty = y[b] - y[a], tz = z[b] - z[a]; const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
    let lx = tz, lz = -tx; const ll = Math.hypot(lx, lz); lx /= ll; lz /= ll;            // horizontal left = up x T
    Lh[i * 2] = lx; Lh[i * 2 + 1] = lz;
    const cb = Math.cos(bankS[i]), sb = Math.sin(bankS[i]);
    const bx = lx * cb, by = sb, bz = lz * cb;
    const nx = ty * bz - tz * by, ny = tz * bx - tx * bz, nz = tx * by - ty * bx, nl = Math.hypot(nx, ny, nz);
    T.set([tx, ty, tz], i * 3); Lft.set([bx, by, bz], i * 3); N.set([nx / nl, ny / nl, nz / nl], i * 3);
  }

  const track = { def, n, ds, length: n * ds, x, y, z, w, curv, curvS, bank: bankS, kerbOn, line, T, L: Lft, N, Lh, wrap };
  // spatial hash for global nearest queries
  const cell = 30, grid = new Map(), key = (cx, cz) => cx * 73856093 ^ cz * 19349663;
  for (let i = 0; i < n; i++) { const k = key(Math.floor(x[i] / cell), Math.floor(z[i] / cell)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
  track.grid = grid; track.cell = cell; track.key = key;
  return track;
}

// Nearest point on the centreline. hint = sample index from last time (fast local search, and it keeps
// a car on ITS part of the track where two sections run close together).
export function locate(tr, px, pz, hint = -1) {
  const { n, x, z, wrap } = tr;
  let best = -1, bd = Infinity;
  const test = i => { const d = (x[i] - px) ** 2 + (z[i] - pz) ** 2; if (d < bd) { bd = d; best = i; } };
  if (hint >= 0) {
    // walk downhill from last time's sample: usually 0-3 steps
    best = hint; bd = (x[hint] - px) ** 2 + (z[hint] - pz) ** 2;
    for (let k = 0; k < 400; k++) {
      const a = wrap(best + 1), b = wrap(best - 1);
      const da = (x[a] - px) ** 2 + (z[a] - pz) ** 2, db = (x[b] - px) ** 2 + (z[b] - pz) ** 2;
      if (da < bd && da <= db) { best = a; bd = da; } else if (db < bd) { best = b; bd = db; } else break;
    }
    if (bd > 60 * 60) { best = -1; bd = Infinity; }
  }
  if (best < 0) {
    const cx = Math.floor(px / tr.cell), cz = Math.floor(pz / tr.cell);
    for (let r = 1; r <= 4 && best < 0; r++) {
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) { const l = tr.grid.get(tr.key(cx + a, cz + b)); if (l) for (const i of l) test(i); }
    }
    if (best < 0) for (let i = 0; i < n; i++) test(i);
  }
  // refine onto the segment before or after the nearest sample
  const seg = i => {
    const j = wrap(i + 1), dx = x[j] - x[i], dz = z[j] - z[i];
    const t = clamp(((px - x[i]) * dx + (pz - z[i]) * dz) / (dx * dx + dz * dz), 0, 1);
    const qx = x[i] + dx * t, qz = z[i] + dz * t;
    return { i, t, d: (px - qx) ** 2 + (pz - qz) ** 2 };
  };
  const a = seg(wrap(best - 1)), b = seg(best), r = a.d < b.d ? a : b;
  const i = r.i, j = wrap(i + 1), t = r.t;
  const lx = tr.Lh[i * 2] * (1 - t) + tr.Lh[j * 2] * t, lz = tr.Lh[i * 2 + 1] * (1 - t) + tr.Lh[j * 2 + 1] * t;
  const cx = x[i] + (x[j] - x[i]) * t, cz = z[i] + (z[j] - z[i]) * t;
  const u = (px - cx) * lx + (pz - cz) * lz;
  return { i, t, s: (i + t) * tr.ds, u };
}

// Nearest centreline sample within maxDist using only the spatial hash; null if the track is farther away.
// (World generation uses this: most terrain points are far from the track and need no exact answer.)
export function locateNear(tr, px, pz, maxDist, hint = -1) {
  if (hint >= 0) {
    const d = (tr.x[hint] - px) ** 2 + (tr.z[hint] - pz) ** 2;
    if (d < 60 * 60) return locate(tr, px, pz, hint);
  }
  const cx = Math.floor(px / tr.cell), cz = Math.floor(pz / tr.cell), r = Math.ceil(maxDist / tr.cell);
  let best = -1, bd = maxDist * maxDist;
  for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
    const l = tr.grid.get(tr.key(cx + a, cz + b)); if (!l) continue;
    for (const i of l) { const d = (tr.x[i] - px) ** 2 + (tr.z[i] - pz) ** 2; if (d < bd) { bd = d; best = i; } }
  }
  return best < 0 ? null : locate(tr, px, pz, best);
}

// interpolated per-sample value (linear), and a smooth cubic version for heights so the slope has no kinks
const lerpAt = (arr, tr, i, t) => arr[i] * (1 - t) + arr[tr.wrap(i + 1)] * t;
const cubicAt = (arr, tr, i, t) => {
  const p0 = arr[tr.wrap(i - 1)], p1 = arr[i], p2 = arr[tr.wrap(i + 1)], p3 = arr[tr.wrap(i + 2)], t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3);
};
export const halfWidth = (tr, i, t) => lerpAt(tr.w, tr, i, t) / 2;

// Height of the drivable surface (road, kerb, grass run-off) at lateral offset u. Beyond the run-off the
// terrain takes over (terrainHeight).
export function surfaceHeight(tr, i, t, u) {
  const yc = cubicAt(tr.y, tr, i, t), b = cubicAt(tr.bank, tr, i, t), hw = halfWidth(tr, i, t);
  const au = Math.abs(u), sgn = Math.sign(u) || 1;
  const roadEdge = yc + sgn * hw * Math.tan(b);
  if (au <= hw) return yc + u * Math.tan(b);
  if (au <= hw + KERB_W) return roadEdge + (au - hw) * Math.tan(b) * sgn + 0.035 * Math.sin(Math.PI * (au - hw) / KERB_W);
  const kerbEdge = roadEdge + KERB_W * Math.tan(b) * sgn;
  return kerbEdge - 0.12 * smooth(hw + KERB_W, hw + VERGE, au);      // run-off falls away a little (drainage)
}
export const vergeEdgeHeight = (tr, i, t, sgn) => surfaceHeight(tr, i, t, sgn * (halfWidth(tr, i, t) + VERGE));

// Terrain: the hills, pulled down to meet the run-off edge near the track.
export function terrainHeight(tr, px, pz, hint = -1) {
  const h = tr.def.hills(px, pz);
  const q = locate(tr, px, pz, hint);
  const hw = halfWidth(tr, q.i, q.t), au = Math.abs(q.u), edge = hw + VERGE;
  if (au > edge + 90) return h;
  const ye = vergeEdgeHeight(tr, q.i, q.t, Math.sign(q.u) || 1);
  if (au < edge) return surfaceHeight(tr, q.i, q.t, q.u) - 0.6;          // hidden under the run-off ribbon
  return ye + (h - ye) * smooth(edge, edge + 90, au);
}

// Surface kind at a point: 0 asphalt, 1 kerb, 2 grass run-off, 3 terrain (rough grass)
export function surfaceKind(tr, i, t, u) {
  const hw = halfWidth(tr, i, t), au = Math.abs(u);
  if (au <= hw) return 0;
  if (au <= hw + KERB_W) return tr.kerbOn[i] ? 1 : 2;
  if (au <= hw + VERGE) return 2;
  return 3;
}

// One call for physics: ground height + normal + kind under (x, z).
export function ground(tr, px, pz, hint = -1) {
  const q = locate(tr, px, pz, hint);
  const hw = halfWidth(tr, q.i, q.t), au = Math.abs(q.u);
  let y, nx, ny, nz;
  if (au <= hw + KERB_W) {                       // road + kerb: the banked track plane, normal from the frame
    y = surfaceHeight(tr, q.i, q.t, q.u);
    const j = tr.wrap(q.i + 1), t = q.t, N = tr.N;
    nx = N[q.i * 3] * (1 - t) + N[j * 3] * t; ny = N[q.i * 3 + 1] * (1 - t) + N[j * 3 + 1] * t; nz = N[q.i * 3 + 2] * (1 - t) + N[j * 3 + 2] * t;
  } else {                                       // run-off / terrain: finite differences
    const h = (ox, oz) => {
      const qq = (ox || oz) ? locate(tr, px + ox, pz + oz, q.i) : q;
      return Math.abs(qq.u) <= halfWidth(tr, qq.i, qq.t) + VERGE ? surfaceHeight(tr, qq.i, qq.t, qq.u) : terrainHeight(tr, px + ox, pz + oz, qq.i);
    };
    const e = 0.4; y = h(0, 0); const hx = h(e, 0), hz = h(0, e);
    nx = -(hx - y) / e; ny = 1; nz = -(hz - y) / e;
  }
  const nl = Math.hypot(nx, ny, nz);
  return { y, nx: nx / nl, ny: ny / nl, nz: nz / nl, kind: surfaceKind(tr, q.i, q.t, q.u), i: q.i, s: q.s, u: q.u, hw };
}

// world position of (s, u) on the surface (for placing cars, props)
export function pointAt(tr, s, u = 0, lift = 0) {
  const f = ((s % tr.length) + tr.length) % tr.length / tr.ds, i = Math.floor(f) % tr.n, t = f - Math.floor(f), j = tr.wrap(i + 1);
  const lx = tr.Lh[i * 2] * (1 - t) + tr.Lh[j * 2] * t, lz = tr.Lh[i * 2 + 1] * (1 - t) + tr.Lh[j * 2 + 1] * t;
  const cx = tr.x[i] + (tr.x[j] - tr.x[i]) * t, cz = tr.z[i] + (tr.z[j] - tr.z[i]) * t;
  const px = cx + lx * u, pz = cz + lz * u;
  const tx = tr.x[j] - tr.x[i], tz = tr.z[j] - tr.z[i];
  return { x: px, y: surfaceHeight(tr, i, t, u) + lift, z: pz, heading: Math.atan2(tx, tz), i, t };
}
