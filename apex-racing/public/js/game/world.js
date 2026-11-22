// World builder: generates every mesh and prop of a circuit from its compact definition (no model files).
import { MeshBuilder, box, cylinder } from '../render/meshes.js';
import { SceneBuilder, mat, KIND } from '../render/scene.js';
import { trs } from '../engine/math.js';
import { buildTrack, locate, locateNear, surfaceHeight, vergeEdgeHeight, halfWidth, pointAt, VERGE, KERB_W } from './trackcore.js';

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) ^ Math.imul(s ^ (s >>> 13), 3266489917)) >>> 0) / 4294967296; }
function vnoise(x, z) {
  const h = (i, j) => { let n = Math.imul(i, 374761393) + Math.imul(j, 668265263); n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
}

// ---------- extra procedural meshes ----------
function icosphere(sub = 1) {
  const t = (1 + Math.sqrt(5)) / 2;
  let V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(v => { const l = Math.hypot(...v); return v.map(c => c / l); });
  let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < sub; s++) {
    const cache = new Map(), mid = (a, b) => { const k = a < b ? a + ',' + b : b + ',' + a; if (cache.has(k)) return cache.get(k); const m = V[a].map((c, i) => (c + V[b][i]) / 2), l = Math.hypot(...m); V.push(m.map(c => c / l)); cache.set(k, V.length - 1); return V.length - 1; };
    F = F.flatMap(([a, b, c]) => { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]; });
  }
  const m = new MeshBuilder();
  for (const v of V) m.vert(v.map(c => c * 0.5), v, [0, 0]);
  for (const f of F) m.tri(...f);
  return m.orient();
}
function cone(seg = 8) {
  const m = new MeshBuilder(), k = 0.5 / Math.hypot(0.5, 1);
  for (let i = 0; i < seg; i++) {
    const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2, am = (a0 + a1) / 2;
    const n0 = [Math.cos(a0), k, Math.sin(a0)], n1 = [Math.cos(a1), k, Math.sin(a1)], nm = [Math.cos(am), k, Math.sin(am)];
    m.tri(m.vert([Math.cos(a0) * 0.5, -0.5, Math.sin(a0) * 0.5], n0, [0, 1]), m.vert([Math.cos(a1) * 0.5, -0.5, Math.sin(a1) * 0.5], n1, [1, 1]), m.vert([0, 0.5, 0], nm, [0.5, 0]));
  }
  return m.orient();
}
function person() {       // feet at y = 0, about 1.75 m tall, 12 + 12 triangles
  const m = new MeshBuilder(), b = box();
  const add = (cx, cy, cz, sx, sy, sz) => { const base = m.v.length / 8; for (let k = 0; k < b.v.length; k += 8) m.vert([b.v[k] * sx + cx, b.v[k + 1] * sy + cy, b.v[k + 2] * sz + cz], [b.v[k + 3], b.v[k + 4], b.v[k + 5]], [0, 0]); for (const i of b.i) m.i.push(base + i); };
  add(0, 0.62, 0, 0.46, 0.95, 0.28); add(0, 1.3, 0, 0.24, 0.3, 0.26);
  // shift so that the shader's "head" test (local y > 0.35) works with y measured from the centre
  for (let k = 1; k < m.v.length; k += 8) m.v[k] -= 0.55;
  return m;
}

