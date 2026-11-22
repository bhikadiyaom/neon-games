// Renderer: owns pipelines and per-frame GPU data, and records each frame as a frame graph:
//   sky-view LUT -> shadow cascades (depth only) -> scene (MSAA, HDR) -> tone map to the screen.
// Static geometry is drawn as instanced groups culled against the camera / each cascade; per-frame objects
// (cars, lights) are written into a dynamic slice of the same instance buffer.
import { FrameGraph } from '../engine/framegraph.js';
import { TRANSMITTANCE, SKYVIEW, MESH, SKY, TONEMAP, SHADOW } from './shaders.js';
import { frustumPlanes, sphereVisible, INST_FLOATS } from './scene.js';
import { lookAt, mul } from '../engine/math.js';
export { INST_FLOATS };

const HDR = 'rgba16float', DEPTH = 'depth32float';
const FRAME_FLOATS = 148;     // must match struct Frame in shaders.js
export const SHADOW_PRESETS = {
  low: { size: 1024, cascades: 2, dist: 220, taps: 4 },
  medium: { size: 2048, cascades: 3, dist: 350, taps: 9 },
  high: { size: 2048, cascades: 4, dist: 500, taps: 9 },
  ultra: { size: 4096, cascades: 4, dist: 700, taps: 9 },
};

// distance level of detail: past the distance a cheaper mesh is drawn (null = not drawn at all)
const LOD = { ico: [[260, 'ico0']], cone: [[260, 'cone4']], cyl: [[140, 'cyl4']], cyl6: [[350, 'cyl4'], [700, null]], person: [[260, null]] };

export class Renderer {
  constructor(gpu, profiler) {
    this.gpu = gpu; this.profiler = profiler;
    this.graph = new FrameGraph(gpu, profiler);
    this.quality = { renderScale: 1, msaa: 4, shadows: SHADOW_PRESETS.high };
    this.frameData = new Float32Array(FRAME_FLOATS);
    this.width = 1; this.height = 1;
    this.dynamic = [];          // per-frame instances: { mesh, model, base, pbr, emit }
    this.trackU = [0, 0, 1, 1];
    this.stats = { drawn: 0, culled: 0 };
  }

