// Post-processing shaders: ambient occlusion (half res), TAA (motion vectors, Catmull-Rom history, variance
// clipping), motion blur, bloom (13-tap downsample with Karis average + tent upsample), auto exposure
// (compute: average log luminance, adapts over time), and the final composite (bloom, lens dirt, chromatic
// aberration at speed, sharpening, AgX tone map, vignette, grain, dither, sRGB).
import { FRAME } from './shaders.js';

const FS = /* wgsl */`
struct FsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> FsOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: FsOut; o.pos = vec4f(p, 0.0, 1.0); o.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); return o;
}
fn ign(p: vec2f, frame: f32) -> f32 {      // interleaved gradient noise, shifted every frame (TAA averages it)
  let q = p + frame * vec2f(5.588238, 5.588238);
  return fract(52.9829189 * fract(dot(q, vec2f(0.06711056, 0.00583715))));
}
`;

// ---------- ambient occlusion: screen-space horizon samples around each pixel's world position ----------
export const AO = FRAME + FS + /* wgsl */`
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var depthTex: texture_depth_2d;
fn worldAt(px: vec2i) -> vec4f {
  let size = vec2i(textureDimensions(depthTex));
  let q = clamp(px, vec2i(0), size - 1);
  let d = textureLoad(depthTex, q, 0);
  let ndc = vec2f((f32(q.x) + 0.5) / f32(size.x) * 2.0 - 1.0, 1.0 - (f32(q.y) + 0.5) / f32(size.y) * 2.0);
  let w = F.invViewProj * vec4f(ndc, d, 1.0);
  return vec4f(w.xyz / w.w, d);
}
@fragment fn fs(in: FsOut) -> @location(0) vec4f {
  let px = vec2i(in.pos.xy * 2.0);
  let c = worldAt(px);
  if (c.w <= 0.0) { return vec4f(1.0); }
  let P = c.xyz;
  // normal from the neighbour with the smaller depth step on each axis (no halos at silhouettes)
  let r = worldAt(px + vec2i(2, 0)).xyz - P; let l = P - worldAt(px - vec2i(2, 0)).xyz;
  let u = worldAt(px + vec2i(0, 2)).xyz - P; let dn = P - worldAt(px - vec2i(0, 2)).xyz;
  let dx = select(l, r, dot(r, r) < dot(l, l)); let dy = select(dn, u, dot(u, u) < dot(dn, dn));
  var N = normalize(cross(dy, dx));
  let V = normalize(F.camPos.xyz - P);
  if (dot(N, V) < 0.0) { N = -N; }
  let dist = length(F.camPos.xyz - P);
  let radius = 1.4;
  let rpx = clamp(radius * F.proj.y / dist * F.res.y * 0.5, 3.0, 90.0);       // world radius in full-res pixels
  let noise = ign(in.pos.xy, F.taa.w);
  var occ = 0.0;
  let dirs = 2; let steps = 3;
  for (var k = 0; k < dirs; k++) {
    let a = (f32(k) + noise) / f32(dirs) * 3.14159265;
    let dir = vec2f(cos(a), sin(a));
    for (var s = 1; s <= steps; s++) {
      let t = (f32(s) - 0.5 + fract(noise * 7.0 + f32(s) * 0.37)) / f32(steps);
      for (var side = -1; side <= 1; side += 2) {
        let q = worldAt(px + vec2i(dir * f32(side) * t * rpx));
        if (q.w <= 0.0) { continue; }
        let v = q.xyz - P; let vv = dot(v, v);
        let fall = max(0.0, 1.0 - vv / (radius * radius * 4.0));
        occ += max(0.0, dot(v, N) / sqrt(vv + 1e-4) - 0.12) * fall;
      }
    }
  }
  let ao = clamp(1.0 - occ / f32(dirs * steps * 2) * 2.2, 0.0, 1.0);
  return vec4f(ao, ao, ao, 1.0);
}
`;