// ---------- track ribbon (road + kerbs + run-off), in chunks for culling ----------
function ribbonChunk(tr, a, b) {
  const m = new MeshBuilder(), cols = [];
  const stations = hw => { const E = hw + VERGE; return [-E, -(hw + KERB_W + 4), -(hw + KERB_W), -(hw + KERB_W / 2), -hw, -hw * 0.5, 0, hw * 0.5, hw, hw + KERB_W / 2, hw + KERB_W, hw + KERB_W + 4, E]; };
  const P = (k, u) => { const i = k % tr.n, lx = tr.Lh[i * 2], lz = tr.Lh[i * 2 + 1]; return [tr.x[i] + lx * u, surfaceHeight(tr, i, 0, u), tr.z[i] + lz * u]; };
  for (let k = a; k <= b; k++) {
    const i = k % tr.n, hw = halfWidth(tr, i, 0), st = stations(hw), s = k * tr.ds, row = [];
    for (const u of st) {
      const p = P(k, u), pf = P(k + 1, u), pb = P(k - 1 + tr.n, u), pl = P(k, u + 0.3), pr = P(k, u - 0.3);
      const T = [pf[0] - pb[0], pf[1] - pb[1], pf[2] - pb[2]], Lv = [pl[0] - pr[0], pl[1] - pr[1], pl[2] - pr[2]];
      const n = [T[1] * Lv[2] - T[2] * Lv[1], T[2] * Lv[0] - T[0] * Lv[2], T[0] * Lv[1] - T[1] * Lv[0]], nl = Math.hypot(...n);
      row.push(m.vert(p, n.map(c => c / nl), [u, s]));
    }
    // skirts hanging down from both outer edges hide any gap to the terrain
    const E = hw + VERGE, lx = tr.Lh[i * 2], lz = tr.Lh[i * 2 + 1];
    const pL = P(k, E), pR = P(k, -E);
    row.unshift(m.vert([pR[0], pR[1] - 1.6, pR[2]], [-lx, 0, -lz], [-E - 0.01, s]));
    row.push(m.vert([pL[0], pL[1] - 1.6, pL[2]], [lx, 0, lz], [E + 0.01, s]));
    cols.push(row);
  }
  for (let r = 0; r < cols.length - 1; r++) for (let c = 0; c < cols[r].length - 1; c++) m.quad(cols[r][c], cols[r][c + 1], cols[r + 1][c + 1], cols[r + 1][c]);
  return m.orient();
}

// ---------- terrain tiles ----------
function terrainAt(tr, x, z, hint) {
  const h = tr.def.hills(x, z);
  const q = locateNear(tr, x, z, 140, hint.i);
  if (!q) { hint.i = -1; return h; }
  hint.i = q.i;
  const hw = halfWidth(tr, q.i, q.t), au = Math.abs(q.u), edge = hw + VERGE;
  if (au > edge + 90) return h;
  if (au < edge) return surfaceHeight(tr, q.i, q.t, q.u) - 0.6;
  const ye = vergeEdgeHeight(tr, q.i, q.t, Math.sign(q.u) || 1);
  return ye + (h - ye) * smooth(edge, edge + 90, au);
}
function terrainTile(tr, x0, z0, size, res, hint, sink = 0) {
  const m = new MeshBuilder(), c = size / res, H = [];
  for (let j = -1; j <= res + 1; j++) { const row = []; for (let i = -1; i <= res + 1; i++) row.push(terrainAt(tr, x0 + i * c, z0 + j * c, hint) - sink); H.push(row); }
  const idx = [];
  for (let j = 0; j <= res; j++) {
    const row = [];
    for (let i = 0; i <= res; i++) {
      const hx = H[j + 1][i + 2] - H[j + 1][i], hz = H[j + 2][i + 1] - H[j][i + 1];
      const n = [-hx / (2 * c), 1, -hz / (2 * c)], l = Math.hypot(...n);
      const x = x0 + i * c, z = z0 + j * c;
      row.push(m.vert([x, H[j + 1][i + 1], z], n.map(v => v / l), [x, z]));
    }
    idx.push(row);
  }
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) m.quad(idx[j][i], idx[j][i + 1], idx[j + 1][i + 1], idx[j + 1][i]);
  // skirts on all four edges (cracks between tiles of different resolution)
  const edge = (list, nrm) => { for (let k = 0; k < list.length - 1; k++) { const a = list[k], b = list[k + 1], va = m.v.slice(a * 8, a * 8 + 3), vb = m.v.slice(b * 8, b * 8 + 3); const a2 = m.vert([va[0], va[1] - 6, va[2]], nrm, [va[0], va[2]]), b2 = m.vert([vb[0], vb[1] - 6, vb[2]], nrm, [vb[0], vb[2]]); m.quad(a, b, b2, a2); } };
  edge(idx[0], [0, 0, -1]); edge(idx[res], [0, 0, 1]); edge(idx.map(r => r[0]), [-1, 0, 0]); edge(idx.map(r => r[res]), [1, 0, 0]);
  return m.orient();
}

