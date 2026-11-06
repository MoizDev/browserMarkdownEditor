import { ArchiveClient } from './archiveClient';
import { mountBridge } from './bridge';
import type { ReaderBridge } from './bridge';
import { object, validLocator, validPreferences } from './bridgeProtocol';
import { EpubBudgets } from './budgets';
import { safeExternalLink, inspectResource } from './resources';
import { DEFAULT_PREFERENCES, EPUB_LIMITS as L } from './types';
import type { CanonicalSelection, EpubLocator, EpubMetadata, EpubSession, FindBatch, FindHit, ReaderAdapter, ReaderCapabilities, ReaderEvents, ReaderIdentity, ReadOnlyFileSnapshot, SessionOptions } from './types';
let appEncoded=0;
export async function createEpubSession(snapshot:ReadOnlyFileSnapshot,identity:ReaderIdentity,options:SessionOptions={},signal?:AbortSignal):Promise<EpubSession>{
 const lifetime=new AbortController(),archive=new ArchiveClient(lifetime.signal,waiting=>events.onStatus?.({phase:waiting?'loading':'ready',message:waiting?'Waiting for the local decoding budget…':undefined})),onAbort=()=>dispose();let bridge:ReaderBridge|undefined,events:ReaderEvents={},disposed=false,bookEncoded=0;const leases=new Map<string,number>(),budgets=new EpubBudgets();
 let resourceRequests=0,nextChunkAt=0,searchGeneration=0;const resourceControllers=new Map<number,AbortController>(),resourceIDs=new Set<string>(),acks=new Map<string,{resolve():void;reject(error:unknown):void;timer:ReturnType<typeof setTimeout>}>();
 function dispose(){if(disposed)return;disposed=true;for(const c of resourceControllers.values())c.abort();resourceControllers.clear();budgets.dispose();lifetime.abort();for(const ack of acks.values()){clearTimeout(ack.timer);ack.reject(new DOMException('Reader closed','AbortError'))}acks.clear();bridge?.dispose();archive.dispose();appEncoded-=bookEncoded;bookEncoded=0;leases.clear();signal?.removeEventListener('abort',onAbort)}
 signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted){dispose();throw signal.reason}
 let info,version;
 try{[info,version]=await Promise.all([archive.open(snapshot.blob),snapshot.fingerprint(lifetime.signal)]);lifetime.signal.throwIfAborted();options.onVersion?.(version)}catch(error){dispose();throw error}
 const initialRecord=options.initialRecord?.v===1&&options.initialRecord.parserSchema===1&&options.initialRecord.sanitizerSchema===1&&options.initialRecord.projectionSchema===1&&validLocator(options.initialRecord.locator)?options.initialRecord:undefined;
 const preferences=validPreferences(options.preferences)?options.preferences:DEFAULT_PREFERENCES;
 const manifest=new Map(info.resources.map(r=>[r.id,r]));
 const session:EpubSession={metadata:{title:'Opening book…',author:'',language:'',direction:'ltr',contents:[],pageList:[],landmarks:[],sections:info.spine,warnings:info.warnings},capabilities:{surface:'epub-reflow',emphasis:{kind:'inactive',reason:'Checking this section’s text for Word emphasis'},text:'partial',find:true,appearance:'reflow',copy:true},
 async mount(container,callbacks){
  if(bridge||disposed)throw Error('EPUB_SESSION_ALREADY_MOUNTED');events=callbacks;
  bridge=await mountBridge(container,{vaultId:identity.vaultId,vaultEpoch:identity.vaultEpoch,documentId:identity.documentId,byteGeneration:identity.byteGeneration},(message,active)=>{
   const p=message.payload;
   if(message.op==='resource'&&object(p)){
    const id=String(p.id),descriptor=manifest.get(id);
    if(!descriptor||resourceRequests>=8||resourceIDs.has(id)){active.send('resource-error',{request:message.id,message:'RESOURCE_NOT_APPROVED_OR_BUSY'});return}
    const resourceController=new AbortController();resourceControllers.set(message.id,resourceController);resourceRequests++;resourceIDs.add(id);
    void (async()=>{try{
     const data=await archive.read(id,resourceController.signal);if(disposed||resourceController.signal.aborted)return;const decoded=inspectResource(data);if(!budgets.resource(id,decoded.pixels,decoded.fontBytes))throw Error('DECODED_RESOURCE_BUDGET');
     if(data.bytes&&!leases.has(id)){if(bookEncoded+data.bytes.length>L.encoded||appEncoded+data.bytes.length>L.appEncoded)throw Error('RESOURCE_MEMORY_LIMIT');leases.set(id,data.bytes.length);bookEncoded+=data.bytes.length;appEncoded+=data.bytes.length}
     const header=new TextEncoder().encode(JSON.stringify({type:data.type,text:data.text,model:data.model}));
     const packed=new Uint8Array(4+header.length+(data.bytes?.length??0));new DataView(packed.buffer).setUint32(0,header.length);packed.set(header,4);if(data.bytes)packed.set(data.bytes,4+header.length);
     const total=Math.max(1,Math.ceil(packed.length/(192*1024)));
     for(let i=0;i<total;i++){if(disposed||resourceController.signal.aborted)return;const bytes=packed.slice(i*192*1024,(i+1)*192*1024);const delay=Math.max(0,nextChunkAt-performance.now());nextChunkAt=Math.max(performance.now(),nextChunkAt)+14;if(delay)await new Promise(r=>setTimeout(r,delay));if(disposed)return;const key=message.id+':'+i;const acknowledged=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{acks.delete(key);reject(Error('RESOURCE_BACKPRESSURE_TIMEOUT'))},10000);acks.set(key,{resolve,reject,timer})});active.send('resource-chunk',{request:message.id,index:i,total,bytes},[bytes.buffer]);await acknowledged}
    }catch(error){active.send('resource-error',{request:message.id,message:(error instanceof Error?error.message:'RESOURCE_ERROR').slice(0,500)})}finally{resourceRequests--;resourceIDs.delete(id);resourceControllers.delete(message.id)}})();return;
   }
   if(message.op==='resource-cancel'&&object(p)){resourceControllers.get(Number(p.request))?.abort();const prefix=p.request+':';for(const [key,ack]of acks)if(key.startsWith(prefix)){clearTimeout(ack.timer);acks.delete(key);ack.reject(new DOMException('Resource cancelled','AbortError'))}return}
   if(message.op==='budget'&&object(p)){const accepted=budgets.reserve(p.kind as 'dom'|'faces'|'encoded',Number(p.amount));active.send('budget-result',{request:message.id,accepted});return}
   if(message.op==='resource-ack'&&object(p)){const key=p.request+':'+p.index,ack=acks.get(key);if(ack){acks.delete(key);clearTimeout(ack.timer);ack.resolve()}return}
   if(message.op==='resource-release'&&object(p)){budgets.releaseResource(String(p.id));const n=leases.get(String(p.id));if(n!==undefined){leases.delete(String(p.id));bookEncoded-=n;appEncoded-=n}return}
   switch(message.op){
    case 'status':events.onStatus?.(p as Parameters<NonNullable<ReaderEvents['onStatus']>>[0]);break;
    case 'capabilities':session.capabilities=p as ReaderCapabilities;events.onCapabilities?.(session.capabilities);break;
    case 'location':if(object(p)&&validLocator(p.locator))events.onLocation?.(p.locator,p.cause as Parameters<NonNullable<ReaderEvents['onLocation']>>[1]);break;
    case 'selection':events.onSelection?.(p as CanonicalSelection|null);break;
    case 'visible-text':events.onVisibleText?.(p as string);break;
    case 'contextmenu':if(object(p))events.onContextMenu?.(Number(p.x),Number(p.y),p.selection as CanonicalSelection|null);break;
    case 'external-link':{const url=safeExternalLink(String(p));if(url)events.onExternalLink?.(url);break}
    case 'focus':events.onFocus?.();break;
    case 'command':events.onCommand?.(p as Parameters<NonNullable<ReaderEvents['onCommand']>>[0]);break;
    case 'metadata':session.metadata={...(p as unknown as EpubMetadata),sections:info.spine};events.onMetadata?.(session.metadata);break;
   }
  },lifetime.signal,message=>{events.onStatus?.({phase:'error',message});dispose()});
  const adapter:ReaderAdapter={
   async navigate(locator,cause='user-navigation'){await bridge!.call('navigate',{locator,cause})},
   captureAnchor(){return bridge!.call<EpubLocator|null>('capture')},
   async configure(preferences){await bridge!.call('configure',preferences)},
   canonicalSelection(){return bridge!.call<CanonicalSelection|null>('selection')},
   async turn(delta){await bridge!.call('turn',delta)},
   async returnToPrevious(){await bridge!.call('return')},
   focus(){bridge?.frame.focus();bridge?.send('focus')},dispose,
  };
  try{session.metadata={...await bridge.call<EpubMetadata>('open',{info,preferences,initialRecord,editionChanged:!!initialRecord&&initialRecord.rawFingerprint!==version.hash}),sections:info.spine};events.onMetadata?.(session.metadata);return adapter}catch(error){dispose();throw error}
 },
 async *find(query,abort){
  if(!bridge||disposed)throw Error('EPUB_NOT_MOUNTED');if(!query.trim()||query.length>256)return;
  let searchBytes=0;const generation=++searchGeneration,queryId=crypto.randomUUID(),hits:FindHit[]=[],unavailableSections:number[]=[];let truncated=false;
  const cancel=()=>bridge?.send('cancel-find',queryId);abort?.addEventListener('abort',cancel,{once:true});
  try{for(let index=0;index<info.spine.length;index++){
   searchBytes+=manifest.get(info.spine[index].href)?.size??0;if(searchBytes>512*1024*1024){yield {queryId,hits:[...hits],done:true,sectionsDone:index,sectionsTotal:info.spine.length,truncated:true,unavailableSections:[...unavailableSections]};return}
   abort?.throwIfAborted();lifetime.signal.throwIfAborted();if(generation!==searchGeneration)throw new DOMException('Search superseded','AbortError');
   try{const value=await bridge.call<{hits:FindHit[];truncated:boolean}>('find',{query,queryId,index},abort);if(generation!==searchGeneration)throw new DOMException('Search superseded','AbortError');hits.push(...value.hits.slice(0,500-hits.length));truncated||=value.truncated||hits.length===500}catch(error){if(abort?.aborted||generation!==searchGeneration)throw error;unavailableSections.push(index)}
   yield {queryId,hits:[...hits],done:index===info.spine.length-1,sectionsDone:index+1,sectionsTotal:info.spine.length,truncated,unavailableSections:[...unavailableSections]} satisfies FindBatch;
   // Keep scanning for honest section coverage after display cap; don't retain more hits.
  }}finally{cancel();abort?.removeEventListener('abort',cancel)}
 },dispose};
 return session;
}
