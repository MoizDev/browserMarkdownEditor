import type { ArchiveSection, EpubTextLocator } from './types';
import type { CanonicalText } from './canonicalText';
import { canonicalRange } from './canonicalText';
import * as CFI from './vendor/epubcfi.js';
import { sha256 } from './sha256';
function context(text:string,offset:number){const graphemes=typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'grapheme'}):null;const take=(s:string,last=false)=>{s=last?s.slice(-1024):s.slice(0,1024);const values=graphemes?[...graphemes.segment(s)].map(x=>x.segment):Array.from(s);return (last?values.slice(-64):values.slice(0,64)).join('').slice(0,256)};return {quote:take(text.slice(offset)),before:take(text.slice(Math.max(0,offset-256),offset),true),after:take(text.slice(offset+take(text.slice(offset)).length))}}
export function textLocator(section:ArchiveSection,c:CanonicalText,digest:string,offset:number,affinity:'before'|'after'='after'):EpubTextLocator {
 const at=Math.max(0,Math.min(c.text.length,offset));let cfi:string|undefined;
 try{const value=CFI.fromRange(canonicalRange(c,undefined,at));if(value.length<=1024)cfi=value}catch{/* Empty sections have no CFI. Canonical offsets remain authoritative. */}
 return {kind:'text',spineIndex:section.index,spineOccurrence:section.occurrence,normalizedHref:section.href,chapterDigest:digest,offsetUTF16:at,affinity,...context(c.text,at),...(cfi?{cfi}:{})};
}
export function resolveTextLocator(locator:EpubTextLocator,c:CanonicalText,digest:string):{offset:number;approximate:boolean}{
 const valid=(at:number)=>at>=0&&at<=c.text.length&&c.text.slice(at,at+locator.quote.length)===locator.quote&&c.text.slice(Math.max(0,at-locator.before.length),at)===locator.before;
 if(locator.chapterDigest===digest&&valid(locator.offsetUTF16))return {offset:locator.offsetUTF16,approximate:false};
 if(locator.quote){let at=0,match=-1,count=0;while((at=c.text.indexOf(locator.quote,at))>=0){if(valid(at)){match=at;if(++count>1)break}at+=Math.max(1,locator.quote.length)}if(count===1)return {offset:match,approximate:false}}
 return {offset:0,approximate:true};
}
export async function chapterDigest(c:CanonicalText,structure:string):Promise<string>{
 const bytes=new TextEncoder().encode('parser:1;sanitizer:1;projection:1;'+structure+'\0'+c.text);
 return sha256(bytes);
}
