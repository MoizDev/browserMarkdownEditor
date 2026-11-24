/* eslint-disable no-control-regex -- reject control characters in archive paths before URL interpretation. */
import { EPUB_LIMITS as L } from './types';
import { Inflate } from './vendor/archive.js';
export interface ZipEntry { name: string; flags: number; method: number; crc: number; packed: number; unpacked: number; start: number }
export function archivePath(value: string): string {
 if (!value || /[\x00-\x1f\x7f\\]/.test(value) || value.startsWith('/') || value.includes(':') || /%(?:2e|2f|5c|25)/i.test(value) || value.split('/').some(p=>p==='.'||p==='..')) throw Error('ZIP_PATH');
 return value;
}
export function resolveArchiveReference(raw: string, base: string): {name: string; fragment: string} | null {
 if (!raw || /[\x00-\x20\x7f\\]/.test(raw) || /^[a-z][\w+.-]*:/i.test(raw) || raw.startsWith('/') || /%(?:2f|5c|25)/i.test(raw)) return null;
 try {
  // Resolve dot segments explicitly: URL silently clamps traversal above root.
  const [part,fragment=''] = raw.split('#'); if(part.includes('?')) return null;
  const segments = base.split('/').slice(0,-1);
  for(const token of decodeURIComponent(part).split('/')) { if(token==='..'){if(!segments.length)return null;segments.pop()}else if(token&&token!=='.')segments.push(token) }
  return {name: part ? archivePath(segments.join('/')) : base, fragment: decodeURIComponent(fragment)};
 } catch { return null }
}
const crcTable=Array.from({length:256},(_,i)=>{for(let j=0;j<8;j++)i=(i&1)?0xedb88320^(i>>>1):i>>>1;return i>>>0});
export class BoundedArchive {
 readonly entries=new Map<string,ZipEntry>();
 readonly stats={reads:0,maxRead:0,maxChunk:0,actualOutput:0,retained:0};
 constructor(private blob:Blob, private signal:AbortSignal) {}
 private check(){this.signal.throwIfAborted()}
 async read(off:number,len:number) {
  this.check();if(!Number.isSafeInteger(off)||!Number.isSafeInteger(len)||off<0||len<0||len>L.directory||off+len>this.blob.size)throw Error('ZIP_BOUNDS');
  this.stats.reads++;this.stats.maxRead=Math.max(this.stats.maxRead,len);const bytes=new Uint8Array(await this.blob.slice(off,off+len).arrayBuffer());this.check();return bytes;
 }
 async init() {
  if(this.blob.size>L.archive||this.blob.size<22)throw Error('ZIP_SIZE');
  const tail=await this.read(Math.max(0,this.blob.size-65557),Math.min(this.blob.size,65557)),v=new DataView(tail.buffer);
  let end=-1;for(let i=tail.length-22;i>=0;i--)if(v.getUint32(i,true)===0x06054b50&&i+22+v.getUint16(i+20,true)===tail.length){end=i;break}
  if(end<0)throw Error('ZIP_EOCD');if(v.getUint16(end+4,true)||v.getUint16(end+6,true))throw Error('ZIP_MULTIDISK');
  const n=v.getUint16(end+10,true),size=v.getUint32(end+12,true),off=v.getUint32(end+16,true);
  // Never reinterpret saturated ZIP32 sizes or allocate from ZIP64 extended values.
  if(n===65535||off===0xffffffff||size===0xffffffff)throw Error('ZIP64_UNSUPPORTED: ZIP64 books are not supported; use a ZIP32 EPUB.');
  if(n>L.entries||size>L.directory||off+size!==this.blob.size-tail.length+end||n!==v.getUint16(end+8,true))throw Error('ZIP_DIRECTORY_LIMIT');
  const c=await this.read(off,size),d=new DataView(c.buffer),intervals:number[][]=[];let p=0,total=0;
  const decoder=new TextDecoder('utf-8',{fatal:true});
  for(let k=0;k<n;k++) {
   if(p+46>c.length||d.getUint32(p,true)!==0x02014b50)throw Error('ZIP_DIRECTORY');
   const flags=d.getUint16(p+8,true),method=d.getUint16(p+10,true),crc=d.getUint32(p+16,true),packed=d.getUint32(p+20,true),unpacked=d.getUint32(p+24,true),nl=d.getUint16(p+28,true),el=d.getUint16(p+30,true),cl=d.getUint16(p+32,true),local=d.getUint32(p+42,true);
   if(p+46+nl+el+cl>c.length||!nl)throw Error('ZIP_DIRECTORY');
   const name=archivePath(decoder.decode(c.subarray(p+46,p+46+nl)));p+=46+nl+el+cl;
   if(packed===0xffffffff||unpacked===0xffffffff||local===0xffffffff)throw Error('ZIP64_UNSUPPORTED');
   if(flags&1)throw Error('ZIP_ENCRYPTED');if(flags&~(0x800|8|2|4))throw Error('ZIP_FLAGS');if(method!==0&&method!==8)throw Error('ZIP_METHOD');
   if(method===0&&(packed!==unpacked||flags&6))throw Error('ZIP_STORED_SIZE');
   if(this.entries.has(name))throw Error('ZIP_DUPLICATE');if(unpacked>L.binary||(total+=unpacked)>L.declared)throw Error('ZIP_DECLARED_LIMIT');
   if(unpacked>Math.max(packed,1)*200)throw Error('ZIP_RATIO');
   if(local+30>off)throw Error('ZIP_BOUNDS');const h=await this.read(local,30),l=new DataView(h.buffer);
   if(l.getUint32(0,true)!==0x04034b50)throw Error('ZIP_LOCAL');
   const lnl=l.getUint16(26,true),lel=l.getUint16(28,true),start=local+30+lnl+lel;
   if(start+packed>off||l.getUint16(6,true)!==flags||l.getUint16(8,true)!==method||decoder.decode(await this.read(local+30,lnl))!==name)throw Error('ZIP_LOCAL_MISMATCH');
   if(!(flags&8)&&(l.getUint32(14,true)!==crc||l.getUint32(18,true)!==packed||l.getUint32(22,true)!==unpacked))throw Error('ZIP_LOCAL_MISMATCH');
   let finish=start+packed;
   if(flags&8){const raw=await this.read(finish,Math.min(16,off-finish)),dd=new DataView(raw.buffer);const at=raw.length>=4&&dd.getUint32(0,true)===0x08074b50?4:0;if(raw.length<at+12||dd.getUint32(at,true)!==crc||dd.getUint32(at+4,true)!==packed||dd.getUint32(at+8,true)!==unpacked)throw Error('ZIP_DESCRIPTOR');finish+=at+12}
   intervals.push([local,finish]);this.entries.set(name,{name,flags,method,crc,packed,unpacked,start});
   if(k%128===0)await new Promise(r=>setTimeout(r,0));
  }
  if(p!==c.length)throw Error('ZIP_DIRECTORY_TRAILING');intervals.sort((a,b)=>a[0]-b[0]);for(let i=1;i<intervals.length;i++)if(intervals[i][0]<intervals[i-1][1])throw Error('ZIP_OVERLAP');
 }
 async extract(name:string,cap=L.text,signal?:AbortSignal):Promise<Uint8Array> {
  this.check();signal?.throwIfAborted();const e=this.entries.get(name);if(!e)throw Error('RESOURCE_MISSING');if(e.unpacked>cap)throw Error('ENTRY_DECLARED_LIMIT');
  let length=0,crc=0xffffffff;const chunks:Uint8Array[]=[];
  const accept=(value:Uint8Array)=>{this.check();signal?.throwIfAborted();this.stats.maxChunk=Math.max(this.stats.maxChunk,value.length);this.stats.actualOutput+=value.length;
   if(value.length>65536||length+value.length>cap||length+value.length>e.unpacked)throw Error('ENTRY_ACTUAL_LIMIT');
   for(let i=0;i<value.length;i++)crc=crcTable[(crc^value[i])&255]^(crc>>>8);length+=value.length;chunks.push(value);
  };
  if(e.method===8){const inflater=new Inflate({raw:true,chunkSize:65536,windowBits:15});inflater.onData=accept;inflater.onEnd=(status:number)=>{inflater.err=status};
   for(let at=0;at<e.packed;at+=16384){signal?.throwIfAborted();const b=await this.read(e.start+at,Math.min(16384,e.packed-at));if(!inflater.push(b,at+b.length===e.packed))throw Error('DEFLATE_INVALID');await new Promise(r=>setTimeout(r,0))}
   if(!inflater.ended||inflater.err)throw Error('DEFLATE_INVALID');
  }else for(let at=0;at<e.packed;at+=65536)accept(await this.read(e.start+at,Math.min(65536,e.packed-at)));
  if(length!==e.unpacked)throw Error('ENTRY_SIZE');if(((crc^0xffffffff)>>>0)!==e.crc)throw Error('ENTRY_CRC');
  const bytes=new Uint8Array(length);let at=0;for(const b of chunks){bytes.set(b,at);at+=b.length}this.stats.retained=bytes.length;return bytes;
 }
}
