// Outside-app browser instrumentation; no engine implementation is reproduced here.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { prepareMutation } from './control.mjs';

export const browserPin = JSON.parse(fs.readFileSync(new URL('../../browser-pin.json', import.meta.url), 'utf8'));
export function playwright() {
  const packagePath = createRequire(import.meta.url).resolve('playwright/package.json');
  const version = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
  if (version !== '1.63.0' || browserPin.driver !== 'playwright@1.63.0') throw Error(`HARNESS_DRIVER_ASSERT: installed Playwright ${version}, expected 1.63.0`);
  return { chromium, version, packagePath };
}

export const idbShim = `
const prefix='__h_idb:';
async function pack(v){
 if(v instanceof FileSystemHandle){const p=window.__harness.paths.get(v);if(!p)throw Error('Unmapped OPFS handle');return {__harnessHandle:p,kind:v.kind}}
 if(Array.isArray(v))return Promise.all(v.map(pack));
 if(v&&typeof v==='object'){const o={};for(const [k,x]of Object.entries(v))o[k]=await pack(x);return o}return v;
}
async function unpack(v){
 if(v&&typeof v==='object'&&v.__harnessHandle){const parts=v.__harnessHandle.split('/').filter(Boolean);let d=await navigator.storage.getDirectory();for(let i=0;i<parts.length;i++)d=await (i===parts.length-1&&v.kind==='file'?d.getFileHandle(parts[i]):d.getDirectoryHandle(parts[i]));return d}
 if(Array.isArray(v))return Promise.all(v.map(unpack));
 if(v&&typeof v==='object'){const o={};for(const [k,x]of Object.entries(v))o[k]=await unpack(x);return o}return v;
}
export async function get(k){const v=localStorage.getItem(prefix+k);return v===null?undefined:unpack(JSON.parse(v))}
export async function set(k,v){localStorage.setItem(prefix+k,JSON.stringify(await pack(v)))}
export async function del(k){localStorage.removeItem(prefix+k)}
export async function clear(){for(const k of Object.keys(localStorage))if(k.startsWith(prefix))localStorage.removeItem(k)}
export async function keys(){return Object.keys(localStorage).filter(k=>k.startsWith(prefix)).map(k=>k.slice(prefix.length))}
export async function values(){return Promise.all((await keys()).map(get))}
export async function entries(){return Promise.all((await keys()).map(async k=>[k,await get(k)]))}
export async function getMany(ks){return Promise.all(ks.map(get))}
export async function setMany(es){for(const [k,v]of es)await set(k,v)}
export async function delMany(ks){for(const k of ks)await del(k)}
let queue=Promise.resolve();export function update(k,f){const p=queue.then(async()=>set(k,f(await get(k))));queue=p.catch(()=>{});return p}
export function createStore(){return undefined}
`;

