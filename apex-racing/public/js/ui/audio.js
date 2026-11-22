// Tiny synthesised UI sounds through a master limiter. The audio context starts on the first key/click
// (browsers block sound before that).
let ctx = null, master = null;
export const audio = { volume: 0.6 };
export function unlockAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -6; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
    master = ctx.createGain(); master.gain.value = audio.volume;
    master.connect(lim); lim.connect(ctx.destination);
  } catch { ctx = null; }
}
export function setVolume(v) { audio.volume = v; if (master) master.gain.value = v; }
function blip(freq, dur, type = 'sine', vol = 0.15, slide = 0) {
  if (!ctx || !master) return;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t); if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
}
export const sfx = {
  move: () => blip(1250, 0.045, 'triangle', 0.08),
  change: () => blip(900, 0.06, 'square', 0.04, 1.3),
  select: () => { blip(660, 0.08, 'triangle', 0.12); setTimeout(() => blip(990, 0.12, 'triangle', 0.12), 60); },
  back: () => blip(520, 0.1, 'triangle', 0.1, 0.6),
  deny: () => blip(180, 0.16, 'sawtooth', 0.06),
};
