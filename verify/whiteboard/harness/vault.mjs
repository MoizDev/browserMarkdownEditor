import { until } from './runtime.mjs';

export function vaultHelpers(h) {
  const { page } = h;
  async function io(operation, path='', data, options={}) {
    return page.evaluate(async ({operation,path,data,options})=>{
      if(path.startsWith('/')||path.split('/').includes('..'))throw Error('Expected vault-relative path');
      const root=await navigator.storage.getDirectory();
      const vault=await root.getDirectoryHandle(window.__harness.vaultName,{create:true});
      const parts=path.split('/').filter(Boolean);let d=vault;
      for(const p of parts.slice(0,-1))d=await d.getDirectoryHandle(p,{create:operation==='write'});
      const name=parts.at(-1);
      if(operation==='list'){
        if(name)d=await d.getDirectoryHandle(name);
        const result=[];async function walk(dir,prefix){for await(const [n,x]of dir.entries()){result.push({path:prefix+n,kind:x.kind});if(options.recursive&&x.kind==='directory')await walk(x,prefix+n+'/')}}
        await walk(d,path?path+'/':'');return result.sort((a,b)=>a.path.localeCompare(b.path));
      }
      if(operation==='remove'){await d.removeEntry(name,{recursive:!!options.recursive});return true;}
      const fh=await d.getFileHandle(name,{create:operation==='write'});
      if(operation==='write'){
        // This fresh handle and native write deliberately bypass the app-write counter.
        const w=await window.__harness.native.createWritable.call(fh);await w.write(data.bytes?new Uint8Array(data.bytes):data.text);await w.close();return true;
      }
      const f=await fh.getFile();
      if(operation==='stat')return {size:f.size,lastModified:f.lastModified,type:f.type,name:f.name};
      return options.bytes?Array.from(new Uint8Array(await f.arrayBuffer())):await f.text();
    },{operation,path,data,options});
  }
  return {
    open: async ()=>{await page.getByRole('button',{name:'Open Vault',exact:true}).click();await page.locator('.vault-switcher').waitFor();},
    seed: async files=>{for(const [path,data]of Object.entries(files))await io('write',path,typeof data==='string'?{text:data}:{bytes:Array.from(data)});},
    write: (path,data)=>io('write',path,typeof data==='string'?{text:data}:{bytes:Array.from(data)}),
    read: async(path,{bytes=false}={})=>{const value=await io('read',path,undefined,{bytes});return bytes?Buffer.from(value):value;},
    stat:path=>io('stat',path),
    list:(path='',options={recursive:true})=>io('list',path,undefined,options),
    remove:(path,options={})=>io('remove',path,undefined,options),
    writes: async(path)=>page.evaluate(path=>window.__harness.writes.filter(w=>!path||w.path===window.__harness.vaultName+'/'+path),path),
    mark: async()=>page.evaluate(()=>window.__harness.sequence),
    localStorage: ()=>page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)]))),
    waitForSave: async(path,{after=0,timeout=30000,predicate}={})=>{
      const event=await until(async()=>{
        const writes=await page.evaluate(({path,after})=>window.__harness.writes.filter(w=>w.id>after&&w.path===window.__harness.vaultName+'/'+path&&w.closed!==null&&!w.error),{path,after});
        if(!writes.length)return false;
        // A clean dot can precede serialization. Compare actual saved/live records below;
        // never import an app reporter to inspect its internal debounce.
        const dirty=await page.locator('[role="tab"]').evaluateAll((tabs,path)=>tabs.some(t=>t.getAttribute('data-tooltip')===path&&!!t.querySelector('.tab-dirty-dot')),path);
        if(dirty)return false;
        if(/\.(tldraw|notebook|pdf)$/.test(path)){const synchronized=await h.probe.synchronized(path);if(synchronized===false||(synchronized===null&&!predicate))return false;}
        if(predicate&&!await predicate(await h.vault.read(path,{bytes:path.endsWith('.pdf')})))return false;
        return writes.at(-1);
      },{timeout,description:`app autosave of ${path}, a completed app write after #${after}, clean tab and independent saved-canvas equality`});
      return event;
    },
  };
}
