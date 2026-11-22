// Neon Apex GP - boot + game loop: WebGPU check (branded fallback if missing), loading screen with real
// progress, the generated circuit, the car (240 Hz physics, interpolated rendering), title attract lap,
// race / time trial with HUD, pause + results, room connection, menus, F3 profiler.
import { GPU, GPUUnavailable } from './engine/gpu.js';
import { Profiler } from './engine/profiler.js';
import { Camera } from './engine/camera.js';
import { sunDirection, trs } from './engine/math.js';
import { Renderer, SHADOW_PRESETS } from './render/renderer.js';
import { mat } from './render/scene.js';
import { buildWorld } from './game/world.js';
import { trackFor } from './game/tracks.js';
import { Car, DT, SPECS } from './game/car.js';
import { buildCarMeshes, carInstances } from './game/carmesh.js';
import { makeLook, miscLayer, fontsReady } from './game/livery.js';
import { Autopilot } from './game/autopilot.js';
import { CameraRig, CAMERAS } from './game/cameras.js';
import { DriveInput } from './game/input.js';
import { RaceSession } from './game/race.js';
import { locate } from './game/trackcore.js';
import { Net, store, roomCode } from './net.js';
import { Menu, LIVERIES, toast } from './ui/menu.js';
import { Hud } from './ui/hud.js';
import { setVolume, unlockAudio, createEngine } from './ui/audio.js';

const APEX = globalThis.APEX;
const $ = id => document.getElementById(id);
const show = id => { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === id); };
const hexRGB = h => { const n = parseInt(h.slice(1), 16), c = v => Math.pow(((n >> v) & 255) / 255, 2.2); return [c(16), c(8), c(0)]; };
const nextFrame = () => new Promise(r => setTimeout(r, 0));

