// Frame graph: each frame the renderer declares passes and the textures they read/write. The graph works out
// each transient texture's lifetime, hands out textures from a pool (two textures with the same shape whose
// lifetimes do not overlap share memory), begins/ends render passes with the right attachments, and wraps every
// pass in GPU timestamps for the profiler. Pool entries unused for a while (e.g. after a resize) are freed.
export class FrameGraph {
  constructor(gpu, profiler) {
    this.gpu = gpu; this.profiler = profiler;
    this.pool = [];            // { key, tex, free, lastFrame }
    this.bgCache = new Map();  // bind groups keyed by layout + resource ids
    this.frame = 0;
  }
  begin() { this.passes = []; this.res = new Map(); this.frame++; }

  // desc: { format, width, height, sampleCount?, usage? }
  texture(name, desc) {
    const usage = desc.usage || (GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
    this.res.set(name, { name, desc: { ...desc, usage }, transient: true, first: -1, last: -1, tex: null });
    return name;
  }
  import(name, tex, view) { this.res.set(name, { name, transient: false, tex, view: view || null }); return name; }

  // spec: { colors: [{ tex, resolve?, clear?: [r,g,b,a], load?: 'load' }], depth?: { tex, clear?: number, load? }, reads?: [names] }
  render(name, spec, exec) { this.passes.push({ name, kind: 'render', spec, exec }); }
  compute(name, spec, exec) { this.passes.push({ name, kind: 'compute', spec, exec }); }

  _uses(p) {
    const s = p.spec, out = [...(s.reads || []), ...(s.writes || [])];
    for (const c of s.colors || []) { out.push(c.tex); if (c.resolve) out.push(c.resolve); }
    if (s.depth) out.push(s.depth.tex);
    return out;
  }
  _acquire(r) {
    const d = r.desc, key = `${d.format}|${d.width}x${d.height}|${d.sampleCount || 1}|${d.usage}`;
    let e = this.pool.find(x => x.free && x.key === key);
    if (!e) {
      e = { key, tex: this.gpu.texture({ label: 'fg:' + r.name, format: d.format, size: [d.width, d.height], sampleCount: d.sampleCount || 1, usage: d.usage }), free: true, lastFrame: 0 };
      this.pool.push(e);
    }
    e.free = false; e.lastFrame = this.frame; r.tex = e.tex; r.entry = e;
  }

  execute(encoder) {
    const passes = this.passes;
    passes.forEach((p, i) => { for (const n of this._uses(p)) { const r = this.res.get(n); if (!r) throw new Error(`Pass "${p.name}" uses unknown resource "${n}"`); if (r.first < 0) r.first = i; r.last = i; } });
    const ctx = {
      gpu: this.gpu,
      tex: n => this.res.get(n).tex,
      view: n => { const r = this.res.get(n); return r.view || this.gpu.view(r.tex); },
      bindGroup: (layout, entries) => this.bindGroup(layout, entries),
    };
    passes.forEach((p, i) => {
      for (const r of this.res.values()) if (r.transient && r.first === i) this._acquire(r);
      const tw = this.profiler && this.profiler.timestampWrites(p.name);
      if (p.kind === 'render') {
        const s = p.spec;
        const desc = {
          label: p.name,
          colorAttachments: (s.colors || []).map(c => ({ view: ctx.view(c.tex), resolveTarget: c.resolve ? ctx.view(c.resolve) : undefined,
            loadOp: c.load === 'load' ? 'load' : 'clear', clearValue: c.clear || [0, 0, 0, 1], storeOp: c.resolve ? 'discard' : 'store' })),
        };
        if (s.depth) desc.depthStencilAttachment = { view: ctx.view(s.depth.tex), depthLoadOp: s.depth.load === 'load' ? 'load' : 'clear', depthClearValue: s.depth.clear ?? 0, depthStoreOp: s.depth.store === false ? 'discard' : 'store' };
        if (tw) desc.timestampWrites = tw;
        const pass = encoder.beginRenderPass(desc);
        p.exec(pass, ctx);
        pass.end();
      } else {
        const pass = encoder.beginComputePass(tw ? { label: p.name, timestampWrites: tw } : { label: p.name });
        p.exec(pass, ctx);
        pass.end();
      }
      for (const r of this.res.values()) if (r.transient && r.last === i && r.entry) r.entry.free = true;
    });
    // free textures nobody asked for in the last few frames (resolution change, preset change)
    if (this.frame % 8 === 0) {
      const keep = [];
      for (const e of this.pool) { if (this.frame - e.lastFrame > 8) { this.gpu.destroy(e.tex); this.bgCache.clear(); } else keep.push(e); }
      this.pool = keep;
    }
  }

  // Bind groups are cached by the identity of what they bind, so they survive across frames until a pooled
  // texture is replaced.
  bindGroup(layout, entries) {
    let key = layout.__id + ':';
    for (const e of entries) { const r = e.resource; key += (r.__id || (r.buffer && r.buffer.__id + '@' + (r.offset || 0)) || (r.__tex && r.__tex.__id) || '?') + ','; }
    let bg = this.bgCache.get(key);
    if (!bg) {
      if (this.bgCache.size > 512) this.bgCache.clear();
      bg = this.gpu.device.createBindGroup({ layout, entries });
      this.bgCache.set(key, bg);
    }
    return bg;
  }
  viewOf(tex) { const v = this.gpu.view(tex); v.__tex = tex; return v; }
}
