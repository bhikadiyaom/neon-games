// node apex-racing/test/track-check.mjs [out.svg] : sanity-checks every track layout and draws a map.
import { buildTrack, locate, ground, pointAt, VERGE } from '../public/js/game/trackcore.js';
import { TRACKS } from '../public/js/game/tracks.js';
import fs from 'fs';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  FAIL:', m); } };
for (const def of TRACKS) {
  const t0 = performance.now();
  const tr = buildTrack(def);
  const ms = performance.now() - t0;
  let maxK = 0, minY = 1e9, maxY = -1e9, maxGrade = 0, maxBank = 0;
  for (let i = 0; i < tr.n; i++) {
    maxK = Math.max(maxK, Math.abs(tr.curvS[i])); minY = Math.min(minY, tr.y[i]); maxY = Math.max(maxY, tr.y[i]);
    maxGrade = Math.max(maxGrade, Math.abs(tr.y[tr.wrap(i + 1)] - tr.y[i]) / tr.ds); maxBank = Math.max(maxBank, Math.abs(tr.bank[i]));
  }
  // closest approach between parts of the track that are far apart along the lap
  let minSep = 1e9, at = null; const skip = Math.round(120 / tr.ds);
  for (let i = 0; i < tr.n; i += 2) for (let j = 0; j < tr.n; j += 2) {
    const da = Math.min(Math.abs(i - j), tr.n - Math.abs(i - j)); if (da < skip) continue;
    const d = Math.hypot(tr.x[i] - tr.x[j], tr.z[i] - tr.z[j]); if (d < minSep) { minSep = d; at = [i, j]; }
  }
  const need = 2 * (6 + VERGE) + 8;
  console.log(`${def.id}: length ${tr.length.toFixed(0)} m, ${tr.n} samples (built in ${ms.toFixed(1)} ms), tightest radius ${(1 / maxK).toFixed(0)} m, ` +
    `elevation ${minY.toFixed(1)}..${maxY.toFixed(1)} m, max grade ${(maxGrade * 100).toFixed(1)}%, max bank ${(maxBank * 57.3).toFixed(1)} deg, ` +
    `closest separate sections ${minSep.toFixed(0)} m (samples ${at})`);
  ok(tr.length > 2500 && tr.length < 6000, 'length');
  ok(1 / maxK > 18, 'no corner tighter than 18 m radius');
  ok(minSep > need, `separate sections at least ${need} m apart`);
  ok(maxGrade < 0.12, 'grades below 12%');
  // locate() round trip
  let worst = 0;
  for (let k = 0; k < 200; k++) {
    const s = Math.random() * tr.length, u = (Math.random() * 2 - 1) * 15;
    const p = pointAt(tr, s, u), q = locate(tr, p.x, p.z);
    const ds = Math.min(Math.abs(q.s - s), tr.length - Math.abs(q.s - s));
    worst = Math.max(worst, ds + Math.abs(q.u - u));
  }
  ok(worst < 0.5, 'pointAt -> locate round trip (worst error ' + worst.toFixed(3) + ' m)');
  const g = ground(tr, pointAt(tr, 100, 0).x, pointAt(tr, 100, 0).z);
  ok(g.kind === 0 && g.ny > 0.9, 'centre of the road is asphalt with an upward normal');
  const t1 = performance.now(); for (let k = 0; k < 20000; k++) { const p = pointAt(tr, k * 0.3 % tr.length, 2); ground(tr, p.x, p.z, p.i); }
  console.log(`  ground() with hint: ${((performance.now() - t1) / 20000 * 1000).toFixed(2)} us per call`);

  // map
  const out = process.argv[2];
  if (out) {
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (let i = 0; i < tr.n; i++) { minX = Math.min(minX, tr.x[i]); maxX = Math.max(maxX, tr.x[i]); minZ = Math.min(minZ, tr.z[i]); maxZ = Math.max(maxZ, tr.z[i]); }
    const pad = 80, W = maxX - minX + pad * 2, H = maxZ - minZ + pad * 2, X = v => (v - minX + pad), Z = v => (maxZ - v + pad);
    let path = ''; for (let i = 0; i <= tr.n; i++) { const k = i % tr.n; path += (i ? 'L' : 'M') + X(tr.x[k]).toFixed(1) + ' ' + Z(tr.z[k]).toFixed(1); }
    let kerbs = ''; for (let i = 0; i < tr.n; i++) if (tr.kerbOn[i]) kerbs += `<circle cx="${X(tr.x[i]).toFixed(1)}" cy="${Z(tr.z[i]).toFixed(1)}" r="3" fill="#ff2d55"/>`;
    let elev = ''; for (let i = 0; i < tr.n; i += 25) elev += `<text x="${X(tr.x[i]) + 8}" y="${Z(tr.z[i])}" font-size="16" fill="#9fd">${tr.y[i].toFixed(0)}</text>`;
    const st = pointAt(tr, def.startS, 0);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#10131f"/>
<path d="${path}" fill="none" stroke="#2a3050" stroke-width="${2 * (6 + VERGE)}"/><path d="${path}" fill="none" stroke="#ddd" stroke-width="12"/>${kerbs}${elev}
<circle cx="${X(st.x)}" cy="${Z(st.z)}" r="10" fill="#0f0"/><text x="20" y="40" font-size="28" fill="#fff">${def.id} ${tr.length.toFixed(0)} m</text></svg>`;
    fs.writeFileSync(out, svg); console.log('  map ->', out);
  }
}
console.log(fail ? `${fail} FAILED` : 'all track checks passed');
process.exit(fail ? 1 : 0);
