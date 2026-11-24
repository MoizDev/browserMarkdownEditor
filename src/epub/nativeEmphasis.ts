import { emphasisRanges } from '../utils/readingEmphasis';
import type { CanonicalText, RenderMap } from './canonicalText';
import { canonicalRange } from './canonicalText';

/** Paint the original glyphs, rather than changing their advance widths. In
 * particular, fixed XHTML pages and ligatures must retain publisher geometry.
 * No duplicate text, replacement font, DOM wrapper or accessibility node exists. */
export class NativeEmphasis {
 private readonly name='reader-ink-'+crypto.randomUUID();
 private readonly style=document.createElement('style');
 private readonly base;
 reason:string|undefined;
 constructor(private readonly canonical:CanonicalText,private readonly map:RenderMap,private readonly locale:string){
  this.base=canonical.exclusions.slice();
  // Custom highlights cannot select a heavier font face. Symmetric glyph ink uses
  // the loaded publisher face (including italic/variable fonts) without reshaping.
  this.style.textContent=`::highlight(${this.name}){text-shadow:.025em 0 currentColor,-.025em 0 currentColor,0 .012em currentColor}`;
 }
 update(enabled:boolean){
  this.clear();const c=this.canonical;
  const exclusions=this.base.slice();
  for(const interval of c.intervals){
   const parent=this.map.fragments.get(interval.node)?.[0]?.node.parentElement;
   if(!parent)continue;const style=getComputedStyle(parent);
   interval.visible=parent.checkVisibility({checkVisibilityCSS:true,checkOpacity:true});
   // Canonical hidden/ARIA-hidden intervals stay addressable for saved locators;
   // computed hidden content stays out of copied prose as well as emphasis.
   if(interval.eligible&&(!interval.visible||Number(style.fontWeight)>=600||style.writingMode.startsWith('vertical')||style.color==='rgba(0, 0, 0, 0)'||style.textShadow!=='none'))exclusions.push({from:interval.from,to:interval.to});
  }
  if(!('highlights' in CSS)||typeof Highlight==='undefined'){this.reason='This browser cannot paint word emphasis in the original document.';return}
  if(c.text.length>1024*1024){this.reason='Word emphasis is unavailable for sections larger than 1 MiB of text.';return}
  const marks=emphasisRanges({text:c.text,locale:this.locale,exclusions,tokenBreaks:c.tokenBreaks});
  if(marks.length>20000){this.reason='Word emphasis is unavailable for sections requiring more than 20,000 prefix ranges.';return}
  this.reason=marks.length?undefined:c.text.trim()?'This section has no eligible Latin text to emphasize. Images, SVG, authored bold, shadowed, vertical and non-Latin text retain their original appearance.':'This page has no text to emphasize.';
  if(!enabled||!marks.length)return;
  const highlight=new Highlight();for(const mark of marks)highlight.add(canonicalRange(c,this.map,mark.from,mark.to));
  document.head.append(this.style);CSS.highlights.set(this.name,highlight);
 }
 private clear(){if('highlights' in CSS)CSS.highlights.delete(this.name);this.style.remove()}
 dispose(){this.clear()}
}
