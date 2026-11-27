import { dropKeptCopy, startFailure, workerScript } from '../platform/workers/script';
import fingerprintWorkerUrl from './snapshotFingerprint.worker.ts?worker&url';

const fingerprintWorker = workerScript(fingerprintWorkerUrl, { keep: true });

export async function fingerprintSnapshot(blob:Blob,signal?:AbortSignal):Promise<string>{
 for(;;){
  signal?.throwIfAborted();
  const worker=await fingerprintWorker.start();
  const outcome=await new Promise<{hash:string}|{again:true}>((resolve,reject)=>{
  const stop=()=>{worker.terminate();signal?.removeEventListener('abort',abort);clearTimeout(timer)};
  const abort=()=>{stop();reject(new DOMException('Snapshot disposed','AbortError'))};
  const timer=setTimeout(()=>{stop();reject(new Error('File fingerprint timed out; retry reading the file'))},60000);
  if(signal?.aborted){abort();return}
  signal?.addEventListener('abort',abort,{once:true});worker.onerror=event=>{stop();if(dropKeptCopy(worker,event)){resolve({again:true});return}void startFailure(worker,event).then(cause=>reject(cause??new Error('File fingerprint worker failed')))};worker.onmessage=e=>{stop();if(typeof e.data?.hash==='string')resolve({hash:e.data.hash});else reject(new Error(e.data?.error??'Fingerprint failed'))};worker.postMessage(blob);
  });
  if('hash' in outcome)return outcome.hash;
 }
}
