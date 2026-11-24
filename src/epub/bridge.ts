import { MessageRate, validateEnvelope } from './bridgeProtocol';
import type { Envelope } from './bridgeProtocol';
import type { ReaderToken } from './types';
import frameHTML from './reader-frame.html?raw';
export interface ReaderBridge { frame:HTMLIFrameElement; call<T>(op:string,payload?:unknown,signal?:AbortSignal):Promise<T>; send(op:string,payload?:unknown,transfer?:Transferable[]):void; dispose():void }
export async function mountBridge(container:HTMLElement,token:ReaderToken,onEvent:(message:Envelope,bridge:ReaderBridge)=>void,signal:AbortSignal,onFailure?:(message:string)=>void):Promise<ReaderBridge>{
 const session=crypto.randomUUID(),frame=document.createElement('iframe'),channel=new MessageChannel(),pending=new Map<number,{resolve(value:unknown):void;reject(error:unknown):void;cleanup():void}>();let sequence=0,closed=false,loads=0;
 frame.className='epub-reader-frame';frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';frame.setAttribute('aria-label','EPUB book content');frame.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
 const bridge:ReaderBridge={frame,send(op,payload=null,transfer=[]){if(closed)return;channel.port1.postMessage({v:1,session,token,id:0,op,payload},transfer)},call<T>(op:string,payload:unknown=null,abort?:AbortSignal):Promise<T>{
  if(pending.size>=64)return Promise.reject(Error('Reader busy; wait for the current action.'));
  if(closed||signal.aborted||abort?.aborted)return Promise.reject(new DOMException('Reader closed','AbortError'));
  return new Promise((resolve,reject)=>{const id=++sequence,cancel=()=>{pending.delete(id);cleanup();reject(abort?.reason??Error('Reader request timed out'))},timer=setTimeout(cancel,120000),cleanup=()=>{clearTimeout(timer);abort?.removeEventListener('abort',cancel)};pending.set(id,{resolve:value=>resolve(value as T),reject,cleanup});abort?.addEventListener('abort',cancel,{once:true});if(op==='open'){const packed=new TextEncoder().encode(JSON.stringify(payload));if(packed.length>192*1024){const total=Math.ceil(packed.length/(192*1024));void(async()=>{for(let index=0;index<total;index++){if(closed)return;const bytes=packed.slice(index*192*1024,(index+1)*192*1024);channel.port1.postMessage({v:1,session,token,id,op:'open-chunk',payload:{request:id,index,total,bytes}},[bytes.buffer]);await new Promise(r=>setTimeout(r,15))}})();return}}channel.port1.postMessage({v:1,session,token,id,op,payload})});
 },dispose(){if(closed)return;bridge.send('dispose');closed=true;for(const p of pending.values()){p.cleanup();p.reject(new DOMException('Reader closed','AbortError'))}pending.clear();channel.port1.close();channel.port2.close();frame.remove();signal.removeEventListener('abort',bridge.dispose)}};
 const rate=new MessageRate();
 const ready=new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>{bridge.dispose();reject(Error('EPUB_FRAME_TIMEOUT'))},10000);
  const abort=()=>{clearTimeout(timer);reject(new DOMException('Reader closed','AbortError'))};signal.addEventListener('abort',abort,{once:true});
  channel.port1.onmessage=({data:m})=>{
   if(closed)return;
   if(!validateEnvelope(m,session,token,'child')||!rate.accept()){clearTimeout(timer);onFailure?.('The reader communication channel was rejected. Reopen this book to retry.');bridge.dispose();reject(Error('EPUB_BRIDGE_PROTOCOL'));return}
   if(m.op==='ready'){clearTimeout(timer);signal.removeEventListener('abort',abort);resolve();return}
   if(m.op==='reply'){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);p.cleanup();const payload=m.payload as {ok:boolean;value?:unknown;error?:string};if(payload.ok)p.resolve(payload.value);else p.reject(Error(payload.error||'EPUB_READER_ERROR'));return}
   onEvent(m,bridge);
  };channel.port1.start();
  frame.addEventListener('load',()=>{if(++loads!==1){onFailure?.('The contained reader navigated unexpectedly and was closed.');bridge.dispose();return}frame.contentWindow?.postMessage({type:'epub-reader-init',v:1,session,token},'*',[channel.port2])});
 });
 signal.addEventListener('abort',bridge.dispose,{once:true});signal.throwIfAborted();frame.srcdoc=frameHTML;container.append(frame);
 try{await ready;return bridge}catch(error){bridge.dispose();throw error}
}
