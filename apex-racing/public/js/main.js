// Neon Apex GP - boot: WebGPU check (branded fallback if missing), loading screen with real progress,
// renderer + title scene, room connection, menus, F3 profiler, main loop.
import { GPU, GPUUnavailable } from './engine/gpu.js';
import { Profiler } from './engine/profiler.js';
import { Camera } from './engine/camera.js';
import { sunDirection } from './engine/math.js';
import { Renderer } from './render/renderer.js';
import { buildTitleScene } from './render/titlescene.js';
import { Net, store, roomCode } from './net.js';
import { Menu, LIVERIES, toast } from './ui/menu.js';
import { setVolume, unlockAudio } from './ui/audio.js';

const APEX = globalThis.APEX;
const $ = id => document.getElementById(id);
const show = id => { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === id); };

const TIPS = [
  'Brake in a straight line, then turn in. Trail off the brake as you reach the apex.',
  'Press F3 at any time to see frame rate, GPU timings and memory.',
  'Share the 4-letter room code: friends type it in the lobby and join your grid.',
  'The host can change track, laps, AI rivals, weather and time of day from the Room page.',
  'Low preset is made for laptops with built-in graphics. High targets 1080p at 60 FPS.',
];
$('ldTip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
const progress = (f, label) => { $('ldBar').style.width = Math.round(f * 100) + '%'; if (label) $('ldStep').textContent = label; };

// ---------- options (saved locally) ----------
// Each preset is a pixel budget (render resolution never exceeds it) + MSAA. The Render scale option multiplies on top.
const PRESETS = { low: { renderScale: 1, msaa: false, cap: 1280 * 720 }, medium: { renderScale: 1, msaa: true, cap: 1600 * 900 }, high: { renderScale: 1, msaa: true, cap: 1920 * 1080 }, ultra: { renderScale: 1, msaa: true, cap: 3840 * 2160 } };
const options = Object.assign({ preset: 'high', renderScale: 1, msaa: true, stats: false, dynamicRes: true, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, volume: 0.6 }, store.get('options', {}));
const profile = Object.assign({ name: 'Driver ' + (100 + Math.floor(Math.random() * 900)), car: 'vanta', livery: LIVERIES[0] }, store.get('profile', {}));
profile.name = APEX.cleanName(profile.name); profile.car = APEX.CARS[APEX.carIndex(profile.car)].id; profile.livery = APEX.cleanColor(profile.livery, LIVERIES[0]);
setVolume(options.volume);

function fallback(err) {
  const why = {
    'no-webgpu': 'This browser does not have WebGPU.',
    'insecure': 'WebGPU only works on secure pages (https, or http://127.0.0.1 on this computer). Open the game through the Neon Arcade link instead of a LAN address.',
    'no-adapter': 'WebGPU is there, but no graphics card was made available to it. Graphics acceleration is probably switched off.',
    'no-device': 'Your graphics card refused to start WebGPU. A driver update usually fixes this.',
    'no-context': 'The page could not get a WebGPU drawing surface.',
    'lost': 'The graphics card stopped responding (driver reset or the GPU went to sleep). Press TRY AGAIN.',
  };
  $('fbWhy').textContent = why[err.code] || ('WebGPU failed to start: ' + err.message);
  show('fallback');
}

async function boot() {
  const canvas = $('view');
  let gpu;
  progress(0.03, 'Checking WebGPU...');
  try { gpu = await GPU.create(canvas); }
  catch (e) { return fallback(e instanceof GPUUnavailable ? e : new GPUUnavailable('no-device', e.message)); }
  gpu.lost.then(info => { if (info.reason !== 'destroyed') fallback(new GPUUnavailable('lost', info.message)); });

  const profiler = new Profiler(gpu); profiler.el = $('prof');
  const renderer = new Renderer(gpu, profiler);
  try {
    await renderer.init((f, label) => progress(0.08 + f * 0.72, label));
    progress(0.84, 'Building the track...');
    const scene = buildTitleScene(gpu);
    renderer.setScene(scene);
    profiler.extra['Instances'] = scene.instances;
  } catch (e) {
    console.error(e);
    $('ldStep').textContent = 'The graphics engine failed to start.';
    $('ldErr').style.display = 'block'; $('ldErr').textContent = String(e.message || e);
    return;
  }

  // ---------- room ----------
  progress(0.9, 'Joining the room...');
  const net = new Net();
  net.loadSettings();
  net.connect(profile);
  const code = roomCode();

  // ---------- quality ----------
  if (!store.get('options', null)) {        // first visit: guess a preset from the GPU, the user can change it
    const v = String(gpu.info.vendor || '').toLowerCase(), a = String(gpu.info.architecture || '').toLowerCase();
    const integrated = (v.includes('intel') && !a.startsWith('xe-hpg') && !a.startsWith('xe2-hpg')) || v.includes('qualcomm') || v.includes('arm') || v.includes('imagination');
    const preset = integrated ? 'low' : v.includes('apple') ? 'medium' : 'high';
    Object.assign(options, { preset, renderScale: PRESETS[preset].renderScale, msaa: PRESETS[preset].msaa });
  }
  const applyQuality = () => {
    const p = PRESETS[options.preset] || PRESETS.high;
    renderer.quality.msaa = options.msaa ? 4 : 1;
    renderer.quality.userScale = options.renderScale;
    renderer.quality.cap = p.cap;
    if (options.stats !== profiler.visible) profiler.toggle();
  };
  const onOptions = patch => {
    if (patch.preset) { const p = PRESETS[patch.preset]; Object.assign(options, { preset: patch.preset, renderScale: p.renderScale, msaa: p.msaa }); }
    else Object.assign(options, patch);
    if ('volume' in patch) setVolume(options.volume);
    store.set('options', options); applyQuality();
  };
  applyQuality();
  const onProfile = patch => { Object.assign(profile, patch); store.set('profile', profile); net.sendProfile(patch); };
  const menu = new Menu({ net, options, profile, onOptions, onProfile, code });

  // ---------- sizing + dynamic resolution ----------
  // The canvas itself is sized to the render resolution whenever we render below 100%, so no pass ever runs at
  // full screen size for nothing; the browser upscales. Above 100% (supersampling) we render big and scale down.
  let dispW = 1, dispH = 1, dyn = 1, dynT = 0, lastScaleKey = '';
  const MIN_DYN = { low: 0.5, medium: 0.6, high: 0.75, ultra: 0.75 };
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    dispW = Math.max(1, Math.round(canvas.clientWidth * dpr)); dispH = Math.max(1, Math.round(canvas.clientHeight * dpr));
    lastScaleKey = '';
  };
  resize(); addEventListener('resize', resize);
  const applySize = now => {
    const q = renderer.quality, st = profiler.stats();
    // dynamic resolution: drop quickly when frames are slow, recover slowly when there is headroom
    if (!options.dynamicRes) dyn = 1;
    else if (now - dynT > 1000 && profiler.samples.length > 30) {
      const gpuHeadroom = !profiler.ts || profiler.gpuMs < 11;
      if (st.avg > 18.2) { dyn = Math.max(MIN_DYN[options.preset] || 0.75, dyn * 0.9); dynT = now; profiler.samples.length = 0; }
      else if (st.avg < 17.0 && gpuHeadroom && dyn < 1) { dyn = Math.min(1, dyn * 1.05); dynT = now + 2000; profiler.samples.length = 0; }
    }
    const capScale = Math.min(1, Math.sqrt(q.cap / (dispW * dispH)));
    let eff = Math.round(q.userScale * capScale * dyn * 20) / 20;
    eff = Math.max(0.25, eff);
    const key = dispW + 'x' + dispH + '@' + eff;
    if (key !== lastScaleKey) {
      lastScaleKey = key;
      const max = gpu.device.limits.maxTextureDimension2D;
      let cw = eff <= 1 ? Math.round(dispW * eff) : dispW, ch = eff <= 1 ? Math.round(dispH * eff) : dispH;
      q.renderScale = eff <= 1 ? 1 : eff;
      if (cw * q.renderScale > max || ch * q.renderScale > max) q.renderScale = Math.min(max / cw, max / ch);
      canvas.width = Math.max(1, cw); canvas.height = Math.max(1, ch);
      renderer.resize(canvas.width, canvas.height);
    }
    return eff;
  };

  // ---------- input ----------
  const KEYMAP = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', ' ': 'enter', Escape: 'back', Backspace: 'back', w: 'up', s: 'down', a: 'left', d: 'right' };
  addEventListener('keydown', e => {
    if (e.key === 'F3') { e.preventDefault(); onOptions({ stats: !options.stats }); if (menu.page === 'options') menu.renderSheet(true); return; }
    if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'text') return;
    const k = KEYMAP[e.key]; if (!k) return;
    e.preventDefault(); menu.key(k);
  });
  addEventListener('pointerdown', unlockAudio, { once: true });
  // gamepad: d-pad / left stick to move, A = select, B = back (with key repeat)
  const pad = { held: {}, next: {} };
  const pollPad = now => {
    const gp = (navigator.getGamepads ? [...navigator.getGamepads()] : []).find(g => g && g.connected);
    if (!gp) return;
    const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0, b = i => gp.buttons[i] && gp.buttons[i].pressed;
    const state = { up: b(12) || ay < -0.55, down: b(13) || ay > 0.55, left: b(14) || ax < -0.55, right: b(15) || ax > 0.55, enter: b(0), back: b(1) };
    for (const [k, on] of Object.entries(state)) {
      if (on && !pad.held[k]) { menu.key(k); pad.next[k] = now + 380; }
      else if (on && now > pad.next[k] && k !== 'enter' && k !== 'back') { menu.key(k); pad.next[k] = now + 110; }
      pad.held[k] = on;
    }
  };

  // ---------- title camera + golden-hour light ----------
  const cam = new Camera();
  const env = { sunDir: sunDirection(5, -22), sunColor: [16, 16, 16], sunDisk: 30, exposure: 1.4, fog: 1.0, ambient: 1.0 };
  const t0 = performance.now();
  progress(1, 'Ready');
  show('title');

  const frame = now => {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    profiler.beginFrame(now);
    pollPad(now);
    const t = (now - t0) / 1000, slow = options.reducedMotion ? 0.15 : 1;
    cam.pos = [3.2 + Math.sin(t * 0.07 * slow) * 3.5, 1.25 + Math.sin(t * 0.11 * slow) * 0.35, -30 + Math.sin(t * 0.05 * slow) * 7];
    cam.target = [-1.5 + Math.sin(t * 0.06 * slow) * 2, 3.2, 14];
    cam.fov = 52 * Math.PI / 180;
    const eff = applySize(now);
    renderer.render(cam, env, t);
    profiler.extra['Render size'] = `${renderer.width} x ${renderer.height} (${Math.round(eff * 100)}% of ${dispW} x ${dispH}, dynamic ${Math.round(dyn * 100)}%) MSAA ${renderer.quality.msaa}x`;
    profiler.extra['Preset'] = options.preset;
    profiler.extra['Room'] = `${code || 'local'} · ${net.status} · ping ${Math.round(net.ping)} ms`;
    profiler.draw(now);
  };
  requestAnimationFrame(frame);
  window.__apex = { gpu, renderer, profiler, net, cam, env, options };   // for debugging from the console
  if (net.isHost) toast('You are the host. Pick a track in Room & track.');
}

boot().catch(e => { console.error(e); $('ldErr').style.display = 'block'; $('ldErr').textContent = String(e && e.stack || e); });