export function installBrowser({ vaultName, theme, polling, recordWriteSizes }) {
  if(window!==window.top)return;
  const paths = new WeakMap();
  const native = {
    getDirectory: navigator.storage.getDirectory.bind(navigator.storage),
    createWritable: FileSystemFileHandle.prototype.createWritable,
  };
  const state = window.__harness = { paths, native, writes: [], input: [], contexts: [], vaultName, sequence: 0 };
  const canvases=new WeakMap();let nextCanvas=1;const getContext=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(kind,...args){const result=getContext.call(this,kind,...args);if(!canvases.has(this))canvases.set(this,nextCanvas++);state.contexts.push({at:performance.now(),canvas:canvases.get(this),kind:String(kind),obtained:result!==null,width:this.width,height:this.height});return result;};
  const grant = (h, p) => {
    if (p !== undefined) paths.set(h, p);
    h.queryPermission = h.requestPermission = async () => 'granted';
    return h;
  };
  navigator.storage.getDirectory = async () => grant(await native.getDirectory(), '');
  for (const method of ['getDirectoryHandle', 'getFileHandle']) {
    const old = FileSystemDirectoryHandle.prototype[method];
    FileSystemDirectoryHandle.prototype[method] = async function(name, ...args) {
      const h = await old.call(this, name, ...args);
      return grant(h, [paths.get(this), name].filter(Boolean).join('/'));
    };
  }
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    return grant(await root.getDirectoryHandle(state.vaultName, { create: true }), state.vaultName);
  };
  FileSystemFileHandle.prototype.createWritable = async function(...args) {
    const id = ++state.sequence;
    let resolved=paths.get(this);
    // Observers and worker structured clones can mint fresh handle objects. Identity maps alone
    // missed PDF writes; resolve the actual descendant path, never guess from a basename.
    if(resolved===undefined){const root=await navigator.storage.getDirectory();const parts=await root.resolve(this);if(parts){resolved=parts.join('/');paths.set(this,resolved);}}
    const entry = { id, path: resolved ?? null, name: this.name, started: performance.now(), closed: null, error: null };
    state.writes.push(entry);
    try {
      const w = await native.createWritable.apply(this, args);
      const close = w.close.bind(w);
      w.close = async () => { try { await close(); entry.closed = performance.now(); if(recordWriteSizes){try{entry.bytes=(await this.getFile()).size;}catch(e){entry.statError=String(e);}} } catch(e) { entry.error = String(e); throw e; } };
      return w;
    } catch(e) { entry.error = String(e); throw e; }
  };
  for (const type of ['pointerdown','pointermove','pointerup','pointercancel','touchstart','touchmove','touchend','wheel','compositionstart','compositionupdate','compositionend','beforeinput','input','paste','dragenter','dragover','drop','beforeunload']) {
    window.addEventListener(type, e => {
      const receipt={ type, trusted: e.isTrusted, pointerType: e.pointerType, pointerId: e.pointerId, pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY, button: e.button, buttons: e.buttons, x: e.clientX, y: e.clientY, deltaX: e.deltaX, deltaY: e.deltaY, ctrlKey: e.ctrlKey, metaKey:e.metaKey,altKey:e.altKey,shiftKey:e.shiftKey, data: e.data, inputType: e.inputType, types: e.clipboardData ? [...e.clipboardData.types] : e.dataTransfer ? [...e.dataTransfer.types] : null, entries:e.type==='drop'&&e.dataTransfer?[...e.dataTransfer.items].map(i=>{try{const entry=i.webkitGetAsEntry?.();return {kind:i.kind,type:i.type,entry:entry?{name:entry.name,isFile:entry.isFile,isDirectory:entry.isDirectory}:null};}catch(error){return {kind:i.kind,type:i.type,error:String(error)};}}):null, touches: e.touches ? [...e.touches].map(t=>({id:t.identifier,x:t.clientX,y:t.clientY,force:t.force})) : null, coalesced: e.getCoalescedEvents ? e.getCoalescedEvents().map(p=>({x:p.clientX,y:p.clientY,pressure:p.pressure,tiltX:p.tiltX,tiltY:p.tiltY,time:p.timeStamp})) : null };state.input.push(receipt);if(['paste','dragenter','dragover','drop','beforeunload'].includes(type))window.__harnessReceipt?.(receipt).catch(()=>{});
      if (state.input.length > 20000) state.input.splice(0,10000);
    }, { capture: true, passive: true });
  }
  if (polling) delete window.FileSystemObserver;
  if (theme) localStorage.setItem('theme', theme);
}

