/** Each hash reads the acquired Blob in <=4 MiB slices; termination cancels CPU and IO. */
export function fingerprintSnapshot(blob:Blob,signal?:AbortSignal):Promise<string>{
 return new Promise((resolve,reject)=>{signal?.throwIfAborted();const worker=new Worker(new URL('./snapshotFingerprint.worker.ts',import.meta.url),{type:'module'});
 const stop=()=>{worker.terminate();signal?.removeEventListener('abort',abort);clearTimeout(timer)};
 const abort=()=>{stop();reject(new DOMException('Snapshot disposed','AbortError'))};
 const timer=setTimeout(()=>{stop();reject(new Error('File fingerprint timed out; retry reading the file'))},60000);
 signal?.addEventListener('abort',abort,{once:true});worker.onerror=()=>{stop();reject(new Error('File fingerprint worker failed'))};worker.onmessage=e=>{stop();if(typeof e.data?.hash==='string')resolve(e.data.hash);else reject(new Error(e.data?.error??'Fingerprint failed'))};worker.postMessage(blob);
 });
}
