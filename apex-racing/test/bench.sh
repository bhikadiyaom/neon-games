#!/bin/sh
# Measures the title scene per preset in headless Edge (real GPU). Usage: sh test/bench.sh http://127.0.0.1:3006/ [outdir]
URL=${1:-http://127.0.0.1:3006/}; OUT=${2:-.}
STAT="(window.__apex.profiler.samples.length=0, await new Promise(r=>setTimeout(r,4000)), ((p)=>({fps:+p.stats().fps.toFixed(1), avgMs:+p.stats().avg.toFixed(2), p99:+p.stats().p99.toFixed(1), gpuMs:+p.gpuMs.toFixed(2), passes:Object.fromEntries([...p.passMs].map(([k,v])=>[k,+v.toFixed(2)])), draws:window.__apex.gpu.stats.draws, tris:window.__apex.gpu.stats.tris, texMB:+(window.__apex.gpu.mem.textures/1048576).toFixed(1), size:window.__apex.renderer.width+'x'+window.__apex.renderer.height, msaa:window.__apex.renderer.quality.msaa}))(window.__apex.profiler))"
set_preset() { echo "eval:(localStorage.setItem('apex.options', JSON.stringify({preset:'$1',renderScale:1,msaa:$2,stats:true,dynamicRes:false})), location.reload(), '$1')"; }
node "$(dirname "$0")/browser-check.js" "nav:$URL" "wait:6000" \
  "$(set_preset low false)" "wait:7000" "eval:$STAT" "shot:$OUT/bench-low.png" \
  "$(set_preset medium true)" "wait:7000" "eval:$STAT" \
  "$(set_preset high true)" "wait:7000" "eval:$STAT" "shot:$OUT/bench-high.png"