// ---------- TAA ----------
export const TAA = FRAME + FS + /* wgsl */`
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var cur: texture_2d<f32>;
@group(0) @binding(2) var hist: texture_2d<f32>;
@group(0) @binding(3) var velTex: texture_2d<f32>;
@group(0) @binding(4) var depthTex: texture_depth_2d;
@group(0) @binding(5) var samp: sampler;
fn rgb2ycocg(c: vec3f) -> vec3f { return vec3f(dot(c, vec3f(0.25, 0.5, 0.25)), dot(c, vec3f(0.5, 0.0, -0.5)), dot(c, vec3f(-0.25, 0.5, -0.25))); }
fn ycocg2rgb(c: vec3f) -> vec3f { return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
fn tm(c: vec3f) -> vec3f { return c / (1.0 + max(c.r, max(c.g, c.b))); }               // tame fireflies before blending
fn itm(c: vec3f) -> vec3f { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-4); }
// 5-tap Catmull-Rom: sharp history without blurring over many frames
override HQ: bool = true;      // 5-tap Catmull-Rom history (sharper); false = one bilinear tap (Low preset)
fn histSample(uv: vec2f) -> vec3f {
  if (!HQ) { return textureSampleLevel(hist, samp, uv, 0.0).rgb; }
  let size = vec2f(textureDimensions(hist));
  let p = uv * size - 0.5; let f = fract(p); let t1 = floor(p) + 0.5;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f)); let w1 = 1.0 + f * f * (-2.5 + 1.5 * f); let w2 = f * (0.5 + f * (2.0 - 1.5 * f)); let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2; let tc0 = (t1 - 1.0) / size; let tc3 = (t1 + 2.0) / size; let tc12 = (t1 + w2 / w12) / size;
  var r = textureSampleLevel(hist, samp, vec2f(tc12.x, tc0.y), 0.0).rgb * (w12.x * w0.y);
  r += textureSampleLevel(hist, samp, vec2f(tc0.x, tc12.y), 0.0).rgb * (w0.x * w12.y);
  r += textureSampleLevel(hist, samp, vec2f(tc12.x, tc12.y), 0.0).rgb * (w12.x * w12.y);
  r += textureSampleLevel(hist, samp, vec2f(tc3.x, tc12.y), 0.0).rgb * (w3.x * w12.y);
  r += textureSampleLevel(hist, samp, vec2f(tc12.x, tc3.y), 0.0).rgb * (w12.x * w3.y);
  let wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / wsum, vec3f(0.0));
}
@fragment fn fs(in: FsOut) -> @location(0) vec4f {
  let p = vec2i(in.pos.xy);
  let size = vec2i(textureDimensions(cur));
  // velocity of the closest pixel in a cross (moving edges keep their own motion), colour statistics of the cross
  var best = -1.0; var bp = p;
  var m1 = vec3f(0.0); var m2 = vec3f(0.0); var mn = vec3f(1e9); var mx = vec3f(-1e9);
  var offs = array<vec2i, 5>(vec2i(0, 0), vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1));
  for (var k = 0; k < 5; k++) {
    let q = clamp(p + offs[k], vec2i(0), size - 1);
    let d = textureLoad(depthTex, q, 0);
    if (d > best) { best = d; bp = q; }
    let c = rgb2ycocg(tm(textureLoad(cur, q, 0).rgb));
    m1 += c; m2 += c * c; mn = min(mn, c); mx = max(mx, c);
  }
  let center = tm(textureLoad(cur, p, 0).rgb);
  if (F.post.w < 0.5) { return vec4f(itm(center), 1.0); }       // history invalid (first frame, resize, camera cut)
  let vel = textureLoad(velTex, bp, 0).xy;
  let prevUV = in.uv - vel;
  if (any(prevUV < vec2f(0.0)) || any(prevUV > vec2f(1.0))) { return vec4f(itm(center), 1.0); }
  var h = rgb2ycocg(tm(histSample(prevUV)));
  // variance clipping: pull the history into the colour range seen around this pixel now
  let mu = m1 / 5.0; let sigma = sqrt(max(m2 / 5.0 - mu * mu, vec3f(0.0)));
  let lo = max(mn, mu - sigma * 1.25); let hi = min(mx, mu + sigma * 1.25);
  let cc = (lo + hi) * 0.5; let ext = max((hi - lo) * 0.5, vec3f(1e-5));
  let dv = (h - cc) / ext; let ma = max(abs(dv.x), max(abs(dv.y), abs(dv.z)));
  if (ma > 1.0) { h = cc + (h - cc) / ma; }
  // more of the new frame when things move fast (less smearing), less when still (smoother)
  let speedPx = length(vel * vec2f(size));
  let alpha = clamp(0.08 + speedPx * 0.012, 0.08, 0.35);
  let outc = mix(ycocg2rgb(h), center, alpha);
  return vec4f(itm(outc), 1.0);
}
`;

