// Renderer: owns pipelines and per-frame GPU data, and records each frame as a frame graph:
//   sky-view LUT -> shadow cascades -> depth prepass -> AO (half res) -> opaque scene (HDR + motion vectors)
//   -> glass (refracts a copy of the scene) -> TAA -> motion blur -> bloom chain -> auto exposure -> final.
// Static geometry is drawn as instanced groups culled against the camera / each cascade and sorted front to
// back; per-frame objects (cars, lights) live in a dynamic slice of the same instance buffer, with last
// frame's matrices kept for motion vectors.
import { FrameGraph } from '../engine/framegraph.js';
import { TRANSMITTANCE, SKYVIEW, MESH, SKY, SHADOW } from './shaders.js';
import { AO, TAA, MBLUR, BLOOM_DOWN, BLOOM_UP, EXPOSURE, FINAL } from './post.js';
import { frustumPlanes, sphereVisible, INST_FLOATS } from './scene.js';
import { lookAt, mul } from '../engine/math.js';
export { INST_FLOATS };

const HDR = 'rgba16float', DEPTH = 'depth32float', VEL = 'rg16float';
const FRAME_FLOATS = 192;     // must match struct Frame in shaders.js
export const LIVERY_W = 1024, LIVERY_H = 512, LIVERY_LAYERS = 8;
export const SHADOW_PRESETS = {
  low: { size: 1024, cascades: 2, dist: 220, taps: 4 },
  medium: { size: 2048, cascades: 3, dist: 350, taps: 9 },
  high: { size: 2048, cascades: 4, dist: 500, taps: 9 },
  ultra: { size: 4096, cascades: 4, dist: 700, taps: 9 },
};
// distance level of detail: past the distance a cheaper mesh is drawn (null = not drawn at all)
const LOD = { ico: [[260, 'ico0']], cone: [[260, 'cone4']], cyl: [[140, 'cyl4']], cyl6: [[350, 'cyl4'], [700, null]], person: [[260, null]] };
const HALTON = [[0.5, 0.333], [0.25, 0.667], [0.75, 0.111], [0.125, 0.444], [0.625, 0.778], [0.375, 0.222], [0.875, 0.556], [0.0625, 0.889]];

export class Renderer {
  constructor(gpu, profiler) {
    this.gpu = gpu; this.profiler = profiler;
    this.graph = new FrameGraph(gpu, profiler);
    this.quality = { renderScale: 1, shadows: SHADOW_PRESETS.high, taa: true, ao: true, bloom: true, motionBlur: 0.5, ca: true, grain: true };
    this.frameData = new Float32Array(FRAME_FLOATS);
    this.width = 1; this.height = 1; this.frame = 0;
    this.dynamic = [];          // per-frame instances: { mesh, model, base, pbr, emit, key? }
    this.prevByKey = new Map();
    this.trackU = [0, 0, 1, 1];
    this.stats = { drawn: 0, culled: 0 };
    this.cut = true;            // history invalid (first frame / resize / camera jump)
  }

