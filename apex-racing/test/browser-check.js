// Drives a real (headless) Edge/Chrome with WebGPU over the DevTools protocol: no npm packages.
// Usage: node test/browser-check.js step step ...
//   nav:URL        open a page            wait:MS        sleep
//   size:WxH       viewport size           eval:JS        evaluate (await-able), print the JSON result
//   shot:FILE.png  screenshot              key:KEY        press a key (ArrowDown, Enter, Escape, F3...)
//   tab            open a second tab and drive it from now on
//   init:JS        run JS in every new page before its own scripts (e.g. hide navigator.gpu)
// Env: BROWSER=path to msedge.exe/chrome.exe, HEADFUL=1 to watch it.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const BROWSERS = [process.env.BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const exe = BROWSERS.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!exe) { console.error('No Edge/Chrome found. Set BROWSER=...'); process.exit(2); }
const PORT = 9300 + Math.floor(Math.random() * 400);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-cdp-'));
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--force-device-scale-factor=1', '--window-size=1920,1080',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required', 'about:blank'];
if (!process.env.HEADFUL) args.unshift('--headless=new');
const proc = spawn(exe, args, { stdio: 'ignore' });

const getJson = p => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: p }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));
const putJson = p => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'PUT' }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }); q.on('error', rej); q.end(); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Tab {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.wait = new Map(); this.logs = [];
    this.ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && this.wait.has(m.id)) { const w = this.wait.get(m.id); this.wait.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
      else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) this.logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' '));
      else if (m.method === 'Runtime.exceptionThrown') this.logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
    this.ready = new Promise(r => this.ws.onopen = r); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.wait.set(id, { res, rej })); }
}

(async () => {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { try { ver = await getJson('/json/version'); } catch { await sleep(150); } }
  if (!ver) throw new Error('browser did not start');
  const open = async () => {
    const pages = (await getJson('/json/list')).filter(t => t.type === 'page');
    const t = tabs.length ? await putJson('/json/new?about:blank') : pages[0];
    const tab = new Tab(t.webSocketDebuggerUrl); await tab.ready;
    await tab.send('Runtime.enable'); await tab.send('Page.enable');
    await tab.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    tabs.push(tab); return tab;
  };
  const tabs = []; let tab = await open();
  console.log('# ' + ver.Browser);
  for (const step of process.argv.slice(2)) {
    const i = step.indexOf(':'), cmd = i < 0 ? step : step.slice(0, i), arg = i < 0 ? '' : step.slice(i + 1);
    if (cmd === 'nav') { await tab.send('Page.navigate', { url: arg }); await sleep(500); }
    else if (cmd === 'wait') await sleep(Number(arg));
    else if (cmd === 'init') await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: arg });
    else if (cmd === 'tab') tab = await open();
    else if (cmd === 'size') { const [w, h] = arg.split('x').map(Number); await tab.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); }
    else if (cmd === 'eval') {
      const r = await tab.send('Runtime.evaluate', { expression: `(async () => (${arg}))()`, awaitPromise: true, returnByValue: true });
      console.log(JSON.stringify(r.exceptionDetails ? { exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text } : r.result.value, null, 1));
    } else if (cmd === 'shot') {
      const r = await tab.send('Page.captureScreenshot', { format: arg.endsWith('.jpg') ? 'jpeg' : 'png', quality: 90 });
      fs.writeFileSync(arg, Buffer.from(r.data, 'base64')); console.log('saved ' + arg);
    } else if (cmd === 'key') {
      const key = arg, code = key.length === 1 ? 'Key' + key.toUpperCase() : key, vk = { Enter: 13, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, F3: 114 }[key] || key.toUpperCase().charCodeAt(0);
      for (const type of ['keyDown', 'keyUp']) await tab.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, text: type === 'keyDown' && key.length === 1 ? key : undefined });
      await sleep(80);
    } else console.log('unknown step ' + step);
  }
  for (const [n, t] of tabs.entries()) if (t.logs.length) console.log(`# tab ${n} console:\n  ` + t.logs.slice(0, 30).join('\n  '));
})().catch(e => { console.error('ERROR', e.message); process.exitCode = 1; }).finally(() => { proc.kill(); setTimeout(() => { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {} process.exit(); }, 400); });
