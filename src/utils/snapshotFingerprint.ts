import { workerScript } from '../platform/workers/script';
import fingerprintWorkerUrl from './snapshotFingerprint.worker.ts?worker&url';

// Kept (platform/workers/script.ts): every board save that holds a picture, every picture added and every large write
// is checked with a fingerprint, each in a worker of its own. Started from the network, a deploy stopped them all in an
// open tab (measured: "“Hand.drawing” was not saved: File fingerprint worker failed", on every change after it).
const fingerprintWorker = workerScript(fingerprintWorkerUrl, { keep: true });

/** Each hash reads the acquired Blob in <=4 MiB slices; termination cancels CPU and IO. */
export async function fingerprintSnapshot(blob:Blob,signal?:AbortSignal):Promise<string>{
 signal?.throwIfAborted();
 const worker=await fingerprintWorker.start();
 return new Promise((resolve,reject)=>{
 const stop=()=>{worker.terminate();signal?.removeEventListener('abort',abort);clearTimeout(timer)};
 const abort=()=>{stop();reject(new DOMException('Snapshot disposed','AbortError'))};
 const timer=setTimeout(()=>{stop();reject(new Error('File fingerprint timed out; retry reading the file'))},60000);
 if(signal?.aborted){abort();return}
 signal?.addEventListener('abort',abort,{once:true});worker.onerror=()=>{stop();reject(new Error('File fingerprint worker failed'))};worker.onmessage=e=>{stop();if(typeof e.data?.hash==='string')resolve(e.data.hash);else reject(new Error(e.data?.error??'Fingerprint failed'))};worker.postMessage(blob);
 });
}
