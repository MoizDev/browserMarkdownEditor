import { reserveDecode } from './budgets';
import type { ArchiveInfo, ResourceData } from './types';
import { EPUB_LIMITS as L } from './types';
let running=0;
const waiters:(()=>void)[]=[];
function returnPermit(){const next=waiters.shift();if(next)next();else running--}
async function permit(signal:AbortSignal):Promise<()=>void>{
 signal.throwIfAborted();
 if(running<3)running++;
 else await new Promise<void>((resolve,reject)=>{const wake=()=>{signal.removeEventListener('abort',abort);resolve()},abort=()=>{const i=waiters.indexOf(wake);if(i>=0)waiters.splice(i,1);reject(signal.reason)};waiters.push(wake);signal.addEventListener('abort',abort,{once:true})});
 if(signal.aborted){returnPermit();throw signal.reason}
 let released=false;return ()=>{if(released)return;released=true;returnPermit()};
}
export class ArchiveClient {
 private worker:Worker;
 private sequence=0;
 private pending=new Map<number,{resolve(value:unknown):void;reject(reason:unknown):void;timer:ReturnType<typeof setTimeout>;release():void}>();
 private lifetime=new AbortController();
 private info?:ArchiveInfo;
 private onAbort=()=>this.dispose();
 constructor(signal?:AbortSignal,private onBudgetWait?:(waiting:boolean)=>void){
  this.worker=new Worker(new URL('./archive.worker.ts',import.meta.url),{type:'module'});
  this.worker.onmessage=({data:m})=>{const task=this.pending.get(m?.id);if(!task)return;this.pending.delete(m.id);clearTimeout(task.timer);task.release();if(typeof m.error==='string')task.reject(Error(m.error));else task.resolve(m.result)};
  this.worker.onerror=()=>this.dispose(Error('EPUB_WORKER_ERROR'));
  signal?.addEventListener('abort',this.onAbort,{once:true});this.lifetime.signal.addEventListener('abort',()=>signal?.removeEventListener('abort',this.onAbort),{once:true});
  if(signal?.aborted)this.dispose();
 }
 private async call(op:string,payload:Record<string,unknown>,signal=this.lifetime.signal):Promise<unknown>{
  signal.throwIfAborted();const release=await permit(signal);
  // StrictMode can dispose between permit's resolution and this continuation.
  // A terminated worker cannot acknowledge a task queued after its disposal.
  if(signal.aborted||this.lifetime.signal.aborted){release();throw signal.reason??this.lifetime.signal.reason}
  return await new Promise((resolve,reject)=>{const id=++this.sequence,cancel=()=>{const p=this.pending.get(id);if(p){this.worker.postMessage({op:'cancel',id});reject(signal.reason)}},timer=setTimeout(()=>this.dispose(Error('EPUB_ARCHIVE_TIMEOUT')),['read','bootstrap','init'].includes(op)?10000:20000);signal.addEventListener('abort',cancel,{once:true});this.pending.set(id,{resolve:value=>{signal.removeEventListener('abort',cancel);resolve(value)},reject:error=>{signal.removeEventListener('abort',cancel);reject(error)},timer,release});this.worker.postMessage({id,op,...payload})})
 }
 async open(blob:Blob):Promise<ArchiveInfo>{if(blob.size>L.archive)throw Error('ZIP_SIZE');const pre=await this.call('preflight',{blob}) as {bootstrapBytes:number};await reserveDecode(pre.bootstrapBytes,this.lifetime.signal,this.onBudgetWait);const bootstrap=await this.call('bootstrap',{}) as {packageBytes:number};await reserveDecode(bootstrap.packageBytes,this.lifetime.signal,this.onBudgetWait);this.info=await this.call('init',{}) as ArchiveInfo;return this.info}
 async read(id:string,abort?:AbortSignal):Promise<ResourceData>{const signal=abort?AbortSignal.any([abort,this.lifetime.signal]):this.lifetime.signal;const resource=this.info?.resources.find(r=>r.id===id);if(!resource)throw Error('RESOURCE_NOT_APPROVED');await reserveDecode(resource.size,signal,this.onBudgetWait);return await this.call('read',{name:id},signal) as ResourceData}
 async stats(){return this.call('stats',{})}
 dispose(reason:unknown=new DOMException('Reader closed','AbortError')){if(this.lifetime.signal.aborted)return;this.lifetime.abort(reason);this.worker.terminate();for(const p of this.pending.values()){clearTimeout(p.timer);p.release();p.reject(reason)}this.pending.clear();this.info=undefined}
}
