// F3 profiler: CPU frame time, FPS, GPU time per pass (timestamp queries when the GPU supports them),
// draw calls, triangles, GPU memory we allocated, JS heap, render resolution.
const MAX_PASSES = 32;

export class Profiler {
  constructor(gpu) {
    this.gpu = gpu;
    this.cpu = 0; this.frameMs = 16.7; this.fps = 60; this.gpuMs = 0; this.passMs = new Map();
    this.samples = []; this.visible = false; this.el = null; this.lastDom = 0; this.extra = {};
    this.ts = gpu.features.has('timestamp-query');
    if (this.ts) {
      const d = gpu.device;
      this.qs = d.createQuerySet({ type: 'timestamp', count: MAX_PASSES * 2 });
      this.resolveBuf = gpu.buffer({ size: MAX_PASSES * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC, label: 'ts-resolve' });
      this.readBufs = [0, 1, 2].map(i => ({ buf: gpu.buffer({ size: MAX_PASSES * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'ts-read' + i }), busy: false, names: null }));
    }
    this.names = [];
  }
  beginFrame(now) {
    if (this.last) {
      const dt = now - this.last;
      if (dt < 250) {                                           // ignore hidden-tab gaps
        this.frameMs += (dt - this.frameMs) * 0.08;
        this.samples.push(dt); if (this.samples.length > 240) this.samples.shift();
      }
    }
    this.last = now; this.cpuStart = performance.now();
    this.names = []; this.gpu.resetStats();
  }
  // Called by the frame graph for each pass.
  timestampWrites(name) {
    if (!this.ts || this.names.length >= MAX_PASSES) return undefined;
    const i = this.names.length; this.names.push(name);
    return { querySet: this.qs, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
  }
  // After all passes are encoded, before submit.
  resolve(encoder) {
    if (!this.ts || !this.names.length) return null;
    const rb = this.readBufs.find(r => !r.busy);
    if (!rb) return null;                                       // all readbacks still in flight: skip this frame
    const n = this.names.length;
    encoder.resolveQuerySet(this.qs, 0, n * 2, this.resolveBuf, 0);
    encoder.copyBufferToBuffer(this.resolveBuf, 0, rb.buf, 0, n * 16);
    rb.busy = true; rb.names = this.names.slice();
    return rb;
  }
  afterSubmit(rb) {
    this.cpu += (performance.now() - this.cpuStart - this.cpu) * 0.1;
    if (!rb) return;
    rb.buf.mapAsync(GPUMapMode.READ).then(() => {
      const t = new BigInt64Array(rb.buf.getMappedRange());
      let total = 0;
      rb.names.forEach((name, i) => {
        const ms = Number(t[i * 2 + 1] - t[i * 2]) / 1e6;
        if (ms >= 0 && ms < 1000) { const prev = this.passMs.get(name) ?? ms; this.passMs.set(name, prev + (ms - prev) * 0.1); total += ms; }
      });
      this.gpuMs += (total - this.gpuMs) * 0.1;
      rb.buf.unmap(); rb.busy = false;
    }).catch(() => { rb.busy = false; });
  }
  stats() {
    const s = this.samples.slice().sort((a, b) => a - b);
    const p = q => s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0;
    return { avg: this.frameMs, fps: 1000 / this.frameMs, p50: p(0.5), p99: p(0.99), worst: s[s.length - 1] || 0 };
  }
  toggle() { this.visible = !this.visible; if (this.el) this.el.style.display = this.visible ? 'block' : 'none'; }
  draw(now) {
    if (!this.visible || !this.el || now - this.lastDom < 250) return;
    this.lastDom = now;
    const st = this.stats(), g = this.gpu, mb = b => (b / 1048576).toFixed(1);
    const heap = performance.memory ? mb(performance.memory.usedJSHeapSize) + ' MB' : 'n/a';
    let passes = '';
    if (this.ts) for (const [n, ms] of this.passMs) passes += `<tr><td>${n}</td><td>${ms.toFixed(2)} ms</td></tr>`;
    else passes = '<tr><td colspan=2>GPU timestamps not supported here</td></tr>';
    const col = st.avg < 17.5 ? '#5dff8a' : st.avg < 25 ? '#ffd45a' : '#ff5a6a';
    this.el.innerHTML = `<b style="color:${col}">${st.fps.toFixed(0)} FPS</b> &nbsp; ${st.avg.toFixed(2)} ms avg · p99 ${st.p99.toFixed(1)} · worst ${st.worst.toFixed(1)}
<table>
<tr><td>CPU (JS per frame)</td><td>${this.cpu.toFixed(2)} ms</td></tr>
<tr><td>GPU total</td><td>${this.ts ? this.gpuMs.toFixed(2) + ' ms' : 'n/a'}</td></tr>
${passes}
<tr><td>Draw calls</td><td>${g.stats.draws}</td></tr>
<tr><td>Triangles</td><td>${g.stats.tris.toLocaleString('en-US')}</td></tr>
<tr><td>GPU memory (ours)</td><td>${mb(g.mem.textures)} MB tex · ${mb(g.mem.buffers)} MB buf</td></tr>
<tr><td>JS heap</td><td>${heap}</td></tr>
${Object.entries(this.extra).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
<tr><td>GPU</td><td>${(g.info.vendor || '?') + ' ' + (g.info.architecture || g.info.description || '')}</td></tr>
${g.errors.length ? `<tr><td style="color:#ff5a6a">GPU errors</td><td style="color:#ff5a6a">${g.errors.length}</td></tr>` : ''}
</table>`;
  }
}
