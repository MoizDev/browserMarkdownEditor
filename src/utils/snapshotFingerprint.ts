import { dropKeptCopy, startFailure, workerScript } from '../platform/workers/script';
import fingerprintWorkerUrl from './snapshotFingerprint.worker.ts?worker&url';

// Kept (platform/workers/script.ts): every board save that holds a picture, every picture added and every large write
// is checked with a fingerprint, each in a worker of its own. Started from the network, a deploy stopped them all in an
// open tab (measured: "“Hand.drawing” was not saved: File fingerprint worker failed", on every change after it).
const fingerprintWorker = workerScript(fingerprintWorkerUrl, { keep: true });

/** Each hash reads the acquired Blob in <=4 MiB slices; termination cancels CPU and IO. */
export async function fingerprintSnapshot(blob:Blob,signal?:AbortSignal):Promise<string>{
 for(;;){
  signal?.throwIfAborted();
  const worker=await fingerprintWorker.start();
  const outcome=await new Promise<{hash:string}|{again:true}>((resolve,reject)=>{
  const stop=()=>{worker.terminate();signal?.removeEventListener('abort',abort);clearTimeout(timer)};
  const abort=()=>{stop();reject(new DOMException('Snapshot disposed','AbortError'))};
  const timer=setTimeout(()=>{stop();reject(new Error('File fingerprint timed out; retry reading the file'))},60000);
  if(signal?.aborted){abort();return}
  // The worker answers once (its own failures arrive as an answer), so an error event is one before it could. A kept copy
  // that would not run is dropped and the hash starts again at once from the network (platform/workers/script.ts); a
  // script that could not be had says why in plain words.
  signal?.addEventListener('abort',abort,{once:true});worker.onerror=event=>{stop();if(dropKeptCopy(worker,event)){resolve({again:true});return}void startFailure(worker,event).then(cause=>reject(cause??new Error('File fingerprint worker failed')))};worker.onmessage=e=>{stop();if(typeof e.data?.hash==='string')resolve({hash:e.data.hash});else reject(new Error(e.data?.error??'Fingerprint failed'))};worker.postMessage(blob);
  });
  if('hash' in outcome)return outcome.hash;
 }
}
