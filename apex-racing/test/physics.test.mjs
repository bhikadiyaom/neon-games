// node apex-racing/test/physics.test.mjs : drives the real car physics headless on the real track.
import { buildTrack, locate, pointAt, halfWidth, VERGE } from '../public/js/game/trackcore.js';
import { VALMORE } from '../public/js/game/tracks.js';
import { Car, DT, SPECS } from '../public/js/game/car.js';
import { Autopilot } from '../public/js/game/autopilot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const tr = buildTrack(VALMORE);
const kmh = v => (v * 3.6).toFixed(0);
const finite = c => [...c.pos, ...c.vel, ...c.q, ...c.av].every(Number.isFinite);

for (const id of Object.keys(SPECS)) {
  const car = new Car(id, tr);
  console.log(`-- ${SPECS[id].name}`);
  // 1. settle on the grid
  car.reset(VALMORE.startS - 20, 3);
  for (let i = 0; i < 480; i++) { car.input = { throttle: 0, brake: 0, steer: 0, handbrake: 1 }; car.step(DT); }
  const sp0 = Math.hypot(...car.vel), comps = car.wheels.map(w => w.comp.toFixed(3)).join(' ');
  ok(sp0 < 0.05 && car.wheels.every(w => w.contact), `${id}: settles at rest (speed ${sp0.toFixed(3)}, compression ${comps})`);

  // 2. full throttle along the main straight (start of the spline is the bottom of the straight)
  car.reset(0, 0);
  let t100 = null, t = 0, maxRoll = 0;
  for (; t < 12; t += DT) {
    car.input = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
    car.step(DT);
    const q = locate(tr, car.pos[0], car.pos[2], car.hint);
    car.input.steer = Math.max(-1, Math.min(1, -q.u * 0.08));
    if (t100 === null && car.speed > 100 / 3.6) t100 = t;
    maxRoll = Math.max(maxRoll, Math.abs(car.local([0, 1, 0])[0]));
    if (q.s > 450) break;
  }
  ok(finite(car), `${id}: no NaN under full throttle`);
  console.log(`  0-100 km/h ${t100 ? t100.toFixed(2) + ' s' : 'not reached'}, ${kmh(car.speed)} km/h after ${t.toFixed(1)} s, gear ${car.gear}`);
  ok(t100 && t100 > 2.0 && t100 < 6.5, `${id}: 0-100 km/h in a plausible time (${t100 && t100.toFixed(2)} s)`);

  // 3. braking from speed
  const v0 = car.speed; let dist = 0, tb = 0;
  while (car.speed > 0.5 && tb < 8) { car.input = { throttle: 0, brake: 1, steer: 0, handbrake: 0 }; car.step(DT); dist += Math.max(0, car.speed) * DT; tb += DT; }
  console.log(`  braking ${kmh(v0)} -> 0 km/h in ${dist.toFixed(1)} m (${tb.toFixed(2)} s)`);
  const decel = v0 * v0 / (2 * dist);
  ok(decel > 9 && decel < 25, `${id}: braking deceleration plausible (${(decel / 9.81).toFixed(2)} g average, ${dist.toFixed(1)} m from ${kmh(v0)} km/h)`);
}

// 4. autopilot laps: no NaN, never stuck, stays on track
for (const id of ['vanta', 'aurex']) {
  const car = new Car(id, tr), ap = new Autopilot(car, tr);
  car.reset(VALMORE.startS - 20, 0);
  let s = 0, last = null, t = 0, off = 0, maxV = 0, stuck = 0, lapT = null, startCross = null;
  const t0 = performance.now();
  for (; t < 400 && lapT === null; t += DT) {
    ap.update(); car.step(DT);
    const q = locate(tr, car.pos[0], car.pos[2], car.hint);
    const d = ((q.s - VALMORE.startS) % tr.length + tr.length) % tr.length;
    if (last !== null && last > tr.length * 0.9 && d < tr.length * 0.1) { if (startCross === null) startCross = t; else lapT = t - startCross; }
    last = d;
    if (Math.abs(q.u) > halfWidth(tr, q.i, q.t) + 1.5) off += DT;
    maxV = Math.max(maxV, car.speed);
    stuck = car.speed < 2 && t > 5 ? stuck + DT : 0;
    if (stuck > 5 || !finite(car)) break;
  }
  const us = (performance.now() - t0) * 1000 / (t / DT);
  console.log(`-- autopilot ${id}: lap ${lapT ? lapT.toFixed(2) + ' s' : 'not completed'}, top ${kmh(maxV)} km/h, off the road ${off.toFixed(1)} s, ${us.toFixed(1)} us per physics step`);
  ok(finite(car), `${id}: no NaN during a lap`);
  ok(lapT !== null && lapT > 60 && lapT < 180, `${id}: autopilot completes a flying lap (${lapT && lapT.toFixed(1)} s)`);
  ok(off < 8, `${id}: autopilot stays mostly on the road (${off.toFixed(1)} s off)`);
  ok(us < 60, `${id}: one physics step is cheap (${us.toFixed(1)} us)`);
}

// 5. crash into the barrier at 100 km/h, 30 degrees: no launch, stays inside, slows down
{
  const car = new Car('vanta', tr);
  const s = 300, p = pointAt(tr, s, 0);
  car.reset(s, 0, p.heading + 0.5);
  const fwd = car.local([0, 0, 1]); car.vel = fwd.map(c => c * 27.8);
  let maxVy = 0, maxU = 0, minY = Infinity;
  for (let t = 0; t < 3; t += DT) {
    car.input = { throttle: 0, brake: 0, steer: 0, handbrake: 0 }; car.step(DT);
    maxVy = Math.max(maxVy, car.vel[1]);
    const q = locate(tr, car.pos[0], car.pos[2], car.hint); maxU = Math.max(maxU, Math.abs(q.u) - (halfWidth(tr, q.i, q.t) + VERGE));
  }
  const up = car.local([0, 1, 0])[1];
  console.log(`-- barrier crash: max upward speed ${maxVy.toFixed(2)} m/s, deepest past the barrier line ${maxU.toFixed(2)} m, speed after ${kmh(Math.hypot(car.vel[0], car.vel[2]))} km/h, hits ${car.hits}, upright ${up.toFixed(2)}`);
  ok(maxVy < 3, 'barrier does not launch the car');
  ok(maxU < 1.3, 'car stays inside the barrier');
  ok(car.hits > 0 && up > 0.8, 'hit registered, car stays upright');
  ok(finite(car), 'no NaN after a crash');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
