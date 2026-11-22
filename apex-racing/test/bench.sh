#!/bin/sh
# Measures the title scene per preset in headless Edge (real GPU), fixed resolution (no dynamic scaling).
# Usage: sh test/bench.sh http://127.0.0.1:3006/ [outdir]
URL=${1:-http://127.0.0.1:3006/}; OUT=${2:-.}
STAT="(window.__apex.profiler.samples.length=0, window.__apex.profiler.passMs.clear(), await new Promise(r=>setTimeout(r,5000)), ((p)=>({fps:+p.stats().fps.toFixed(1), avgMs:+p.stats().avg.toFixed(2), p99:+p.stats().p99.toFixed(1), gpuMs:+p.gpuMs.toFixed(2), cpuMs:+p.cpu.toFixed(2), passes:Object.fromEntries([...p.passMs].filter(([k])=>!/bloom (down|up) [2-6]/.test(k)).map(([k,v])=>[k,+v.toFixed(2)])), draws:window.__apex.gpu.stats.draws, tris:window.__apex.gpu.stats.tris, texMB:+(window.__apex.gpu.mem.textures/1048576).toFixed(1), size:window.__apex.renderer.width+'x'+window.__apex.renderer.height}))(window.__apex.profiler))"
set_preset() { echo "eval:(localStorage.setItem('apex.options', JSON.stringify({preset:'$1',renderScale:1,taa:true,ao:$2,bloom:true,motionBlur:$3,lens:$4,stats:true,dynamicRes:false})), location.reload(), '$1')"; }
node "$(dirname "$0")/browser-check.js" "nav:$URL" "wait:4000" \
  "$(set_preset low false 0 false)" "wait:16000" "eval:$STAT" "shot:$OUT/bench-low.png" \
  "$(set_preset medium true 0.35 true)" "wait:16000" "eval:$STAT" \
  "$(set_preset high true 0.5 true)" "wait:16000" "eval:$STAT" "shot:$OUT/bench-high.png"
