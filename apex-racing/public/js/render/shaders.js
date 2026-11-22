// WGSL shaders. Units: metres in the world, kilometres inside the atmosphere model.
export const FRAME = /* wgsl */`
struct Frame {
  viewProj: mat4x4f,     // jittered (TAA)
  invViewProj: mat4x4f,
  view: mat4x4f,
  camPos: vec4f,       // xyz metres, w = time (s)
  sunDir: vec4f,       // xyz towards the sun, w = sun disk brightness
  sunColor: vec4f,     // rgb sun illuminance above the atmosphere, w = exposure compensation (EV)
  res: vec4f,          // render width, height, 1/width, 1/height
  params: vec4f,       // x fog density, y ambient strength, z wetness, w night
  track: vec4f,        // x lap length, y start line s, z sample spacing, w sample count
  shadowVP: array<mat4x4f, 4>,
  shadowSplits: vec4f, // far view depth of each cascade
  shadowTexel: vec4f,  // world size of one shadow texel per cascade
  shadowParams: vec4f, // x 1/map size, y cascade count, z max distance, w PCF taps (4 or 9)
  vpNoJitter: mat4x4f, // for motion vectors
  prevVP: mat4x4f,     // last frame, no jitter
  taa: vec4f,          // xy jitter (NDC), z first dynamic instance, w frame index
  post: vec4f,         // x dt, y motion blur shutter, z speed m/s, w history valid
  proj: vec4f,         // x P00, y P11, z near, w AO strength (0 = off)
};
const PI = 3.14159265;
`;

export const ATMOS = /* wgsl */`
const RG = 6360.0;
const RT = 6460.0;
const RAY_S = vec3f(5.802e-3, 13.558e-3, 33.1e-3);
const MIE_S = 3.996e-3;
const MIE_E = 4.40e-3;
const OZO_A = vec3f(0.650e-3, 1.881e-3, 0.085e-3);
fn densities(h: f32) -> vec3f { return vec3f(exp(-h / 8.0), exp(-h / 1.2), max(0.0, 1.0 - abs(h - 25.0) / 15.0)); }
fn extinctionAt(h: f32) -> vec3f { let d = densities(h); return RAY_S * d.x + vec3f(MIE_E * d.y) + OZO_A * d.z; }
fn raySphere(ro: vec3f, rd: vec3f, r: f32) -> vec2f {
  let b = dot(ro, rd); let c = dot(ro, ro) - r * r; let disc = b * b - c;
  if (disc < 0.0) { return vec2f(-1.0, -1.0); }
  let s = sqrt(disc); return vec2f(-b - s, -b + s);
}
fn transUV(r: f32, mu: f32) -> vec2f { return vec2f(mu * 0.5 + 0.5, clamp((r - RG) / (RT - RG), 0.0, 1.0)); }
fn phaseR(c: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
fn phaseM(c: f32, g: f32) -> f32 { let g2 = g * g; return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
`;

const FULLSCREEN = /* wgsl */`
struct FsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> FsOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: FsOut; o.pos = vec4f(p, 0.0, 1.0); o.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); return o;
}
`;

// ---------- transmittance LUT (256 x 64), computed once ----------
export const TRANSMITTANCE = FRAME + ATMOS + FULLSCREEN + /* wgsl */`
@fragment fn fs(in: FsOut) -> @location(0) vec4f {
  let uv = in.pos.xy / vec2f(256.0, 64.0);
  let mu = uv.x * 2.0 - 1.0;
  let r = RG + uv.y * (RT - RG);
  let ro = vec3f(0.0, r, 0.0);
  let rd = vec3f(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  if (raySphere(ro, rd, RG).x > 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let t = raySphere(ro, rd, RT).y;
  var od = vec3f(0.0);
  let n = 40;
  let dt = t / f32(n);
  for (var i = 0; i < n; i++) {
    let p = ro + rd * ((f32(i) + 0.5) * dt);
    od += extinctionAt(length(p) - RG) * dt;
  }
  return vec4f(exp(-od), 1.0);
}
`;