  async init(progress = () => {}) {
    const g = this.gpu, d = g.device, V = GPUShaderStage.VERTEX, Fr = GPUShaderStage.FRAGMENT, C = GPUShaderStage.COMPUTE;
    this.frameBuf = g.buffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'frame' });
    this.cascadeBuf = g.buffer({ size: 256 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'cascades' });
    this.fxBuf = g.buffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'fx' });
    this.exposureBuf = g.buffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'exposure' });
    const ubo = { buffer: { type: 'uniform' } }, tex = { texture: { sampleType: 'float' } }, utex = { texture: { sampleType: 'unfilterable-float' } }, smp = { sampler: { type: 'filtering' } };
    const dtex = { texture: { sampleType: 'depth' } };
    this.L = {
      frameOnly: g.layout([{ binding: 0, visibility: V | Fr, ...ubo }], 'frameOnly'),
      skyview: g.layout([{ binding: 0, visibility: Fr, ...ubo }, { binding: 1, visibility: Fr, ...tex }, { binding: 2, visibility: Fr, ...smp }], 'skyview'),
      scene: g.layout([{ binding: 0, visibility: V | Fr, ...ubo }, { binding: 1, visibility: Fr, ...tex }, { binding: 2, visibility: Fr, ...smp }, { binding: 3, visibility: Fr, ...tex },
        { binding: 4, visibility: Fr, texture: { sampleType: 'depth', viewDimension: '2d-array' } }, { binding: 5, visibility: Fr, sampler: { type: 'comparison' } },
        { binding: 6, visibility: Fr, ...utex }, { binding: 7, visibility: Fr, ...tex }, { binding: 8, visibility: Fr, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 9, visibility: Fr, ...smp }], 'scene'),
      inst: g.layout([{ binding: 0, visibility: V | Fr, buffer: { type: 'read-only-storage' } }, { binding: 1, visibility: V, buffer: { type: 'read-only-storage' } }], 'instances'),
      glass: g.layout([{ binding: 0, visibility: Fr, ...tex }], 'glass'),
      cascade: g.layout([{ binding: 0, visibility: V, buffer: { type: 'uniform', hasDynamicOffset: true } }], 'cascade'),
      ao: g.layout([{ binding: 0, visibility: Fr, ...ubo }, { binding: 1, visibility: Fr, ...dtex }], 'ao'),
      taa: g.layout([{ binding: 0, visibility: Fr, ...ubo }, { binding: 1, visibility: Fr, ...tex }, { binding: 2, visibility: Fr, ...tex }, { binding: 3, visibility: Fr, ...tex }, { binding: 4, visibility: Fr, ...dtex }, { binding: 5, visibility: Fr, ...smp }], 'taa'),
      mblur: g.layout([{ binding: 0, visibility: Fr, ...ubo }, { binding: 1, visibility: Fr, ...tex }, { binding: 2, visibility: Fr, ...tex }, { binding: 3, visibility: Fr, ...smp }], 'mblur'),
      down: g.layout([{ binding: 0, visibility: Fr, ...tex }, { binding: 1, visibility: Fr, ...smp }], 'bloomDown'),
      up: g.layout([{ binding: 0, visibility: Fr, ...tex }, { binding: 1, visibility: Fr, ...tex }, { binding: 2, visibility: Fr, ...smp }], 'bloomUp'),
      expo: g.layout([{ binding: 0, visibility: C, ...ubo }, { binding: 1, visibility: C, ...tex }, { binding: 2, visibility: C, buffer: { type: 'storage' } }], 'exposure'),
      final: g.layout([{ binding: 0, visibility: Fr, ...ubo }, { binding: 1, visibility: Fr, ...tex }, { binding: 2, visibility: Fr, ...tex }, { binding: 3, visibility: Fr, ...smp },
        { binding: 4, visibility: Fr, buffer: { type: 'read-only-storage' } }, { binding: 5, visibility: Fr, ...ubo }], 'final'),
    };
    this.shadowSampler = g.sampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.anisoSampler = g.sampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', maxAnisotropy: 16 });
    const pl = (...ls) => d.createPipelineLayout({ bindGroupLayouts: ls });

    const mod = {};
    const shaderList = [['transmittance', TRANSMITTANCE], ['skyview', SKYVIEW], ['mesh', MESH], ['sky', SKY], ['shadow', SHADOW], ['ao', AO], ['taa', TAA], ['mblur', MBLUR],
      ['bloomDown', BLOOM_DOWN], ['bloomUp', BLOOM_UP], ['exposure', EXPOSURE], ['final', FINAL]];
    let done = 0; const total = shaderList.length + 15;
    const tick = label => progress(++done / total, label);
    for (const [name, code] of shaderList) { mod[name] = await g.module(code, name); tick('Compiling shader: ' + name); }

    const full = (name, layout, targets, extra = {}) => ({ layout, vertex: { module: mod[name], entryPoint: 'vs' }, fragment: { module: mod[name], entryPoint: 'fs', targets: targets.map(f => ({ format: f })), constants: extra.constants }, primitive: { topology: 'triangle-list' }, ...(extra.depthStencil ? { depthStencil: extra.depthStencil } : {}) });
    const attrs = [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x2' }];
    const meshVS = { module: mod.mesh, entryPoint: 'vs', buffers: [{ arrayStride: 32, attributes: attrs }] };
    const make = async (key, desc) => { const p = await g.renderPipeline(key, desc); tick('Pipeline: ' + key); return p; };
    this.P = {};
    const jobs = [
      make('transmittance', full('transmittance', pl(this.L.frameOnly), [HDR])).then(p => this.P.transmittance = p),
      make('skyview', full('skyview', pl(this.L.skyview), [HDR])).then(p => this.P.skyview = p),
      make('shadow', { layout: pl(this.L.cascade, this.L.inst), vertex: { module: mod.shadow, entryPoint: 'vs', buffers: [{ arrayStride: 32, attributes: [attrs[0]] }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.0, depthBiasClamp: 0.01 } }).then(p => this.P.shadow = p),
      make('prepass', { layout: pl(this.L.scene, this.L.inst), vertex: meshVS, primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
        depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'greater' } }).then(p => this.P.prepass = p),
      make('mesh', { layout: pl(this.L.scene, this.L.inst), vertex: meshVS, fragment: { module: mod.mesh, entryPoint: 'fs', targets: [{ format: HDR }, { format: VEL }] },
        primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' }, depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'greater-equal' } }).then(p => this.P.mesh = p),
      make('glass', { layout: pl(this.L.scene, this.L.inst, this.L.glass), vertex: meshVS, fragment: { module: mod.mesh, entryPoint: 'fsGlass', targets: [{ format: HDR }] },
        primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' }, depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'greater' } }).then(p => this.P.glass = p),
      make('sky', full('sky', pl(this.L.scene), [HDR, VEL], { depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'greater-equal' } })).then(p => this.P.sky = p),
      make('ao', full('ao', pl(this.L.ao), ['r8unorm'])).then(p => this.P.ao = p),
      make('taa', full('taa', pl(this.L.taa), [HDR], { constants: { HQ: 1 } })).then(p => this.P.taa = p),
      make('taaLow', full('taa', pl(this.L.taa), [HDR], { constants: { HQ: 0 } })).then(p => this.P.taaLow = p),
      make('mblur', full('mblur', pl(this.L.mblur), [HDR])).then(p => this.P.mblur = p),
      make('bloomDown0', full('bloomDown', pl(this.L.down), [HDR], { constants: { KARIS: 1 } })).then(p => this.P.bloomDown0 = p),
      make('bloomDown', full('bloomDown', pl(this.L.down), [HDR], { constants: { KARIS: 0 } })).then(p => this.P.bloomDown = p),
      make('bloomUp', full('bloomUp', pl(this.L.up), [HDR])).then(p => this.P.bloomUp = p),
      make('final', full('final', pl(this.L.final), [g.format])).then(p => this.P.final = p),
      g.computePipeline('exposure', { layout: pl(this.L.expo), compute: { module: mod.exposure, entryPoint: 'cs' } }).then(p => { this.P.exposure = p; tick('Pipeline: exposure'); }),
    ];
    await Promise.all(jobs);

    // the transmittance LUT never changes: render it once
    this.transLUT = g.texture({ label: 'transmittance', format: HDR, size: [256, 64], usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const enc = d.createCommandEncoder();
    const p = enc.beginRenderPass({ colorAttachments: [{ view: g.view(this.transLUT), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    p.setPipeline(this.P.transmittance);
    p.setBindGroup(0, d.createBindGroup({ layout: this.L.frameOnly, entries: [{ binding: 0, resource: { buffer: this.frameBuf } }] }));
    g.draw(p, 3); p.end();
    g.queue.submit([enc.finish()]);
    // small defaults: white AO (when AO is off), livery layers until the game draws real ones
    this.whiteTex = g.texture({ label: 'white', format: 'r8unorm', size: [1, 1], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    g.queue.writeTexture({ texture: this.whiteTex }, new Uint8Array([255]), { bytesPerRow: 256 }, [1, 1]);
    this.liveryMips = Math.floor(Math.log2(LIVERY_W)) + 1;
    this.liveryTex = g.texture({ label: 'liveries', format: 'rgba8unorm-srgb', size: [LIVERY_W, LIVERY_H, LIVERY_LAYERS], mipLevelCount: this.liveryMips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    this.liveryView = this.liveryTex.createView({ dimension: '2d-array' }); this.liveryView.__id = 'liveryArr';
    this.setTrackData(new Float32Array([6, 0, 0, 0]), 1, 0, 1);
    this.cascadeGroup = d.createBindGroup({ layout: this.L.cascade, entries: [{ binding: 0, resource: { buffer: this.cascadeBuf, size: 64 } }] });
    tick('Atmosphere ready');
  }

  // a livery (or the misc layer) drawn on a 2D canvas -> one layer of the texture array, with a mip chain
  setLiveryLayer(layer, canvas) {
    const g = this.gpu;
    let src = canvas, w = LIVERY_W, h = LIVERY_H;
    for (let m = 0; m < this.liveryMips; m++) {
      if (m > 0) {
        w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
        const c = new OffscreenCanvas(w, h), x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, w, h); src = c;
      }
      g.queue.copyExternalImageToTexture({ source: src }, { texture: this.liveryTex, mipLevel: m, origin: [0, 0, layer] }, [w, h]);
    }
  }

  // per-sample track info texture (half width, kerb, racing line, -) + lap length / start line for the shader
  setTrackData(info, length, startS, ds) {
    const g = this.gpu, n = info.length / 4;
    if (this.trackTex) g.destroy(this.trackTex);
    this.trackTex = g.texture({ label: 'track-data', format: 'rgba32float', size: [n, 1], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    g.queue.writeTexture({ texture: this.trackTex }, info, { bytesPerRow: n * 16 }, [n, 1]);
    this.trackU = [length, startS, ds, n];
  }

  setScene(scene) {
    this.scene = scene;
    this.prevBuf = this.gpu.buffer({ size: scene.dynCap * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'prev-models' });
    this.prevData = new Float32Array(scene.dynCap * 16);
    this.instGroup = this.gpu.device.createBindGroup({ layout: this.L.inst, entries: [{ binding: 0, resource: { buffer: scene.instBuf } }, { binding: 1, resource: { buffer: this.prevBuf } }] });
  }

  ensureShadowMap() {
    const s = this.quality.shadows, key = s.size + 'x' + s.cascades;
    if (this.shadowKey === key) return;
    const g = this.gpu;
    if (this.shadowTex) g.destroy(this.shadowTex);
    this.shadowTex = g.texture({ label: 'shadow-map', format: DEPTH, size: [s.size, s.size, 4], usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.shadowArrayView = this.shadowTex.createView({ dimension: '2d-array' }); this.shadowArrayView.__id = 'shadowArr' + key;
    this.shadowLayerViews = [0, 1, 2, 3].map(i => { const v = this.shadowTex.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }); v.__id = 'shadowL' + i + key; return v; });
    this.shadowKey = key;
  }
  // TAA history: two persistent textures, swapped every frame
  ensureHistory() {
    const key = this.width + 'x' + this.height;
    if (this.histKey === key) return;
    const g = this.gpu;
    for (const t of this.hist || []) g.destroy(t);
    this.hist = [0, 1].map(i => g.texture({ label: 'taa-history' + i, format: HDR, size: [this.width, this.height], usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    this.histKey = key; this.cut = true;
  }

  // Cascaded shadow maps: split the view frustum, fit each slice in a sphere (size never changes -> no
  // swimming), point an orthographic sun camera at it, and snap it to whole shadow texels.
  updateCascades(cam, env) {
    const s = this.quality.shadows, N = s.cascades, out = this.cascades = [];
    const near = 0.5, far = s.dist, lambda = 0.78;
    const fwd = cam.forward(), right = [cam.view[0], cam.view[4], cam.view[8]], up = [cam.view[1], cam.view[5], cam.view[9]];
    const ty = Math.tan(cam.fov / 2), tx = ty * cam.aspect;
    const L = env.sunDir;
    let prev = near;
    for (let i = 0; i < N; i++) {
      const f = (i + 1) / N, split = lambda * near * Math.pow(far / near, f) + (1 - lambda) * (near + (far - near) * f);
      const mid = (prev + split) / 2;
      const c = [cam.pos[0] + fwd[0] * mid, cam.pos[1] + fwd[1] * mid, cam.pos[2] + fwd[2] * mid];
      let r = 0;
      for (const dd of [prev, split]) for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const p = [0, 1, 2].map(k => cam.pos[k] + fwd[k] * dd + right[k] * sx * tx * dd + up[k] * sy * ty * dd);
        r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
      }
      r = Math.ceil(r);
      const back = r + 250, eye = [c[0] + L[0] * back, c[1] + L[1] * back, c[2] + L[2] * back];
      const view = lookAt(eye, c, Math.abs(L[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]);
      const zf = back + r + 60, proj = new Float32Array(16);
      proj[0] = 1 / r; proj[5] = 1 / r; proj[10] = -1 / zf; proj[14] = 0; proj[15] = 1;
      const vp = mul(proj, view);
      const half = s.size / 2, ox = vp[12] * half, oy = vp[13] * half;
      vp[12] += (Math.round(ox) - ox) / half; vp[13] += (Math.round(oy) - oy) / half;
      out.push({ vp, split, texel: 2 * r / s.size, planes: frustumPlanes(vp) });
      prev = split;
    }
  }

  resize(displayW, displayH) { this.displayW = displayW; this.displayH = displayH; }

  writeFrame(cam, env, time, post) {
    const f = this.frameData, s = this.quality.shadows, cs = this.cascades, q = this.quality;
    f.set(cam.viewProj, 0); f.set(cam.invViewProj, 16); f.set(cam.view, 32);
    f.set([cam.pos[0], cam.pos[1], cam.pos[2], time], 48);
    f.set([env.sunDir[0], env.sunDir[1], env.sunDir[2], env.sunDisk], 52);
    f.set([env.sunColor[0], env.sunColor[1], env.sunColor[2], env.ev || 0], 56);
    f.set([this.width, this.height, 1 / this.width, 1 / this.height], 60);
    f.set([env.fog, env.ambient, env.wet || 0, env.night || 0], 64);
    f.set(this.trackU, 68);
    for (let i = 0; i < 4; i++) if (cs[i]) f.set(cs[i].vp, 72 + i * 16);
    f.set([0, 1, 2, 3].map(i => cs[i] ? cs[i].split : 1e9), 136);
    f.set([0, 1, 2, 3].map(i => cs[i] ? cs[i].texel : 1), 140);
    f.set([1 / s.size, env.shadows === false ? 0 : cs.length, s.dist, s.taps], 144);
    f.set(cam.vpNoJitter, 148); f.set(this.cut ? cam.vpNoJitter : cam.prevVPNoJitter, 164);
    f.set([cam.jitter[0], cam.jitter[1], this.scene ? this.scene.dynBase : 1e9, this.frame % 64], 180);
    // blur length = a fixed shutter (half of a 60 FPS frame), however long this frame took
    f.set([post.dt, q.motionBlur * Math.min(1, (1 / 60) / Math.max(post.dt, 1e-3)), post.speed || 0, this.cut ? 0 : 1], 184);
    f.set([cam.projNJ[0], cam.projNJ[5], cam.near, q.ao ? 1 : 0], 188);
    this.gpu.queue.writeBuffer(this.frameBuf, 0, f);
    const cb = new Float32Array(256);
    cs.forEach((c, i) => cb.set(c.vp, i * 64));
    this.gpu.queue.writeBuffer(this.cascadeBuf, 0, cb);
    const speedK = Math.min(1, Math.max(0, ((post.speed || 0) - 25) / 55));
    this.gpu.queue.writeBuffer(this.fxBuf, 0, new Float32Array([q.bloom ? 0.05 : 0, q.ca ? 0.25 + speedK * 0.9 : 0, q.grain ? 1 : 0, q.taa ? 0.6 : 0.25]));
  }

  // group this frame's dynamic instances by mesh and upload them (and last frame's matrices) after the static ones
  uploadDynamic() {
    const sc = this.scene, list = this.dynamic;
    this.dynDraws = [];
    if (!sc || !list.length) return;
    list.sort((a, b) => a.mesh < b.mesh ? -1 : a.mesh > b.mesh ? 1 : 0);
    const n = Math.min(list.length, sc.dynCap), data = this.dynData && this.dynData.length >= n * INST_FLOATS ? this.dynData : (this.dynData = new Float32Array(sc.dynCap * INST_FLOATS));
    const nextPrev = new Map();
    for (let i = 0; i < n; i++) {
      const it = list[i], o = i * INST_FLOATS;
      data.set(it.model, o); data.set(it.base, o + 16); data.set(it.pbr, o + 20); data.set(it.emit || [0, 0, 0, 0], o + 24);
      const prev = (!this.cut && it.key && this.prevByKey.get(it.key)) || it.model;
      this.prevData.set(prev, i * 16);
      if (it.key) nextPrev.set(it.key, it.model);
      const last = this.dynDraws[this.dynDraws.length - 1];
      if (last && last.name === it.mesh) last.count++;
      else this.dynDraws.push({ name: it.mesh, mesh: sc.pool.get(it.mesh), first: sc.dynBase + i, count: 1, glass: it.mesh.includes('Glass'),
        shadowMesh: it.shadow === undefined ? sc.pool.get(it.mesh) : it.shadow === null ? null : sc.pool.get(it.shadow) });
    }
    this.prevByKey = nextPrev;
    this.gpu.queue.writeBuffer(sc.instBuf, sc.dynBase * INST_FLOATS * 4, data, 0, n * INST_FLOATS);
    this.gpu.queue.writeBuffer(this.prevBuf, 0, this.prevData, 0, n * 16);
  }

  // mode: 'shadow' | 'opaque' (prepass, remembered for the main pass) | 'glass'
  drawScene(pass, planes, mode) {
    const g = this.gpu, sc = this.scene, cp = this.camPos, list = mode === 'opaque' ? (this.visible = []) : [];
    pass.setVertexBuffer(0, sc.pool.vbuf); pass.setIndexBuffer(sc.pool.ibuf, 'uint32');
    if (mode !== 'glass') {
      for (const dr of sc.draws) {
        if (mode === 'shadow' && !dr.shadow) continue;
        if (!sphereVisible(planes, dr.center, dr.radius)) { this.stats.culled++; continue; }
        const d = Math.max(0, Math.hypot(dr.center[0] - cp[0], dr.center[1] - cp[1], dr.center[2] - cp[2]) - dr.radius);
        let mesh = dr.mesh;
        const lod = LOD[mesh.name];
        if (lod) { for (const [dist, name] of lod) if (d > dist) mesh = name ? sc.pool.get(name) : null; if (!mesh) continue; }
        list.push({ d, mesh, dr });
      }
      // front to back: near geometry fills the depth buffer first, hidden pixels behind it are rejected early
      if (mode !== 'shadow') list.sort((a, b) => a.d - b.d);
      for (const { mesh, dr } of list) { this.stats.drawn++; g.drawIndexed(pass, mesh.indexCount, dr.count, mesh.firstIndex, mesh.baseVertex, dr.first); }
    }
    for (const dr of this.dynDraws) {
      if ((mode === 'glass') !== dr.glass) continue;
      const m = mode === 'shadow' ? dr.shadowMesh : dr.mesh;
      if (m) g.drawIndexed(pass, m.indexCount, dr.count, m.firstIndex, m.baseVertex, dr.first);
    }
  }
  // the prepass's culled + sorted list again for the shading pass
  redraw(pass) {
    const g = this.gpu, sc = this.scene;
    pass.setVertexBuffer(0, sc.pool.vbuf); pass.setIndexBuffer(sc.pool.ibuf, 'uint32');
    for (const { mesh, dr } of this.visible || []) g.drawIndexed(pass, mesh.indexCount, dr.count, mesh.firstIndex, mesh.baseVertex, dr.first);
    for (const dr of this.dynDraws) if (!dr.glass) g.drawIndexed(pass, dr.mesh.indexCount, dr.count, dr.mesh.firstIndex, dr.mesh.baseVertex, dr.first);
  }

  // post = { dt, speed }
  render(cam, env, time, post = { dt: 1 / 60, speed: 0 }) {
    const g = this.gpu, d = g.device, q = this.quality;
    const w = Math.max(1, Math.round(this.displayW * q.renderScale)), h = Math.max(1, Math.round(this.displayH * q.renderScale));
    if (w !== this.width || h !== this.height) this.cut = true;
    this.width = w; this.height = h;
    this.frame++;
    if (q.taa) { const [hx, hy] = HALTON[this.frame % 8]; cam.jitter = [(hx - 0.5) * 2 / w, (hy - 0.5) * 2 / h]; } else cam.jitter = [0, 0];
    cam.update(w, h);
    this.ensureShadowMap(); this.ensureHistory();
    this.updateCascades(cam, env);
    this.writeFrame(cam, env, time, post);
    this.uploadDynamic();
    this.stats.drawn = 0; this.stats.culled = 0; this.camPos = cam.pos;
    const camPlanes = frustumPlanes(cam.viewProj);

    const fg = this.graph; fg.begin();
    const swap = g.context.getCurrentTexture();
    const TB = GPUTextureUsage.TEXTURE_BINDING, RA = GPUTextureUsage.RENDER_ATTACHMENT;
    fg.import('screen', swap, swap.createView());
    fg.import('transLUT', this.transLUT);
    fg.import('shadowMap', this.shadowTex, this.shadowArrayView);
    const histCur = this.hist[this.frame & 1], histPrev = this.hist[(this.frame + 1) & 1];
    fg.import('histOut', histCur); fg.import('histIn', histPrev);
    fg.texture('skyLUT', { format: HDR, width: 192, height: 108 });
    fg.texture('hdr', { format: HDR, width: w, height: h, usage: RA | TB | GPUTextureUsage.COPY_SRC });
    fg.texture('vel', { format: VEL, width: w, height: h });
    fg.texture('depth', { format: DEPTH, width: w, height: h, usage: RA | TB });
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    if (q.ao) fg.texture('ao', { format: 'r8unorm', width: hw, height: hh });
    const frameUbo = { buffer: this.frameBuf };
    const sceneGroup = (ctx, noAO) => ctx.bindGroup(this.L.scene, [{ binding: 0, resource: frameUbo }, { binding: 1, resource: ctx.view('transLUT') }, { binding: 2, resource: g.linear },
      { binding: 3, resource: ctx.view('skyLUT') }, { binding: 4, resource: this.shadowArrayView }, { binding: 5, resource: this.shadowSampler }, { binding: 6, resource: g.view(this.trackTex) },
      { binding: 7, resource: q.ao && !noAO ? ctx.view('ao') : g.view(this.whiteTex) }, { binding: 8, resource: this.liveryView }, { binding: 9, resource: this.anisoSampler }]);
    const fs3 = (pass, pipe, group) => { pass.setPipeline(pipe); pass.setBindGroup(0, group); g.draw(pass, 3); };

    fg.render('sky-view LUT', { colors: [{ tex: 'skyLUT' }], reads: ['transLUT'] }, (pass, ctx) => fs3(pass, this.P.skyview, ctx.bindGroup(this.L.skyview, [{ binding: 0, resource: frameUbo }, { binding: 1, resource: ctx.view('transLUT') }, { binding: 2, resource: g.linear }])));

    const shadowsOn = this.scene && env.shadows !== false;
    if (shadowsOn) this.cascades.forEach((c, i) => {
      fg.import('shadow' + i, this.shadowTex, this.shadowLayerViews[i]);
      fg.render('shadow ' + i, { colors: [], depth: { tex: 'shadow' + i, clear: 1 } }, pass => {
        pass.setPipeline(this.P.shadow); pass.setBindGroup(0, this.cascadeGroup, [i * 256]); pass.setBindGroup(1, this.instGroup);
        this.drawScene(pass, c.planes, 'shadow');
      });
    });
    const shadowReads = shadowsOn ? this.cascades.map((c, i) => 'shadow' + i) : [];

    // depth prepass: every hidden pixel is rejected before the expensive shading runs
    fg.render('depth prepass', { colors: [], depth: { tex: 'depth', clear: 0 }, reads: ['skyLUT', 'transLUT', ...(q.ao ? [] : [])] }, (pass, ctx) => {
      if (!this.scene) return;
      pass.setPipeline(this.P.prepass); pass.setBindGroup(0, sceneGroup(ctx, true)); pass.setBindGroup(1, this.instGroup);
      this.drawScene(pass, camPlanes, 'opaque');
    });
    if (q.ao) fg.render('AO', { colors: [{ tex: 'ao' }], reads: ['depth'] }, (pass, ctx) => fs3(pass, this.P.ao, ctx.bindGroup(this.L.ao, [{ binding: 0, resource: frameUbo }, { binding: 1, resource: ctx.view('depth') }])));

    fg.render('scene', { colors: [{ tex: 'hdr', clear: [0, 0, 0, 1] }, { tex: 'vel', clear: [0, 0, 0, 0] }], depth: { tex: 'depth', load: 'load' }, reads: ['transLUT', 'skyLUT', 'shadowMap', ...shadowReads, ...(q.ao ? ['ao'] : [])] }, (pass, ctx) => {
      const bg = sceneGroup(ctx);
      if (this.scene) { pass.setPipeline(this.P.mesh); pass.setBindGroup(0, bg); pass.setBindGroup(1, this.instGroup); this.redraw(pass); }
      fs3(pass, this.P.sky, bg);
    });

    if (this.dynDraws && this.dynDraws.some(x => x.glass)) {
      fg.texture('hdrCopy', { format: HDR, width: w, height: h, usage: TB | GPUTextureUsage.COPY_DST });
      fg.copy('copy for glass', 'hdr', 'hdrCopy');
      fg.render('glass', { colors: [{ tex: 'hdr', load: 'load' }], depth: { tex: 'depth', load: 'load' }, reads: ['hdrCopy', 'shadowMap', ...(q.ao ? ['ao'] : [])] }, (pass, ctx) => {
        pass.setPipeline(this.P.glass); pass.setBindGroup(0, sceneGroup(ctx)); pass.setBindGroup(1, this.instGroup);
        pass.setBindGroup(2, ctx.bindGroup(this.L.glass, [{ binding: 0, resource: ctx.view('hdrCopy') }]));
        this.drawScene(pass, camPlanes, 'glass');
      });
    }

    let src = 'hdr';
    if (q.taa) {
      fg.render('TAA', { colors: [{ tex: 'histOut' }], reads: ['hdr', 'histIn', 'vel', 'depth'] }, (pass, ctx) => fs3(pass, q.taaHQ === false ? this.P.taaLow : this.P.taa, ctx.bindGroup(this.L.taa, [{ binding: 0, resource: frameUbo },
        { binding: 1, resource: ctx.view('hdr') }, { binding: 2, resource: ctx.view('histIn') }, { binding: 3, resource: ctx.view('vel') }, { binding: 4, resource: ctx.view('depth') }, { binding: 5, resource: g.linear }])));
      src = 'histOut';
    }
    if (q.motionBlur > 0) {
      fg.texture('mb', { format: HDR, width: w, height: h });
      const from = src;
      fg.render('motion blur', { colors: [{ tex: 'mb' }], reads: [from, 'vel'] }, (pass, ctx) => fs3(pass, this.P.mblur, ctx.bindGroup(this.L.mblur, [{ binding: 0, resource: frameUbo },
        { binding: 1, resource: ctx.view(from) }, { binding: 2, resource: ctx.view('vel') }, { binding: 3, resource: g.linear }])));
      src = 'mb';
    }
    // bloom: 6 levels down (1/2 .. 1/64), then back up adding each level
    const levels = 6;
    let bw = w, bh = h;
    for (let i = 1; i <= levels; i++) { bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1); fg.texture('b' + i, { format: HDR, width: bw, height: bh }); if (i < levels) fg.texture('u' + i, { format: HDR, width: bw, height: bh }); }
    for (let i = 1; i <= levels; i++) {
      const from = i === 1 ? src : 'b' + (i - 1), pipe = i === 1 ? this.P.bloomDown0 : this.P.bloomDown;
      fg.render('bloom down ' + i, { colors: [{ tex: 'b' + i }], reads: [from] }, (pass, ctx) => fs3(pass, pipe, ctx.bindGroup(this.L.down, [{ binding: 0, resource: ctx.view(from) }, { binding: 1, resource: g.linear }])));
    }
    for (let i = levels - 1; i >= 1; i--) {
      const low = i === levels - 1 ? 'b' + levels : 'u' + (i + 1);
      fg.render('bloom up ' + i, { colors: [{ tex: 'u' + i }], reads: [low, 'b' + i] }, (pass, ctx) => fs3(pass, this.P.bloomUp, ctx.bindGroup(this.L.up, [{ binding: 0, resource: ctx.view(low) }, { binding: 1, resource: ctx.view('b' + i) }, { binding: 2, resource: g.linear }])));
    }
    fg.compute('exposure', { reads: ['b4'] }, (pass, ctx) => {
      pass.setPipeline(this.P.exposure);
      pass.setBindGroup(0, ctx.bindGroup(this.L.expo, [{ binding: 0, resource: frameUbo }, { binding: 1, resource: ctx.view('b4') }, { binding: 2, resource: { buffer: this.exposureBuf } }]));
      pass.dispatchWorkgroups(1);
    });
    const fsrc = src;
    fg.render('final', { colors: [{ tex: 'screen' }], reads: [fsrc, 'u1'] }, (pass, ctx) => fs3(pass, this.P.final, ctx.bindGroup(this.L.final, [{ binding: 0, resource: frameUbo },
      { binding: 1, resource: ctx.view(fsrc) }, { binding: 2, resource: ctx.view('u1') }, { binding: 3, resource: g.linear }, { binding: 4, resource: { buffer: this.exposureBuf } }, { binding: 5, resource: { buffer: this.fxBuf } }])));

    const enc = d.createCommandEncoder({ label: 'frame' });
    fg.execute(enc);
    const rb = this.profiler.resolve(enc);
    g.queue.submit([enc.finish()]);
    this.profiler.afterSubmit(rb);
    this.dynamic.length = 0;
    this.cut = false;
  }
}
