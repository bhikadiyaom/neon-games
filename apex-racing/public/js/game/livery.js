// Liveries painted at runtime on a 2D canvas and uploaded as one layer of the livery texture array.
// Body UVs: u (canvas x) runs along the car from the rear (0) to the nose (1); v (canvas y) runs around the body:
// 0 = left sill, 0.25 = left door, 0.5 = roof / bonnet centre line, 0.75 = right door, 1 = right sill.
// Alpha = how clean and glossy the clear coat is (dirt and matte decals lower it).
// All sponsor names are invented.
import { LIVERY_W, LIVERY_H } from '../render/renderer.js';

export const SPONSORS = ['VEXLAR', 'QUORRA', 'NIMBUSK', 'TARVO', 'ONDREL', 'KYVEX', 'BRISKEL', 'ZANTHO', 'HELVIR', 'PRAXUM'];
const hexRGB = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lum = h => { const [r, g, b] = hexRGB(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
const lin = h => hexRGB(h).map(c => Math.pow(c / 255, 2.2));
const FONT = '"Barlow Condensed", "Rajdhani", sans-serif';

export async function fontsReady() {
  try { await Promise.all([document.fonts.load(`italic 800 64px ${FONT}`), document.fonts.load(`700 64px ${FONT}`)]); } catch { /* offline: fallback fonts */ }
}

// everything a car looks like: { layer, helmet, rim, caliper, canvas }
export function makeLook(o) {
  const color = o.color, dark = lum(color) < 0.45, accent = o.accent || (dark ? '#f2f2f2' : '#111318'), ink = lum(accent) > 0.5 ? '#111318' : '#f2f2f2';
  const c = new OffscreenCanvas(LIVERY_W, LIVERY_H), g = c.getContext('2d'), W = LIVERY_W, H = LIVERY_H;
  let seed = (o.seed || 1) >>> 0; const rnd = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822519) ^ Math.imul(seed ^ (seed >>> 13), 3266489917)) >>> 0) / 4294967296;
  g.fillStyle = color; g.fillRect(0, 0, W, H);
  // twin stripes over the top, full length
  g.fillStyle = accent;
  g.fillRect(0, H * 0.468, W, H * 0.016); g.fillRect(0, H * 0.516, W, H * 0.016);
  // side swooshes (mirrored on the right side)
  const swoosh = (y0, y1, flip) => {
    g.save(); g.fillStyle = accent; g.globalAlpha = 0.95; g.beginPath();
    const a = y => flip ? H - y : y;
    g.moveTo(W * 0.04, a(y0)); g.lineTo(W * 0.32, a(y0)); g.lineTo(W * 0.96, a(y1)); g.lineTo(W * 0.96, a(y1 + H * 0.025)); g.lineTo(W * 0.3, a(y0 + H * 0.05)); g.lineTo(W * 0.04, a(y0 + H * 0.05));
    g.closePath(); g.fill(); g.restore();
  };
  swoosh(H * 0.1, H * 0.3, false); swoosh(H * 0.1, H * 0.3, true);
  // text helper: left-side decals are rotated 180 degrees so they read correctly on the car
  const text = (str, x, y, size, col, rot, weight = 800, italic = true) => {
    g.save(); g.translate(x, y); g.rotate(rot); g.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = col; g.fillText(str, 0, 0); g.restore();
  };
  const plate = (x, y, w, h, rot, num) => {
    g.save(); g.translate(x, y); g.rotate(rot);
    g.fillStyle = '#f4f4f4'; g.beginPath(); g.roundRect(-w / 2, -h / 2, w, h, h * 0.25); g.fill();
    g.lineWidth = 6; g.strokeStyle = accent === '#f2f2f2' ? '#111318' : accent; g.stroke();
    g.font = `italic 800 ${h * 0.86}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#111318'; g.fillText(String(num), 0, h * 0.04);
    g.restore();
  };
  const num = o.number || 7;
  plate(W * 0.53, H * 0.235, 150, 108, Math.PI, num);            // left door
  plate(W * 0.53, H * 0.765, 150, 108, 0, num);                  // right door
  plate(W * 0.84, H * 0.5, 120, 86, Math.PI / 2, num);           // bonnet, read from the cockpit
  // sponsors: front quarter, rear quarter, sills
  const sp = [...SPONSORS].sort(() => rnd() - 0.5);
  const sideText = (str, x, yL, size, col) => { text(str, x, H * yL, size, col, Math.PI); text(str, x, H * (1 - yL), size, col, 0); };
  sideText(sp[0], W * 0.75, 0.2, 46, dark ? '#ffffff' : '#111318');
  sideText(sp[1], W * 0.27, 0.22, 40, dark ? '#ffffff' : '#111318');
  sideText(sp[2], W * 0.52, 0.07, 28, '#d8d8d8');
  sideText((o.name || 'DRIVER').toUpperCase(), W * 0.47, 0.34, 26, ink === '#111318' && !dark ? '#111318' : '#f2f2f2');
  text(sp[3], W * 0.08, H * 0.5, 34, ink, Math.PI / 2);          // rear deck, read from behind
  text('NEON APEX', W * 0.97, H * 0.5, 22, ink, Math.PI / 2);    // nose
  // dirt: grime on the sills and the tail, lowers gloss (alpha) and tints brown
  const dirt = (x0, y0, x1, y1, gx0, gy0, gx1, gy1, amount) => {
    const gr = g.createLinearGradient(gx0, gy0, gx1, gy1);
    gr.addColorStop(0, `rgba(70,55,40,${0.35 * amount})`); gr.addColorStop(1, 'rgba(70,55,40,0)');
    g.fillStyle = gr; g.fillRect(x0, y0, x1 - x0, y1 - y0);
  };
  dirt(0, 0, W, H * 0.14, 0, 0, 0, H * 0.14, 1); dirt(0, H * 0.86, W, H, 0, H, 0, H * 0.86, 1); dirt(0, 0, W * 0.12, H, 0, 0, W * 0.12, 0, 0.8);
  // gloss in alpha: knock some out where the dirt is
  g.globalCompositeOperation = 'destination-out';
  const ga = (x0, y0, x1, y1, gx0, gy0, gx1, gy1, a) => { const gr = g.createLinearGradient(gx0, gy0, gx1, gy1); gr.addColorStop(0, `rgba(0,0,0,${a})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x0, y0, x1 - x0, y1 - y0); };
  ga(0, 0, W, H * 0.12, 0, 0, 0, H * 0.12, 0.5); ga(0, H * 0.88, W, H, 0, H, 0, H * 0.88, 0.5); ga(0, 0, W * 0.1, H, 0, 0, W * 0.1, 0, 0.35);
  g.globalCompositeOperation = 'source-over';
  const acc = lin(accent);
  return { canvas: c, helmet: acc, rim: dark ? [0.08, 0.08, 0.09] : [0.55, 0.55, 0.58], caliper: lin(o.caliper || (dark ? '#ffcc00' : '#e8112d')) };
}

// shared misc layer: tyre sidewall lettering (u = around the tyre, v 0.5..1 = across the sidewall)
export function miscLayer() {
  const c = new OffscreenCanvas(LIVERY_W, LIVERY_H), g = c.getContext('2d'), W = LIVERY_W, H = LIVERY_H;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff'; g.font = `700 ${Math.round(H * 0.07)}px ${FONT}`; g.textBaseline = 'middle';
  const strip = 'NEON APEX  RACING SLICK  305/30 R19      ';
  let x = 0; const y = H * 0.74;
  g.save(); g.scale(1, 1);
  while (x < W) { g.fillText(strip, x, y); x += g.measureText(strip).width; }
  g.restore();
  g.fillRect(0, H * 0.62, W, H * 0.008); g.fillRect(0, H * 0.86, W, H * 0.008);
  return c;
}