// ---------- sky-view LUT (192 x 108), every frame; azimuth is measured from the sun ----------
export const SKYVIEW = FRAME + ATMOS + FULLSCREEN + /* wgsl */`
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@fragment fn fs(in: FsOut) -> @location(0) vec4f {
  let uv = in.pos.xy / vec2f(192.0, 108.0);
  let az = uv.x * PI;
  let l = 1.0 - uv.y * 2.0;
  let el = sign(l) * l * l * (PI * 0.5);
  let camH = max(F.camPos.y * 0.001, 0.0) + 0.0005;
  let ro = vec3f(0.0, RG + camH, 0.0);
  let rd = vec3f(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  let sunEl = asin(clamp(F.sunDir.y, -1.0, 1.0));
  let sun = vec3f(cos(sunEl), sin(sunEl), 0.0);
  let gnd = raySphere(ro, rd, RG);
  var tMax = raySphere(ro, rd, RT).y;
  if (gnd.x > 0.0) { tMax = gnd.x; }
  let c = dot(rd, sun);
  let pr = phaseR(c);
  let pm = phaseM(c, 0.8);
  var L = vec3f(0.0);
  var T = vec3f(1.0);
  let n = 30;
  var tPrev = 0.0;
  for (var i = 1; i <= n; i++) {
    let f = f32(i) / f32(n);
    let t = tMax * f * f;
    let dt = t - tPrev;
    let p = ro + rd * (tPrev + dt * 0.5);
    tPrev = t;
    let r = length(p);
    let d = densities(r - RG);
    let sunT = textureSampleLevel(transLUT, samp, transUV(r, dot(p / r, sun)), 0.0).rgb;
    let scatR = RAY_S * d.x;
    let scatM = MIE_S * d.y;
    // single scattering + a cheap isotropic multiple-scattering term (lifts the shadowed sky a little)
    let S = sunT * (scatR * pr + vec3f(scatM * pm)) + (scatR + vec3f(scatM)) * (0.06 / (4.0 * PI)) * max(sun.y + 0.1, 0.0);
    let ext = scatR + vec3f(MIE_E * d.y) + OZO_A * d.z;
    let stepT = exp(-ext * dt);
    L += T * (S - S * stepT) / ext;
    T *= stepT;
  }
  return vec4f(L, 1.0);
}
`;

// ---------- shared lighting for the main scene ----------
const SCENE_COMMON = FRAME + ATMOS + /* wgsl */`
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var skyLUT: texture_2d<f32>;
@group(0) @binding(4) var shadowMap: texture_depth_2d_array;
@group(0) @binding(5) var shadowSamp: sampler_comparison;
@group(0) @binding(6) var trackData: texture_2d<f32>;
@group(0) @binding(7) var aoTex: texture_2d<f32>;
@group(0) @binding(8) var livery: texture_2d_array<f32>;
@group(0) @binding(9) var aniso: sampler;

fn skyUV(dir: vec3f) -> vec2f {
  let el = asin(clamp(dir.y, -1.0, 1.0));
  let dh = dir.xz; let sh = F.sunDir.xz;
  var az = 0.0;
  if (dot(dh, dh) > 1e-8 && dot(sh, sh) > 1e-8) { az = acos(clamp(dot(normalize(dh), normalize(sh)), -1.0, 1.0)); }
  let l = sign(el) * sqrt(abs(el) / (PI * 0.5));
  return vec2f(az / PI, 0.5 - 0.5 * l);
}
fn skyL(dir: vec3f) -> vec3f { return textureSampleLevel(skyLUT, samp, skyUV(dir), 0.0).rgb * F.sunColor.rgb; }
fn sunRadianceAt(y: f32) -> vec3f {
  let r = RG + max(y * 0.001, 0.0) + 0.0005;
  return textureSampleLevel(transLUT, samp, transUV(r, F.sunDir.y), 0.0).rgb * F.sunColor.rgb;
}
// Aerial perspective: things far away fade into the sky colour of the horizon behind them.
fn applyFog(col: vec3f, wp: vec3f) -> vec3f {
  let toP = wp - F.camPos.xyz;
  let d = length(toP) * 0.001 * F.params.x;
  let dir = toP / max(length(toP), 1e-4);
  let T = exp(-(RAY_S + vec3f(MIE_E * 1.5)) * d);
  let haze = skyL(normalize(vec3f(dir.x, max(dir.y, 0.015), dir.z)));
  return col * T + haze * (1.0 - T);
}
// Cascaded shadow maps: pick the cascade by view depth, offset along the normal by ~1.5 texels (no acne),
// filter with hardware 2x2 compares in a 2x2 or 3x3 pattern, fade out at the far end.
fn shadowAt(wp: vec3f, N: vec3f) -> f32 {
  let vd = -(F.view * vec4f(wp, 1.0)).z;
  let maxD = F.shadowParams.z;
  if (vd > maxD || F.shadowParams.y < 0.5) { return 1.0; }
  var c = 0;
  if (vd > F.shadowSplits.x) { c = 1; }
  if (vd > F.shadowSplits.y) { c = 2; }
  if (vd > F.shadowSplits.z) { c = 3; }
  c = min(c, i32(F.shadowParams.y) - 1);
  let p = F.shadowVP[c] * vec4f(wp + N * (F.shadowTexel[c] * 1.6), 1.0);
  let uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || p.z > 1.0) { return 1.0; }
  let ts = F.shadowParams.x;
  var sum = 0.0;
  if (F.shadowParams.w > 5.0) {
    for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
      sum += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2f(f32(x), f32(y)) * ts, c, p.z);
    } }
    sum /= 9.0;
  } else {
    for (var y = 0; y < 2; y++) { for (var x = 0; x < 2; x++) {
      sum += textureSampleCompareLevel(shadowMap, shadowSamp, uv + (vec2f(f32(x), f32(y)) - 0.5) * ts, c, p.z);
    } }
    sum /= 4.0;
  }
  return mix(sum, 1.0, smoothstep(maxD * 0.8, maxD, vd));
}
fn aoAt(fragPos: vec2f) -> f32 {
  if (F.proj.w <= 0.0) { return 1.0; }
  return mix(1.0, textureSampleLevel(aoTex, samp, fragPos * F.res.zw, 0.0).r, F.proj.w);
}
`;

