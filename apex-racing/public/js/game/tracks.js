// Track catalogue: each circuit is a few control points + rules. Everything else (road, kerbs, terrain, props,
// minimap, grid, sectors) is generated from this. Index matches APEX.MAPS.
const g2 = (x, z, cx, cz, r) => Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (2 * r * r));

export const VALMORE = {
  id: 'valmore',
  width: 12,
  step: 2,
  // [x, z, width?]: the circuit runs north up the main straight, then round clockwise-from-above
  points: [
    [0, -150, 14], [0, 120, 14], [0, 420, 14], [22, 540], [92, 590], [200, 588], [300, 616], [384, 692], [470, 736],
    [556, 704], [600, 614], [592, 470], [574, 316], [604, 214], [642, 128], [630, 40], [578, 2], [520, 28], [500, 110],
    [430, 190], [330, 232], [242, 202], [204, 120], [190, 0], [158, -112], [108, -196], [40, -232], [-4, -214],
  ],
  // rolling hills: a big hill the back section climbs, a mound in the infield, a dip in the south, distant ridges
  hills(x, z) {
    let h = 30 * g2(x, z, 500, 600, 260) + 9 * g2(x, z, 330, 80, 170) - 7 * g2(x, z, 200, -260, 260)
      + 3 * Math.sin(x * 0.011 + 0.7) * Math.cos(z * 0.009) + 1.4 * Math.sin(x * 0.031 + z * 0.023);
    const dx = x - 300, dz = z - 250, r = Math.hypot(dx, dz);
    if (r > 950) { const a = Math.atan2(dz, dx); h += Math.min(220, (r - 950) * 0.16) * (0.55 + 0.25 * Math.sin(a * 5 + 1) + 0.2 * Math.sin(a * 11 + 2)); }
    return h;
  },
  bankGain: 90, maxBank: 0.06, kerbRadius: 160,
  startS: 150,                 // the start/finish line, metres along the spline from the first point (main straight)
  sectors: [0.34, 0.68],       // sector boundaries as fractions of a lap
  time: 'sunset',
};

export const TRACKS = [VALMORE];
export const trackFor = mapIndex => TRACKS[mapIndex] || VALMORE;
