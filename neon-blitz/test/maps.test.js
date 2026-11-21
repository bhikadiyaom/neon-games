// node neon-blitz/test/maps.test.js : map sanity + reachability using the REAL player physics
const NB = require('../public/shared.js');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  FAIL:', msg); } };

for (let i = 0; i < NB.MAPS.length; i++) {
  const m = NB.getMap(i), { T, W, H } = m;
  // symmetry
  let sym = true; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m.tiles[y * W + x] !== m.tiles[y * W + (W - 1 - x)]) sym = false;
  ok(sym, `${m.name}: mirror symmetric`);
  ok(m.spawns.length >= 8 && m.weapons.length >= 4 && m.health.length >= 4, `${m.name}: enough spawns/pickups`);
  // every item stands on something with headroom
  const standable = (tx, ty) => { const a = NB.tileAt(m, tx, ty), b = NB.tileAt(m, tx, ty + 1); return (a === NB.AIR || a === NB.PAD) && (b === NB.SOLID || b === NB.THIN) && NB.tileAt(m, tx, ty - 1) !== NB.SOLID && NB.tileAt(m, tx, ty - 2) !== NB.SOLID; };
  const items = [...m.spawns, ...m.weapons, ...m.health];
  ok(items.every(p => standable(p.tx, p.ty)), `${m.name}: items stand on a floor with headroom: ${items.filter(p => !standable(p.tx, p.ty)).map(p => p.tx + ',' + p.ty).join(' ')}`);
  ok(items.every(p => !NB.hits(m, p.x, p.y, 1e9, false)), `${m.name}: items not inside walls`);

  // reachability: nodes are standing tiles; edges come from simulating runs / jumps / drops
  const key = (tx, ty) => ty * W + tx;
  const edges = (tx, ty) => {
    const out = new Set();
    for (const dir of [-1, 0, 1]) for (const hold of [0, 0.12, 0.3, 0.6]) for (const drop of [0, 1]) for (const delay of [0, 0.2, 0.4]) {
      if (drop && hold) continue;
      const b = NB.newBody((tx + .5) * T, (ty + 1) * T - NB.HH);
      for (let k = 0; k < 6; k++) NB.step(m, b, {}, NB.DT);
      for (let k = 0; k < 150; k++) {
        const t = k / 60;
        const inp = { l: dir < 0, r: dir > 0, u: hold > 0 && t < hold, d: drop && k < 4 };
        if (delay && t < delay) { inp.l = inp.r = false; if (!drop) inp.u = false; }
        if (hold === 0 && !drop) inp.u = false;
        NB.step(m, b, inp, NB.DT);
        if (b.y > H * T) break;
        if (b.ground) { const sx = Math.floor(b.x / T), sy = Math.floor((b.y + NB.HH - 1) / T); out.add(key(sx, sy)); }
      }
    }
    return out;
  };
  const start = m.spawns[0], seen = new Set([key(start.tx, start.ty)]), q = [[start.tx, start.ty]];
  for (let k = 0; k < q.length; k++) { const [tx, ty] = q[k]; for (const n of edges(tx, ty)) if (!seen.has(n)) { seen.add(n); q.push([n % W, (n / W) | 0]); } }
  const unreachable = items.filter(p => !seen.has(key(p.tx, p.ty)));
  ok(unreachable.length === 0, `${m.name}: all spawns/pickups reachable (unreachable: ${unreachable.map(p => p.tx + ',' + p.ty).join(' ')})`);
  console.log(`${m.name}: ${seen.size} reachable standing tiles, ${items.length} items checked`);
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
