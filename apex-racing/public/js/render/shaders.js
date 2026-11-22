// WGSL shaders. Units: metres in the world, kilometres inside the atmosphere model.
export const FRAME = /* wgsl */`
struct Frame {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  view: mat4x4f,
  camPos: vec4f,     // xyz metres, w = time (s)
  sunDir: vec4f,     // xyz towards the sun, w = sun disk brightness
  sunColor: vec4f,   // rgb sun illuminance above the atmosphere, w = exposure
  res: vec4f,        // render width, height, 1/width, 1/height
  params: vec4f,     // x fog density, y ambient strength, z wetness, w night
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
`;

// ---------- meshes: PBR with clear coat; kind 1 = procedural track surface ----------
export const MESH = SCENE_COMMON + /* wgsl */`
struct Inst { model: mat4x4f, base: vec4f, pbr: vec4f, emit: vec4f };   // pbr: metal, rough, clearcoat, kind
@group(1) @binding(0) var<storage, read> insts: array<Inst>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) base: vec4f,
  @location(4) @interpolate(flat) pbr: vec4f,
  @location(5) @interpolate(flat) emit: vec4f,
};
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @builtin(instance_index) ii: u32) -> VOut {
  let inst = insts[ii];
  let w = inst.model * vec4f(p, 1.0);
  var o: VOut;
  o.pos = F.viewProj * w; o.wp = w.xyz; o.n = (inst.model * vec4f(n, 0.0)).xyz; o.uv = uv;
  o.base = inst.base; o.pbr = inst.pbr; o.emit = inst.emit;
  return o;
}

fn hashu(x: u32) -> u32 { let v = x * 747796405u + 2891336453u; let w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (w >> 22u) ^ w; }
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

fn trackSurface(wp: vec3f, fx: f32, fz: f32) -> Mat {
  var m: Mat; m.metal = 0.0; m.coat = 0.0;
  let x = abs(wp.x); let z = wp.z;
  let fp = max(fx, fz);
  let road = band(x, -1.0, 6.0, fx);
  let kerbW = band(x, 6.0, 7.4, fx);
  m.base = vec3f(0.0); m.rough = 0.0;
  var wsum = 0.0;
  // grass with mowing stripes (8 m bands) and clumps - only where grass shows
  let gw = 1.0 - road - kerbW;
  if (gw > 0.0) {
    let stripe = sqw(z / 8.0, fz / 8.0);
    let clump = fnoise(wp.xz * 0.35, fp * 0.35) * 0.6 + fnoise(wp.xz * 2.1, fp * 2.1) * 0.4;
    m.base += mix(vec3f(0.035, 0.085, 0.018), vec3f(0.06, 0.125, 0.026), stripe) * (0.75 + 0.5 * clump) * gw;
    m.rough += 0.92 * gw;
  }
  // asphalt: fine grain, darker rubbered racing line, lighter dusty edges, painted edge line
  if (road > 0.0) {
    let grain = fnoise(wp.xz * 9.0, fp * 9.0) * 0.5 + fnoise(wp.xz * 2.3, fp * 2.3) * 0.5;
    let rubber = 1.0 - smoothstep(0.6, 2.2, abs(wp.x - 2.2 * sin(z * 0.013)));
    var asph = vec3f(0.055) * (0.75 + 0.5 * grain);
    asph = mix(asph, vec3f(0.032), rubber * 0.8);
    asph = mix(asph, vec3f(0.085, 0.08, 0.075), smoothstep(4.0, 5.6, x) * 0.6);
    var ar = mix(0.82, 0.62, rubber) - grain * 0.08;
    let paint = band(x, 5.45, 5.7, fx);
    asph = mix(asph, vec3f(0.7), paint); ar = mix(ar, 0.55, paint);
    m.base += asph * road; m.rough += ar * road;
  }
  // kerbs: 3 m red/white blocks
  if (kerbW > 0.0) {
    m.base += mix(vec3f(0.55, 0.02, 0.015), vec3f(0.72, 0.72, 0.7), sqw(z / 3.0, fz / 3.0)) * kerbW;
    m.rough += 0.5 * kerbW;
  }
  return m;
}

fn D_GGX(NoH: f32, a: f32) -> f32 { let a2 = a * a; let d = NoH * NoH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
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

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let fx = fwidth(in.wp.x); let fz = fwidth(in.wp.z);
  var m: Mat;
  m.base = in.base.rgb; m.metal = in.pbr.x; m.rough = in.pbr.y; m.coat = in.pbr.z;
  if (in.pbr.w > 0.5) { m = trackSurface(in.wp, fx, fz); }

  let N = normalize(in.n);
  let V = normalize(F.camPos.xyz - in.wp);
  let L = F.sunDir.xyz;
  let H = normalize(V + L);
  let NoV = max(dot(N, V), 1e-4); let NoL = max(dot(N, L), 0.0); let NoH = max(dot(N, H), 0.0); let VoH = max(dot(V, H), 0.0);
  let rough = clamp(m.rough, 0.045, 1.0);
  let a = rough * rough;
  let f0 = mix(vec3f(0.04), m.base, m.metal);
  let sunL = sunRadianceAt(in.wp.y);

  // direct sun: GGX specular + energy-conserving Lambert
  let Fs = F_Schlick(f0, VoH);
  let spec = D_GGX(NoH, a) * V_Smith(NoV, NoL, a) * Fs;
  let diff = (vec3f(1.0) - Fs) * (1.0 - m.metal) * m.base / PI;
  var col = (diff + spec) * sunL * NoL;

  // ambient from the sky (+ a bounce from the sunlit ground below)
  let skyUp = skyL(normalize(vec3f(N.x, max(N.y, 0.0) + 0.6, N.z)));
  let groundRad = vec3f(0.12, 0.13, 0.09) * (sunL * max(F.sunDir.y, 0.0) + skyL(vec3f(0.0, 1.0, 0.0)) * PI) / PI;
  let irr = PI * (skyUp * (0.5 + 0.5 * N.y) + groundRad * (0.5 - 0.5 * N.y)) * F.params.y;
  let R = reflect(-V, N);
  var env = groundRad;
  if (R.y > 0.0) { env = mix(skyL(R), skyUp, rough * rough); }
  env = mix(env, groundRad, smoothstep(0.05, -0.05, R.y));
  // multi-scatter compensation keeps rough metals from going dark
  let eb = envBRDF(f0, rough, NoV);
  let ms = 1.0 + f0 * (1.0 / max(eb.y + eb.x, 0.2) - 1.0) * 0.5;
  col += (1.0 - m.metal) * m.base * irr / PI * (vec3f(1.0) - eb) + env * eb * ms;

  // clear coat (car paint, carbon): a second, glossy layer on top
  if (m.coat > 0.0) {
    let Fc = (0.04 + 0.96 * pow(1.0 - NoV, 5.0)) * m.coat;
    let ca = 0.05 * 0.05;
    let cspec = D_GGX(NoH, ca) * V_Smith(NoV, NoL, ca) * (0.04 + 0.96 * pow(1.0 - VoH, 5.0)) * m.coat;
    col = col * (1.0 - Fc) + cspec * sunL * NoL + skyL(normalize(vec3f(R.x, max(R.y, 0.02), R.z))) * Fc * smoothstep(-0.1, 0.05, R.y) + groundRad * Fc * smoothstep(0.05, -0.1, R.y);
  }
  col += in.emit.rgb * in.emit.w;
  return vec4f(applyFog(col, in.wp), 1.0);
}
`;

// ---------- sky (drawn last, only where nothing else was drawn) ----------
export const SKY = SCENE_COMMON + FULLSCREEN + /* wgsl */`
@fragment fn fs(in: FsOut) -> @location(0) vec4f {
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
  // below the horizon (beyond the ground plane): dim ground colour fading into haze
  if (dir.y < 0.0) {
    let g = vec3f(0.05, 0.07, 0.035) * (sunRadianceAt(0.0) * max(F.sunDir.y, 0.0) + skyL(vec3f(0.0, 1.0, 0.0)) * PI) / PI;
    col = mix(col, g, smoothstep(0.0, -0.2, dir.y) * 0.6);
  }
  return vec4f(col, 1.0);
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