// ---------- the whole world ----------
export async function buildWorld(gpu, def, onProgress = async () => {}, beforeBuild = null) {
  const tr = buildTrack(def), S = new SceneBuilder(), R = rng(1234);
  S.mesh('box', box()); S.mesh('cyl', cylinder(12)); S.mesh('cyl6', cylinder(6)); S.mesh('ico', icosphere(1)); S.mesh('cone', cone(8)); S.mesh('person', person());
  S.mesh('ico0', icosphere(0)); S.mesh('cone4', cone(4)); S.mesh('cyl4', cylinder(4));
  const E = i => halfWidth(tr, i, 0) + VERGE;

  // ribbon chunks
  const CH = 48;
  for (let a = 0, c = 0; a < tr.n; a += CH, c++) {
    S.mesh('rib' + c, ribbonChunk(tr, a, Math.min(a + CH, tr.n)));
    S.add('rib' + c, trs([0, 0, 0]), mat(1, 1, 1, 0, 1, 0, KIND.TRACK), { shadow: false, group: 'rib' + c });
  }
  await onProgress(0.15, 'Track surface');

  // terrain: 384 m tiles, split into 192 m high-resolution tiles near the track
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < tr.n; i++) { minX = Math.min(minX, tr.x[i]); maxX = Math.max(maxX, tr.x[i]); minZ = Math.min(minZ, tr.z[i]); maxZ = Math.max(maxZ, tr.z[i]); }
  const BIG = 384, margin = 1700;
  const gx0 = Math.floor((minX - margin) / BIG) * BIG, gx1 = Math.ceil((maxX + margin) / BIG) * BIG, gz0 = Math.floor((minZ - margin) / BIG) * BIG, gz1 = Math.ceil((maxZ + margin) / BIG) * BIG;
  const hint = { i: 0 }; let tiles = 0;
  const terrMat = mat(1, 1, 1, 0, 1, 0, KIND.TERRAIN);
  for (let z = gz0; z < gz1; z += BIG) for (let x = gx0; x < gx1; x += BIG) {
    const near = locateNear(tr, x + BIG / 2, z + BIG / 2, BIG * 0.71 + 260) !== null;
    const name = 't' + tiles++; S.mesh(name, terrainTile(tr, x, z, BIG, near ? 64 : 12, hint)); S.add(name, trs([0, 0, 0]), terrMat, { shadow: false, group: name });
  }
  // horizon ring: coarse, sunk well below inside the detailed area so it never shows through
  {
    const m = new MeshBuilder(), cx = (gx0 + gx1) / 2, cz = (gz0 + gz1) / 2, half = 9000, res = 60, c = 2 * half / res, rows = [];
    for (let j = 0; j <= res; j++) { const row = []; for (let i = 0; i <= res; i++) {
      const x = cx - half + i * c, z = cz - half + j * c, inside = x > gx0 + 50 && x < gx1 - 50 && z > gz0 + 50 && z < gz1 - 50;
      const y = tr.def.hills(x, z) - (inside ? 60 : 0), e = 20, n = [-(tr.def.hills(x + e, z) - tr.def.hills(x - e, z)) / (2 * e), 1, -(tr.def.hills(x, z + e) - tr.def.hills(x, z - e)) / (2 * e)], l = Math.hypot(...n);
      row.push(m.vert([x, y, z], n.map(v => v / l), [x, z])); } rows.push(row); }
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) m.quad(rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]);
    S.mesh('horizon', m.orient()); S.add('horizon', trs([0, 0, 0]), terrMat, { shadow: false, group: 'horizon' });
  }
  await onProgress(0.45, 'Terrain');

  // ---------- barriers: armco on both sides, posts, tyre walls on the outside of tight corners ----------
  const armco = mat(0.62, 0.63, 0.66, 1, 0.33), post = mat(0.32, 0.33, 0.35, 0.9, 0.5), tyre = mat(0.025, 0.025, 0.028, 0, 0.85);
  const startI = Math.round(def.startS / tr.ds) % tr.n;
  const standRange = (i) => { let d = i - startI; d = ((d % tr.n) + tr.n) % tr.n; if (d > tr.n / 2) d -= tr.n; return d * tr.ds; };   // signed metres from the start line
  for (const side of [1, -1]) {
    for (let k = 0; k < tr.n; k += 2) {
      const i = k, j = (k + 2) % tr.n, ui = side * (E(i) + 0.4), uj = side * (E(j) + 0.4);
      const a = pointAt(tr, i * tr.ds, ui), b = pointAt(tr, (i + 2) * tr.ds, uj);
      const len = Math.hypot(b.x - a.x, b.z - a.z), yaw = Math.atan2(b.x - a.x, b.z - a.z);
      const ya = vergeEdgeHeight(tr, i, 0, side), yb = vergeEdgeHeight(tr, j, 0, side), pitch = -Math.atan2(yb - ya, len);
      S.add('box', trs([(a.x + b.x) / 2, (ya + yb) / 2 + 0.6, (a.z + b.z) / 2], yaw, pitch, 0, [0.1, 0.32, len + 0.05]), armco);
      S.add('box', trs([a.x, ya + 0.38, a.z], yaw, 0, 0, [0.1, 0.76, 0.1]), post);
    }
  }
  for (let i = 0; i < tr.n; i += 1) {
    if (Math.abs(tr.curvS[i]) < 1 / 95) continue;
    const side = -Math.sign(tr.curvS[i]);
    for (const off of [0.55, 1.2]) for (const along of [0, 0.66, 1.32]) {
      const p = pointAt(tr, i * tr.ds + along, side * (E(i) - off)), y = vergeEdgeHeight(tr, i, 0, side);
      S.add('cyl', trs([p.x, y + 0.42, p.z], 0, 0, 0, [0.62, 0.84, 0.62]), tyre);
    }
  }
  await onProgress(0.55, 'Barriers');

  // ---------- start/finish gantry (lights are dynamic: they follow the start sequence) ----------
  const st = pointAt(tr, def.startS, 0), hwS = halfWidth(tr, startI, 0), steel = mat(0.16, 0.17, 0.19, 0.85, 0.38), dark = mat(0.05, 0.055, 0.07, 0, 0.45, 0.6);
  const gYaw = st.heading, sideX = Math.cos(gYaw), sideZ = -Math.sin(gYaw);       // left vector for this heading
  const gantry = { x: st.x, y: st.y, z: st.z, yaw: gYaw, lights: [] };
  for (const sgn of [1, -1]) { const u = sgn * (hwS + 2.4); S.add('box', trs([st.x + sideX * u, st.y + 4, st.z + sideZ * u], gYaw, 0, 0, [0.9, 8, 0.9]), steel); }
  const span = 2 * (hwS + 2.4) + 1;
  S.add('box', trs([st.x, st.y + 7.8, st.z], gYaw, 0, 0, [span, 1.6, 1.2]), dark);
  const fwdX = Math.sin(gYaw), fwdZ = Math.cos(gYaw);
  for (const face of [-1, 1]) {
    const fx = st.x + fwdX * face * 0.62, fz = st.z + fwdZ * face * 0.62;
    S.add('box', trs([fx, st.y + 7.8, fz], gYaw, 0, 0, [span * 0.7, 1.3, 0.05]), mat(0.82, 0.82, 0.84, 0, 0.4));
    S.add('box', trs([fx + sideX * span * 0.24, st.y + 7.8, fz + sideZ * span * 0.24], gYaw, 0, 0, [span * 0.22, 1.3, 0.07]), mat(0.6, 0.02, 0.03, 0, 0.35));
    S.add('box', trs([fx - sideX * span * 0.24, st.y + 7.8, fz - sideZ * span * 0.24], gYaw, 0, 0, [span * 0.22, 1.3, 0.07]), mat(0.02, 0.32, 0.12, 0, 0.35));
  }
  // light housing facing the grid (cars come from -fwd)
  S.add('box', trs([st.x - fwdX * 0.8, st.y + 6.3, st.z - fwdZ * 0.8], gYaw, 0, 0, [6.2, 1.1, 0.6]), mat(0.02, 0.02, 0.025, 0, 0.6));
  for (let k = 0; k < 5; k++) { const u = (k - 2) * 1.15; gantry.lights.push([st.x - fwdX * 1.12 + sideX * u, st.y + 6.3, st.z - fwdZ * 1.12 + sideZ * u]); }

  // ---------- grandstands with crowds on the right of the main straight ----------
  const concrete = mat(0.42, 0.41, 0.39, 0, 0.9), seat = mat(0.5, 0.06, 0.08, 0, 0.55), roof = mat(0.72, 0.73, 0.76, 0.9, 0.35);
  let crowd = 0;
  for (const [s0, s1] of [[-80, 0], [22, 112]]) {
    const sm = def.startS + (s0 + s1) / 2, len = s1 - s0, c = pointAt(tr, sm, 0), ci = c.i, side = -1;
    const yaw = c.heading, lx = Math.cos(yaw), lz = -Math.sin(yaw), base = vergeEdgeHeight(tr, ci, 0, side);
    const u0 = side * (E(ci) + 3.5), rows = 12;
    const at = (u, h) => [c.x + lx * u, base + h, c.z + lz * u];
    for (let r = 0; r < rows; r++) {
      const u = u0 + side * (r + 0.5), h = 0.5 * (r + 1);
      S.add('box', trs(at(u, h / 2), yaw, 0, 0, [1.02, h, len]), concrete);
      S.add('box', trs(at(u + side * 0.25, h + 0.05), yaw, 0, 0, [0.5, 0.1, len]), seat);
      for (let k = 0; k < len / 0.62; k++) {
        if (R() < 0.08) continue;
        const sOff = -len / 2 + (k + 0.5) * 0.62 + (R() - 0.5) * 0.15, fx2 = Math.sin(yaw), fz2 = Math.cos(yaw), p = at(u + side * 0.1, h + 0.55);
        S.add('person', trs([p[0] + fx2 * sOff, p[1], p[2] + fz2 * sOff], yaw + Math.PI / 2 * -side + (R() - 0.5) * 0.4, 0, 0, [1, 0.9 + R() * 0.2, 1]), mat(1, 1, 1, 0, 0.8, 0, KIND.CROWD), { shadow: false });
        crowd++;
      }
    }
    const back = u0 + side * (rows + 0.6), topH = 0.5 * rows;
    S.add('box', trs(at(back, (topH + 3) / 2), yaw, 0, 0, [0.4, topH + 3, len]), concrete);
    S.add('box', trs(at(u0 + side * rows / 2, topH + 4.2), yaw, 0, -side * 0.08, [rows + 3, 0.25, len + 2]), roof);
    for (let k = 0; k <= len; k += len / 4) { const fx2 = Math.sin(yaw), fz2 = Math.cos(yaw), p = at(back, (topH + 4) / 2); S.add('cyl', trs([p[0] + fx2 * (k - len / 2), p[1], p[2] + fz2 * (k - len / 2)], 0, 0, 0, [0.4, topH + 4, 0.4]), steel); }
  }
  await onProgress(0.65, 'Grandstands');

  // ---------- marshal posts and billboards ----------
  const sponsor = [[0.75, 0.02, 0.05], [0.02, 0.25, 0.7], [0.9, 0.55, 0.02], [0.05, 0.05, 0.06], [0.02, 0.5, 0.3], [0.5, 0.05, 0.5]];
  for (let s = 200, k = 0; s < tr.length - 60; s += 380, k++) {
    const side = k % 2 ? 1 : -1, i = Math.round(s / tr.ds) % tr.n, p = pointAt(tr, s, side * (E(i) + 2.4)), y = vergeEdgeHeight(tr, i, 0, side);
    S.add('box', trs([p.x, y + 1.1, p.z], p.heading, 0, 0, [1.6, 2.2, 1.6]), mat(0.85, 0.85, 0.82, 0, 0.7));
    S.add('box', trs([p.x, y + 1.6, p.z], p.heading, 0, 0, [1.66, 0.35, 1.66]), mat(0.9, 0.35, 0.02, 0, 0.6));
  }
  for (let i = 0, k = 0; i < tr.n; i += 1) {
    if (Math.abs(tr.curvS[i]) < 1 / 140 || (i % 40) !== 0) continue;
    const side = -Math.sign(tr.curvS[i]), p = pointAt(tr, i * tr.ds, side * (E(i) + 3.2)), y = vergeEdgeHeight(tr, i, 0, side), col = sponsor[k++ % sponsor.length];
    S.add('box', trs([p.x, y + 2.4, p.z], p.heading + Math.PI / 2, 0, 0, [9, 2.6, 0.2]), mat(...col, 0, 0.45));
    S.add('box', trs([p.x, y + 2.0, p.z], p.heading + Math.PI / 2, 0, 0, [9.05, 0.5, 0.24]), mat(0.85, 0.85, 0.85, 0, 0.45));
    for (const o of [-3.8, 3.8]) S.add('box', trs([p.x + Math.sin(p.heading) * o, y + 0.6, p.z + Math.cos(p.heading) * o], p.heading, 0, 0, [0.15, 1.2, 0.15]), post);
  }

  // ---------- trees: forest patches + scattered trees, kept off the track and away from the stands ----------
  let trees = 0;
  const leaf = [mat(0.05, 0.11, 0.03, 0, 0.8, 0, KIND.FOLIAGE), mat(0.035, 0.08, 0.035, 0, 0.8, 0, KIND.FOLIAGE)], bark = mat(0.1, 0.07, 0.05, 0, 0.9);
  const th = { i: 0 };
  for (let z = gz0 + 200; z < gz1 - 200; z += 19) for (let x = gx0 + 200; x < gx1 - 200; x += 19) {
    const px = x + (R() - 0.5) * 16, pz = z + (R() - 0.5) * 16;
    const forest = vnoise(px * 0.006, pz * 0.006) * 0.7 + vnoise(px * 0.02, pz * 0.02) * 0.3;
    if (forest < 0.6 && R() > 0.012) continue;
    const q = locateNear(tr, px, pz, 90, th.i); th.i = q ? q.i : -1;
    if (q && Math.abs(q.u) < halfWidth(tr, q.i, q.t) + VERGE + 16) continue;
    if (q && q.u < 0 && Math.abs(standRange(q.i)) < 160 && Math.abs(q.u) < 80) continue;
    const y = terrainAt(tr, px, pz, th);
    if (y > 120) continue;
    const conifer = vnoise(px * 0.01 + 50, pz * 0.01) > 0.55, h = 8 + R() * 10;
    S.add('cyl6', trs([px, y + h * 0.18, pz], 0, 0, 0, [0.45, h * 0.4, 0.45]), bark);
    if (conifer) S.add('cone', trs([px, y + h * 0.58, pz], R() * 6, 0, 0, [h * 0.42, h * 0.85, h * 0.42]), leaf[1]);
    else S.add('ico', trs([px, y + h * 0.62, pz], R() * 6, 0, 0, [h * 0.55, h * 0.6, h * 0.55]), leaf[0]);
    trees++;
  }
  await onProgress(0.9, 'Trees');

  // ---------- data for the shader, HUD and race ----------
  const info = new Float32Array(tr.n * 4);
  for (let i = 0; i < tr.n; i++) {
    let k = 0; for (let d = -2; d <= 2; d++) k += tr.kerbOn[tr.wrap(i + d)]; k /= 5;
    info.set([halfWidth(tr, i, 0), k, tr.line[i], tr.curvS[i]], i * 4);
  }
  const grid = [];
  for (let k = 0; k < 8; k++) { const back = 10 + 8 * k + 2.4, u = k % 2 === 0 ? 3 : -3; grid.push({ ...pointAt(tr, def.startS - back, u), s: def.startS - back, u }); }
  if (beforeBuild) beforeBuild(S);
  const scene = S.build(gpu, 1536);
  scene.stats = { tiles, trees, crowd };
  return { tr, scene, info, gantry, grid, def };
}