// ---------- meshes: PBR with clear coat; kind 1 = procedural track surface ----------
export const MESH = SCENE_COMMON + /* wgsl */`
struct Inst { model: mat4x4f, base: vec4f, pbr: vec4f, emit: vec4f };   // pbr: metal, rough, clearcoat, kind
@group(1) @binding(0) var<storage, read> insts: array<Inst>;
@group(1) @binding(1) var<storage, read> prevModels: array<mat4x4f>;     // last frame's matrices of dynamic instances

struct VOut {
  @builtin(position) @invariant pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) base: vec4f,
  @location(4) @interpolate(flat) pbr: vec4f,
  @location(5) @interpolate(flat) emit: vec4f,
  @location(6) cur: vec4f,       // clip position without jitter (motion vectors)
  @location(7) prev: vec4f,      // last frame's clip position
};
fn hashu(x: u32) -> u32 { let v = x * 747796405u + 2891336453u; let w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (w >> 22u) ^ w; }
fn hashf(x: u32) -> f32 { return f32(hashu(x)) * (1.0 / 4294967295.0); }

// kind 3 = crowd (people bob and wave), kind 4 = foliage (sways in the wind)
fn animate(w: vec3f, p: vec3f, kind: f32, ii: u32) -> vec3f {
  var o = w;
  let t = F.camPos.w;
  if (kind > 2.5 && kind < 3.5) {
    let h = hashf(ii);
    let cheer = max(0.0, sin(t * (2.5 + h * 3.0) + h * 40.0));
    o.y += cheer * cheer * 0.10 * smoothstep(0.2, 1.0, p.y + 0.5);
  } else if (kind > 3.5 && kind < 4.5) {
    let k = max(p.y + 0.5, 0.0);
    o.x += sin(t * 1.1 + w.z * 0.05 + w.x * 0.03) * 0.12 * k;
    o.z += cos(t * 0.9 + w.x * 0.04) * 0.08 * k;
  }
  return o;
}

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @builtin(instance_index) ii: u32) -> VOut {
  let inst = insts[ii];
  var w = (inst.model * vec4f(p, 1.0)).xyz;
  w = animate(w, p, inst.pbr.w, ii);
  var pw = w;
  let db = u32(F.taa.z);
  if (ii >= db) { pw = (prevModels[ii - db] * vec4f(p, 1.0)).xyz; }
  var o: VOut;
  o.pos = F.viewProj * vec4f(w, 1.0); o.wp = w; o.n = (inst.model * vec4f(n, 0.0)).xyz; o.uv = uv;
  o.base = inst.base; o.pbr = inst.pbr; o.emit = inst.emit;
  o.cur = F.vpNoJitter * vec4f(w, 1.0); o.prev = F.prevVP * vec4f(pw, 1.0);
  if (inst.pbr.w > 2.5 && inst.pbr.w < 4.5) {        // vary crowd shirts and tree greens per instance
    let h = hashf(ii * 7u + 3u);
    if (inst.pbr.w < 3.5) {
      var pal = array<vec3f, 8>(vec3f(0.6, 0.05, 0.05), vec3f(0.05, 0.15, 0.6), vec3f(0.7, 0.7, 0.7), vec3f(0.8, 0.6, 0.05), vec3f(0.05, 0.35, 0.1), vec3f(0.08, 0.08, 0.09), vec3f(0.5, 0.1, 0.45), vec3f(0.85, 0.35, 0.05));
      if (p.y > 0.35) { o.base = vec4f(vec3f(0.55, 0.38, 0.27) * (0.5 + h), 1.0); }       // heads
      else { o.base = vec4f(pal[hashu(ii) % 8u], 1.0); }
    } else {
      o.base = vec4f(inst.base.rgb * (0.7 + 0.6 * h), 1.0);
    }
  }
  return o;
}
fn velocity(in: VOut) -> vec2f { return (in.cur.xy / in.cur.w - in.prev.xy / in.prev.w) * vec2f(0.5, -0.5); }

fn hash2(p: vec2f) -> f32 { let i = vec2i(floor(p)); return f32(hashu((bitcast<u32>(i.x) * 1973u) ^ hashu(bitcast<u32>(i.y) + 9277u))) * (1.0 / 4294967295.0); }
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}
// noise that fades to its average once a texel is smaller than a pixel (no shimmer in motion)
fn fnoise(p: vec2f, fw: f32) -> f32 { return mix(vnoise(p), 0.5, smoothstep(0.35, 1.0, fw)); }
// box-filtered square wave of period 1 (duty 0.5) over a footprint of width w: crisp up close, grey far away
fn sqw(x: f32, w: f32) -> f32 {
  let ww = max(w, 1e-4);
  let a = x - ww * 0.5; let b = x + ww * 0.5;
  let Fa = floor(a) * 0.5 + max(fract(a) - 0.5, 0.0);
  let Fb = floor(b) * 0.5 + max(fract(b) - 0.5, 0.0);
  return (Fb - Fa) / ww;
}
// filtered band: 1 inside [lo, hi], antialiased with footprint w
fn band(x: f32, lo: f32, hi: f32, w: f32) -> f32 { let ww = max(w, 1e-4); return clamp((min(x + ww * 0.5, hi) - max(x - ww * 0.5, lo)) / ww, 0.0, 1.0); }

struct Mat { base: vec3f, metal: f32, rough: f32, coat: f32 };

// per-sample track data, linearly interpolated: x half width, y kerb (0/1), z racing line offset
fn trackInfo(s: f32) -> vec4f {
  let n = i32(F.track.w);
  let f = s / F.track.z;
  let i0 = ((i32(floor(f)) % n) + n) % n;
  let i1 = (i0 + 1) % n;
  return mix(textureLoad(trackData, vec2i(i0, 0), 0), textureLoad(trackData, vec2i(i1, 0), 0), fract(f));
}

// the drivable ribbon: uv = (lateral metres, + = left; distance along the lap)
fn trackSurface(u: f32, s: f32, fu: f32, fs: f32, wp: vec3f) -> Mat {
  var m: Mat; m.metal = 0.0; m.coat = 0.0;
  let info = trackInfo(s);
  let hw = info.x; let x = abs(u);
  let fp = max(fu, fs);
  let road = band(x, -1.0, hw, fu);
  let kerbW = band(x, hw, hw + 1.5, fu) * info.y;
  let grassW = max(0.0, 1.0 - road - kerbW);
  m.base = vec3f(0.0); m.rough = 0.0;
  if (grassW > 0.0) {      // run-off grass with 10 m mowing stripes across the track direction
    let stripe = sqw(s / 10.0, fs / 10.0);
    let clump = fnoise(wp.xz * 0.35, fp * 0.35) * 0.6 + fnoise(wp.xz * 2.1, fp * 2.1) * 0.4;
    m.base += mix(vec3f(0.032, 0.08, 0.017), vec3f(0.055, 0.12, 0.024), stripe) * (0.75 + 0.5 * clump) * grassW;
    m.rough += 0.92 * grassW;
  }
  if (road > 0.0) {
    let grain = fnoise(wp.xz * 9.0, fp * 9.0) * 0.5 + fnoise(wp.xz * 2.3, fp * 2.3) * 0.5;
    let patchy = smoothstep(0.62, 0.66, fnoise(vec2f(s * 0.05, u * 0.2), fs * 0.05));            // repaired patches
    let rubber = 1.0 - smoothstep(0.5, 2.3, abs(u - info.z));
    var asph = vec3f(0.058) * (0.78 + 0.45 * grain);
    asph = mix(asph, vec3f(0.042), patchy * 0.7);
    asph = mix(asph, vec3f(0.03), rubber * 0.75);
    asph = mix(asph, vec3f(0.08, 0.075, 0.07), smoothstep(hw - 2.5, hw - 0.6, x) * (1.0 - rubber) * 0.6);   // marbles / dust off line
    var ar = mix(0.8, 0.6, rubber) - grain * 0.08;
    // white edge lines
    let paint = band(x, hw - 0.45, hw - 0.2, fu);
    // start/finish line (checkered) and grid boxes behind it
    var d = s - F.track.y;
    d = d - F.track.x * round(d / F.track.x);
    var mark = paint;
    if (abs(d) < 0.8) { mark = max(mark, band(d, -0.6, 0.6, fs) * abs(sqw(u / 1.2, fu / 1.2) - sqw(d / 1.2 + 0.25, fs / 1.2))); }
    let back = -d;
    if (back > 6.0 && back < 74.0) {
      let k = round((back - 10.0) / 8.0);
      let side = select(-3.0, 3.0, (i32(k) % 2) == 0);
      let front = 10.0 + k * 8.0;
      mark = max(mark, band(back, front - 0.12, front + 0.12, fs) * band(u, side - 1.3, side + 1.3, fu));
      mark = max(mark, band(back, front, front + 1.4, fs) * (band(u, side - 1.42, side - 1.3, fu) + band(u, side + 1.3, side + 1.42, fu)));
    }
    asph = mix(asph, vec3f(0.72), mark); ar = mix(ar, 0.5, mark);
    m.base += asph * road; m.rough += ar * road;
  }
  if (kerbW > 0.0) {
    m.base += mix(vec3f(0.55, 0.02, 0.015), vec3f(0.72, 0.72, 0.7), sqw(s / 3.0, fs / 3.0)) * kerbW;
    m.rough += 0.5 * kerbW;
  }
  return m;
}

// farmland: irregular fields (meadow, wheat, ploughed earth, pasture) with crop rows in different directions,
// rock on steep slopes
fn terrainSurface(wp: vec3f, N: vec3f, fp: f32) -> Mat {
  var m: Mat; m.metal = 0.0; m.coat = 0.0;
  let warp = vec2f(vnoise(wp.xz * 0.004), vnoise(wp.xz * 0.004 + 7.3)) * 90.0;
  let q = wp.xz + warp;
  let cell = floor(q / 170.0);
  let h = hash2(cell + 17.0);
  let ang = hash2(cell + 3.0) * PI;
  let dir = vec2f(cos(ang), sin(ang));
  let rows = sqw(dot(wp.xz, dir) / 4.0, fp / 4.0);
  let fine = fnoise(wp.xz * 1.7, fp * 1.7);
  let big = vnoise(wp.xz * 0.02);
  var c = vec3f(0.045, 0.1, 0.022) * (0.8 + 0.4 * big);                     // meadow
  var r = 0.95;
  if (h > 0.70 && h < 0.80) { c = mix(vec3f(0.2, 0.16, 0.06), vec3f(0.26, 0.21, 0.08), rows); r = 0.9; }   // wheat
  else if (h >= 0.80 && h < 0.90) { c = mix(vec3f(0.11, 0.07, 0.045), vec3f(0.08, 0.05, 0.032), rows); }    // ploughed
  else if (h >= 0.90) { c = mix(vec3f(0.06, 0.12, 0.03), vec3f(0.075, 0.14, 0.035), rows); }             // mown pasture
  c *= 0.8 + 0.4 * fine;
  // hedges along field edges
  let e = abs(fract(q / 170.0) - 0.5);
  let hedge = 1.0 - smoothstep(0.485, 0.497, max(e.x, e.y));
  c = mix(c, vec3f(0.025, 0.05, 0.015), (1.0 - hedge) * 0.6);
  // rock on steep slopes (the distant ridges)
  let rock = smoothstep(0.86, 0.72, N.y);
  c = mix(c, vec3f(0.16, 0.14, 0.12) * (0.7 + 0.6 * fine), rock); r = mix(r, 0.85, rock);
  m.base = c; m.rough = r;
  return m;
}

fn D_GGX(NoH: f32, a: f32) -> f32 { let a2 = a * a; let d = NoH * NoH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
fn D_aniso(NoH: f32, ToH: f32, BoH: f32, ax: f32, ay: f32) -> f32 { let d = ToH * ToH / (ax * ax) + BoH * BoH / (ay * ay) + NoH * NoH; return 1.0 / (PI * ax * ay * d * d); }
fn V_Smith(NoV: f32, NoL: f32, a: f32) -> f32 {
  let a2 = a * a;
  let gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  let gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
fn F_Schlick(f0: vec3f, VoH: f32) -> vec3f { return f0 + (vec3f(1.0) - f0) * pow(1.0 - VoH, 5.0); }
fn envBRDF(f0: vec3f, rough: f32, NoV: f32) -> vec3f {
  let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022); let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
  let r = rough * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  let ab = vec2f(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

struct GOut { @location(0) color: vec4f, @location(1) vel: vec2f };
const K_TRACK = 1.0; const K_TERRAIN = 2.0; const K_PAINT = 5.0; const K_CARBON = 7.0; const K_TYRE = 8.0; const K_BRUSHED = 9.0;
fn isKind(k: f32, v: f32) -> bool { return abs(k - v) < 0.5; }

@fragment fn fs(in: VOut, @builtin(front_facing) front: bool) -> GOut {
  let fx = fwidth(in.wp.x); let fz = fwidth(in.wp.z);
  let fu = fwidth(in.uv.x); let fsd = fwidth(in.uv.y);
  // tangent frame from screen derivatives (anisotropic materials)
  let dp1 = dpdx(in.wp); let dp2 = dpdy(in.wp); let duv1 = dpdx(in.uv); let duv2 = dpdy(in.uv);
  let kind = in.pbr.w;
  var N = normalize(in.n);
  if (!front) { N = -N; }
  var Tg = dp1 * duv2.y - dp2 * duv1.y;
  Tg = normalize(Tg - N * dot(N, Tg) + vec3f(1e-6, 0.0, 0.0));
  var m: Mat;
  m.base = in.base.rgb; m.metal = in.pbr.x; m.rough = in.pbr.y; m.coat = in.pbr.z;
  var anisoX = 0.0; var anisoY = 0.0; var flakes = 0.0;
  if (isKind(kind, K_TRACK)) { m = trackSurface(in.uv.x, in.uv.y, fu, fsd, in.wp); }
  else if (isKind(kind, K_TERRAIN)) { m = terrainSurface(in.wp, N, max(fx, fz)); }
  else if (isKind(kind, K_PAINT)) {
    // livery texture: rgb paint, alpha = clean (1) .. dirty / matte decal (0)
    let lv = textureSampleGrad(livery, aniso, in.uv, i32(in.base.a - 0.5), duv1, duv2);
    m.base = lv.rgb; m.coat = lv.a; m.rough = mix(0.62, m.rough, lv.a); m.metal = in.pbr.x * lv.a;
    flakes = lv.a * (1.0 - smoothstep(0.0006, 0.004, max(fu, fsd)));
  }
  else if (isKind(kind, K_CARBON)) {
    // 2x2 twill weave: the highlight runs along the threads, alternating direction per cell
    let q = in.uv * vec2f(260.0, 520.0);
    let cell = (i32(floor(q.x)) + i32(floor(q.y))) % 2;
    let along = select(0.0, 1.0, cell == 0);
    let fade = 1.0 - smoothstep(0.002, 0.01, max(fu, fsd));
    m.base = vec3f(0.018) * (0.8 + 0.4 * along * fade);
    anisoX = mix(0.25, 0.08, along); anisoY = mix(0.08, 0.25, along);
    anisoX = mix(0.16, anisoX, fade); anisoY = mix(0.16, anisoY, fade);
  }
  else if (isKind(kind, K_TYRE)) {
    let t = textureSampleGrad(livery, aniso, in.uv, 7, duv1, duv2);          // misc layer: tyre sidewall lettering
    m.base = mix(vec3f(0.028), vec3f(0.55), t.r * step(0.5, in.uv.y)); m.rough = mix(0.86, 0.6, t.r);
  }
  else if (isKind(kind, K_BRUSHED)) { anisoX = 0.06; anisoY = 0.32; }

  let V = normalize(F.camPos.xyz - in.wp);
  let L = F.sunDir.xyz;
  let H = normalize(V + L);
  let NoV = max(dot(N, V), 1e-4); let NoLr = dot(N, L); let NoL = max(NoLr, 0.0); let NoH = max(dot(N, H), 0.0); let VoH = max(dot(V, H), 0.0);
  let rough = clamp(m.rough, 0.045, 1.0);
  let a = rough * rough;
  let f0 = mix(vec3f(0.04), m.base, m.metal);
  let sh = shadowAt(in.wp, N);
  let sunL = sunRadianceAt(in.wp.y) * sh;
  let ao = aoAt(in.pos.xy);

  // direct sun: GGX (or anisotropic GGX) specular + energy-conserving Lambert (foliage: wrapped)
  let Fs = F_Schlick(f0, VoH);
  var D = D_GGX(NoH, a);
  if (anisoX > 0.0) { let B = cross(N, Tg); D = D_aniso(NoH, dot(Tg, H), dot(B, H), anisoX, anisoY); }
  let spec = D * V_Smith(NoV, NoL, a) * Fs;
  var diffL = NoL;
  if (kind > 3.5 && kind < 4.5) { diffL = max((NoLr + 0.45) / 1.45, 0.0); }
  let diff = (vec3f(1.0) - Fs) * (1.0 - m.metal) * m.base / PI;
  var col = diff * sunL * diffL + spec * sunL * NoL;
  // metallic flakes: tiny mirrors under the clear coat that sparkle in the sun
  if (flakes > 0.0) {
    let cellId = vec2u(floor(in.uv * vec2f(1400.0, 2800.0)));
    let hh = vec3f(hashf(cellId.x * 92837u + cellId.y), hashf(cellId.y * 71993u + cellId.x + 5u), hashf((cellId.x * 1931u) ^ (cellId.y * 7u))) - 0.5;
    let fN = normalize(N + hh * 0.35);
    let sp = pow(max(dot(reflect(-L, fN), V), 0.0), 900.0);
    col += m.base * sp * sunL * NoL * 6.0 * flakes;
  }

  // ambient from the sky (+ a bounce from the sunlit ground below); shadowed areas and AO get less
  let skyUp = skyL(normalize(vec3f(N.x, max(N.y, 0.0) + 0.6, N.z)));
  let groundRad = vec3f(0.1, 0.11, 0.07) * (sunRadianceAt(0.0) * max(F.sunDir.y, 0.0) + skyL(vec3f(0.0, 1.0, 0.0)) * PI) / PI;
  let occ = mix(0.75, 1.0, sh) * ao;
  let irr = PI * (skyUp * (0.5 + 0.5 * N.y) + groundRad * (0.5 - 0.5 * N.y)) * F.params.y * occ;
  let R = reflect(-V, N);
  var env = groundRad;
  if (R.y > 0.0) { env = mix(skyL(R), skyUp, rough * rough); }
  env = mix(env, groundRad, smoothstep(0.05, -0.05, R.y)) * occ;
  let eb = envBRDF(f0, rough, NoV);
  let ms = 1.0 + f0 * (1.0 / max(eb.y + eb.x, 0.2) - 1.0) * 0.5;
  col += (1.0 - m.metal) * m.base * irr / PI * (vec3f(1.0) - eb) + env * eb * ms;

  // clear coat (car paint, carbon): a second, glossy layer on top
  if (m.coat > 0.0) {
    let Fc = (0.04 + 0.96 * pow(1.0 - NoV, 5.0)) * m.coat;
    let ca = 0.05 * 0.05;
    let cspec = D_GGX(NoH, ca) * V_Smith(NoV, NoL, ca) * (0.04 + 0.96 * pow(1.0 - VoH, 5.0)) * m.coat;
    col = col * (1.0 - Fc) + cspec * sunL * NoL + (skyL(normalize(vec3f(R.x, max(R.y, 0.02), R.z))) * smoothstep(-0.1, 0.05, R.y) + groundRad * smoothstep(0.05, -0.1, R.y)) * Fc * occ;
  }
  col += in.emit.rgb * in.emit.w;
  var o: GOut;
  o.color = vec4f(applyFog(col, in.wp), 1.0);
  o.vel = velocity(in);
  return o;
}

// glass (kind 6): reflects the sky, lets the scene behind show through slightly refracted and tinted
@group(2) @binding(0) var sceneCopy: texture_2d<f32>;
@fragment fn fsGlass(in: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var N = normalize(in.n); if (!front) { N = -N; }
  let V = normalize(F.camPos.xyz - in.wp);
  let NoV = max(dot(N, V), 1e-4);
  let Fr = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
  let vn = (F.view * vec4f(N, 0.0)).xyz;
  let uv = clamp(in.pos.xy * F.res.zw - vn.xy * vec2f(1.0, -1.0) * 0.012, vec2f(0.001), vec2f(0.999));
  let behind = textureSampleLevel(sceneCopy, samp, uv, 0.0).rgb;
  let R = reflect(-V, N);
  var refl = skyL(normalize(vec3f(R.x, max(R.y, 0.02), R.z)));
  refl = mix(refl, vec3f(0.02), smoothstep(0.05, -0.1, R.y));
  let L = F.sunDir.xyz; let H = normalize(V + L);
  let sunL = sunRadianceAt(in.wp.y) * shadowAt(in.wp, N);
  let spec = D_GGX(max(dot(N, H), 0.0), 0.003) * V_Smith(NoV, max(dot(N, L), 0.0), 0.003) * Fr * sunL * max(dot(N, L), 0.0);
  let col = behind * in.base.rgb * (1.0 - Fr) + refl * Fr + spec;
  return vec4f(applyFog(col, in.wp), 1.0);
}
`;

