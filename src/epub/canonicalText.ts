import type { Utf16Range } from '../utils/readingEmphasis';
export const EPUB_TEXT_SCHEMA='epub-text-v1';
const blocks=new Set('p div section article h1 h2 h3 h4 h5 h6 li tr blockquote pre figure figcaption dt dd'.split(' '));
export interface TextInterval {node:Text;from:number;to:number;synthetic:boolean;eligible:boolean;visible?:boolean}
export interface CanonicalText {text:string;intervals:TextInterval[];byNode:WeakMap<Node,TextInterval>;elements:WeakMap<Node,{from:number;to:number}>;exclusions:Utf16Range[];tokenBreaks:number[]}
export interface RenderMap {root:Element;fragments:WeakMap<Node,{node:Text;from:number;to:number}[]>;offsets:WeakMap<Node,{from:number;to:number}>;elements:WeakMap<Node,{from:number;to:number}>}
export function projectCanonical(root:Element):CanonicalText {
 const result:CanonicalText={text:'',intervals:[],byNode:new WeakMap(),elements:new WeakMap(),exclusions:[],tokenBreaks:[]};
 const add=(node:Text,synthetic:boolean,eligible:boolean)=>{const interval={node,from:result.text.length,to:result.text.length+node.length,synthetic,eligible};result.text+=node.data;result.intervals.push(interval);result.byNode.set(node,interval);if(!eligible)result.exclusions.push({from:interval.from,to:interval.to});if(synthetic)result.tokenBreaks.push(interval.from,interval.to)};
 function walk(node:Node,excluded=false){
  if(node.nodeType===3){add(node as Text,false,!excluded);return}
  if(!(node instanceof Element))return;
  const from=result.text.length,tag=node.localName;
  const skip=excluded||node.hasAttribute('hidden')||node.getAttribute('aria-hidden')==='true'||['code','pre','kbd','samp','var','svg','math','ruby','rt','rp','b','strong'].includes(tag)||node.namespaceURI!=='http://www.w3.org/1999/xhtml'||node.getAttribute('dir')==='rtl'||/font-weight\s*:\s*(?:bold|[6-9]00)/i.test(node.getAttribute('style')??'')||/writing-mode\s*:\s*vertical/i.test(node.getAttribute('style')??'');
  for(const child of [...node.childNodes])walk(child,skip);
  if(tag==='br'||blocks.has(tag)&&result.text&&!result.text.endsWith('\n')){
   // Real app-owned LF nodes make synthetic boundaries addressable in both directions,
   // including native cross-section selections. No duplicated hidden text layer.
   const lf=node.ownerDocument.createTextNode('\n');node.append(lf);add(lf,true,false);
  }
  result.elements.set(node,{from,to:result.text.length});
 }
 walk(root);return result;
}
export function renderCanonical(root:Element,canonical:CanonicalText):RenderMap {
 const map:RenderMap={root:null as unknown as Element,fragments:new WeakMap(),offsets:new WeakMap(),elements:new WeakMap()};
 // One text node per source interval for the lifetime of this mounted section.
 // Native highlight ranges never enter this map or alter its UTF-16 coordinates.
 function clone(node:Node):Node {
  if(node.nodeType===3){const text=node as Text,t=document.createTextNode(text.data),interval=canonical.byNode.get(node);
   if(interval){map.fragments.set(node,[{node:t,from:0,to:text.length}]);map.offsets.set(t,{from:interval.from,to:interval.to})}return t;
  }
  const el=node.cloneNode(false),bounds=canonical.elements.get(node);if(bounds)map.elements.set(el,bounds);for(const child of node.childNodes)el.appendChild(clone(child));return el;
 }
 map.root=clone(root) as Element;return map;
}
export function canonicalEndpoint(c:CanonicalText,map:RenderMap|undefined,offset:number,affinity:'before'|'after'='after'):{node:Node;offset:number}{
 const at=Math.max(0,Math.min(c.text.length,offset));
 const interval=c.intervals.find(i=>i.from<=at&&(at<i.to||affinity==='before'&&at===i.to))??c.intervals.at(-1);
 if(!interval)throw Error('EMPTY_TEXT_ENDPOINT');const delta=Math.max(0,Math.min(interval.node.length,at-interval.from));if(!map)return {node:interval.node,offset:delta};
 const parts=map.fragments.get(interval.node);const f=parts?.find(p=>delta>=p.from&&(delta<p.to||affinity==='before'&&delta===p.to))??parts?.at(-1);if(!f)throw Error('UNMAPPED_TEXT_ENDPOINT');return {node:f.node,offset:Math.min(f.to-f.from,Math.max(0,delta-f.from))};
}
export function canonicalOffset(c:CanonicalText,map:RenderMap,node:Node,offset:number,affinity:'before'|'after'='after'):number {
 const direct=map.offsets.get(node);if(direct)return Math.max(direct.from,Math.min(direct.to,direct.from+offset));
 const bounds=map.elements.get(node);
 const children=[...node.childNodes],right=children.slice(offset),left=children.slice(0,offset).reverse();
 function edge(n:Node,end:boolean):number|undefined {const t=map.offsets.get(n);if(t)return end?t.to:t.from;const e=map.elements.get(n);if(e)return end?e.to:e.from;const nodes=[...n.childNodes];if(end)nodes.reverse();for(const child of nodes){const at=edge(child,end);if(at!==undefined)return at}return undefined}
 for(const child of affinity==='after'?right:left){const at=edge(child,affinity==='before');if(at!==undefined)return at}
 for(const child of affinity==='after'?left:right){const at=edge(child,affinity==='after');if(at!==undefined)return at}
 return affinity==='before'?bounds?.to??c.text.length:bounds?.from??0;
}
export function canonicalRange(c:CanonicalText,map:RenderMap|undefined,from:number,to=from):Range{
 const a=canonicalEndpoint(c,map,from),b=canonicalEndpoint(c,map,to,'before'),range=document.createRange();range.setStart(a.node,a.offset);range.setEnd(b.node,b.offset);return range;
}
