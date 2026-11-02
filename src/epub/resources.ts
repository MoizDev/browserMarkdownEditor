/* eslint-disable no-control-regex -- reject control characters in archive paths before URL interpretation. */
import type { ResourceData, ResourceDescriptor, XmlNode } from './types';
import { EPUB_LIMITS as L } from './types';
export interface ResolvedReference {name:string;fragment:string}
// Used in the opaque frame only. URL() alone silently clamps traversal above root.
export function resolveBookReference(raw:string,base:string):ResolvedReference|null {
 if(!raw||/[\x00-\x20\x7f\\]/.test(raw)||/^[a-z][\w+.-]*:/i.test(raw)||raw.startsWith('/')||/%(?:2f|5c|25)/i.test(raw))return null;
 try{const [part,fragment='']=raw.split('#');if(part.includes('?'))return null;const bits=base.split('/').slice(0,-1);for(const p of decodeURIComponent(part).split('/')){if(p==='..'){if(!bits.length)return null;bits.pop()}else if(p&&p!=='.')bits.push(p)}return {name:part?bits.join('/'):base,fragment:decodeURIComponent(fragment)}}catch{return null}
}
export function safeExternalLink(raw:string):string|null{
 try{const u=new URL(raw);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;const h=u.hostname.toLowerCase().replace(/\.$/,'');
  if(!h.includes('.')||h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.startsWith('['))return null;
  if(/^\d+\.\d+\.\d+\.\d+$/.test(h)){const [a,b]=h.split('.').map(Number);if(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a>=224)return null}
  return u.href;
 }catch{return null}
}
export function inspectResource(data:ResourceData):{pixels:number;fontBytes:number}{
 if(data.type==='image/svg+xml'&&data.model){const a=data.model.attrs,box=a.viewBox?.trim().split(/[ ,]+/).map(Number),w=Number(a.width?.replace(/px$/,'')||box?.[2]||300),h=Number(a.height?.replace(/px$/,'')||box?.[3]||150);if(!Number.isFinite(w)||!Number.isFinite(h)||w<1||h<1||w>16384||h>16384||w*h>L.imagePixels)throw Error('IMAGE_PIXELS');return {pixels:Math.ceil(w*h),fontBytes:0}}
 if(!data.bytes)return {pixels:0,fontBytes:0};const b=data.bytes,v=new DataView(b.buffer,b.byteOffset,b.byteLength),font=/^(font\/|application\/(?:font-|x-font-|vnd.ms-opentype))/.test(data.type);let pixels=0;
   if(font){if(b.length<12||b.length>L.font)throw Error('FONT_SIZE');const sig=v.getUint32(0);if(![0x774f4632,0x774f4646,0x00010000,0x4f54544f,0x74727565].includes(sig))throw Error('FONT_SIGNATURE');if((sig===0x774f4632||sig===0x774f4646)&&(b.length<48||v.getUint32(16)>32*1024*1024))throw Error('FONT_EXPANSION');}
   else {
    if(!['image/png','image/jpeg','image/gif','image/webp','image/avif'].includes(data.type))throw Error('IMAGE_FORMAT_UNSUPPORTED');
    // Reject animation before decode. PNG/WebP are chunk-scanned; GIF is refused explicitly.
    if(data.type==='image/gif')throw Error('IMAGE_ANIMATION_UNSUPPORTED: GIF images are not supported.');
    if(data.type==='image/avif')throw Error('IMAGE_FORMAT_UNSUPPORTED: AVIF images are not supported.');
    if(data.type==='image/png'){if(b.length<33||v.getUint32(0)!==0x89504e47||v.getUint32(4)!==0x0d0a1a0a)throw Error('IMAGE_SIGNATURE');let p=8;for(;p+12<=b.length;){const n=v.getUint32(p),t=v.getUint32(p+4);if(n>b.length-p-12)throw Error('IMAGE_CHUNKS');if(t===0x6163544c)throw Error('IMAGE_ANIMATION_UNSUPPORTED');p+=n+12;if(t===0x49454e44)break}const w=v.getUint32(16),h=v.getUint32(20);if(!w||!h||w>16384||h>16384||w*h>L.imagePixels)throw Error('IMAGE_PIXELS');pixels=w*h}
    if(data.type==='image/webp'){if(b.length<20||v.getUint32(0)!==0x52494646||v.getUint32(8)!==0x57454250)throw Error('IMAGE_SIGNATURE');for(let p=12;p+8<=b.length;){const tag=v.getUint32(p),n=v.getUint32(p+4,true);if(n>b.length-p-8)throw Error('IMAGE_CHUNKS');if(tag===0x414e494d||tag===0x414e4d46||tag===0x56503858&&n>=1&&(b[p+8]&2))throw Error('IMAGE_ANIMATION_UNSUPPORTED');p+=8+n+(n%2)}}
    if(data.type==='image/jpeg'){
     if(b.length<4||v.getUint16(0)!==0xffd8)throw Error('IMAGE_SIGNATURE');let found=false;
     for(let p=2;p+4<b.length;){if(b[p++]!==255)throw Error('IMAGE_JPEG');while(b[p]===255)p++;const marker=b[p++];if(marker===217||marker===218)break;if(marker>=208&&marker<=215)continue;const len=v.getUint16(p);if(len<2||p+len>b.length)throw Error('IMAGE_JPEG');if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){const h=v.getUint16(p+3),w=v.getUint16(p+5);if(!w||!h||w>16384||h>16384||w*h>L.imagePixels)throw Error('IMAGE_PIXELS');pixels=w*h;found=true;break}p+=len}if(!found)throw Error('IMAGE_JPEG');
    }
    if(data.type==='image/webp'){
     // Read dimensions without asking the decoder to allocate a publisher-sized bitmap.
     const tag=v.getUint32(12);let w=0,h=0;
     if(tag===0x56503858&&b.length>=30){w=1+b[24]+(b[25]<<8)+(b[26]<<16);h=1+b[27]+(b[28]<<8)+(b[29]<<16)}
     else if(tag===0x56503820&&b.length>=30&&b[23]===0x9d&&b[24]===1&&b[25]===0x2a){w=v.getUint16(26,true)&0x3fff;h=v.getUint16(28,true)&0x3fff}
     else if(tag===0x5650384c&&b.length>=25&&b[20]===0x2f){w=1+((b[22]&0x3f)<<8)+b[21];h=1+((b[24]&15)<<10)+(b[23]<<2)+(b[22]>>6)}
     if(!w||!h||w>16384||h>16384||w*h>L.imagePixels)throw Error('IMAGE_PIXELS');pixels=w*h;
    }
   }
 return {pixels,fontBytes:font?([0x774f4632,0x774f4646].includes(v.getUint32(0))?v.getUint32(16):b.length):0};
}
interface Asset {url:string;bytes:number;owners:Set<number>;pixels:number}
export class ResourceRegistry {
 private assets=new Map<string,Promise<Asset>>();
 private sectionAssets=new Map<number,Set<string>>();
 private disposed=false;
 private bytes=0;
 private pixels=0;
 private fonts=0;
 constructor(readonly manifest:Map<string,ResourceDescriptor>,readonly read:(id:string)=>Promise<ResourceData>,private release:(id:string)=>void,readonly reserve:(kind:'dom'|'faces'|'encoded',amount:number)=>Promise<boolean>=async()=>true){}
 constructSVG?: (model:XmlNode,base:string,index:number,chain:string[])=>Promise<Element>;
 async asset(name:string,index:number,chain:string[]=[]):Promise<string>{
  if(this.disposed)throw Error('DISPOSED');if(chain.includes(name)||chain.length>=16)throw Error('RESOURCE_CYCLE');
  const descriptor=this.manifest.get(name);if(!descriptor)throw Error('RESOURCE_NOT_APPROVED');
  let used=this.sectionAssets.get(index);if(!used){used=new Set();this.sectionAssets.set(index,used)}used.add(name);
  if(!this.assets.has(name))this.assets.set(name,this.create(name,index,chain).catch(async error=>{this.assets.delete(name);if(!this.disposed)await this.reserve('encoded',this.bytes);this.release(name);throw error}));
  const value=await this.assets.get(name)!;if(this.disposed)throw Error('DISPOSED');value.owners.add(index);return value.url;
 }
 private async create(name:string,index:number,chain:string[]):Promise<Asset>{
  const data=await this.read(name);if(this.disposed)throw Error('DISPOSED');let blob:Blob,pixels=0,font=false;
  if(data.type==='image/svg+xml'&&data.model&&this.constructSVG){pixels=inspectResource(data).pixels;const element=await this.constructSVG(data.model,name,index,chain.concat(name));blob=new Blob([new XMLSerializer().serializeToString(element)],{type:data.type})}
  else if(data.bytes){const b=data.bytes;font=/^(font\/|application\/(?:font-|x-font-|vnd.ms-opentype))/.test(data.type);
   const inspection=inspectResource(data);pixels=inspection.pixels;if(font&&this.fonts>=8)throw Error('FONT_FACE_LIMIT');
   blob=new Blob([b as Uint8Array<ArrayBuffer>],{type:data.type});
  }else throw Error('RESOURCE_TYPE_UNSUPPORTED');
  if(this.disposed)throw Error('DISPOSED');if(this.bytes+blob.size>L.encoded||this.pixels+pixels>2*L.imagePixels)throw Error('RESOURCE_MEMORY_LIMIT');
  if(!await this.reserve('encoded',this.bytes+blob.size))throw Error('RESOURCE_MEMORY_LIMIT');if(this.disposed)throw Error('DISPOSED');this.bytes+=blob.size;this.pixels+=pixels;if(font)this.fonts++;return {url:URL.createObjectURL(blob),bytes:blob.size,pixels,owners:new Set([index])};
 }
 async releaseSection(index:number){const names=this.sectionAssets.get(index);this.sectionAssets.delete(index);for(const name of names??[]){const promise=this.assets.get(name);if(!promise)continue;try{const a=await promise;a.owners.delete(index);if(!a.owners.size){URL.revokeObjectURL(a.url);this.bytes-=a.bytes;this.pixels-=a.pixels;if(/^(font\/|application\/)/.test(this.manifest.get(name)?.type??''))this.fonts--;this.assets.delete(name);await this.reserve('encoded',this.bytes);this.release(name)}}catch{/* Failed assets are already released. */}}}
 dispose(){if(this.disposed)return;this.disposed=true;for(const p of this.assets.values())void p.then(a=>URL.revokeObjectURL(a.url)).catch(()=>{});this.assets.clear();this.sectionAssets.clear();this.bytes=0;this.pixels=0}
 stats(){return {urls:this.assets.size,bytes:this.bytes,pixels:this.pixels,fonts:this.fonts}}
}
