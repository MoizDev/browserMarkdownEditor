import type { EpubReadingRecord,PdfTextReadingRecord,ReaderIdentity } from '../types/reading';
import { readRecord,flushRecord } from './storage';
const timers=new Map<string,ReturnType<typeof setTimeout>>();
const dirty=new Set<string>();
const obj=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const nonnegative=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const integer=(x:unknown)=>nonnegative(x)&&Number.isInteger(x);
const hash=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const context=(x:Record<string,unknown>)=>['quote','before','after'].every(k=>typeof x[k]==='string'&&(x[k] as string).length<=512&&Array.from(segmenter.segment(x[k] as string)).length<=64);
const key=(vaultId:string,path:string)=>`${vaultId}\u0000${path}`;
function epub(value:unknown):value is EpubReadingRecord{
 if(!obj(value)||value.v!==1||value.kind!=='epub'||!hash(value.rawFingerprint)||value.parserSchema!==1||value.sanitizerSchema!==1||value.projectionSchema!==1||!['scroll','pages'].includes(value.requestedLayout as string)||!obj(value.locator))return false;
 const l=value.locator;if(JSON.stringify(l).length>4096||!integer(l.spineOccurrence)||!integer(l.spineIndex)||typeof l.normalizedHref!=='string'||l.normalizedHref.length>2048)return false;
 if(l.kind==='text')return hash(l.chapterDigest)&&integer(l.offsetUTF16)&&['before','after'].includes(l.affinity as string)&&context(l)&&(l.cfi===undefined||typeof l.cfi==='string')&&(l.alignHint===undefined||typeof l.alignHint==='number'&&Number.isFinite(l.alignHint)&&Math.abs(l.alignHint)<=10000);
 return l.kind==='fixed'&&hash(l.sectionDigest)&&obj(l.viewport)&&nonnegative(l.viewport.x)&&nonnegative(l.viewport.y)&&nonnegative(l.viewport.zoom)&&Number(l.viewport.zoom)>0&&Number(l.viewport.zoom)<=10;
}
function pdf(value:unknown):value is PdfTextReadingRecord{
 if(!obj(value)||value.v!==1||!['original','text'].includes(value.surface as string)||(value.textChoice!==undefined&&value.textChoice!=='manual')||!hash(value.rawFingerprint)||value.extractionSchema!==1||!obj(value.originalCheckpoint)||!integer(value.textNavigationRevision))return false;
 const c=value.originalCheckpoint;if(!integer(c.page)||!nonnegative(c.offset)||Number(c.offset)>1||!nonnegative(c.zoom)||Number(c.zoom)<=0||!integer(c.navigationRevision))return false;
 if(value.pageDigest!==undefined&&!hash(value.pageDigest))return false;
 const a=value.textAnchor;return a===undefined||(obj(a)&&integer(a.physicalPageIndex)&&integer(a.offsetUTF16)&&['before','after'].includes(a.affinity as string)&&context(a));
}
export function readReaderViewState(vaultId:string,path:string):EpubReadingRecord|undefined {const v=readRecord<unknown>('readerViewState')[key(vaultId,path)];return epub(v)?structuredClone(v):undefined}
export function readPdfTextViewState(vaultId:string,path:string):PdfTextReadingRecord|undefined {
 const v=readRecord<unknown>('pdfTextViewState')[key(vaultId,path)];if(!pdf(v))return undefined;
 const record=structuredClone(v);
 // The old emphasis button opened Text automatically. Only records written by
 // the independent manual action may restore it; keep every saved anchor/camera.
 if(record.surface==='text'&&record.textChoice!=='manual')record.surface='original';
 return record;
}
let failed=false;
export const readerPersistenceUnavailable=()=>failed;
function flush(name:string){const timer=timers.get(name);if(timer)clearTimeout(timer);timers.delete(name);if(!dirty.has(name))return;const previous=failed;failed=!flushRecord(name);if(!failed)dirty.delete(name);else if(!previous&&typeof window!=='undefined')window.dispatchEvent(new Event('reading-persistence-unavailable'))}
function write(name:string,identity:ReaderIdentity,value:unknown,now:boolean){dirty.add(name);readRecord<unknown>(name)[key(identity.vaultId,identity.path)]=structuredClone(value);const timer=timers.get(name);if(timer)clearTimeout(timer);if(now)flush(name);else timers.set(name,setTimeout(()=>flush(name),350))}
export function writeReaderViewState(identity:ReaderIdentity,record:EpubReadingRecord,now=false){if(epub(record))write('readerViewState',identity,record,now)}
export function writePdfTextViewState(identity:ReaderIdentity,record:PdfTextReadingRecord,now=false){if(pdf(record))write('pdfTextViewState',identity,{...record,textChoice:record.surface==='text'?'manual':undefined},now)}
export function flushReaderViewState(){flush('readerViewState')}
export function flushPdfTextViewState(){flush('pdfTextViewState')}
export function moveReaderViewState(identity:ReaderIdentity,from:string,to:string){for(const name of ['readerViewState','pdfTextViewState']){const r=readRecord<unknown>(name),old=key(identity.vaultId,from),next=key(identity.vaultId,to);if(!r[next]&&!r[old])continue;dirty.add(name);delete r[next];if(r[old]){r[next]=r[old];delete r[old]}flush(name)}}
if(typeof window!=='undefined')window.addEventListener('pagehide',()=>{flushReaderViewState();flushPdfTextViewState()});