  async init(progress = () => {}) {
    const g = this.gpu, d = g.device, V = GPUShaderStage.VERTEX, Fr = GPUShaderStage.FRAGMENT;
    this.frameBuf = g.buffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'frame' });
    this.cascadeBuf = g.buffer({ size: 256 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'cascades' });
    const ubo = { buffer: { type: 'uniform' } }, tex = { texture: { sampleType: 'float' } }, smp = { sampler: { type: 'filtering' } };
    this.L = {
      frameOnly: g.layout([{ binding: 0, visibility: V | Fr, ...ubo }], 'frameOnly'),
      skyview: g.layout([{ binding: 0, visibility: Fr, ...ubo }, { binding: 1, visibility: Fr, ...tex }, { binding: 2, visibility: Fr, ...smp }], 'skyview'),
      scene: g.layout([{ binding: 0, visibility: V | Fr, ...ubo }, { binding: 1, visibility: Fr, ...tex }, { binding: 2, visibility: Fr, ...smp }, { binding: 3, visibility: Fr, ...tex },
        { binding: 4, visibility: Fr, texture: { sampleType: 'depth', viewDimension: '2d-array' } }, { binding: 5, visibility: Fr, sampler: { type: 'comparison' } },
        { binding: 6, visibility: Fr, texture: { sampleType: 'unfilterable-float' } }], 'scene'),
      inst: g.layout([{ binding: 0, visibility: V | Fr, buffer: { type: 'read-only-storage' } }], 'instances'),
      cascade: g.layout([{ binding: 0, visibility: V, buffer: { type: 'uniform', hasDynamicOffset: true } }], 'cascade'),
      post: g.layout([{ binding: 0, visibility: Fr, ...ubo }, { binding: 1, visibility: Fr, ...tex }, { binding: 2, visibility: Fr, ...smp }], 'post'),
    };
    this.shadowSampler = g.sampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const pl = (...ls) => d.createPipelineLayout({ bindGroupLayouts: ls });

    const mod = {};
    const shaderList = [['transmittance', TRANSMITTANCE], ['skyview', SKYVIEW], ['mesh', MESH], ['sky', SKY], ['tonemap', TONEMAP], ['shadow', SHADOW]];
    let done = 0; const total = shaderList.length + 8;
    const tick = label => progress(++done / total, label);
    for (const [name, code] of shaderList) { mod[name] = await g.module(code, name); tick('Compiling shader: ' + name); }

    const full = (name, layout, format, extra = {}) => ({ layout, vertex: { module: mod[name], entryPoint: 'vs' }, fragment: { module: mod[name], entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' }, ...extra });
    const attrs = [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x2' }];
    const make = async (key, desc) => { const p = await g.renderPipeline(key, desc); tick('Pipeline: ' + key); return p; };
    this.P = {};
    const jobs = [
      make('transmittance', full('transmittance', pl(this.L.frameOnly), HDR)).then(p => this.P.transmittance = p),
      make('skyview', full('skyview', pl(this.L.skyview), HDR)).then(p => this.P.skyview = p),
      make('tonemap', full('tonemap', pl(this.L.post), g.format)).then(p => this.P.tonemap = p),
      make('shadow', { layout: pl(this.L.cascade, this.L.inst), vertex: { module: mod.shadow, entryPoint: 'vs', buffers: [{ arrayStride: 32, attributes: [attrs[0]] }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.0, depthBiasClamp: 0.01 } }).then(p => this.P.shadow = p),
    ];
    for (const msaa of [1, 4]) {
      jobs.push(make('mesh' + msaa, { layout: pl(this.L.scene, this.L.inst), vertex: { module: mod.mesh, entryPoint: 'vs', buffers: [{ arrayStride: 32, attributes: attrs }] },
        fragment: { module: mod.mesh, entryPoint: 'fs', targets: [{ format: HDR }] }, primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
        depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'greater' }, multisample: { count: msaa } }).then(p => this.P['mesh' + msaa] = p));
      jobs.push(make('sky' + msaa, full('sky', pl(this.L.scene), HDR, { depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'greater-equal' }, multisample: { count: msaa } })).then(p => this.P['sky' + msaa] = p));
    }
    await Promise.all(jobs);

    // the transmittance LUT never changes: render it once
    this.transLUT = g.texture({ label: 'transmittance', format: HDR, size: [256, 64], usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const enc = d.createCommandEncoder();
    const p = enc.beginRenderPass({ colorAttachments: [{ view: g.view(this.transLUT), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    p.setPipeline(this.P.transmittance);
    p.setBindGroup(0, d.createBindGroup({ layout: this.L.frameOnly, entries: [{ binding: 0, resource: { buffer: this.frameBuf } }] }));
    g.draw(p, 3); p.end();
    g.queue.submit([enc.finish()]);
    this.setTrackData(new Float32Array([6, 0, 0, 0]), 1, 0, 1);
    this.cascadeGroup = d.createBindGroup({ layout: this.L.cascade, entries: [{ binding: 0, resource: { buffer: this.cascadeBuf, size: 64 } }] });
    tick('Atmosphere ready');
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
    this.instGroup = this.gpu.device.createBindGroup({ layout: this.L.inst, entries: [{ binding: 0, resource: { buffer: scene.instBuf } }] });
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

  writeFrame(cam, env, time) {
    const f = this.frameData, s = this.quality.shadows, cs = this.cascades;
    f.set(cam.viewProj, 0); f.set(cam.invViewProj, 16); f.set(cam.view, 32);
    f.set([cam.pos[0], cam.pos[1], cam.pos[2], time], 48);
    f.set([env.sunDir[0], env.sunDir[1], env.sunDir[2], env.sunDisk], 52);
    f.set([env.sunColor[0], env.sunColor[1], env.sunColor[2], env.exposure], 56);
    f.set([this.width, this.height, 1 / this.width, 1 / this.height], 60);
    f.set([env.fog, env.ambient, env.wet || 0, env.night || 0], 64);
    f.set(this.trackU, 68);
    for (let i = 0; i < 4; i++) if (cs[i]) f.set(cs[i].vp, 72 + i * 16);
    f.set([0, 1, 2, 3].map(i => cs[i] ? cs[i].split : 1e9), 136);
    f.set([0, 1, 2, 3].map(i => cs[i] ? cs[i].texel : 1), 140);
    f.set([1 / s.size, env.shadows === false ? 0 : cs.length, s.dist, s.taps], 144);
    this.gpu.queue.writeBuffer(this.frameBuf, 0, f);
    const cb = new Float32Array(256);
    cs.forEach((c, i) => cb.set(c.vp, i * 64));
    this.gpu.queue.writeBuffer(this.cascadeBuf, 0, cb);
  }

  // group this frame's dynamic instances by mesh and upload them after the static ones
  uploadDynamic() {
    const sc = this.scene, list = this.dynamic;
    this.dynDraws = [];
    if (!sc || !list.length) return;
    list.sort((a, b) => a.mesh < b.mesh ? -1 : a.mesh > b.mesh ? 1 : 0);
    const n = Math.min(list.length, sc.dynCap), data = this.dynData && this.dynData.length >= n * INST_FLOATS ? this.dynData : (this.dynData = new Float32Array(sc.dynCap * INST_FLOATS));
    for (let i = 0; i < n; i++) {
      const it = list[i], o = i * INST_FLOATS;
      data.set(it.model, o); data.set(it.base, o + 16); data.set(it.pbr, o + 20); data.set(it.emit || [0, 0, 0, 0], o + 24);
      const last = this.dynDraws[this.dynDraws.length - 1];
      if (last && last.name === it.mesh) last.count++;
      else this.dynDraws.push({ name: it.mesh, mesh: sc.pool.get(it.mesh), first: sc.dynBase + i, count: 1 });
    }
    this.gpu.queue.writeBuffer(sc.instBuf, sc.dynBase * INST_FLOATS * 4, data, 0, n * INST_FLOATS);
  }

  drawScene(pass, planes, shadowOnly) {
    const g = this.gpu, sc = this.scene, cp = this.camPos, list = this.visible || (this.visible = []);
    pass.setVertexBuffer(0, sc.pool.vbuf); pass.setIndexBuffer(sc.pool.ibuf, 'uint32');
    list.length = 0;
    for (const dr of sc.draws) {
      if (shadowOnly && !dr.shadow) continue;
      if (!sphereVisible(planes, dr.center, dr.radius)) { this.stats.culled++; continue; }
      const d = Math.max(0, Math.hypot(dr.center[0] - cp[0], dr.center[1] - cp[1], dr.center[2] - cp[2]) - dr.radius);
      let mesh = dr.mesh;
      const lod = LOD[mesh.name];
      if (lod) { for (const [dist, name] of lod) if (d > dist) mesh = name ? sc.pool.get(name) : null; if (!mesh) continue; }
      list.push({ d, mesh, dr });
    }
    // front to back: near geometry fills the depth buffer first, hidden pixels behind it are rejected early
    if (!shadowOnly) list.sort((a, b) => a.d - b.d);
    for (const { mesh, dr } of list) {
      this.stats.drawn++;
      g.drawIndexed(pass, mesh.indexCount, dr.count, mesh.firstIndex, mesh.baseVertex, dr.first);
    }
    for (const dr of this.dynDraws) g.drawIndexed(pass, dr.mesh.indexCount, dr.count, dr.mesh.firstIndex, dr.mesh.baseVertex, dr.first);
  }

  render(cam, env, time) {
    const g = this.gpu, d = g.device, q = this.quality, msaa = q.msaa > 1 ? 4 : 1;
    this.width = Math.max(1, Math.round(this.displayW * q.renderScale));
    this.height = Math.max(1, Math.round(this.displayH * q.renderScale));
    cam.update(this.width, this.height);
    this.ensureShadowMap();
    this.updateCascades(cam, env);
    this.writeFrame(cam, env, time);
    this.uploadDynamic();
    this.stats.drawn = 0; this.stats.culled = 0; this.camPos = cam.pos;
    const camPlanes = frustumPlanes(cam.viewProj);

    const fg = this.graph; fg.begin();
    const swap = g.context.getCurrentTexture();
    fg.import('screen', swap, swap.createView());
    fg.import('transLUT', this.transLUT);
    fg.import('shadowMap', this.shadowTex, this.shadowArrayView);
    fg.texture('skyLUT', { format: HDR, width: 192, height: 108 });
    fg.texture('hdr', { format: HDR, width: this.width, height: this.height });
    fg.texture('depth', { format: DEPTH, width: this.width, height: this.height, sampleCount: msaa, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    if (msaa > 1) fg.texture('hdrMS', { format: HDR, width: this.width, height: this.height, sampleCount: msaa, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const frameUbo = { buffer: this.frameBuf };

    fg.render('sky-view LUT', { colors: [{ tex: 'skyLUT' }], reads: ['transLUT'] }, (pass, ctx) => {
      pass.setPipeline(this.P.skyview);
      pass.setBindGroup(0, ctx.bindGroup(this.L.skyview, [{ binding: 0, resource: frameUbo }, { binding: 1, resource: ctx.view('transLUT') }, { binding: 2, resource: g.linear }]));
      g.draw(pass, 3);
    });

    if (this.scene && env.shadows !== false) {
      this.cascades.forEach((c, i) => {
        fg.import('shadow' + i, this.shadowTex, this.shadowLayerViews[i]);
        fg.render('shadow ' + i, { colors: [], depth: { tex: 'shadow' + i, clear: 1 } }, pass => {
          pass.setPipeline(this.P.shadow);
          pass.setBindGroup(0, this.cascadeGroup, [i * 256]); pass.setBindGroup(1, this.instGroup);
          this.drawScene(pass, c.planes, true);
        });
      });
    }

    const color = msaa > 1 ? { tex: 'hdrMS', resolve: 'hdr', clear: [0, 0, 0, 1] } : { tex: 'hdr', clear: [0, 0, 0, 1] };
    const shadowReads = this.scene && env.shadows !== false ? this.cascades.map((c, i) => 'shadow' + i) : [];
    fg.render('scene', { colors: [color], depth: { tex: 'depth', clear: 0, store: false }, reads: ['transLUT', 'skyLUT', 'shadowMap', ...shadowReads] }, (pass, ctx) => {
      const bg = ctx.bindGroup(this.L.scene, [{ binding: 0, resource: frameUbo }, { binding: 1, resource: ctx.view('transLUT') }, { binding: 2, resource: g.linear },
        { binding: 3, resource: ctx.view('skyLUT') }, { binding: 4, resource: this.shadowArrayView }, { binding: 5, resource: this.shadowSampler }, { binding: 6, resource: g.view(this.trackTex) }]);
      if (this.scene) {
        pass.setPipeline(this.P['mesh' + msaa]);
        pass.setBindGroup(0, bg); pass.setBindGroup(1, this.instGroup);
        this.drawScene(pass, camPlanes, false);
      }
      pass.setPipeline(this.P['sky' + msaa]);
      pass.setBindGroup(0, bg);
      g.draw(pass, 3);
    });

    fg.render('tonemap', { colors: [{ tex: 'screen' }], reads: ['hdr'] }, (pass, ctx) => {
      pass.setPipeline(this.P.tonemap);
      pass.setBindGroup(0, ctx.bindGroup(this.L.post, [{ binding: 0, resource: frameUbo }, { binding: 1, resource: ctx.view('hdr') }, { binding: 2, resource: g.linear }]));
      g.draw(pass, 3);
    });

    const enc = d.createCommandEncoder({ label: 'frame' });
    fg.execute(enc);
    const rb = this.profiler.resolve(enc);
    g.queue.submit([enc.finish()]);
    this.profiler.afterSubmit(rb);
    this.dynamic.length = 0;
  }
}