export async function launchRuntime(options = {}) {
  const { chromium, version: driverVersion, packagePath: driverPackage } = playwright();
  const portAt = process.argv.indexOf('--port');
  const baseURL = options.baseURL || process.env.BASE_URL || `http://localhost:${portAt >= 0 ? process.argv[portAt + 1] : '6520'}/`;
  const attached=!!options.connectOverCDP;
  if (options.channel) throw Error('HARNESS_BROWSER_ASSERT: use the pinned CfT executable, not a browser channel');
  const executablePath = fs.realpathSync(path.resolve('/Users/adham/Developer/bme-impl/scratch/browsers', browserPin.version, browserPin.executable));
  if (options.executablePath && fs.realpathSync(options.executablePath) !== executablePath) throw Error('HARNESS_BROWSER_ASSERT: wrong CfT path');
  const browser = attached?await chromium.connectOverCDP(options.connectOverCDP):await chromium.launch({ headless: !(options.headed || process.argv.includes('--headed')), executablePath });
  let context;
  try {
    if (browser.version() !== browserPin.version) throw Error(`HARNESS_BROWSER_ASSERT: ${browser.version()}, expected ${browserPin.version}`);
    // Remote H-mode keeps physical viewport/DPR/input unless the operator explicitly overrides.
    // Always use an isolated context: never silently seed the person's existing browser profile.
    context = await browser.newContext(attached?{viewport:options.viewport??null,...(options.deviceScaleFactor===undefined?{}:{deviceScaleFactor:options.deviceScaleFactor}),permissions:['clipboard-read','clipboard-write']}:{ viewport: options.viewport || { width: 1440, height: 1000 }, deviceScaleFactor: options.deviceScaleFactor ?? 1, permissions: ['clipboard-read','clipboard-write'], hasTouch: true });
    const page = await context.newPage();
    const network = [], responses = [], nativeReceipts = [], responseObjects = new Map(), errors = [], consoleMessages = [];
    await page.exposeBinding('__harnessReceipt',(_,r)=>nativeReceipts.push(r));
    page.on('response',r=>{const request=r.request();responses.push({url:r.url(),status:r.status(),type:request.resourceType(),mainDocument:request.isNavigationRequest()&&request.frame()===page.mainFrame(),at:Date.now()});responseObjects.set(r.url(),r);});
    context.on('request', r => { const url=r.url(); const offOrigin = /^https?:/.test(url) && new URL(url).origin !== new URL(baseURL).origin; network.push({ url, method:r.method(), type:r.resourceType(), offOrigin, at:Date.now() }); });
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if(m.type()==='error'||m.type()==='warning')consoleMessages.push({type:m.type(),text:m.text()}); });
    if (options.blockOffOrigin) await context.route('**/*', route => { const u=route.request().url(); return /^https?:/.test(u)&&new URL(u).origin!==new URL(baseURL).origin?route.abort():route.continue(); });
    // The pinned CfT survives native handle restore. The shim is opt-in only;
    // its storage representation cannot stand in for the app's real restore.
    let shimHits = 0;
    if (options.idbShim) await context.route(/\/idb-keyval\.js(?:\?|$)/, async route => { shimHits++; await route.fulfill({ contentType:'text/javascript',body:idbShim }); });
    const params = { vaultName: options.vaultName || 'ParityVault', theme: options.theme === null ? null : (options.theme || 'light'), polling: !!options.polling, recordWriteSizes:!!options.recordWriteSizes };
    // One ordered init script: a separate reference initializer can otherwise
    // run before the instrumentation it extends after a real reload.
    const after = (options.afterInstrumentation || []).map(fn => `(${fn.toString()})();`).join('\n');
    await context.addInitScript({ content: `(${installBrowser.toString()})(${JSON.stringify(params)});\n${after}` });
    const cdp = await context.newCDPSession(page);
    for(const script of options.initScripts||[])await context.addInitScript(script);
    const mutations=[];
    if(options.beforeNavigate)await options.beforeNavigate({browser,context,page,cdp,baseURL,mutations});
    for(const spec of options.mutations||[])mutations.push(await prepareMutation({browser,context,page,cdp,baseURL},spec));
    await page.goto(baseURL, { waitUntil:'domcontentloaded' });
    await page.getByRole('button', { name:'Open Vault',exact:true }).waitFor();
    const dev = await page.evaluate(()=>!!document.querySelector('script[src*="/@vite/client"]'));
    return { browser, context, page, cdp, modKey:await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform)?'Meta':'Control'), baseURL, baseline:options.baseline||'b10d0d3', hardware:attached, mutations, network, responses, nativeReceipts, responseObjects, errors, consoleMessages, mode:dev?(options.idbShim?'dev-idb-shim':'dev-native-idb'):'production-native-idb', runtimeIdentity:{driverVersion,driverPackage,browserVersion:browser.version(),executablePath,attached}, shimHits:()=>shimHits, close:async()=>{await context.close();await browser.close();} };
  } catch (e) { if(context)await context.close().catch(()=>{});await browser.close(); throw e; }
}

export const frames = (page, n=2) => page.evaluate(n=>new Promise(resolve=>{ const tick=()=>--n<=0?resolve():requestAnimationFrame(tick);requestAnimationFrame(tick); }),n);
export async function until(fn, { timeout=15000, interval=50, description='condition' }={}) {
  const start=Date.now();let last;
  while(Date.now()-start<timeout){try{const x=await fn();if(x)return x;}catch(e){if(/PROBE_(?:OBJECT|VERSION|PATH|CONTROL)_ASSERT|REFERENCE_BUILD_ASSERT|HARNESS_(?:BROWSER|DRIVER)_ASSERT/.test(e.message))throw e;last=e;}await new Promise(r=>setTimeout(r,interval));}
  throw Error(`Timed out after ${timeout}ms: ${description}${last?`: ${last.message}`:''}`);
}