const TIPS = [
  'Brake in a straight line, then turn in. Feed the throttle in as you unwind the steering.',
  'Press F3 at any time to see frame rate, GPU timings and memory.',
  'Share the 4-letter room code: friends type it in the lobby and join your grid.',
  'Four wheels off the track invalidates the lap. Kerbs are fine.',
  'Press C to change camera, R to put the car back on the track.',
  'Low preset is made for laptops with built-in graphics. High targets 1080p at 60 FPS.',
];
$('ldTip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
const progress = (f, label) => { $('ldBar').style.width = Math.round(f * 100) + '%'; if (label) $('ldStep').textContent = label; };

// ---------- options (saved locally) ----------
// Each preset is a pixel budget (render resolution never exceeds it) + MSAA + shadow quality.
const PRESETS = {
  low: { renderScale: 1, cap: 1280 * 720, taa: true, ao: false, bloom: true, motionBlur: 0, lens: false },
  medium: { renderScale: 1, cap: 1600 * 900, taa: true, ao: true, bloom: true, motionBlur: 0.35, lens: true },
  high: { renderScale: 1, cap: 1920 * 1080, taa: true, ao: true, bloom: true, motionBlur: 0.5, lens: true },
  ultra: { renderScale: 1, cap: 3840 * 2160, taa: true, ao: true, bloom: true, motionBlur: 0.5, lens: true },
};
const presetFields = p => ({ renderScale: p.renderScale, taa: p.taa, ao: p.ao, bloom: p.bloom, motionBlur: p.motionBlur, lens: p.lens });
const options = Object.assign({ preset: 'high', ...presetFields(PRESETS.high), stats: false, dynamicRes: true, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  volume: 0.6, units: 'kmh', assists: 'low', shake: true }, store.get('options', {}));
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

// time of day presets for the sun / exposure
function environment(def, time) {
  const t = time === 'auto' ? def.time : time;
  if (t === 'day') return { name: 'day', sunDir: sunDirection(52, 140), sunColor: [15, 15, 15], sunDisk: 20, ev: -0.2, fog: 0.8, ambient: 1 };
  return { name: 'sunset', sunDir: sunDirection(8, 28), sunColor: [16, 16, 16], sunDisk: 30, ev: 0.25, fog: 1.0, ambient: 1 };
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
  const net = new Net();
  net.loadSettings();
  let world, def;
  try {
    await renderer.init((f, label) => progress(0.05 + f * 0.4, label));
    def = trackFor(0);
    const t0 = performance.now();
    world = await buildWorld(gpu, def, async (f, label) => { progress(0.48 + f * 0.42, 'Building Valmore Hills: ' + label.toLowerCase()); await nextFrame(); },
      S => { for (const id of Object.keys(SPECS)) buildCarMeshes(S, id, SPECS[id]); });
    renderer.setScene(world.scene);
    renderer.setTrackData(world.info, world.tr.length, def.startS, world.tr.ds);
    profiler.extra['World'] = `${world.scene.instances} objects, ${(world.scene.staticTris / 1e6).toFixed(2)} M tris, ${world.scene.draws.length} groups, built in ${Math.round(performance.now() - t0)} ms`;
  } catch (e) {
    console.error(e);
    $('ldStep').textContent = 'The graphics engine failed to start.';
    $('ldErr').style.display = 'block'; $('ldErr').textContent = String(e.message || e);
    return;
  }
  const tr = world.tr;
  // liveries: layer 0 = the player, 1-6 = rivals (phase 5), 7 = shared misc (tyre lettering)
  await fontsReady();
  renderer.setLiveryLayer(7, miscLayer());
  let look = null;
  const paintPlayer = () => { look = makeLook({ color: profile.livery, number: game.number || 7, name: profile.name, seed: 7 }); look.layer = 0; renderer.setLiveryLayer(0, look.canvas); };

  // ---------- room ----------
  progress(0.93, 'Joining the room...');
  net.connect(profile);
  const code = roomCode();

  // ---------- quality ----------
  if (!store.get('options', null)) {        // first visit: guess a preset from the GPU, the user can change it
    const v = String(gpu.info.vendor || '').toLowerCase(), a = String(gpu.info.architecture || '').toLowerCase();
    const integrated = (v.includes('intel') && !a.startsWith('xe-hpg') && !a.startsWith('xe2-hpg')) || v.includes('qualcomm') || v.includes('arm') || v.includes('imagination');
    const preset = integrated ? 'low' : v.includes('apple') ? 'medium' : 'high';
    Object.assign(options, { preset, ...presetFields(PRESETS[preset]) });
  }
  const applyQuality = () => {
    const p = PRESETS[options.preset] || PRESETS.high;
    Object.assign(renderer.quality, { taaHQ: options.preset !== 'low', taa: !!options.taa, ao: !!options.ao, bloom: options.bloom !== false, motionBlur: options.reducedMotion ? 0 : +options.motionBlur || 0, ca: !!options.lens && !options.reducedMotion, grain: !!options.lens });
    renderer.quality.userScale = options.renderScale;
    renderer.quality.cap = p.cap;
    renderer.quality.shadows = SHADOW_PRESETS[options.preset] || SHADOW_PRESETS.high;
    if (options.stats !== profiler.visible) profiler.toggle();
  };
  const onOptions = patch => {
    if (patch.preset) Object.assign(options, { preset: patch.preset, ...presetFields(PRESETS[patch.preset]) });
    else Object.assign(options, patch);
    if ('volume' in patch) setVolume(options.volume);
    store.set('options', options); applyQuality();
  };
  applyQuality();
  const onProfile = patch => { Object.assign(profile, patch); store.set('profile', profile); net.sendProfile(patch); if (patch.car && game.state === 'title') newAttractCar(); if (patch.livery || patch.name) paintPlayer(); };

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

  // ---------- game state ----------
  const cam = new Camera(), rig = new CameraRig(cam, tr), input = new DriveInput(), hud = new Hud();
  hud.setupMap(tr);
  const game = { state: 'title', car: null, ap: null, session: null, acc: 0, engine: null, sendT: 0, finishT: 0, cine: 0 };
  let env = environment(def, 'auto');
  const assistsFor = () => { const room = net.settings.assists, a = room && room !== 'any' ? room : options.assists; return { abs: a === 'off' ? 0 : a === 'full' ? 2 : 1, tc: a === 'off' ? 0 : a === 'full' ? 2 : 1 }; };
  function newAttractCar() {
    game.car = new Car(profile.car, tr);
    game.car.reset(def.startS + 60, 0);
    game.ap = new Autopilot(game.car, tr, { grip: 0.82 });
  }
  newAttractCar();
  paintPlayer();
  net.addEventListener('welcome', e => { if (e.detail && e.detail.num) { game.number = e.detail.num; paintPlayer(); } });

  function startRace(mode) {
    unlockAudio();
    if (!game.engine) game.engine = createEngine();
    const s = net.settings, notes = [];
    if (s.map !== 0) notes.push(APEX.MAPS[s.map].name + ' arrives in a later update');
    if (s.weather === 'rain') notes.push('rain arrives with the weather update');
    if (s.time === 'night') notes.push('night racing arrives with the lights update');
    if (notes.length) toast('Racing Valmore Hills: ' + notes.join(', ') + '.');
    env = environment(def, s.time === 'night' ? 'auto' : s.time);
    const car = new Car(profile.car, tr);
    car.assists = assistsFor();
    const slot = world.grid[0];
    car.reset(slot.s, slot.u);
    game.car = car; game.ap = null; game.acc = 0; game.finishT = 0;
    game.session = new RaceSession({ tr, def, laps: mode === 'trial' ? Infinity : s.laps, mode, carId: car.specId });
    game.state = 'race'; rig.pos = null; renderer.cut = true;
    show(''); hud.show(true); hud.closeMenu(); input.active = true;
    if (net.roster.length > 1) toast('Online grids arrive with the multiplayer update. For now everyone races on their own copy of the track.');
  }
  function quitToMenu() {
    game.state = 'title'; game.session = null; input.active = false;
    hud.closeMenu(); hud.show(false); show('title'); menu.renderSheet(true);
    if (game.engine) game.engine.stop();
    env = environment(def, net.settings.time === 'night' ? 'auto' : net.settings.time);
    newAttractCar(); renderer.cut = true;
  }
  function pause() {
    if (game.state !== 'race') return;
    game.state = 'paused'; input.active = false;
    hud.openMenu('hPause', [
      { label: 'Resume', run: () => { hud.closeMenu(); game.state = 'race'; input.active = true; input.take(); } },
      { label: 'Restart', run: () => startRace(game.session.mode) },
      { label: 'Camera: ' + CAMERAS[rig.mode], run: () => { rig.next(); renderer.cut = true; pause2(); } },
      { label: 'Quit to menu', run: quitToMenu },
    ]);
  }
  const pause2 = () => { game.state = 'race'; pause(); };
  function showResults() {
    game.state = 'results'; input.active = false;
    hud.results(game.session, game.car.spec.name);
    hud.openMenu('hResults', [{ label: game.session.mode === 'trial' ? 'Keep driving' : 'Race again', run: () => { if (game.session.mode === 'trial') { hud.closeMenu(); game.state = 'race'; input.active = true; input.take(); game.ap = null; } else startRace('race'); } }, { label: 'Back to menu', run: quitToMenu }]);
  }
  function resetToTrack() {
    const car = game.car, q = locate(tr, car.pos[0], car.pos[2], car.hint);
    car.reset(q.s, Math.max(-3, Math.min(3, q.u * 0.3))); renderer.cut = true;
    if (game.session) game.session.prevD = null;
  }

  const menu = new Menu({ net, options, profile, onOptions, onProfile, code, onStart: startRace });
  for (const ev of ['settings']) net.addEventListener(ev, () => { if (game.state === 'title') env = environment(def, net.settings.time === 'night' ? 'auto' : net.settings.time); });

  // ---------- input ----------
  const KEYMAP = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', ' ': 'enter', Escape: 'back', Backspace: 'back', w: 'up', s: 'down', a: 'left', d: 'right' };
  addEventListener('keydown', e => {
    if (e.key === 'F3') { e.preventDefault(); onOptions({ stats: !options.stats }); if (menu.page === 'options') menu.renderSheet(true); return; }
    if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'text') return;
    const k = KEYMAP[e.key];
    if (game.state === 'title') { if (!k) return; e.preventDefault(); menu.key(k); return; }
    if (hud.overlay) { if (!k) return; e.preventDefault(); hud.menuKey(k); }
  });
  addEventListener('pointerdown', unlockAudio, { once: true });
  // gamepad for menus (title, pause, results): d-pad / left stick to move, A = select, B = back (with key repeat)
  const pad = { held: {}, next: {} };
  const pollPad = now => {
    const gp = (navigator.getGamepads ? [...navigator.getGamepads()] : []).find(g => g && g.connected);
    if (!gp || (game.state === 'race' && !hud.overlay)) return;
    const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0, b = i => gp.buttons[i] && gp.buttons[i].pressed;
    const state = { up: b(12) || ay < -0.55, down: b(13) || ay > 0.55, left: b(14) || ax < -0.55, right: b(15) || ax > 0.55, enter: b(0), back: b(1) };
    for (const [k, on] of Object.entries(state)) {
      const fire = () => { if (game.state === 'title') menu.key(k); else hud.menuKey(k); };
      if (on && !pad.held[k]) { fire(); pad.next[k] = now + 380; }
      else if (on && now > pad.next[k] && k !== 'enter' && k !== 'back') { fire(); pad.next[k] = now + 110; }
      pad.held[k] = on;
    }
  };

  progress(1, 'Ready');
  show('title');
  const tStart = performance.now();
  let last = performance.now(), physMs = 0;

  const frame = now => {
    requestAnimationFrame(frame);
    if (document.hidden) { last = now; return; }
    profiler.beginFrame(now);
    pollPad(now);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const t = (now - tStart) / 1000, car = game.car, S = game.session;

    // ---- simulation ----
    const p0 = performance.now();
    if (game.state === 'race' || game.state === 'results' || game.state === 'title') {
      let inp = null;
      if (game.state === 'race') {
        inp = input.read(dt, car.speed);
        for (const a of input.take()) {
          if (a === 'pause') { pause(); break; }
          if (a === 'camera') { rig.next(); renderer.cut = true; }
          if (a === 'reset') resetToTrack();
          if (a === 'shiftUp') car.shift(1);
          if (a === 'shiftDown') car.shift(-1);
        }
      }
      if (game.state !== 'paused') {
        const frozen = S && S.state === 'countdown';
        game.acc += dt;
        let n = 0;
        while (game.acc >= DT && n < 12) {
          if (game.ap) game.ap.update();
          else if (inp) car.input = { throttle: inp.throttle, brake: inp.brake, steer: inp.steer, handbrake: inp.handbrake };
          if (frozen) { car.prevPos = car.pos.slice(); car.prevQ = car.q.slice(); car.rpm += ((car.spec.idle + (inp ? inp.throttle : 0) * (car.spec.redline - car.spec.idle) * 0.8) - car.rpm) * 0.05; }
          else car.step(DT);
          game.acc -= DT; n++;
        }
        if (n === 12) game.acc = 0;
        if (car.watch(dt) && game.state === 'race') resetToTrack();
        if (S && game.state !== 'title') {
          const q = locate(tr, car.pos[0], car.pos[2], car.hint);
          S.update(dt, q.s, car.wheels.every(w => w.kind >= 2), car.speed);
          for (const e of S.events.splice(0)) { hud.event(e, S); if (e.type === 'go') input.rumble(0.3, 0.3, 120); }
          if (S.state === 'finished' && game.state === 'race') {
            if (!game.finishT) { game.finishT = now; hud.message(S.mode === 'trial' ? 'SESSION OVER' : 'CHEQUERED FLAG', 2500); }
            else if (now - game.finishT > 2500) { game.ap = new Autopilot(car, tr, { grip: 0.7 }); showResults(); }
          }
          if (car.lastHit > 6000) { input.rumble(Math.min(1, car.lastHit / 30000), 0.4, 140); car.lastHit = 0; }
        }
      }
    }
    physMs += (performance.now() - p0 - physMs) * 0.1;

    // ---- camera ----
    const alpha = Math.min(1, game.acc / DT), pose = car.pose(alpha);
    if (game.state === 'title') {
      // cinematic: a slow orbit around the attract car
      game.cine += dt * (options.reducedMotion ? 0.02 : 0.08);
      const ang = Math.sin(game.cine) * 1.1 + Math.PI, r = 8.5, f = car.local([0, 0, 1]), fh = Math.hypot(f[0], f[2]) || 1, fx = f[0] / fh, fz = f[2] / fh;
      const ca = Math.cos(ang), sa = Math.sin(ang), dx = fx * ca - fz * sa, dz = fx * sa + fz * ca;
      const want = [pose.pos[0] + dx * r, pose.pos[1] + 1.6, pose.pos[2] + dz * r];
      if (!rig.cine) rig.cine = want.slice();
      for (let i = 0; i < 3; i++) rig.cine[i] += (want[i] - rig.cine[i]) * Math.min(1, dt * 3);
      cam.pos = rig.cine.slice(); cam.target = [pose.pos[0], pose.pos[1] + 0.5, pose.pos[2]]; cam.up = [0, 1, 0]; cam.fov = 48 * Math.PI / 180;
    } else {
      rig.cine = null;
      rig.update(car, pose, dt, { lookBack: game.state === 'race' && input.key('lookBack'), reduced: options.reducedMotion, shake: options.shake ? 1 : 0 });
    }

    // ---- per-frame instances: the car + start lights ----
    carInstances(car, alpha, look, renderer.dynamic, { headlights: false, camPos: cam.pos, lodBias: options.preset === 'low' ? 1 : 0 });
    const lit = S && S.state === 'countdown' ? S.lights : 0;
    world.gantry.lights.forEach((p, k) => renderer.dynamic.push({ mesh: 'ico', model: trs(p, 0, 0, 0, [0.62, 0.62, 0.62]), ...mat(0.1, 0.01, 0.01, 0, 0.25), emit: 4 - k < lit ? [1, 0.02, 0.01, 2.6] : [0.12, 0.01, 0.01, 0.15] }));

    // ---- render ----
    const eff = applySize(now);
    renderer.render(cam, env, t, { dt, speed: Math.abs(car.speed) });

    // ---- HUD, audio, network ----
    if (game.state !== 'title' && S) hud.update(now, S, car, [], { units: options.units, color: profile.livery, place: 1, of: 1 });
    if (game.engine) {
      const slip = Math.max(...car.wheels.map(w => w.contact ? (w.sl || 0) : 0));
      game.engine.update(car.rpm, car.input.throttle, Math.abs(car.speed), slip, game.state === 'race');
    }
    if (game.state === 'race' && now - game.sendT > 50) {
      game.sendT = now;
      net.sendState({ x: car.pos[0], y: car.pos[1], z: car.pos[2], qx: car.q[0], qy: car.q[1], qz: car.q[2], qw: car.q[3], vx: car.vel[0], vy: car.vel[1], vz: car.vel[2],
        steer: car.input.steer, throttle: car.input.throttle, brake: car.input.brake, gear: car.gear, rpm: car.rpm, flags: car.input.brake > 0.05 ? 1 : 0, lap: S ? Math.min(255, S.lap) : 0, dist: S && S.prevD !== null ? S.prevD : 0, seq: 0 });
    }
    const rq = renderer.quality;
    profiler.extra['Render size'] = `${renderer.width} x ${renderer.height} (${Math.round(eff * 100)}% of ${dispW} x ${dispH}, dynamic ${Math.round(dyn * 100)}%)`;
    profiler.extra['Effects'] = ['TAA', 'AO', 'bloom'].filter((n, i) => [rq.taa, rq.ao, rq.bloom][i]).join(' + ') + (rq.motionBlur ? ' + motion blur' : '') + (rq.ca ? ' + lens' : '');
    profiler.extra['Shadows'] = `${renderer.quality.shadows.cascades} cascades, ${renderer.quality.shadows.size}px, ${renderer.quality.shadows.dist} m`;
    profiler.extra['Culling'] = `${renderer.stats.drawn} drawn, ${renderer.stats.culled} culled`;
    profiler.extra['Physics'] = `${physMs.toFixed(2)} ms/frame (${(1 / DT).toFixed(0)} Hz)`;
    profiler.extra['Car'] = `${(car.speed * 3.6).toFixed(0)} km/h, gear ${car.gear}, ${Math.round(car.rpm)} rpm`;
    profiler.extra['Preset'] = options.preset;
    profiler.extra['Room'] = `${code || 'local'} · ${net.status} · ping ${Math.round(net.ping)} ms`;
    profiler.draw(now);
  };
  requestAnimationFrame(frame);
  window.__apex = { gpu, renderer, profiler, net, cam, env: () => env, options, game, world, startRace, quitToMenu, rig, input,
    autodrive: (grip = 1) => { game.ap = new Autopilot(game.car, tr, { grip }); } };       // for automated tests
  if (net.isHost) toast('You are the host. Pick laps and AI in Room & track.');
}

boot().catch(e => { console.error(e); $('ldErr').style.display = 'block'; $('ldErr').textContent = String(e && e.stack || e); });
