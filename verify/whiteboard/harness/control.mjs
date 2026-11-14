// Run control only: identity, deliberate served-build faults, and recorded human prompts.
import {createHash}from'node:crypto';
import {createInterface}from'node:readline/promises';
import {referenceIdentity}from'./reference-identity.mjs';
const sha=text=>createHash('sha256').update(text).digest('hex');
const matches=(pattern,text)=>typeof pattern==='string'?text.includes(pattern):new RegExp(pattern.source,pattern.flags.replaceAll('g','').replaceAll('y','')).test(text);
function parseIndex(html,baseURL){
 const scripts=[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map(m=>new URL(m[1],baseURL).href).filter(u=>!u.includes('/@vite/client'));
 const entry=scripts.find(u=>/\/assets\/index-.*\.js/.test(u))||scripts.find(u=>u.includes('/src/main.'))||scripts.at(-1);if(!entry)throw Error('Served index has no module entry');
 return {entry,indexSha256:sha(html),hash:entry.match(/\/index-([\w-]+)\.js(?:\?|$)/)?.[1]??null,commitFromIndex:html.match(/<meta\s+name=["'](?:build-commit|git-commit)["']\s+content=["']([^"']+)/)?.[1]??null};
}
async function indexInfo(context,baseURL){const response=await context.request.get(baseURL);if(!response.ok())throw Error('Could not fetch served index: '+response.status());return parseIndex(await response.text(),baseURL);}
export async function prepareMutation(h,{kind,chunk,find,replace,count=1,maxModules=128}){
 if(!['whole-chunk','constant','shader','marker'].includes(kind))throw Error('mutate.kind must declare whole-chunk/constant/shader/marker; logic mutants require buildMutant from patched scratch source');
 if(!(chunk instanceof RegExp)&&typeof chunk!=='string')throw Error('mutate.chunk must be URL RegExp or substring');
 if((typeof find!=='string'&&!(find instanceof RegExp))||find==='')throw Error('mutate.find must be nonempty string or RegExp');
 if(typeof replace!=='string'||!Number.isInteger(count)||count<1)throw Error('mutate requires literal replace string and positive exact count');
 const index=await indexInfo(h.context,h.baseURL);if(!index.hash)throw Error('mutate only accepts built production chunks; no dev source patching');
 const queue=[index.entry],seen=new Set();let target;
 while(queue.length&&seen.size<maxModules){
  const url=queue.shift();if(seen.has(url)||new URL(url).origin!==new URL(h.baseURL).origin)continue;seen.add(url);
  const r=await h.context.request.get(url);if(!r.ok())continue;const body=await r.text();
  if(matches(chunk,url)){target={url,body};break;}
  for(const m of body.matchAll(/["']([^"'\\]+\.m?js(?:\?[^"'\\]*)?)["']/g)){
   const ref=m[1];if(ref.startsWith('http')&&new URL(ref).origin!==new URL(h.baseURL).origin)continue;
   try{queue.push(new URL(ref.startsWith('assets/')?'/'+ref:ref,url).href);}catch{ /* Non-URL literals are not module-graph edges. */ }
  }
 }
 if(!target)throw Error(`No built chunk matching ${chunk} discovered in ${seen.size} served modules`);
 const alreadyLoaded=await h.page.evaluate(url=>performance.getEntriesByType('resource').some(r=>r.name===url),target.url);if(alreadyLoaded)throw Error('Refusing late mutation: chunk already loaded by this page: '+target.url);
 const pattern=typeof find==='string'?null:new RegExp(find.source,find.flags.replaceAll('g','').replaceAll('y','')+'g');
 const found=pattern?[...target.body.matchAll(pattern)].length:target.body.split(find).length-1;
 if(found!==count)throw Error(`Mutation find matched ${found}, expected exactly ${count}, in ${target.url}`);
 const patched=pattern?target.body.replace(pattern,()=>replace):target.body.split(find).join(replace);
 if(patched===target.body)throw Error('Mutation did not change served bytes');
 const record={kind,url:target.url,find:String(find),expectedMatches:count,matches:found,beforeSha256:sha(target.body),afterSha256:sha(patched),served:0};
 await h.context.route(target.url,async route=>{record.served++;await route.fulfill({status:200,contentType:'application/javascript',body:patched});});
 record.assertApplied=()=>{if(record.served<1)throw Error('Mutation never reached the running app: '+record.url);return record;};
 return record;
}
export async function controlHelpers(h,options={}){
 h.mutations??=[];h.humanPrompts=[];
 h.assertReferenceBuild=await referenceIdentity(h,options);
 h.identity=async()=>{
  const document=h.responses.findLast(r=>r.mainDocument&&r.status>=200&&r.status<400),index=document&&h.responseObjects.get(document.url);if(!index)throw Error('Identity unavailable: browser has no successful main-document response');
  const build=parseIndex(await index.text(),h.baseURL),patterns=options.engineChunks||[/\/(?:DrawingPane|NotebookPane|PdfAnnotateCanvas|Tldraw)[-./]/,/\/(?:node_modules\/\.vite\/deps\/)?tldraw\.js(?:\?|$)/];
  const answered=[...new Map(h.responses.filter(r=>r.status>=200&&r.status<400&&patterns.some(p=>matches(p,r.url))).map(r=>[r.url,r])).values()],chunks=[];
  for(const response of answered){const bytes=await h.responseObjects.get(response.url).body();chunks.push({...response,bytes:bytes.length,sha256:sha(bytes)});}
  const contexts=await h.page.evaluate(()=>window.__harness.contexts);const reference=options.referenceBuild?await h.assertReferenceBuild():null;return {runtime:h.runtimeIdentity,reference,browser:{version:h.browser.version(),modKey:h.modKey},declaredBaseline:h.baseline,declaredEngine:options.declaredEngine??null,engine:{loaded:chunks.length>0,chunks},backend:{contexts,contextKinds:[...new Set(contexts.filter(c=>c.obtained).map(c=>c.kind))],coverage:'Main-frame HTMLCanvasElement.getContext only; DOM/SVG and worker contexts are not inferred'},build:{...build,kind:h.mode,observedBy:'actual main-document response'},mutations:h.mutations.map(m=>({kind:m.kind,url:m.url,matches:m.matches,served:m.served,beforeSha256:m.beforeSha256,afterSha256:m.afterSha256}))};
 };
 h.mutate=async spec=>{const m=await prepareMutation(h,spec);h.mutations.push(m);return m;};
 h.prompt=async text=>{
  const row={text,askedAt:new Date().toISOString(),simulated:!!options.promptReader};h.humanPrompts.push(row);
  if(options.promptReader)row.answer=String(await options.promptReader(text));else{
   if(!process.stdin.isTTY)throw Error('Human prompt requires a TTY; hardware gate is NOT RUN (do not synthesize an answer)');
   const io=createInterface({input:process.stdin,output:process.stdout});try{row.answer=await io.question(text+'\n> ');}finally{io.close();}
  }
  row.answeredAt=new Date().toISOString();return row.answer;
 };
 return h;
}