// depth-only pass into one shadow cascade
export const SHADOW = /* wgsl */`
struct Inst { model: mat4x4f, base: vec4f, pbr: vec4f, emit: vec4f };
struct Cascade { vp: mat4x4f };
@group(0) @binding(0) var<uniform> C: Cascade;
@group(1) @binding(0) var<storage, read> insts: array<Inst>;
@vertex fn vs(@location(0) p: vec3f, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  return C.vp * (insts[ii].model * vec4f(p, 1.0));
}
`;

// ---------- sky (drawn last, only where nothing else was drawn) ----------
export const SKY = SCENE_COMMON + FULLSCREEN + /* wgsl */`
struct SkyOut { @location(0) color: vec4f, @location(1) vel: vec2f };
@fragment fn fs(in: FsOut) -> SkyOut {
  let ndc = vec2f(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
  let w = F.invViewProj * vec4f(ndc, 0.5, 1.0);
  let dir = normalize(w.xyz / w.w - F.camPos.xyz);
  var col = skyL(dir);
  // sun disk with limb darkening
  let c = dot(dir, F.sunDir.xyz);
  let sunR = 0.0047 * 1.7;
  let cosR = cos(sunR);
  if (c > cosR) {
    let x = clamp(acos(min(c, 1.0)) / sunR, 0.0, 1.0);
    let limb = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - x * x, 0.0)));
    col += sunRadianceAt(F.camPos.y) * F.sunDir.w * limb * smoothstep(0.0, 0.02, dir.y + 0.01);
  }
  if (dir.y < 0.0) {
    let g = vec3f(0.05, 0.07, 0.035) * (sunRadianceAt(0.0) * max(F.sunDir.y, 0.0) + skyL(vec3f(0.0, 1.0, 0.0)) * PI) / PI;
    col = mix(col, g, smoothstep(0.0, -0.2, dir.y) * 0.6);
  }
  // motion of a point at infinity: only the camera's rotation moves it
  let cur = F.vpNoJitter * vec4f(dir, 0.0); let prev = F.prevVP * vec4f(dir, 0.0);
  var o: SkyOut;
  o.color = vec4f(col, 1.0);
  o.vel = (cur.xy / cur.w - prev.xy / prev.w) * vec2f(0.5, -0.5);
  return o;
}
`;

