// Renderer: owns pipelines and per-frame GPU data, and records each frame as a frame graph:
//   sky-view LUT -> scene (MSAA, HDR) -> tone map to the screen.
// Phase 2+ adds shadows, track geometry, post effects as more passes in the same graph.
import { FrameGraph } from '../engine/framegraph.js';
import { TRANSMITTANCE, SKYVIEW, MESH, SKY, TONEMAP } from './shaders.js';

const HDR = 'rgba16float', DEPTH = 'depth32float';
const FRAME_BYTES = 352;
export const INST_FLOATS = 28;    // mat4 + base(4) + pbr(4) + emit(4)

export class Renderer {
  constructor(gpu, profiler) {
    this.gpu = gpu; this.profiler = profiler;
    this.graph = new FrameGraph(gpu, profiler);
    this.quality = { renderScale: 1, msaa: 4 };
    this.frameData = new Float32Array(FRAME_BYTES / 4);
    this.width = 1; this.height = 1;
  }

  async init(progress = () => {}) {
    const g = this.gpu, d = g.device, V = GPUShaderStage.VERTEX, Fr = GPUShaderStage.FRAGMENT;
    this.frameBuf = g.buffer({ size: FRAME_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'frame' });
    const ubo = { buffer: { type: 'uniform' } }, tex = { texture: { sampleType: 'float' } }, smp = { sampler: { type: 'filtering' } };
    this.L = {
      frameOnly: g.layout([{ binding: 0, visibility: V | Fr, ...ubo }], 'frameOnly'),
      skyview: g.layout([{ binding: 0, visibility: Fr, ...ubo }, { binding: 1, visibility: Fr, ...tex }, { binding: 2, visibility: Fr, ...smp }], 'skyview'),
      scene: g.layout([{ binding: 0, visibility: V | Fr, ...ubo }, { binding: 1, visibility: Fr, ...tex }, { binding: 2, visibility: Fr, ...smp }, { binding: 3, visibility: Fr, ...tex }], 'scene'),
      inst: g.layout([{ binding: 0, visibility: V | Fr, buffer: { type: 'read-only-storage' } }], 'instances'),
      post: g.layout([{ binding: 0, visibility: Fr, ...ubo }, { binding: 1, visibility: Fr, ...tex }, { binding: 2, visibility: Fr, ...smp }], 'post'),
    };
    const pl = (...ls) => d.createPipelineLayout({ bindGroupLayouts: ls });

    // compile every shader and pipeline up front, in the background, with progress for the loading screen
    const jobs = [];
    const mod = {};
    const shaderList = [['transmittance', TRANSMITTANCE], ['skyview', SKYVIEW], ['mesh', MESH], ['sky', SKY], ['tonemap', TONEMAP]];
    let done = 0; const total = shaderList.length + 7;
    const tick = label => progress(++done / total, label);
    for (const [name, code] of shaderList) { mod[name] = await g.module(code, name); tick('Compiling shader: ' + name); }

    const fsTarget = format => ({ module: null, entryPoint: 'fs', targets: [{ format }] });
    const full = (name, layout, format, extra = {}) => ({ layout, vertex: { module: mod[name], entryPoint: 'vs' }, fragment: { ...fsTarget(format), module: mod[name] }, primitive: { topology: 'triangle-list' }, ...extra });
    const vtx = { module: mod.mesh, entryPoint: 'vs', buffers: [{ arrayStride: 32, attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x2' }] }] };
    const make = async (key, desc) => { const p = await g.renderPipeline(key, desc); tick('Pipeline: ' + key); return p; };
    this.P = {};
    jobs.push(make('transmittance', full('transmittance', pl(this.L.frameOnly), HDR)).then(p => this.P.transmittance = p));
    jobs.push(make('skyview', full('skyview', pl(this.L.skyview), HDR)).then(p => this.P.skyview = p));
    jobs.push(make('tonemap', full('tonemap', pl(this.L.post), g.format)).then(p => this.P.tonemap = p));
    for (const msaa of [1, 4]) {
      jobs.push(make('mesh' + msaa, { layout: pl(this.L.scene, this.L.inst), vertex: vtx, fragment: { module: mod.mesh, entryPoint: 'fs', targets: [{ format: HDR }] },
        primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
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
    tick('Atmosphere ready');
  }

  // scene: { pool (MeshPool), instBuf, draws: [{ mesh, first, count }] }
  setScene(scene) {
    this.scene = scene;
    this.instGroup = this.gpu.device.createBindGroup({ layout: this.L.inst, entries: [{ binding: 0, resource: { buffer: scene.instBuf } }] });
  }

  resize(displayW, displayH) { this.displayW = displayW; this.displayH = displayH; }

  writeFrame(cam, env, time) {
    const f = this.frameData;
    f.set(cam.viewProj, 0); f.set(cam.invViewProj, 16); f.set(cam.view, 32);
    f.set([cam.pos[0], cam.pos[1], cam.pos[2], time], 48);
    f.set([env.sunDir[0], env.sunDir[1], env.sunDir[2], env.sunDisk], 52);
    f.set([env.sunColor[0], env.sunColor[1], env.sunColor[2], env.exposure], 56);
    f.set([this.width, this.height, 1 / this.width, 1 / this.height], 60);
    f.set([env.fog, env.ambient, env.wet || 0, env.night || 0], 64);
    this.gpu.queue.writeBuffer(this.frameBuf, 0, f);
  }

  render(cam, env, time) {
    const g = this.gpu, d = g.device, q = this.quality, msaa = q.msaa > 1 ? 4 : 1;
    this.width = Math.max(1, Math.round(this.displayW * q.renderScale));
    this.height = Math.max(1, Math.round(this.displayH * q.renderScale));
    cam.update(this.width, this.height);
    this.writeFrame(cam, env, time);

    const fg = this.graph; fg.begin();
    const swap = g.context.getCurrentTexture();
    fg.import('screen', swap, swap.createView());
    fg.import('transLUT', this.transLUT);
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

    const color = msaa > 1 ? { tex: 'hdrMS', resolve: 'hdr', clear: [0, 0, 0, 1] } : { tex: 'hdr', clear: [0, 0, 0, 1] };
    fg.render('scene', { colors: [color], depth: { tex: 'depth', clear: 0, store: false }, reads: ['transLUT', 'skyLUT'] }, (pass, ctx) => {
      const bg = ctx.bindGroup(this.L.scene, [{ binding: 0, resource: frameUbo }, { binding: 1, resource: ctx.view('transLUT') }, { binding: 2, resource: g.linear }, { binding: 3, resource: ctx.view('skyLUT') }]);
      const sc = this.scene;
      if (sc) {
        pass.setPipeline(this.P['mesh' + msaa]);
        pass.setBindGroup(0, bg); pass.setBindGroup(1, this.instGroup);
        pass.setVertexBuffer(0, sc.pool.vbuf); pass.setIndexBuffer(sc.pool.ibuf, 'uint32');
        for (const dr of sc.draws) g.drawIndexed(pass, dr.mesh.indexCount, dr.count, dr.mesh.firstIndex, dr.mesh.baseVertex, dr.first);
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
  }
}