// ---------- motion blur: samples along this pixel's motion (camera + objects) ----------
export const MBLUR = FRAME + FS + /* wgsl */`
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var velTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@fragment fn fs(in: FsOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  var v = textureLoad(velTex, vec2i(in.pos.xy), 0).xy * F.post.y;        // shutter fraction
  let lpx = length(v * size);
  let maxPx = 28.0;
  if (lpx > maxPx) { v *= maxPx / lpx; }
  let c0 = textureSampleLevel(src, samp, in.uv, 0.0).rgb;
  if (lpx < 0.75) { return vec4f(c0, 1.0); }
  let n = 9; let j = ign(in.pos.xy, F.taa.w) - 0.5;
  var acc = c0; var w = 1.0;
  for (var i = 0; i < n; i++) {
    let t = (f32(i) + 0.5 + j) / f32(n) - 0.5;
    acc += textureSampleLevel(src, samp, in.uv + v * t, 0.0).rgb; w += 1.0;
  }
  return vec4f(acc / w, 1.0);
}
`;

// ---------- bloom ----------
export const BLOOM_DOWN = FS + /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
override KARIS: bool = false;      // first level: Karis average so single bright pixels cannot flicker
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn karis(c: vec3f) -> f32 { return 1.0 / (1.0 + lum(c)); }
@fragment fn fs(in: FsOut) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src)); let uv = in.uv;
  var s = array<vec2f, 13>(vec2f(-2, -2), vec2f(0, -2), vec2f(2, -2), vec2f(-1, -1), vec2f(1, -1), vec2f(-2, 0), vec2f(0, 0), vec2f(2, 0), vec2f(-1, 1), vec2f(1, 1), vec2f(-2, 2), vec2f(0, 2), vec2f(2, 2));
  var c: array<vec3f, 13>;
  for (var i = 0; i < 13; i++) { c[i] = min(textureSampleLevel(src, samp, uv + s[i] * t, 0.0).rgb, vec3f(6e4)); }
  // 13-tap filter = 4 overlapping 2x2 boxes + the centre box (weights 0.125 x 4 + 0.5)
  let b0 = (c[3] + c[4] + c[8] + c[9]) * 0.25; let b1 = (c[0] + c[1] + c[5] + c[6]) * 0.25; let b2 = (c[1] + c[2] + c[6] + c[7]) * 0.25;
  let b3 = (c[5] + c[6] + c[10] + c[11]) * 0.25; let b4 = (c[6] + c[7] + c[11] + c[12]) * 0.25;
  if (KARIS) {
    let w0 = karis(b0) * 0.5; let w1 = karis(b1) * 0.125; let w2 = karis(b2) * 0.125; let w3 = karis(b3) * 0.125; let w4 = karis(b4) * 0.125;
    return vec4f((b0 * w0 + b1 * w1 + b2 * w2 + b3 * w3 + b4 * w4) / (w0 + w1 + w2 + w3 + w4), 1.0);
  }
  return vec4f(b0 * 0.5 + (b1 + b2 + b3 + b4) * 0.125, 1.0);
}
`;
export const BLOOM_UP = FS + /* wgsl */`
@group(0) @binding(0) var low: texture_2d<f32>;     // smaller, already accumulated level
@group(0) @binding(1) var here: texture_2d<f32>;    // this level's downsample
@group(0) @binding(2) var samp: sampler;
@fragment fn fs(in: FsOut) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(low)); let uv = in.uv;
  var s = textureSampleLevel(low, samp, uv, 0.0).rgb * 4.0;
  s += (textureSampleLevel(low, samp, uv + vec2f(-t.x, 0.0), 0.0).rgb + textureSampleLevel(low, samp, uv + vec2f(t.x, 0.0), 0.0).rgb + textureSampleLevel(low, samp, uv + vec2f(0.0, -t.y), 0.0).rgb + textureSampleLevel(low, samp, uv + vec2f(0.0, t.y), 0.0).rgb) * 2.0;
  s += textureSampleLevel(low, samp, uv - t, 0.0).rgb + textureSampleLevel(low, samp, uv + t, 0.0).rgb + textureSampleLevel(low, samp, uv + vec2f(t.x, -t.y), 0.0).rgb + textureSampleLevel(low, samp, uv + vec2f(-t.x, t.y), 0.0).rgb;
  return vec4f(textureSampleLevel(here, samp, uv, 0.0).rgb + s / 16.0, 1.0);
}
`;

// ---------- auto exposure (compute): average log luminance of a small bloom level, smooth adaptation ----------
export const EXPOSURE = FRAME + /* wgsl */`
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> E: array<f32, 4>;     // 0 exposure (linear multiplier), 1 avg log2 luminance, 2 initialised
var<workgroup> acc: array<vec2f, 256>;
@compute @workgroup_size(256) fn cs(@builtin(local_invocation_index) li: u32) {
  let size = vec2u(textureDimensions(src));
  var s = vec2f(0.0);
  for (var i = li; i < size.x * size.y; i += 256u) {
    let q = vec2u(i % size.x, i / size.x);
    let c = textureLoad(src, q, 0).rgb;
    let L = max(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 1e-4);
    let uv = (vec2f(q) + 0.5) / vec2f(size) - 0.5;
    let w = 1.0 - smoothstep(0.1, 0.6, length(uv * vec2f(1.0, 1.3)));      // centre-weighted
    s += vec2f(log2(L) * (w + 0.05), w + 0.05);
  }
  acc[li] = s;
  workgroupBarrier();
  for (var st = 128u; st > 0u; st >>= 1u) { if (li < st) { acc[li] += acc[li + st]; } workgroupBarrier(); }
  if (li == 0u) {
    let avg = acc[0].x / max(acc[0].y, 1e-4);
    // key value: 0.18 grey, times the scene's compensation (F.sunColor.w as EV bias); clamp the range
    let goal = clamp(0.18 * exp2(F.sunColor.w) / exp2(avg), 0.02, 64.0);
    let dt = F.post.x;
    if (E[2] < 0.5) { E[0] = goal; E[2] = 1.0; }
    else {
      let k = 1.0 - exp(-dt * select(1.1, 2.4, goal < E[0]));            // adapt to bright light faster than to dark
      E[0] = exp2(mix(log2(E[0]), log2(goal), k));
    }
    E[1] = avg;
  }
}
`;

// ---------- final composite ----------
export const FINAL = FRAME + FS + /* wgsl */`
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var bloom: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<storage, read> E: array<f32, 4>;
@group(0) @binding(5) var<uniform> FX: vec4f;      // x bloom strength, y chromatic aberration, z grain, w sharpen
fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x; let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
fn agx(c: vec3f) -> vec3f {
  let m = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  let lo = -12.47393; let hi = 4.026069;
  var v = m * c;
  v = clamp(log2(max(v, vec3f(1e-10))), vec3f(lo), vec3f(hi));
  return agxContrast((v - lo) / (hi - lo));
}
fn agxLook(v: vec3f) -> vec3f { let luma = dot(v, vec3f(0.2126, 0.7152, 0.0722)); let s = pow(max(v, vec3f(0.0)), vec3f(1.12)); return luma + (s - luma) * 1.2; }
fn agxEotf(v: vec3f) -> vec3f {
  let mi = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  return pow(max(mi * v, vec3f(0.0)), vec3f(2.2));
}
fn toSRGB(c: vec3f) -> vec3f { let lo = c * 12.92; let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055; return select(hi, lo, c <= vec3f(0.0031308)); }
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
fn vnoise(p: vec2f) -> f32 { let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), u.x), mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), u.x), u.y); }
// faint smudges and dust on the lens, only visible where bright light (bloom) passes through them
fn lensDirt(uv: vec2f) -> f32 {
  let p = uv * vec2f(16.0, 9.0);
  let d = smoothstep(0.62, 0.9, vnoise(p * 0.9 + 3.1)) * 0.7 + smoothstep(0.7, 0.95, vnoise(p * 2.7 + 11.0)) * 0.5 + smoothstep(0.86, 0.98, vnoise(p * 7.0)) * 0.6;
  return d * (0.4 + 0.6 * length(uv - 0.5));
}
@fragment fn fs(in: FsOut) -> @location(0) vec4f {
  let uv = in.uv;
  let d = uv - 0.5;
  let ts = 1.0 / vec2f(textureDimensions(src));
  // chromatic aberration: red and blue pulled slightly apart towards the edges, more at speed
  let ca = d * FX.y * 0.004;
  var c = textureSampleLevel(src, samp, uv, 0.0).rgb;
  if (length(ca) * f32(textureDimensions(src).x) > 0.35) {
    c = vec3f(textureSampleLevel(src, samp, uv - ca, 0.0).r, c.g, textureSampleLevel(src, samp, uv + ca, 0.0).b);
  }
  // light sharpening (offsets the softness TAA leaves behind)
  if (FX.w > 0.0) {
    let n = textureSampleLevel(src, samp, uv + vec2f(0.0, -ts.y), 0.0).rgb + textureSampleLevel(src, samp, uv + vec2f(0.0, ts.y), 0.0).rgb
          + textureSampleLevel(src, samp, uv + vec2f(-ts.x, 0.0), 0.0).rgb + textureSampleLevel(src, samp, uv + vec2f(ts.x, 0.0), 0.0).rgb;
    let mn = min(c, n * 0.25); let edge = c - n * 0.25;
    c = max(c + edge * FX.w * 0.8 / (1.0 + dot(abs(edge), vec3f(0.33)) * 4.0), mn * 0.5);
  }
  let b = textureSampleLevel(bloom, samp, uv, 0.0).rgb / 6.0;        // 6 levels summed
  c = mix(c, b, FX.x);
  let bl = dot(b, vec3f(0.33)) * E[0];
  if (bl > 0.6 && FX.z > 0.0) { c += b * lensDirt(uv) * FX.x * 2.5 * smoothstep(0.6, 2.0, bl); }
  c *= E[0];
  c = agxEotf(agxLook(agx(c)));
  c *= mix(1.0, 0.7, smoothstep(0.25, 0.85, dot(d, d) * 2.2));       // vignette
  var o = toSRGB(clamp(c, vec3f(0.0), vec3f(1.0)));
  let g = hash(in.pos.xy + fract(F.camPos.w * 7.13) * 100.0) - 0.5;
  o += g * (FX.z * 0.035 * (1.0 - dot(o, vec3f(0.33)) * 0.7)) + g / 255.0;   // film grain (mostly in the darks) + dither
  return vec4f(o, 1.0);
}
`;
