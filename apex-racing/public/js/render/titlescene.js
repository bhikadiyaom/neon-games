// Title-screen scene: a start/finish straight with gantry and start lights, armco, a grandstand, trees,
// rolling hills, and a row of material test spheres (paint, chrome, gold, rubber, carbon, neon).
// Phase 2 replaces this with the real Valmore Hills circuit built from its spline.
import { MeshPool, plane, box, sphere, cylinder } from './meshes.js';
import { trs } from '../engine/math.js';
import { INST_FLOATS } from './renderer.js';

export function buildTitleScene(gpu) {
  const pool = new MeshPool();
  pool.add('plane', plane(1, 1)); pool.add('box', box()); pool.add('sphere', sphere(40, 80)); pool.add('sphereLo', sphere(10, 20)); pool.add('cyl', cylinder(24));
  pool.upload(gpu);

  const list = [];
  const add = (mesh, model, base, pbr, emit = [0, 0, 0, 0]) => list.push({ mesh, model, base, pbr, emit });
  const mat = (r, g, b, metal = 0, rough = 0.5, coat = 0, kind = 0) => ({ base: [r, g, b, 1], pbr: [metal, rough, coat, kind] });
  const put = (mesh, pos, size, m, emit, yaw = 0) => add(mesh, trs(pos, yaw, 0, 0, size), m.base, m.pbr, emit);

  // ground + track surface (procedural in the shader)
  put('plane', [0, 0, 0], [20000, 1, 20000], mat(1, 1, 1, 0, 1, 0, 1));

  // start gantry with sponsor banner and five start lights (three lit, like a start in progress)
  const steel = mat(0.16, 0.17, 0.19, 0.85, 0.38), paint = mat(0.06, 0.065, 0.08, 0, 0.45, 0.6);
  for (const x of [-9.6, 9.6]) put('box', [x, 3.9, 0], [0.8, 7.8, 0.8], steel);
  put('box', [0, 7.7, 0], [20.4, 1.5, 1.1], paint);
  put('box', [0, 7.7, -0.6], [13, 1.15, 0.1], mat(0.78, 0.78, 0.8, 0, 0.4));
  put('box', [-4.3, 7.7, -0.66], [4.2, 1.15, 0.05], mat(0.6, 0.02, 0.03, 0, 0.35));
  put('box', [4.3, 7.7, -0.66], [4.2, 1.15, 0.05], mat(0.02, 0.35, 0.12, 0, 0.35));
  put('box', [0, 6.25, -0.15], [5.6, 1.0, 0.6], mat(0.02, 0.02, 0.025, 0, 0.6));
  for (let i = 0; i < 5; i++) put('sphere', [-2.2 + i * 1.1, 6.25, -0.48], [0.7, 0.7, 0.7], mat(0.08, 0.01, 0.01, 0, 0.2), i < 3 ? [1, 0.02, 0.01, 3.5] : [0.12, 0.01, 0.01, 0.3]);

  // material test spheres on the left verge
  const spheres = [mat(0.55, 0.015, 0.02, 0, 0.32, 1), mat(0.96, 0.95, 0.92, 1, 0.07), mat(1.0, 0.77, 0.34, 1, 0.24),
    mat(0.025, 0.025, 0.028, 0, 0.92), mat(0.018, 0.018, 0.02, 0, 0.28, 1), mat(0.02, 0.02, 0.03, 0, 0.3)];
  spheres.forEach((m, i) => put('sphere', [-9.5, 0.85, 8 + i * 4.2], [1.7, 1.7, 1.7], m, i === 5 ? [0.0, 0.9, 1.0, 6] : undefined));

  // armco both sides (instanced), posts
  const armco = mat(0.62, 0.63, 0.66, 1, 0.32);
  for (const x of [-12.6, 12.6]) for (let z = -400; z < 600; z += 4) put('box', [x, 0.62, z + 2], [0.12, 0.34, 4.02], armco);
  const post = mat(0.3, 0.31, 0.33, 0.9, 0.5);
  for (const x of [-12.75, 12.75]) for (let z = -400; z < 600; z += 4) put('box', [x, 0.4, z], [0.12, 0.8, 0.12], post);

  // grandstand on the right with roof and pillars
  const concrete = mat(0.42, 0.41, 0.39, 0, 0.9);
  for (let i = 0; i < 9; i++) put('box', [18.5 + i * 1.7, (i + 1) * 0.31, 8], [1.7, (i + 1) * 0.62, 70], concrete);
  for (let i = 0; i < 9; i++) put('box', [18.5 + i * 1.7, (i + 1) * 0.62 + 0.04, 8], [1.6, 0.08, 70], mat(0.55, 0.05, 0.08, 0, 0.6));
  put('box', [25.5, 9.6, 8], [17, 0.3, 74], mat(0.75, 0.76, 0.78, 0.9, 0.35));
  for (let z = -26; z <= 42; z += 11.3) put('cyl', [32.4, 4.8, z], [0.5, 9.6, 0.5], steel);

  // trees beyond the barriers
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 70; i++) {
    const side = rnd() < 0.5 ? -1 : 1, x = side * (22 + rnd() * 140), z = -300 + rnd() * 900;
    if (side > 0 && x < 45 && z > -40 && z < 60) continue;
    const h = 7 + rnd() * 9, w = h * (0.45 + rnd() * 0.2);
    put('cyl', [x, h * 0.2, z], [0.5, h * 0.4, 0.5], mat(0.12, 0.08, 0.05, 0, 0.9));
    put('sphereLo', [x, h * 0.62, z], [w, h * 0.8, w], mat(0.03 + rnd() * 0.02, 0.07 + rnd() * 0.04, 0.02, 0, 0.85));
  }
  // rolling hills on the horizon
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * Math.PI * 2 + 0.3, r = 1600 + (i * 397 % 900);
    put('sphereLo', [Math.sin(a) * r, -60, Math.cos(a) * r], [900 + (i * 211 % 700), 260 + (i * 137 % 200), 700 + (i * 173 % 500)], mat(0.045, 0.085, 0.03, 0, 0.95));
  }

  // group by mesh so each mesh is one instanced draw
  list.sort((a, b) => a.mesh.localeCompare(b.mesh));
  const data = new Float32Array(list.length * INST_FLOATS), draws = [];
  list.forEach((it, i) => {
    const o = i * INST_FLOATS;
    data.set(it.model, o); data.set(it.base, o + 16); data.set(it.pbr, o + 20); data.set(it.emit, o + 24);
    const last = draws[draws.length - 1];
    if (last && last.name === it.mesh) last.count++;
    else draws.push({ name: it.mesh, mesh: pool.get(it.mesh), first: i, count: 1 });
  });
  const instBuf = gpu.bufferWith(data, GPUBufferUsage.STORAGE, 'instances');
  return { pool, instBuf, draws, instances: list.length };
}
