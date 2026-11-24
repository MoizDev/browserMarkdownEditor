import type { EpubLocator, ReaderToken, ReaderPreferences } from './types';
import { EPUB_LIMITS as L } from './types';
export const PROTOCOL=1;
export interface Envelope { v:1; session:string; token:ReaderToken; id:number; op:string; payload:unknown }
const HOST_OPS=new Set(['open','open-chunk','configure','navigate','capture','selection','turn','return','find','cancel-find','resource-chunk','resource-error','budget-result','dispose','focus']);
const CHILD_OPS=new Set(['ready','reply','resource','resource-release','resource-ack','resource-cancel','budget','status','capabilities','location','selection','visible-text','contextmenu','external-link','focus','command','metadata']);
export function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
export function boundedString(value:unknown,max:number):value is string{return typeof value==='string'&&value.length<=max}
export function finite(value:unknown,min:number,max:number):value is number{return typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max}
export function validToken(a:unknown):a is ReaderToken{return object(a)&&boundedString(a.vaultId,256)&&boundedString(a.documentId,256)&&Number.isSafeInteger(a.vaultEpoch)&&finite(a.vaultEpoch,0,Number.MAX_SAFE_INTEGER)&&Number.isSafeInteger(a.byteGeneration)&&finite(a.byteGeneration,0,Number.MAX_SAFE_INTEGER)}
export function sameToken(a:unknown,b:ReaderToken):boolean{return validToken(a)&&validToken(b)&&a.vaultId===b.vaultId&&a.vaultEpoch===b.vaultEpoch&&a.documentId===b.documentId&&a.byteGeneration===b.byteGeneration&&Object.keys(a).length===4}
export function validLocator(v:unknown):v is EpubLocator {
 if(!object(v)||JSON.stringify(v).length>4096||Object.keys(v).some(k=>!['kind','spineOccurrence','spineIndex','normalizedHref','chapterDigest','offsetUTF16','affinity','quote','before','after','cfi','alignHint','sectionDigest','elementId','viewport','printLabel'].includes(k))||!Number.isInteger(v.spineIndex)||!finite(v.spineIndex,0,19999)||!Number.isInteger(v.spineOccurrence)||!finite(v.spineOccurrence,0,19999)||!boundedString(v.normalizedHref,2048))return false;
 if(v.kind==='text')return boundedString(v.chapterDigest,128)&&Number.isInteger(v.offsetUTF16)&&finite(v.offsetUTF16,0,L.text)&&['before','after'].includes(String(v.affinity))&&boundedString(v.quote,256)&&boundedString(v.before,256)&&boundedString(v.after,256)&&(v.cfi===undefined||boundedString(v.cfi,1024))&&(v.alignHint===undefined||finite(v.alignHint,-10000,10000));
 return v.kind==='fixed'&&boundedString(v.sectionDigest,128)&&(v.elementId===undefined||boundedString(v.elementId,512))&&object(v.viewport)&&finite(v.viewport.x,0,100000)&&finite(v.viewport.y,0,100000)&&finite(v.viewport.zoom,0.1,8);
}
export function validPreferences(v:unknown):v is ReaderPreferences {
 if(!object(v)||!object(v.typography)||!object(v.emphasis)||typeof v.emphasis.enabled!=='boolean')return false;
 const t=v.typography;
 return ['serif','sans','publisher'].includes(String(t.family))&&finite(t.size,12,40)&&finite(t.leading,1.2,2.2)&&['compact','comfortable','wide'].includes(String(t.measure))&&['small','medium','large'].includes(String(t.margins))&&['follow-app','light','sepia','dark'].includes(String(t.theme))&&(v.flow===undefined||v.flow==='scroll'||v.flow==='pages')&&(v.appTheme===undefined||v.appTheme==='light'||v.appTheme==='dark')&&(v.fixed===undefined||object(v.fixed)&&['page','width','actual'].includes(String(v.fixed.fit))&&finite(v.fixed.zoom,0.1,8)&&typeof v.fixed.spreads==='boolean');
}
export function validSelection(v:unknown):boolean{return v===null||object(v)&&boundedString(v.text,128*1024)&&validLocator(v.anchor)&&v.anchor.kind==='text'&&validLocator(v.focus)&&v.focus.kind==='text'}
export function validateEnvelope(value:unknown,session:string,token:ReaderToken,direction:'host'|'child'):value is Envelope {
 if(!object(value)||Object.keys(value).some(k=>!['v','session','token','id','op','payload'].includes(k))||value.v!==PROTOCOL||value.session!==session||!sameToken(value.token,token)||!Number.isSafeInteger(value.id)||!finite(value.id,0,Number.MAX_SAFE_INTEGER)||!boundedString(value.op,32)||!(direction==='host'?HOST_OPS:CHILD_OPS).has(value.op))return false;
 const p=value.payload;
 if(value.op==='resource-chunk'||value.op==='open-chunk')return object(p)&&Number.isSafeInteger(p.request)&&Number.isSafeInteger(p.index)&&Number.isSafeInteger(p.total)&&finite(p.total,1,512)&&finite(p.index,0,Number(p.total)-1)&&p.bytes instanceof Uint8Array&&p.bytes.byteLength<=192*1024;
 try{if(JSON.stringify(value).length>L.payload)return false}catch{return false}
 switch(value.op){
  case 'configure':return validPreferences(p);
  case 'navigate':return object(p)&&(validLocator(p.locator)||object(p.locator)&&Number.isInteger(p.locator.sectionIndex)&&finite(p.locator.sectionIndex,0,19999)&&(p.locator.fragment===undefined||boundedString(p.locator.fragment,512)))&&['restore','layout','user-navigation','search','link'].includes(String(p.cause));
  case 'find':return object(p)&&boundedString(p.query,256)&&boundedString(p.queryId,80)&&Number.isInteger(p.index)&&finite(p.index,0,19999);
  case 'cancel-find':return boundedString(p,80);
  case 'resource-cancel':return object(p)&&Number.isSafeInteger(p.request);
  case 'budget':return object(p)&&['dom','faces','encoded'].includes(String(p.kind))&&Number.isInteger(p.amount)&&finite(p.amount,0,p.kind==='dom'?150000:p.kind==='faces'?8:128*1024*1024);
  case 'budget-result':return object(p)&&Number.isSafeInteger(p.request)&&typeof p.accepted==='boolean';
  case 'resource-ack':return object(p)&&Number.isSafeInteger(p.request)&&Number.isInteger(p.index)&&finite(p.index,0,511);
  case 'resource-release':
  case 'resource':return object(p)&&boundedString(p.id,2048);
  case 'resource-error':return object(p)&&Number.isSafeInteger(p.request)&&boundedString(p.message,500);
  case 'turn':return p===1||p===-1;
  case 'visible-text':return boundedString(p,16384);
  case 'location':return object(p)&&validLocator(p.locator)&&['restore','layout','user-scroll','user-navigation','search','link'].includes(String(p.cause));
  case 'selection':return validSelection(p);
  case 'contextmenu':return object(p)&&finite(p.x,0,100000)&&finite(p.y,0,100000)&&validSelection(p.selection);
  case 'external-link':return boundedString(p,4096);
  case 'command':return ['next-document','previous-document','close-document','reopen-document','find','dismiss','read-only-mode'].includes(String(p));
  case 'status':return object(p)&&['loading','ready','partial','error'].includes(String(p.phase))&&(p.message===undefined||boundedString(p.message,1000));
  case 'capabilities':return object(p)&&['epub-reflow','epub-fixed'].includes(String(p.surface))&&object(p.emphasis)&&((p.emphasis.kind==='toggle')||(p.emphasis.kind==='inactive'&&boundedString(p.emphasis.reason,500)))&&['available','partial','none'].includes(String(p.text))&&typeof p.find==='boolean'&&['reflow','fixed'].includes(String(p.appearance))&&typeof p.copy==='boolean';
  case 'reply':return object(p)&&typeof p.ok==='boolean'&&(p.error===undefined||boundedString(p.error,1000));
  case 'open':return object(p)&&object(p.info)&&Array.isArray(p.info.resources)&&p.info.resources.length<=L.entries&&Array.isArray(p.info.spine)&&p.info.spine.length<=L.entries;
  case 'metadata':return object(p)&&boundedString(p.title,500)&&boundedString(p.author,1000)&&boundedString(p.language,100)&&Array.isArray(p.contents)&&Array.isArray(p.sections);
  default:return p===null;
 }
}
export class MessageRate {private start=performance.now();private count=0;accept(){const now=performance.now();if(now-this.start>1000){this.start=now;this.count=0}return ++this.count<=120}}
