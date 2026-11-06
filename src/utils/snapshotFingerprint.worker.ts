import { Sha256 } from '../epub/sha256';
self.onmessage=async (event:MessageEvent<Blob>)=>{try{const blob=event.data,hash=new Sha256();for(let at=0;at<blob.size;at+=4*1024*1024)hash.update(new Uint8Array(await blob.slice(at,at+4*1024*1024).arrayBuffer()));self.postMessage({hash:hash.digest()})}catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)})}};
