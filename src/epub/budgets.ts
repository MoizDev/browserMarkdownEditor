// Main-realm accounting only: opaque frames reserve before DOM attach or decode.
// These are counters for controlled resources, not a browser process-memory quota.
export type BudgetKind='dom'|'faces'|'encoded';
const totals={dom:0,faces:0,pixels:0,fontBytes:0,encoded:0};
export class EpubBudgets {
 private dom=0;private faces=0;private encoded=0;private resources=new Map<string,{pixels:number;fontBytes:number}>();
 reserve(kind:BudgetKind,amount:number):boolean {if(!Number.isSafeInteger(amount)||amount<0)return false;const old=this[kind],bookMax=kind==='dom'?150000:kind==='faces'?8:128*1024*1024,appMax=kind==='dom'?300000:kind==='faces'?24:256*1024*1024;if(amount>bookMax||totals[kind]-old+amount>appMax)return false;totals[kind]+=amount-old;this[kind]=amount;return true}
 resource(id:string,pixels:number,fontBytes:number):boolean{if(this.resources.has(id))return true;const book=[...this.resources.values()].reduce((s,r)=>s+r.pixels,0);if(!Number.isSafeInteger(pixels)||pixels<0||!Number.isSafeInteger(fontBytes)||fontBytes<0||pixels>16*1024*1024||book+pixels>32*1024*1024||totals.pixels+pixels>64*1024*1024||totals.fontBytes+fontBytes>64*1024*1024)return false;this.resources.set(id,{pixels,fontBytes});totals.pixels+=pixels;totals.fontBytes+=fontBytes;return true}
 releaseResource(id:string){const r=this.resources.get(id);if(r){this.resources.delete(id);totals.pixels-=r.pixels;totals.fontBytes-=r.fontBytes}}
 dispose(){this.reserve('dom',0);this.reserve('faces',0);this.reserve('encoded',0);for(const id of this.resources.keys())this.releaseResource(id)}
}
const work:{at:number;bytes:number}[]=[];
export async function reserveDecode(bytes:number,signal:AbortSignal,onWait?:(waiting:boolean)=>void){if(!Number.isSafeInteger(bytes)||bytes<0||bytes>32*1024*1024)throw Error('DECODE_BUDGET');let waiting=false;try{for(;;){signal.throwIfAborted();const now=performance.now();while(work.length&&work[0].at<=now-30000)work.shift();if(work.reduce((n,r)=>n+r.bytes,0)+bytes<=256*1024*1024){work.push({at:now,bytes});return}if(!waiting){waiting=true;onWait?.(true)}await new Promise<void>((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(signal.reason)},timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve()},Math.max(1,work[0].at+30001-now));signal.addEventListener('abort',stop,{once:true})})}}finally{if(waiting)onWait?.(false)}}
