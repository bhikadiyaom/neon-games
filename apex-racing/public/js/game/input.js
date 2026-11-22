// Driving input: keyboard (smoothed steering) + Gamepad API (analog triggers/stick, deadzone, curve).
// Edge-triggered actions (camera, reset, pause, shifts) are queued for the game loop.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const KEYS = {
  throttle: ['ArrowUp', 'KeyW'], brake: ['ArrowDown', 'KeyS'], left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'],
  handbrake: ['Space'], camera: ['KeyC'], reset: ['KeyR'], pause: ['Escape', 'KeyP'], shiftUp: ['KeyE', 'ShiftLeft'], shiftDown: ['KeyQ', 'ControlLeft'],
  lookBack: ['KeyB'],
};

export class DriveInput {
  constructor() {
    this.down = new Set(); this.actions = []; this.steer = 0; this.active = false;
    this.pad = { prev: {}, deadzone: 0.08 };
    addEventListener('keydown', e => {
      if (!this.active || e.repeat) return;
      for (const [act, codes] of Object.entries(KEYS)) if (codes.includes(e.code)) { e.preventDefault(); if (['camera', 'reset', 'pause', 'shiftUp', 'shiftDown'].includes(act)) this.actions.push(act); }
      this.down.add(e.code);
    });
    addEventListener('keyup', e => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
  }
  key(act) { return KEYS[act].some(c => this.down.has(c)); }
  // returns { throttle, brake, steer, handbrake, lookBack } for this frame
  read(dt, speed) {
    let throttle = this.key('throttle') ? 1 : 0, brake = this.key('brake') ? 1 : 0, handbrake = this.key('handbrake') ? 1 : 0, lookBack = this.key('lookBack');
    const want = (this.key('left') ? 1 : 0) - (this.key('right') ? 1 : 0);
    // keyboard steering eases in (slower at speed) and recentres quickly
    const rate = want === 0 ? 6 : (Math.sign(want) !== Math.sign(this.steer) && this.steer !== 0 ? 7 : 3.2 / (1 + Math.abs(speed) / 45));
    this.steer += clamp(want - this.steer, -rate * dt, rate * dt);
    let steer = this.steer;
    const gp = (navigator.getGamepads ? [...navigator.getGamepads()] : []).find(g => g && g.connected);
    if (gp) {
      const b = i => gp.buttons[i] ? gp.buttons[i].value : 0, dz = this.pad.deadzone;
      let ax = gp.axes[0] || 0; ax = Math.abs(ax) < dz ? 0 : Math.sign(ax) * ((Math.abs(ax) - dz) / (1 - dz)) ** 1.6;
      const rt = b(7), lt = b(6);
      if (Math.abs(ax) > 0.001 || this.pad.used) { steer = -ax; this.pad.used = true; }
      if (rt > 0.02) throttle = Math.max(throttle, rt);
      if (lt > 0.02) brake = Math.max(brake, lt);
      if (b(2) > 0.5) handbrake = 1;
      if (b(4) > 0.5) lookBack = true;
      const edge = (i, act) => { const on = b(i) > 0.5; if (on && !this.pad.prev[i] && this.active) this.actions.push(act); this.pad.prev[i] = on; };
      edge(3, 'camera'); edge(8, 'reset'); edge(9, 'pause'); edge(5, 'shiftUp'); edge(1, 'shiftDown');
      this.gamepad = gp;
    }
    return { throttle, brake, steer, handbrake, lookBack };
  }
  rumble(strong, weak, ms = 80) {
    const a = this.gamepad && this.gamepad.vibrationActuator;
    if (a && a.playEffect) a.playEffect('dual-rumble', { duration: ms, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) }).catch(() => {});
  }
  take() { const a = this.actions; this.actions = []; return a; }
}
