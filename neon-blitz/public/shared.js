// Neon Blitz - shared code: the 4 maps + player physics. Loaded by server.js (require) and the browser (<script src="shared.js">).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const T = 32, MW = 48, MH = 27;              // tile size, map size in tiles (1536 x 864 px)
  const AIR = 0, SOLID = 1, THIN = 2, PAD = 3;
  const PW = 20, PH = 36, HW = PW / 2, HH = PH / 2;
  const DT = 1 / 60;
  const P = { gravity: 1900, run: 300, groundAccel: 3400, groundFric: 3000, airAccel: 1900, jump: 640, maxFall: 1100, pad: 940, coyote: 0.09 };
  const EVT = { JUMP: 1, LAND: 2, PAD: 4 };

  // Maps are drawn for the LEFT half (x 0..23) and mirrored, so every map is fair for both teams.
  // ops: ['#' solid | '=' one-way platform | '^' jump pad, x0, y0, x1, y1]. Items stand ON the tile row given.
  const MAPS = [
    { name: 'Neon Grid', blurb: 'Open tiers and a bridge over the middle', theme: { sky: ['#06051a', '#1a0f45'], solid: '#26237a', edge: '#7a4dff', accent: '#00e5ff', glow: '#7a4dff' },
      ops: [['#', 0, 0, 47, 0], ['#', 0, 0, 0, 26], ['#', 0, 24, 47, 26], ['#', 11, 22, 12, 23],
        ['=', 2, 21, 7, 21], ['=', 14, 21, 19, 21], ['=', 4, 18, 9, 18], ['=', 12, 18, 16, 18], ['=', 19, 18, 23, 18], ['=', 1, 15, 5, 15], ['=', 8, 15, 12, 15], ['=', 16, 15, 20, 15],
        ['=', 4, 12, 9, 12], ['=', 13, 12, 17, 12], ['=', 19, 12, 23, 12], ['=', 8, 9, 14, 9], ['=', 17, 9, 21, 9], ['^', 21, 23, 21, 23], ['^', 2, 23, 2, 23]],
      spawns: [[3, 23], [9, 23], [5, 17], [10, 14], [16, 17]], weapons: [[16, 20], [21, 17], [11, 8]], health: [[5, 20], [2, 14], [14, 11]] },
    { name: 'The Foundry', blurb: 'Furnace pit in the middle: mind the gap', theme: { sky: ['#1a0707', '#3a1208'], solid: '#5a3026', edge: '#ff8a3d', accent: '#ffd45a', glow: '#ff5a2a' },
      ops: [['#', 0, 0, 47, 0], ['#', 0, 0, 0, 26], ['#', 0, 24, 19, 26], ['#', 6, 20, 9, 23], ['#', 14, 21, 15, 23],
        ['=', 21, 21, 23, 21], ['=', 1, 20, 5, 20], ['=', 10, 18, 13, 18], ['=', 16, 18, 19, 18], ['=', 21, 17, 23, 17], ['=', 2, 16, 8, 16], ['=', 12, 15, 15, 15], ['=', 17, 14, 21, 14],
        ['=', 1, 12, 5, 12], ['=', 8, 11, 12, 11], ['=', 15, 11, 19, 11], ['=', 21, 10, 23, 10], ['=', 4, 8, 8, 8], ['=', 12, 8, 17, 8], ['^', 18, 23, 18, 23], ['^', 3, 23, 3, 23]],
      spawns: [[2, 23], [11, 23], [3, 19], [13, 17], [18, 17]], weapons: [[22, 20], [14, 14], [14, 7]], health: [[7, 15], [2, 11], [22, 9]] },
    { name: 'Skyline Rooftops', blurb: 'Leap between buildings: the street is deadly', theme: { sky: ['#0a0618', '#3a1046'], solid: '#3d1c5c', edge: '#ff3d81', accent: '#ffd45a', glow: '#ff3d81' },
      ops: [['#', 0, 0, 47, 0], ['#', 0, 0, 0, 26], ['#', 0, 20, 6, 26], ['#', 10, 17, 15, 26], ['#', 18, 21, 23, 26], ['#', 14, 15, 15, 16], ['#', 21, 18, 23, 20],
        ['=', 2, 16, 5, 16], ['=', 8, 13, 11, 13], ['=', 15, 12, 19, 12], ['=', 19, 17, 22, 17], ['=', 1, 12, 4, 12], ['=', 5, 9, 9, 9], ['=', 12, 10, 16, 10], ['=', 19, 8, 23, 8], ['^', 4, 19, 4, 19], ['^', 20, 20, 20, 20]],
      spawns: [[3, 19], [12, 16], [19, 20], [4, 15], [16, 11]], weapons: [[14, 14], [21, 7], [7, 8]], health: [[2, 11], [16, 9], [22, 7]] },
    { name: 'Core Reactor', blurb: 'Fight around a huge central tower', theme: { sky: ['#03121a', '#07404a'], solid: '#13495a', edge: '#00e5ff', accent: '#5dff8a', glow: '#00e5ff' },
      ops: [['#', 0, 0, 47, 0], ['#', 0, 0, 0, 26], ['#', 0, 24, 47, 26], ['#', 22, 9, 23, 23], ['#', 2, 22, 4, 23],
        ['=', 17, 21, 21, 21], ['=', 12, 18, 16, 18], ['=', 18, 17, 21, 17], ['=', 7, 15, 11, 15], ['=', 13, 14, 17, 14], ['=', 18, 12, 21, 12], ['=', 2, 12, 6, 12], ['=', 9, 11, 13, 11], ['=', 14, 8, 21, 8],
        ['=', 3, 18, 6, 18], ['=', 6, 8, 10, 8], ['^', 9, 23, 9, 23], ['^', 20, 23, 20, 23]],
      spawns: [[3, 21], [14, 23], [5, 17], [9, 14], [19, 11]], weapons: [[19, 16], [10, 10], [17, 7]], health: [[19, 20], [4, 11], [8, 7]] },
  ];

  const cache = [];
  function getMap(i) {
    i = ((i | 0) % MAPS.length + MAPS.length) % MAPS.length;
    if (cache[i]) return cache[i];
    const def = MAPS[i], tiles = new Uint8Array(MW * MH);
    const code = { '#': SOLID, '=': THIN, '^': PAD };
    for (const [c, x0, y0, x1, y1] of def.ops) for (const [a, b] of [[x0, x1], [MW - 1 - x1, MW - 1 - x0]])
      for (let y = y0; y <= y1; y++) for (let x = a; x <= b; x++) if (x >= 0 && x < MW && y >= 0 && y < MH && (c !== '=' || tiles[y * MW + x] === AIR)) tiles[y * MW + x] = code[c];
    const pos = ([x, y]) => ({ x: (x + .5) * T, y: (y + 1) * T - HH, tx: x, ty: y });
    const both = list => list.flatMap(p => [pos(p), pos([MW - 1 - p[0], p[1]])]);
    const m = { index: i, name: def.name, blurb: def.blurb, theme: def.theme, W: MW, H: MH, T, tiles,
      spawns: both(def.spawns), weapons: both(def.weapons), health: both(def.health) };
    return (cache[i] = m);
  }
  const tileAt = (m, tx, ty) => (tx < 0 || tx >= MW || ty < 0 ? SOLID : ty >= MH ? AIR : m.tiles[ty * MW + tx]);  // below the map = open void (a deadly pit)

  // ---------- movement ----------
  function newBody(x, y) { return { x, y, vx: 0, vy: 0, ground: false, coyote: 0, jumpHeld: false, drop: 0, face: 1, evt: 0, cut: false }; }
  function hits(m, x, y, prevBottom, thin) {
    const x0 = Math.floor((x - HW) / T), x1 = Math.floor((x + HW - 0.001) / T), y0 = Math.floor((y - HH) / T), y1 = Math.floor((y + HH - 0.001) / T);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const t = tileAt(m, tx, ty);
      if (t === SOLID) return true;
      if (t === THIN && thin && prevBottom <= ty * T + 0.01 && y + HH > ty * T) return true;
    }
    return false;
  }
  function moveAxis(m, b, d, axis) {
    while (Math.abs(d) > 1e-6) {
      const s = Math.abs(d) > 1 ? Math.sign(d) : d;
      const nx = axis === 0 ? b.x + s : b.x, ny = axis === 1 ? b.y + s : b.y;
      if (hits(m, nx, ny, b.y + HH, axis === 1 && s > 0 && b.drop <= 0)) return true;
      b.x = nx; b.y = ny; d -= s;
    }
    return false;
  }
  // inp = { l, r, u, d }
  function step(m, b, inp, dt) {
    b.evt = 0;
    b.drop = Math.max(0, b.drop - dt); b.coyote = Math.max(0, b.coyote - dt);
    const mx = (inp.r ? 1 : 0) - (inp.l ? 1 : 0);
    if (mx) b.face = mx;
    const was = b.ground;
    b.ground = b.vy >= -1 && hits(m, b.x, b.y + 1.01, b.y + HH, b.drop <= 0);
    if (b.ground) b.coyote = P.coyote;
    if (b.ground && !was) b.evt |= EVT.LAND;
    if (inp.d && b.ground && b.drop <= 0 && !hits(m, b.x, b.y + 1.01, b.y + HH, false)) { b.drop = 0.22; b.ground = false; }
    b.vy = Math.min(P.maxFall, b.vy + P.gravity * dt);
    if (b.ground) {
      if (mx === 0) { const f = P.groundFric * dt; b.vx = Math.abs(b.vx) <= f ? 0 : b.vx - Math.sign(b.vx) * f; }
      else if (Math.abs(b.vx) <= P.run || Math.sign(b.vx) !== mx) b.vx += Math.max(-P.groundAccel * dt, Math.min(P.groundAccel * dt, mx * P.run - b.vx));
      else b.vx -= Math.sign(b.vx) * P.groundFric * 0.3 * dt;
    } else if (mx !== 0) {
      if (Math.abs(b.vx) < P.run || Math.sign(b.vx) !== mx) b.vx += Math.max(-P.airAccel * dt, Math.min(P.airAccel * dt, mx * P.run - b.vx));
    } else if (Math.abs(b.vx) > P.run) b.vx -= Math.sign(b.vx) * 400 * dt;
    if (inp.u && !b.jumpHeld && (b.ground || b.coyote > 0)) { b.vy = -P.jump; b.coyote = 0; b.ground = false; b.cut = true; b.evt |= EVT.JUMP; }
    if (!inp.u && b.cut && b.vy < -200) b.vy *= 0.5;          // short hop when you let go early
    if (b.vy >= 0 || !inp.u) b.cut = false;
    b.jumpHeld = !!inp.u;
    if (moveAxis(m, b, b.vx * dt, 0)) b.vx = 0;
    if (moveAxis(m, b, b.vy * dt, 1)) { if (b.vy > 0) b.ground = true; b.vy = 0; }
    // jump pad: the tile the feet are in
    if (b.vy >= 0 && tileAt(m, Math.floor(b.x / T), Math.floor((b.y + HH - 1) / T)) === PAD) { b.vy = -P.pad; b.ground = false; b.evt |= EVT.PAD; }
  }
  // line of sight through solid tiles (thin platforms don't block shots)
  function los(m, x0, y0, x1, y1) {
    const d = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(d / 8);
    for (let i = 1; i < n; i++) { const t = i / n; if (tileAt(m, Math.floor((x0 + (x1 - x0) * t) / T), Math.floor((y0 + (y1 - y0) * t) / T)) === SOLID) return false; }
    return true;
  }
  return { T, MW, MH, AIR, SOLID, THIN, PAD, PW, PH, HW, HH, DT, P, EVT, MAPS, getMap, tileAt, newBody, hits, step, los };
});
