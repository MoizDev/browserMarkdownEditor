import { BoundedArchive, archivePath, resolveArchiveReference } from './archivePreflight';
import { decodeXml, parseXml, xmlAll, xmlText } from './tokenModel';
import { EPUB_LIMITS as L } from './types';
import type { ArchiveInfo, ResourceData, ResourceDescriptor } from './types';
let archive:BoundedArchive|undefined;
let approved=new Map<string,ResourceDescriptor>();
const obfuscations=new Map<string,{key:Uint8Array;length:number}>();
const lifetime=new AbortController();
let packagePath='';
async function preflight(blob:Blob){archive=new BoundedArchive(blob,lifetime.signal);await archive.init();let bootstrapBytes=0;for(const name of ['mimetype','META-INF/container.xml']){const entry=archive.entries.get(name);if(!entry)throw Error('EPUB_CONTAINER');if(entry.unpacked>L.text)throw Error('ENTRY_DECLARED_LIMIT');bootstrapBytes+=entry.unpacked}return {bootstrapBytes}}
async function bootstrap(){const text=async(name:string)=>decodeXml(await archive!.extract(name));if(await text('mimetype')!=='application/epub+zip')throw Error('EPUB_MIMETYPE');const container=parseXml(await text('META-INF/container.xml')),opfPath=xmlAll(container,'rootfile').find(n=>n.attrs['media-type']==='application/oebps-package+xml')?.attrs['full-path'];if(!opfPath||!archive!.entries.has(archivePath(opfPath)))throw Error('EPUB_CONTAINER');packagePath=opfPath;let packageBytes=0;for(const name of [opfPath,'META-INF/encryption.xml']){const entry=archive!.entries.get(name);if(entry){if(entry.unpacked>L.text)throw Error('ENTRY_DECLARED_LIMIT');packageBytes+=entry.unpacked}}return {packageBytes}}
async function init():Promise<ArchiveInfo>{
 if(!archive||!packagePath)throw Error('EPUB_CONTAINER');const opfPath=packagePath,text=async(name:string)=>decodeXml(await archive!.extract(name));
 const opf=parseXml(await text(opfPath));if(opf.name!=='package')throw Error('EPUB_PACKAGE');
 const manifest=xmlAll(opf,'item'),byId=new Map<string,typeof manifest[number]>(),warnings:string[]=[];
 approved=new Map();
 for(const id of ['META-INF/container.xml',opfPath,'META-INF/com.apple.ibooks.display-options.xml','META-INF/com.kobobooks.display-options.xml'])if(archive.entries.has(id))approved.set(id,{id,type:'application/xml',properties:'',size:archive.entries.get(id)!.unpacked});
 let fonts=0;
 for(const item of manifest){const a=item.attrs,id=resolveArchiveReference(a.href,opfPath)?.name;if(!a.id||byId.has(a.id))throw Error('EPUB_MANIFEST_DUPLICATE');byId.set(a.id,item);
  if(!id||!archive.entries.has(id)){warnings.push('Unavailable resource: '+String(a.id).slice(0,100));continue}
  const type=a['media-type'];if(!type||type.length>100)throw Error('EPUB_MEDIA_TYPE');
  if(isFont(type)&&++fonts>32)throw Error('EPUB_FONT_COUNT');
  if(approved.has(id)&&approved.get(id)!.type!==type)throw Error('EPUB_MANIFEST_TYPE_CONFLICT');
  approved.set(id,{id,type,properties:a.properties||'',size:archive.entries.get(id)!.unpacked});
 }
 if(archive.entries.has('META-INF/encryption.xml')){
  const enc=parseXml(await text('META-INF/encryption.xml')),identifier=xmlText(xmlAll(opf,'identifier').find(n=>n.attrs.id===opf.attrs['unique-identifier'])??'');
  for(const x of xmlAll(enc,'EncryptedData')){
   const algorithm=xmlAll(x,'EncryptionMethod')[0]?.attrs.Algorithm,name=xmlAll(x,'CipherReference')[0]?.attrs.URI;
   if(!['http://www.idpf.org/2008/embedding','http://ns.adobe.com/pdf/enc#RC'].includes(algorithm))throw Error('EPUB_DRM_UNSUPPORTED: This book is encrypted with unsupported DRM.');
   if(!approved.has(name)||!isFont(approved.get(name)!.type))throw Error('EPUB_ENCRYPTED_NONFONT');
   const hex=identifier.replace(/^urn:uuid:/,'').replace(/-/g,'');let key:Uint8Array;
   if(algorithm.includes('idpf.org'))key=new Uint8Array(await crypto.subtle.digest('SHA-1',new TextEncoder().encode(identifier.replace(/[\t\n\r ]/g,''))));
   else {if(!/^[a-f\d]{32}$/i.test(hex))throw Error('EPUB_OBFUSCATION_ID');key=Uint8Array.from(hex.match(/../g)!,s=>parseInt(s,16))}
   obfuscations.set(name,{key,length:algorithm.includes('idpf.org')?1040:1024});
  }
 }
 const seen=new Map<string,number>();
 const spine=xmlAll(opf,'itemref').map((n,index)=>{
  let item=byId.get(n.attrs.idref);if(!item)throw Error('EPUB_SPINE_REFERENCE');const visited=new Set<string>();
  while(!['application/xhtml+xml','image/svg+xml','image/png','image/jpeg','image/webp','image/gif','image/avif'].includes(item.attrs['media-type'])&&item.attrs.fallback){if(visited.has(item.attrs.id))throw Error('EPUB_FALLBACK_CYCLE');visited.add(item.attrs.id);item=byId.get(item.attrs.fallback);if(!item)throw Error('EPUB_FALLBACK_MISSING')}
  const href=resolveArchiveReference(item.attrs.href,opfPath)?.name;if(!href||!approved.has(href))throw Error('EPUB_SPINE_MISSING');
  const occurrence=seen.get(href)??0;seen.set(href,occurrence+1);
  if(item.attrs.properties?.split(/\s+/).includes('scripted'))warnings.push('Scripts disabled in section '+(index+1));
  return {index,href,mediaType:item.attrs['media-type'],properties:n.attrs.properties||'',linear:n.attrs.linear!=='no',occurrence};
 });
 if(!spine.length)throw Error('EPUB_EMPTY_SPINE');
 return {opfPath,resources:[...approved.values()],spine,warnings:warnings.slice(0,100)};
}
export function isFont(type:string){return /^(font\/|application\/(?:font-|x-font-|vnd.ms-opentype))/.test(type)}
async function read(name:string,signal:AbortSignal):Promise<ResourceData>{
 const a=approved.get(name);if(!archive||!a)throw Error('RESOURCE_NOT_APPROVED');
 const binary=/^(image\/(?!svg)|font\/|application\/(?:font-|x-font-|vnd.ms-opentype))/.test(a.type);
 const bytes=await archive.extract(name,binary?(isFont(a.type)?L.font:L.binary):L.text,signal);
 const ob=obfuscations.get(name);if(ob)for(let i=0;i<Math.min(ob.length,bytes.length);i++)bytes[i]^=ob.key[i%ob.key.length];
 if(binary)return {type:a.type,bytes};
 const text=decodeXml(bytes);return /xml|svg/.test(a.type)?{type:a.type,model:parseXml(text)}:{type:a.type,text};
}
let queue=Promise.resolve();const operations=new Map<number,AbortController>();
self.onmessage=({data:m})=>{
 if(!m||!Number.isSafeInteger(m.id))return;if(m.op==='cancel'){operations.get(m.id)?.abort();return}if(!['preflight','bootstrap','init','read','stats'].includes(m.op))return;const operation=new AbortController();operations.set(m.id,operation);
 queue=queue.then(async()=>{try {operation.signal.throwIfAborted();const result=m.op==='preflight'&&m.blob instanceof Blob?await preflight(m.blob):m.op==='bootstrap'?await bootstrap():m.op==='init'?await init():m.op==='read'&&typeof m.name==='string'?await read(m.name,operation.signal):m.op==='stats'?archive?.stats:undefined;
  if(!result)throw Error('WORKER_PROTOCOL');const transfers=result&&'bytes'in result&&result.bytes?[result.bytes.buffer]:[];self.postMessage({id:m.id,result}, {transfer:transfers as ArrayBuffer[]});
 }catch(error){self.postMessage({id:m.id,error:error instanceof Error?error.message:'EPUB_ARCHIVE_ERROR'})}finally{operations.delete(m.id)}});
};
