// WebGPU device setup, tracked resources (for the memory readout), shader/pipeline caching with async
// warm-up, and draw-call counting for the profiler.
export class GPUUnavailable extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; }
}

const FORMAT_BYTES = { 'rgba16float': 8, 'rgba32float': 16, 'rgba8unorm': 4, 'rgba8unorm-srgb': 4, 'bgra8unorm': 4, 'bgra8unorm-srgb': 4,
  'r16float': 2, 'rg16float': 4, 'r32float': 4, 'rg32float': 8, 'r8unorm': 1, 'rg8unorm': 2, 'depth32float': 4, 'depth24plus': 4,
  'depth24plus-stencil8': 4, 'rg11b10ufloat': 4, 'rgb10a2unorm': 4, 'r32uint': 4 };
let nextId = 1;

export class GPU {
  static async create(canvas) {
    if (!('gpu' in navigator)) throw new GPUUnavailable('no-webgpu', 'This browser has no WebGPU.');
    if (!window.isSecureContext) throw new GPUUnavailable('insecure', 'WebGPU needs https or http://127.0.0.1.');
    let adapter = null;
    try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch { /* handled below */ }
    if (!adapter) throw new GPUUnavailable('no-adapter', 'No usable graphics adapter (GPU acceleration may be off).');
    const want = ['timestamp-query', 'rg11b10ufloat-renderable', 'float32-filterable', 'texture-compression-bc'];
    const requiredFeatures = want.filter(f => adapter.features.has(f));
    const L = adapter.limits, requiredLimits = {};
    for (const k of ['maxStorageBufferBindingSize', 'maxBufferSize', 'maxTextureDimension2D', 'maxColorAttachmentBytesPerSample'])
      if (L[k]) requiredLimits[k] = L[k];
    let device;
    try { device = await adapter.requestDevice({ requiredFeatures, requiredLimits }); }
    catch (e) { throw new GPUUnavailable('no-device', 'The GPU refused to start: ' + e.message); }
    const context = canvas.getContext('webgpu');
    if (!context) throw new GPUUnavailable('no-context', 'Could not create a WebGPU canvas.');
    const info = adapter.info || {};
    return new GPU(device, context, canvas, requiredFeatures, info);
  }

  constructor(device, context, canvas, features, info) {
    this.device = device; this.queue = device.queue; this.context = context; this.canvas = canvas;
    this.features = new Set(features); this.info = info;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.mem = { buffers: 0, textures: 0 };
    this.stats = { draws: 0, tris: 0 };
    this.errors = [];
    this.modules = new Map(); this.pipelines = new Map();
    device.addEventListener('uncapturederror', e => {
      const msg = e.error && e.error.message || String(e.error);
      if (this.errors.length < 20) this.errors.push(msg);
      console.error('[WebGPU]', msg);
    });
    this.lost = device.lost;
    this.linear = this.sampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.linearRepeat = this.sampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 16 });
  }

  // ---- tracked resources ----
  buffer(desc) {
    const b = this.device.createBuffer(desc); b.__id = nextId++; b.__kind = 'b'; b.__bytes = desc.size;
    this.mem.buffers += desc.size; return b;
  }
  bufferWith(data, usage, label) {
    const b = this.buffer({ size: Math.max(16, (data.byteLength + 3) & ~3), usage: usage | GPUBufferUsage.COPY_DST, label });
    this.queue.writeBuffer(b, 0, data.buffer || data, data.byteOffset || 0, data.byteLength);
    return b;
  }
  texture(desc) {
    const t = this.device.createTexture(desc); t.__id = nextId++; t.__kind = 't';
    const w = desc.size.width || desc.size[0], h = desc.size.height || desc.size[1] || 1, d = desc.size.depthOrArrayLayers || desc.size[2] || 1;
    t.__bytes = Math.round(w * h * d * (FORMAT_BYTES[desc.format] || 4) * (desc.sampleCount || 1) * ((desc.mipLevelCount || 1) > 1 ? 1.334 : 1));
    this.mem.textures += t.__bytes; return t;
  }
  destroy(r) { if (!r || r.__dead) return; r.__dead = true; if (r.__bytes) { if (r.__kind === 'b') this.mem.buffers -= r.__bytes; else this.mem.textures -= r.__bytes; } r.destroy(); }
  view(t) { if (!t.__view) { t.__view = t.createView(); t.__view.__id = 'v' + (t.__id || nextId++); } return t.__view; }
  sampler(desc) { const s = this.device.createSampler(desc); s.__id = nextId++; return s; }
  layout(entries, label) { const l = this.device.createBindGroupLayout({ entries, label }); l.__id = nextId++; return l; }

  // ---- shaders and pipelines ----
  async module(code, label) {
    let m = this.modules.get(code);
    if (m) return m;
    m = this.device.createShaderModule({ code, label });
    const info = await m.getCompilationInfo();
    const errs = info.messages.filter(x => x.type === 'error');
    if (errs.length) {
      const lines = code.split('\n');
      throw new Error(`Shader "${label}" failed:\n` + errs.map(e => `  line ${e.lineNum}: ${e.message}\n    ${(lines[e.lineNum - 1] || '').trim()}`).join('\n'));
    }
    this.modules.set(code, m);
    return m;
  }
  // Compiles in the background (no frame hitch); `key` caches the result.
  async renderPipeline(key, desc) {
    if (this.pipelines.has(key)) return this.pipelines.get(key);
    this.device.pushErrorScope('validation');
    const p = await this.device.createRenderPipelineAsync(desc);
    const err = await this.device.popErrorScope();
    if (err) throw new Error(`Pipeline "${key}": ${err.message}`);
    this.pipelines.set(key, p); return p;
  }
  async computePipeline(key, desc) {
    if (this.pipelines.has(key)) return this.pipelines.get(key);
    const p = await this.device.createComputePipelineAsync(desc);
    this.pipelines.set(key, p); return p;
  }

  // ---- counted draws ----
  draw(pass, vertexCount, instanceCount = 1, firstVertex = 0, firstInstance = 0) {
    pass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
    this.stats.draws++; this.stats.tris += Math.floor(vertexCount / 3) * instanceCount;
  }
  drawIndexed(pass, indexCount, instanceCount = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0) {
    pass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
    this.stats.draws++; this.stats.tris += Math.floor(indexCount / 3) * instanceCount;
  }
  resetStats() { this.stats.draws = 0; this.stats.tris = 0; }
}
