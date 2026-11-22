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
  light: () => blip(880, 0.22, 'sine', 0.16),
  go: () => blip(1760, 0.45, 'sine', 0.2),
};

// Engine: two detuned saws at the firing frequency + a sub octave through a low-pass that opens with load,
// plus filtered noise for tyre squeal and wind. (Phase 7 replaces this with the full granular/additive engine.)
export function createEngine() {
  if (!ctx || !master) return null;
  const out = ctx.createGain(); out.gain.value = 0; out.connect(master);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3; lp.connect(out);
  const oscs = [['sawtooth', 1, 0.5], ['sawtooth', 1.006, 0.4], ['square', 0.5, 0.35]].map(([type, mul, g]) => {
    const o = ctx.createOscillator(), gn = ctx.createGain(); o.type = type; gn.gain.value = g; o.connect(gn); gn.connect(lp); o.start(); return { o, mul };
  });
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.start();
  const sq = ctx.createBiquadFilter(); sq.type = 'bandpass'; sq.frequency.value = 1100; sq.Q.value = 6;
  const sqG = ctx.createGain(); sqG.gain.value = 0; noise.connect(sq); sq.connect(sqG); sqG.connect(master);
  const wind = ctx.createBiquadFilter(); wind.type = 'lowpass'; wind.frequency.value = 500;
  const windG = ctx.createGain(); windG.gain.value = 0; noise.connect(wind); wind.connect(windG); windG.connect(master);
  return {
    update(rpm, throttle, speed, slip, on) {
      const t = ctx.currentTime, f = Math.max(20, rpm / 60 * 3);       // 6-cylinder firing frequency
      for (const { o, mul } of oscs) o.frequency.setTargetAtTime(f * mul, t, 0.02);
      lp.frequency.setTargetAtTime(300 + throttle * 2600 + rpm * 0.12, t, 0.04);
      out.gain.setTargetAtTime(on ? 0.05 + throttle * 0.09 : 0, t, 0.06);
      sqG.gain.setTargetAtTime(on ? Math.min(0.12, Math.max(0, slip - 0.6) * 0.15) : 0, t, 0.05);
      windG.gain.setTargetAtTime(on ? Math.min(0.12, speed * speed * 0.000025) : 0, t, 0.1);
    },
    stop() { try { out.gain.setTargetAtTime(0, ctx.currentTime, 0.05); sqG.gain.value = 0; windG.gain.value = 0; } catch {} },
  };
}