// ---------- tone mapping (AgX), vignette, dither, sRGB; also upscales from the render resolution ----------
export const TONEMAP = FRAME + FULLSCREEN + /* wgsl */`
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x; let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
fn agx(c: vec3f) -> vec3f {
  let m = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                  0.0784335999999992, 0.878468636469772, 0.0784336,
                  0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  let lo = -12.47393; let hi = 4.026069;
  var v = m * c;
  v = clamp(log2(max(v, vec3f(1e-10))), vec3f(lo), vec3f(hi));
  v = (v - lo) / (hi - lo);
  return agxContrast(v);
}
fn agxLook(v: vec3f) -> vec3f {   // a touch of "punch": more saturation and contrast
  let luma = dot(v, vec3f(0.2126, 0.7152, 0.0722));
  let s = pow(max(v, vec3f(0.0)), vec3f(1.12));
  return luma + (s - luma) * 1.18;
}
fn agxEotf(v: vec3f) -> vec3f {
  let mi = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                   -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                   -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  return pow(max(mi * v, vec3f(0.0)), vec3f(2.2));
}
fn toSRGB(c: vec3f) -> vec3f {
  let lo = c * 12.92; let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}
@fragment fn fs(in: FsOut) -> @location(0) vec4f {
  var c = textureSampleLevel(hdr, samp, in.uv, 0.0).rgb * F.sunColor.w;
  c = agxEotf(agxLook(agx(c)));
  let d = in.uv - 0.5;
  c *= mix(1.0, 0.72, smoothstep(0.25, 0.85, dot(d, d) * 2.2));
  var o = toSRGB(clamp(c, vec3f(0.0), vec3f(1.0)));
  // blue-noise-ish dither kills banding in the sky gradients
  let n = fract(sin(dot(in.pos.xy, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
  o += n / 255.0;
  return vec4f(o, 1.0);
}
`;
