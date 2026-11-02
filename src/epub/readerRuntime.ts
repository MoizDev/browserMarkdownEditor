import { EPUB } from './vendor/epub.js';
import { BookPolicy } from './policy';
import { ResourceRegistry, resolveBookReference, safeExternalLink } from './resources';
import { projectCanonical, renderCanonical, canonicalOffset, canonicalRange, canonicalEndpoint } from './canonicalText';
import type { CanonicalText, RenderMap } from './canonicalText';
import { chapterDigest, textLocator, resolveTextLocator } from './locator';
import { MessageRate, object, sameToken, validateEnvelope } from './bridgeProtocol';
import { DEFAULT_PREFERENCES, EPUB_LIMITS as L } from './types';
import type { ArchiveInfo, ArchiveSection, CanonicalSelection, EpubLocator, EpubMetadata, FindHit, LocationCause, ReaderPreferences, ReaderToken, ResourceData, XmlNode } from './types';
const surface=document.getElementById('surface') as HTMLElement;
const notice=document.getElementById('notice') as HTMLElement;
let port:MessagePort,session:string,token:ReaderToken,disposed=false,sequence=0,info:ArchiveInfo,registry:ResourceRegistry,policy:BookPolicy,metadata:EpubMetadata,book:EPUB;
let currentElementId:string|undefined;
let prefs:ReaderPreferences=DEFAULT_PREFERENCES,currentIndex=0,inputRevision=0,layoutBusy=false,requestedFlow='scroll',activeFixed=false;
let layoutQueue:Promise<unknown>=Promise.resolve(),layoutPending=0;
function runLayout<T>(job:()=>Promise<T>):Promise<T>{if(layoutPending>=64)return Promise.reject(Error('Reader busy; wait for the current navigation.'));layoutPending++;const next=layoutQueue.then(()=>{if(disposed)throw new DOMException('Reader closed','AbortError');return job()}).finally(()=>{layoutPending--});layoutQueue=next.catch(()=>{});return next}
const budgetReplies=new Map<number,{resolve(value:boolean):void;reject(error:unknown):void;timer:ReturnType<typeof setTimeout>}>();
function reserveBudget(kind:'dom'|'faces'|'encoded',amount:number):Promise<boolean>{return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{budgetReplies.delete(id);reject(Error('RESOURCE_BUDGET_TIMEOUT'))},10000);budgetReplies.set(id,{resolve,reject,timer});send('budget',{kind,amount},id)})}
function nodeCount(root:Node):number{const walker=document.createTreeWalker(root,NodeFilter.SHOW_ALL);let n=1;while(walker.nextNode())n++;return n}
let activeFindQuery:string|undefined;
const pending=new Map<number,{resolve(value:ResourceData):void;reject(error:unknown):void;queryId?:string;chunks:Uint8Array[];total:number;length:number;timer:ReturnType<typeof setTimeout>}>();
const states=new Map<number,SectionState>(),jumpTrail:EpubLocator[]=[],findCancelled=new Set<string>();
interface SectionState { item:ArchiveSection; canonical:CanonicalText; doc:Document; digest:string; root:HTMLElement; style:HTMLStyleElement; map:RenderMap; fixed:boolean; viewport:{w:number;h:number} }
// Measured: rapid source-window rotations exceeded 120 control messages/s once
// resource acknowledgements were added. Pace the producer, keeping the strict receiver
// limit and at most one unacknowledged chunk per resource.
const outgoing:{op:string;payload:unknown;id:number;transfer:Transferable[]}[]=[];
let sendTimer:ReturnType<typeof setTimeout>|undefined,lastSent=-Infinity;
function drainMessages(){sendTimer=undefined;if(disposed)return;const delay=10-(performance.now()-lastSent);if(delay>0){sendTimer=setTimeout(drainMessages,delay);return}const m=outgoing.shift();if(!m)return;lastSent=performance.now();port.postMessage({v:1,session,token,id:m.id,op:m.op,payload:m.payload},m.transfer);if(outgoing.length)sendTimer=setTimeout(drainMessages,10)}
function send(op:string,payload:unknown=null,id=0,transfer:Transferable[]=[]){if(disposed)return;if(outgoing.length>=256){dispose();return}outgoing.push({op,payload,id,transfer});if(sendTimer===undefined)drainMessages()}
function status(message:string){message=message.slice(0,1000);notice.textContent=message;send('status',{phase:'partial',message})}
function read(id:string):Promise<ResourceData>{
 if(disposed||activeFindQuery&&findCancelled.has(activeFindQuery)||!registry.manifest.has(id))return Promise.reject(Error('RESOURCE_NOT_APPROVED'));
 if(pending.size>=8)return Promise.reject(Error('RESOURCE_REQUEST_LIMIT'));
 return new Promise((resolve,reject)=>{const key=++sequence,timer=setTimeout(()=>{pending.delete(key);reject(Error('RESOURCE_TIMEOUT'))},120000);pending.set(key,{resolve,reject,queryId:activeFindQuery,chunks:[],total:0,length:0,timer});send('resource',{id},key)});
}
function acceptResource(payload:unknown){
 if(!object(payload))throw Error('RESOURCE_PROTOCOL');const p=pending.get(Number(payload.request));if(!p)return;
 if(payload.message){pending.delete(Number(payload.request));clearTimeout(p.timer);p.reject(Error(String(payload.message)));return}
 const bytes=payload.bytes as Uint8Array;
 if(Number(payload.index)!==p.chunks.length||p.total&&p.total!==Number(payload.total)||p.length+bytes.length>48*1024*1024)throw Error('RESOURCE_CHUNK_ORDER');
 p.total=Number(payload.total);p.length+=bytes.length;p.chunks.push(bytes);send('resource-ack',{request:payload.request,index:payload.index});
 if(p.chunks.length===p.total){pending.delete(Number(payload.request));clearTimeout(p.timer);const joined=new Uint8Array(p.length);let at=0;for(const chunk of p.chunks){joined.set(chunk,at);at+=chunk.length}try{if(joined.length<4)throw Error('RESOURCE_HEADER');const headerLength=new DataView(joined.buffer).getUint32(0);if(headerLength>joined.length-4)throw Error('RESOURCE_HEADER');const value=JSON.parse(new TextDecoder().decode(joined.subarray(4,4+headerLength))) as ResourceData;if(joined.length>4+headerLength)value.bytes=joined.subarray(4+headerLength);p.resolve(value)}catch(error){p.reject(error)}}
}
const escapeXML=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const metadataLinks=new Map<string,string>();let metadataLinkSequence=0;
function serialize(n:XmlNode|string,base:string):string{
 if(typeof n==='string')return escapeXML(n);
 if(['script','style','iframe','object','embed','form','base','template','link'].includes(n.name))return '';
 const attrs=Object.entries(n.attrs).filter(([name])=>name!=='xmlns'&&!/^on/i.test(name)&&!['style','src','srcset','poster','data','background','ping','action','xlink:href','href'].includes(name));
 const linkName=n.name==='a'?'href':n.name==='content'&&n.ns==='http://www.daisy.org/z3986/2005/ncx/'?'src':undefined;
 if(linkName&&n.attrs[linkName]){const raw=n.attrs[linkName],ref=resolveBookReference(raw,base),id='reader-nav-'+(++metadataLinkSequence);metadataLinks.set(base+'#'+id,ref?ref.name+(ref.fragment?'#'+ref.fragment:''):raw);attrs.push([linkName,'#'+id])}
 else if(n.ns==='http://www.idpf.org/2007/opf'&&n.attrs.href)attrs.push(['href',n.attrs.href]);
 return '<'+n.name+' xmlns="'+escapeXML(n.ns)+'"'+attrs.map(([k,v])=>' '+k+'="'+escapeXML(v)+'"').join('')+'>'+n.children.map(child=>serialize(child,base)).join('')+'</'+n.name+'>';
}
function label(value:unknown,max=500):string{if(typeof value==='string')return value.slice(0,max);if(Array.isArray(value))return value.map(x=>label(x,max)).join(', ').slice(0,max);if(object(value))return label(value.name??value.value??Object.values(value)[0],max);return ''}
function toc(items:unknown,depth=0,counter={n:0}):EpubMetadata['contents']{
 if(!Array.isArray(items))return [];if(depth>16){info.warnings.push('Contents nesting beyond 16 levels is unavailable.');return []}if(items.length>1000)info.warnings.push('This contents level exceeds 1,000 entries; remaining sections are accessible through reading navigation.');
 return items.slice(0,1000).flatMap(n=>{if(!object(n)||++counter.n>2000)return [];return [{id:'nav-'+counter.n,label:label(n.label)||'Untitled section',href:metadataLinks.get(label(n.href,2048))??label(n.href,2048),children:toc(n.subitems,depth+1,counter)}]});
}
function hasScript(n:XmlNode|string):boolean{return typeof n!=='string'&&(n.name==='script'||n.children.some(hasScript))}
async function loadSection(index:number):Promise<SectionState>{
 const existing=states.get(index);if(existing)return existing;if(disposed)throw Error('DISPOSED');
 const item=info.spine[index];if(!item)throw Error('SECTION_INDEX');
 const data=await read(item.href),styles:string[]=[];
 const fixed=item.properties.includes('layout-pre-paginated')||!item.properties.includes('layout-reflowable')&&(book.rendition.layout==='pre-paginated'||item.mediaType.startsWith('image/'));
 let element:Element,viewport={w:600,h:800};
 if(data.model){
  const model=data.model;
  const findViewport=(n:XmlNode|string):string|undefined=>typeof n==='string'?undefined:n.name==='meta'&&n.attrs.name==='viewport'?n.attrs.content:n.children.map(findViewport).find(Boolean);
  const value=findViewport(model),w=value?.match(/width\s*=\s*([\d.]+)/i)?.[1],h=value?.match(/height\s*=\s*([\d.]+)/i)?.[1];
  const viewBox=model.attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
  viewport={w:Number(w||model.attrs.width?.replace(/px$/,'')||viewBox?.[2]||600),h:Number(h||model.attrs.height?.replace(/px$/,'')||viewBox?.[3]||800)};
  if(!Number.isFinite(viewport.w)||!Number.isFinite(viewport.h)||viewport.w<1||viewport.h<1||viewport.w>16384||viewport.h>16384)throw Error('FIXED_VIEWPORT_LIMIT');
  const node=await policy.construct(model,item.href,index,styles);if(!(node instanceof Element))throw Error('SECTION_ROOT');element=policy.sanitize(node);
  if(!element.textContent?.trim()&&!element.querySelector('img,svg,math')&&hasScript(model))throw Error('EPUB_SCRIPT_ONLY: This section requires scripting and cannot be displayed safely.');
 }else if(item.mediaType.startsWith('image/')){const image=document.createElement('img');image.src=await registry.asset(item.href,index);image.alt='Book page '+(index+1);await image.decode();viewport={w:image.naturalWidth,h:image.naturalHeight};element=document.createElement('div');element.append(image)}
 else throw Error('SECTION_UNSUPPORTED: '+item.mediaType);
 if(disposed)throw Error('DISPOSED');
 const doc=document.implementation.createHTMLDocument('Canonical EPUB section');doc.body.append(doc.importNode(element,true));
 const canonical=projectCanonical(doc.body.firstElementChild!);
 const structure=(node:Node):unknown=>node instanceof Element?{tag:node.localName,ns:node.namespaceURI,attrs:[...node.attributes].map(a=>[a.name,a.value.startsWith('blob:')?'<approved-resource>':a.value]),children:[...node.childNodes].filter(n=>n.nodeType===1).map(structure)}:null;
 const digest=await chapterDigest(canonical,JSON.stringify({item,viewport,structure:structure(doc.body)}));
 const root=document.createElement('section');root.dataset.section='s'+index;root.className='chapter';root.setAttribute('aria-label','Section '+(index+1));root.lang=metadata.language;root.dir=metadata.direction;
 const style=document.createElement('style');style.textContent=styles.join('\n');
 const map=renderCanonical(doc.body.firstElementChild!,canonical,false,metadata.language);
 root.append(style,map.root);const state={item,canonical,doc,digest,root,style,map,fixed,viewport};states.set(index,state);return state;
}
const baseExclusions=new WeakMap<CanonicalText,{from:number;to:number}[]>(),renderedStates=new WeakSet<SectionState>();
async function render(state:SectionState){if(state.digest==='unavailable')return;let base=baseExclusions.get(state.canonical);if(!base){base=state.canonical.exclusions.slice();baseExclusions.set(state.canonical,base)}state.canonical.exclusions=base.slice();
 if(state.root.isConnected)for(const interval of state.canonical.intervals){
  let parent=state.map.fragments.get(interval.node)?.[0]?.node.parentElement;
  if(parent&&state.map.wrappers.has(parent))parent=parent.parentElement;
  if(parent){const style=getComputedStyle(parent);interval.visible=parent.checkVisibility({checkVisibilityCSS:true});
   if(interval.eligible&&(Number(style.fontWeight)>=600||style.writingMode.startsWith('vertical')||!interval.visible))state.canonical.exclusions.push({from:interval.from,to:interval.to});}
 }
 const map=renderCanonical(state.doc.body.firstElementChild!,state.canonical,prefs.emphasis.enabled&&!state.fixed,metadata.language);
 if(!state.fixed)for(const el of [map.root,...map.root.querySelectorAll('*')]){
  if(!(el instanceof HTMLElement)||el.closest('svg,math,pre,code,kbd,samp'))continue;
  // Inline important also wins over publisher inline/important sizes. Heading ratios
  // remain relative; fixed pages never enter this reflow typography path.
  const scale=({h1:'2em',h2:'1.5em',h3:'1.17em',h4:'1em',h5:'.83em',h6:'.67em'} as Record<string,string>)[el.localName];
  el.style.setProperty('font-size',scale??'inherit','important');el.style.setProperty('line-height','inherit','important');
  if(prefs.typography.family!=='publisher')el.style.setProperty('font-family','inherit','important');
 }
 const count=nodeCount(map.root)+3;if(count>100000)throw Error('DOM_SECTION_BUDGET');const total=32+count+[...states.values()].filter(s=>s!==state&&s.root.isConnected).reduce((n,s)=>n+nodeCount(s.root),0);if(!await reserveBudget('dom',total))throw Error('DOM_BOOK_BUDGET');const saved=selectionEndpoints();state.map=map;state.root.replaceChildren(state.style,state.map.root);restoreSelection(saved);renderedStates.add(state)}
function selectionEndpoints(){const s=getSelection();if(!s?.rangeCount||s.isCollapsed||!s.anchorNode||!s.focusNode)return null;
 const stateFor=(n:Node)=>{const el=n instanceof Element?n:n.parentElement;const root=el?.closest('[data-section]');return root?states.get(Number((root as HTMLElement).dataset.section?.slice(1))):undefined};
 const a=stateFor(s.anchorNode),f=stateFor(s.focusNode);if(!a||!f)return null;
 return {anchor:{index:a.item.index,offset:canonicalOffset(a.canonical,a.map,s.anchorNode,s.anchorOffset)},focus:{index:f.item.index,offset:canonicalOffset(f.canonical,f.map,s.focusNode,s.focusOffset,'before')}};
}
function restoreSelection(saved:ReturnType<typeof selectionEndpoints>){if(!saved)return;const a=states.get(saved.anchor.index),f=states.get(saved.focus.index);if(!a?.root.isConnected||!f?.root.isConnected)return;try{const x=canonicalEndpoint(a.canonical,a.map,saved.anchor.offset),y=canonicalEndpoint(f.canonical,f.map,saved.focus.offset,'before');getSelection()?.setBaseAndExtent(x.node,x.offset,y.node,y.offset)}catch{/* Image-only section. */}}
function selected():CanonicalSelection|null{
 const saved=selectionEndpoints();if(!saved)return null;const aa=saved.anchor,ff=saved.focus,back=aa.index>ff.index||aa.index===ff.index&&aa.offset>ff.offset,start=back?ff:aa,end=back?aa:ff;let text='';
 for(let i=start.index;i<=end.index;i++){const s=states.get(i);if(!s)throw Error('SELECTION_UNAVAILABLE: Extend selections within the five loaded sections.');const from=i===start.index?start.offset:0,to=i===end.index?end.offset:s.canonical.text.length;
  for(const interval of s.canonical.intervals)if(interval.visible!==false&&interval.to>from&&interval.from<to)text+=s.canonical.text.slice(Math.max(from,interval.from),Math.min(to,interval.to));if(text.length>128*1024)throw Error('SELECTION_LIMIT: Selection exceeds 128 KiB; copy a smaller passage.')}
 const a=states.get(aa.index)!,f=states.get(ff.index)!;return {text,anchor:textLocator(a.item,a.canonical,a.digest,aa.offset),focus:textLocator(f.item,f.canonical,f.digest,ff.offset,'before')};
}
function focusedSection():number|undefined {const root=document.activeElement?.closest('[data-section]');return root?Number((root as HTMLElement).dataset.section?.slice(1)):undefined}
async function windowAt(index:number,clear=false){
 const saved=clear?null:selectionEndpoints(),wanted=new Set<number>();
 for(const n of [index-1,index,index+1])if(n>=0&&n<info.spine.length)wanted.add(n);
 if(saved)for(let n=Math.min(saved.anchor.index,saved.focus.index);n<=Math.max(saved.anchor.index,saved.focus.index);n++)wanted.add(n);
 const focused=focusedSection();if(focused!==undefined)wanted.add(focused);
 if(wanted.size>L.roots){status('Selection or keyboard focus pins five sections. Copy or clear the selection to continue.');return false}
 for(const [i,s]of states)if(!wanted.has(i)){s.root.remove();states.delete(i);await policy.release(i)}
 const ordered=[...wanted].sort((a,b)=>a-b);
 for(const i of ordered){try{await loadSection(i)}catch(error){if(i===index)throw error;const doc=document.implementation.createHTMLDocument('Unavailable section'),content=doc.createElement('div');doc.body.append(content);const canonical=projectCanonical(content),root=document.createElement('section'),style=document.createElement('style');root.dataset.section='s'+i;root.className='chapter';const message=document.createElement('p');message.textContent='Section '+(i+1)+' unavailable: '+(error instanceof Error?error.message:'Unsupported content');root.append(message);const map=renderCanonical(content,canonical,false,'en');states.set(i,{item:info.spine[i],doc,canonical,digest:'unavailable',root,style,map,fixed:false,viewport:{w:600,h:800}});status(message.textContent)}}
 if(disposed)return false;
 // Move existing roots rather than destroying their descendants; saved source endpoints
 // restore a backwards selection as well as a forwards one after window rotation.
 const total=32+ordered.reduce((n,i)=>n+nodeCount(states.get(i)!.root),0);if(!await reserveBudget('dom',total))throw Error('DOM_BOOK_BUDGET');const finalSelection=selectionEndpoints();surface.replaceChildren(...ordered.map(i=>states.get(i)!.root));for(const i of ordered){const state=states.get(i)!;if(!renderedStates.has(state))await render(state);}restoreSelection(finalSelection??saved);return true;
}
function sourceLocator(state:SectionState,offset:number):EpubLocator{
 if(state.fixed)return {kind:'fixed',spineIndex:state.item.index,spineOccurrence:state.item.occurrence,normalizedHref:state.item.href,sectionDigest:state.digest,...(state.item.index===currentIndex&&currentElementId?{elementId:currentElementId}:{}),viewport:{x:Math.abs(surface.scrollLeft),y:surface.scrollTop,zoom:prefs.fixed?.zoom??1}};
 return textLocator(state.item,state.canonical,state.digest,offset);
}
let lastReadingAnchor:EpubLocator|null=null;
function capture():EpubLocator|null {const locator=measureAnchor();if(locator)lastReadingAnchor=locator;return locator}
function measureAnchor():EpubLocator|null {
 const box=surface.getBoundingClientRect();
 // A point in the outer margin resolves to the paragraph's first character,
 // even when that character is above the viewport. Probe the actual text edge
 // and reject clipped lines: emphasis can move a word off that partial line.
 for(const candidate of [...states.values()].sort((a,b)=>a.item.index-b.item.index)){
 const bounds=candidate.root.getBoundingClientRect();if(candidate.fixed||bounds.bottom<=box.top||bounds.top>=box.bottom)continue;
 const x=metadata?.direction==='rtl'?Math.min(box.right-1,bounds.right-1):Math.max(box.left+1,bounds.left+1);
 for(let y=Math.max(box.top+1,bounds.top);y<Math.min(box.bottom,box.top+100,bounds.bottom);y+=Math.max(4,prefs.typography.size/3)){
  const point=document.caretRangeFromPoint(x,y);if(!point||!surface.contains(point.startContainer))continue;
  const el=point.startContainer instanceof Element?point.startContainer:point.startContainer.parentElement,root=el?.closest('[data-section]'),state=root?states.get(Number((root as HTMLElement).dataset.section?.slice(1))):undefined;
  if(!state||state.fixed)continue;let offset=canonicalOffset(state.canonical,state.map,point.startContainer,point.startOffset);
  while(offset>0&&offset>canonicalOffset(state.canonical,state.map,point.startContainer,point.startOffset)-80&&!/\s/u.test(state.canonical.text[offset-1]))offset--;
  const locator=textLocator(state.item,state.canonical,state.digest,offset);try{const rect=canonicalRange(state.canonical,state.map,offset,Math.min(offset+1,state.canonical.text.length)).getBoundingClientRect();if(!rect.width||rect.top<box.top-1||rect.bottom>box.bottom+1)continue;locator.alignHint=rect.top-box.top}catch{continue}return locator;
 }
 }
let active:SectionState|undefined,offset=0;
 for(const s of [...states.values()].sort((a,b)=>a.item.index-b.item.index)){
  const rect=s.root.getBoundingClientRect();if(rect.bottom<=box.top||rect.top>=box.bottom||rect.right<=box.left||rect.left>=box.right)continue;active=s;
  for(const part of s.canonical.intervals){if(part.synthetic||!part.node.length)continue;const from=part.from,range=canonicalRange(s.canonical,s.map,from,Math.min(from+1,s.canonical.text.length)),r=range.getBoundingClientRect();if(r.bottom>box.top+4&&r.top<box.bottom&&r.right>box.left&&r.left<box.right){offset=from;break}}
  break;
 }
 active??=states.get(currentIndex);return active?sourceLocator(active,offset):null;
}
let lastCapabilities='';
function capabilities(state:SectionState){const value={surface:state.fixed?'epub-fixed':'epub-reflow',emphasis:state.map.emphasisUnavailable?{kind:'inactive',reason:state.map.emphasisUnavailable}:state.fixed?{kind:'inactive',reason:'Original fixed-layout pages preserve publisher geometry. Word emphasis applies to reflowable sections.'}:{kind:'toggle'},text:state.canonical.text.trim()?'available':'none',find:true,appearance:state.fixed?'fixed':'reflow',copy:!!state.canonical.text};const key=JSON.stringify(value);if(key!==lastCapabilities){lastCapabilities=key;send('capabilities',value)}}
function applyAppearance(){const t=prefs.typography,theme=t.theme==='follow-app'?prefs.appTheme??'dark':t.theme;surface.dataset.theme=theme;surface.dataset.family=t.family;surface.style.setProperty('--reader-size',t.size+'px');surface.style.setProperty('--reader-leading',String(t.leading));surface.style.setProperty('--reader-measure',({compact:48,comfortable:65,wide:80}[t.measure])+'ch');surface.style.setProperty('--reader-margin',({small:12,medium:24,large:40}[t.margins])+'px');surface.style.setProperty('--reader-column',Math.max(160,surface.clientWidth-2*({small:12,medium:24,large:40}[t.margins]))+'px');surface.classList.toggle('pages',requestedFlow==='pages'&&!activeFixed);surface.classList.toggle('fixed-view',activeFixed);surface.dir=metadata?.direction??'ltr';
 const fixedStates=[...states.values()].filter(s=>s.fixed),spread=new Set([currentIndex]);
 if(activeFixed&&prefs.fixed?.spreads){const state=states.get(currentIndex)!,side=state.item.properties.match(/page-spread-(left|right|center)/)?.[1],leading=metadata.direction==='rtl'?'right':'left';const neighbor=side==='center'?undefined:side?currentIndex+(side===leading?1:-1):fixedStates.find(s=>s.item.index===currentIndex+1)?.item.index??currentIndex-1;if(neighbor!==undefined&&states.get(neighbor)?.fixed)spread.add(neighbor)}
 for(const s of states.values()){
  s.root.classList.toggle('fixed',s.fixed);if(s.fixed){const facing=activeFixed?spread.size:1,fit=prefs.fixed?.fit??'page',scale=(fit==='actual'?1:fit==='width'?surface.clientWidth/(s.viewport.w*facing):Math.min(surface.clientWidth/(s.viewport.w*facing),surface.clientHeight/s.viewport.h))*(prefs.fixed?.zoom??1);s.root.style.width=s.viewport.w+'px';s.root.style.height=s.viewport.h+'px';s.root.style.zoom=String(Math.max(.1,Math.min(8,scale)));s.root.hidden=activeFixed&&!spread.has(s.item.index)}else {s.root.style.removeProperty('zoom');s.root.hidden=activeFixed}}
}
async function settle(){await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,1200))]);await Promise.race([Promise.all([...surface.querySelectorAll('img')].map(i=>i.decode().catch(()=>{}))),new Promise(r=>setTimeout(r,1200))]);await Promise.race([new Promise(requestAnimationFrame),new Promise(r=>setTimeout(r,120))]);await Promise.race([new Promise(requestAnimationFrame),new Promise(r=>setTimeout(r,120))])}
function place(state:SectionState,offset:number,alignHint=12){if(!state.canonical.text.length){state.root.scrollIntoView({block:'start',inline:'start'});return}const range=canonicalRange(state.canonical,state.map,offset,Math.min(state.canonical.text.length,offset+1)),rect=range.getBoundingClientRect(),box=surface.getBoundingClientRect();
 if(requestedFlow==='pages'&&!state.fixed){const delta=metadata.direction==='rtl'?Math.ceil((rect.right-box.right)/surface.clientWidth)*surface.clientWidth:Math.floor((rect.left-box.left)/surface.clientWidth)*surface.clientWidth;surface.scrollLeft+=delta}
 else surface.scrollTop+=rect.top-box.top-alignHint;
}
async function navigate(target:EpubLocator|{sectionIndex:number;fragment?:string},cause:LocationCause='user-navigation'){
 // A saved ordinal belongs to an edition. Resolve section identity before bounds
 // or text context; a removed chapter must never make a valid book unopenable.
 let index:number;
 if('sectionIndex'in target)index=target.sectionIndex;
 else {const saved=target;const match=info.spine.find(s=>s.href===saved.normalizedHref&&s.occurrence===saved.spineOccurrence);
  if(match){index=match.index;target={...target,spineIndex:index};}
  else {index=info.spine.find(s=>s.linear)?.index??0;target={sectionIndex:index};status('The saved section is no longer in this edition. Showing the first reading section approximately.');}
 }
 if(index<0||index>=info.spine.length)throw Error('SECTION_INDEX');
 const previous=capture();if(['link','search','user-navigation'].includes(cause)&&previous){jumpTrail.push(previous);if(jumpTrail.length>20)jumpTrail.shift()}
 clearTimeout(scrollTimer);const revision=++inputRevision;getSelection()?.removeAllRanges();layoutBusy=true;
 try{if(!await windowAt(index,true))return;const state=states.get(index)!;currentIndex=index;currentElementId='fragment'in target?target.fragment:'kind'in target&&target.kind==='fixed'?target.elementId:undefined;activeFixed=state.fixed;applyAppearance();await settle();if(disposed||revision!==inputRevision)return;
  let offset=0;
  if('kind'in target&&target.kind==='text'){if(target.normalizedHref!==state.item.href||target.spineOccurrence!==state.item.occurrence)status('Book structure changed; showing the matching section approximately.');const resolved=resolveTextLocator(target,state.canonical,state.digest);offset=resolved.offset;if(resolved.approximate)status('The saved passage changed or is ambiguous. Showing the start of this section.')}
  if('fragment'in target&&target.fragment){const el=state.map.root.querySelector('#'+CSS.escape(`s${index}--${target.fragment}`));if(el)offset=state.map.elements.get(el)?.from??0;else status('The linked fragment is unavailable; showing the section start.')}
  if('kind'in target&&target.kind==='fixed'&&state.fixed&&target.sectionDigest===state.digest){prefs={...prefs,fixed:{...prefs.fixed!,zoom:target.viewport.zoom}};applyAppearance();surface.scrollTop=target.viewport.y;surface.scrollLeft=target.viewport.x*(metadata.direction==='rtl'?-1:1)}else place(state,offset);
  capabilities(state);if(state.map.emphasisUnavailable&&prefs.emphasis.enabled)status(state.map.emphasisUnavailable);send('location',{locator:sourceLocator(state,offset),cause});send('visible-text',state.canonical.text.slice(offset,offset+16384));
 }finally{layoutBusy=false}
}
async function configure(value:ReaderPreferences,revision=inputRevision){
 clearTimeout(scrollTimer);const anchor=capture(),saved=selectionEndpoints();layoutBusy=true;
 try{prefs=value;requestedFlow=value.flow??requestedFlow;for(const state of states.values())await render(state);applyAppearance();restoreSelection(saved);await settle();if(disposed)return;if(revision===inputRevision)restoreSelection(saved);if(revision===inputRevision&&anchor){const state=states.get(anchor.spineIndex);if(state)place(state,anchor.kind==='text'?anchor.offsetUTF16:0,anchor.kind==='text'?anchor.alignHint:12)}if(anchor){const state=states.get(anchor.spineIndex);if(state){capabilities(state);if(state.map.emphasisUnavailable&&prefs.emphasis.enabled)status(state.map.emphasisUnavailable)}send('location',{locator:capture()??anchor,cause:'layout'})}}finally{layoutBusy=false}
}
async function turn(delta:-1|1){
 ++inputRevision;
 if(!activeFixed){const before=requestedFlow==='pages'?surface.scrollLeft:surface.scrollTop;
  if(requestedFlow==='pages')surface.scrollLeft+=delta*surface.clientWidth*(metadata.direction==='rtl'?-1:1);else surface.scrollTop+=delta*surface.clientHeight*.85;
  const after=requestedFlow==='pages'?surface.scrollLeft:surface.scrollTop;if(Math.abs(after-before)>1){report('user-navigation');return}}
 let next=currentIndex+delta;while(next>=0&&next<info.spine.length&&!info.spine[next].linear)next+=delta;
 if(next>=0&&next<info.spine.length)await navigate({sectionIndex:next},'user-navigation');
}
function report(cause:LocationCause){const locator=capture();if(!locator)return;currentIndex=locator.spineIndex;const state=states.get(currentIndex);if(state){capabilities(state);send('visible-text',state.canonical.text.slice(locator.kind==='text'?locator.offsetUTF16:0,(locator.kind==='text'?locator.offsetUTF16:0)+16384))}send('location',{locator,cause})}
let scrollTimer:ReturnType<typeof setTimeout>|undefined;
surface.addEventListener('scroll',()=>{if(layoutBusy||disposed||!info)return;clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>{if(layoutBusy||disposed)return;void runLayout(async()=>{const anchor=capture();if(!anchor)return;const state=states.get(anchor.spineIndex)!;currentIndex=anchor.spineIndex;
  if(state.fixed!==activeFixed){await navigate({sectionIndex:state.item.index},'user-scroll');return}
  if(!activeFixed){const before=state.root.getBoundingClientRect(),saved=inputRevision;layoutBusy=true;try{if(await windowAt(anchor.spineIndex)){const after=state.root.getBoundingClientRect();if(saved===inputRevision){surface.scrollTop+=after.top-before.top;surface.scrollLeft+=after.left-before.left}}}finally{layoutBusy=false}}
  report('user-scroll');
 }).catch(error=>status(error instanceof Error?error.message:'Section unavailable'))},100)},{passive:true});
for(const type of ['wheel','pointerdown','touchstart'])surface.addEventListener(type,()=>{inputRevision++},{passive:true});
surface.addEventListener('focusin',()=>send('focus'));
surface.addEventListener('copy',event=>{try{const value=selected();if(value){event.preventDefault();event.clipboardData?.setData('text/plain',value.text)}}catch(error){event.preventDefault();status(error instanceof Error?error.message:'Selection unavailable')}});
surface.addEventListener('contextmenu',event=>{event.preventDefault();try{send('contextmenu',{x:event.clientX,y:event.clientY,selection:selected()})}catch(error){status(error instanceof Error?error.message:'Selection unavailable')}});
surface.addEventListener('dragover',event=>event.preventDefault());surface.addEventListener('drop',event=>event.preventDefault());
async function activate(element:Element){const link=policy.links.get(element.getAttribute('data-link')??'');if(!link)return;const ref=resolveBookReference(link.raw,link.base);
 if(ref){const indexes=info.spine.filter(s=>s.href===ref.name);const nearest=indexes.find(s=>s.index===currentIndex)??indexes[0];if(nearest)await navigate({sectionIndex:nearest.index,fragment:ref.fragment},'link');else status('This link points to a resource outside the book reading order.');return}
 const url=safeExternalLink(link.raw);if(url)send('external-link',url);else status('This link is unavailable or uses a blocked address.');
}
surface.addEventListener('click',event=>{const element=(event.target as Element).closest('[data-link]');if(element){event.preventDefault();void runLayout(()=>activate(element)).catch(error=>status(String(error)))}});
surface.addEventListener('auxclick',event=>event.preventDefault());
surface.addEventListener('keydown',event=>{
 inputRevision++;const element=(event.target as Element).closest('[data-link]');if(element&&(event.key==='Enter'||event.key===' ')){event.preventDefault();void runLayout(()=>activate(element)).catch(error=>{if(!disposed)status(String(error))});return}
 if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='f'){event.preventDefault();send('command','find');return}
 if(event.altKey&&event.code==='Tab'){event.preventDefault();send('command',event.shiftKey?'previous-document':'next-document');return}
 if(event.altKey&&event.shiftKey&&(event.code==='KeyW'||event.code==='KeyT')){event.preventDefault();send('command',event.code==='KeyW'?'close-document':'reopen-document');return}
 if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();return}
 if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='e'){event.preventDefault();send('command','read-only-mode');return}
 if(event.key==='Escape'){event.preventDefault();send('command','dismiss');return}
 if(!event.shiftKey&&!event.metaKey&&!event.ctrlKey&&!event.altKey&&['PageDown','PageUp','ArrowRight','ArrowLeft',' '].includes(event.key)){
  if((event.key==='ArrowRight'||event.key==='ArrowLeft')&&getSelection()?.toString())return;
  event.preventDefault();const next=event.key==='PageDown'||event.key===' '||event.key===(metadata.direction==='rtl'?'ArrowLeft':'ArrowRight');void runLayout(()=>turn(next?1:-1)).catch(error=>{if(!disposed)status(String(error))});
 }
});
let selectionTimer:ReturnType<typeof setTimeout>|undefined;
document.addEventListener('selectionchange',()=>{if(disposed||layoutBusy)return;inputRevision++;clearTimeout(selectionTimer);selectionTimer=setTimeout(()=>{try{send('selection',selected())}catch(error){status(String(error))}},100)});
let resizeTimer:ReturnType<typeof setTimeout>|undefined;
const resizeObserver=new ResizeObserver(()=>{if(!metadata||layoutBusy||disposed)return;// ResizeObserver runs after reflow: measuring here would anchor the NEW line.
 const anchor=lastReadingAnchor??capture(),revision=inputRevision;clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{void runLayout(async()=>{applyAppearance();if(anchor&&revision===inputRevision){const s=states.get(anchor.spineIndex);if(s){place(s,anchor.kind==='text'?anchor.offsetUTF16:0,anchor.kind==='text'?anchor.alignHint:12);report('layout')}}}).catch(()=>{});},100)});resizeObserver.observe(surface);
async function dispatch(op:string,payload:unknown,receivedRevision=inputRevision):Promise<unknown>{
 switch(op){
 case 'open':{
  const p=payload as {info:ArchiveInfo;preferences?:ReaderPreferences;initialRecord?:{locator:EpubLocator};editionChanged?:boolean};info=p.info;prefs=p.preferences??DEFAULT_PREFERENCES;requestedFlow=prefs.flow??'scroll';registry=new ResourceRegistry(new Map(info.resources.map(r=>[r.id,r])),read,id=>send('resource-release',{id}),reserveBudget);policy=new BookPolicy(registry);
  // Foliate's pinned metadata/TOC parser runs only here. Its loader/renderers are
  // never called; every XML string is reconstructed from the worker's bounded tokens.
  book=await new EPUB({loadText:async(id:string)=>{if(id==='META-INF/encryption.xml')return null;if(!registry.manifest.has(id))return null;const value=await read(id);return value.model?serialize(value.model,id):value.text??null},loadBlob:()=>{throw Error('FOLIATE_LOADER_DISABLED')},getSize:(id:string)=>registry.manifest.get(id)?.size??0}).init();
  metadata={title:label(book.metadata.title)||'Untitled book',author:label(book.metadata.author,1000),language:label(book.metadata.language,100),direction:book.dir==='rtl'?'rtl':'ltr',contents:toc(book.toc),pageList:toc(book.pageList),landmarks:toc(book.landmarks),sections:info.spine,warnings:info.warnings};
  if(!metadata.contents.length)metadata.contents=info.spine.map(s=>({id:'section-'+s.index,label:'Section '+(s.index+1),href:s.href,children:[]}));
  if(JSON.stringify({...metadata,sections:[]}).length>192*1024)throw Error('EPUB_METADATA_LIMIT: This book’s contents exceed the reader’s bounded metadata limit.');send('metadata',{...metadata,sections:[]});if(p.editionChanged)status('Book edition changed; restoring the saved section and passage where available.');await navigate(p.initialRecord?.locator??{sectionIndex:info.spine.find(s=>s.linear)?.index??0},'restore');
  const warnings=[...info.warnings,...policy.warnings];if(warnings.length)status(warnings.slice(0,5).join(' · '));else if(!notice.textContent)send('status',{phase:'ready'});return {...metadata,sections:[]};
 }
 case 'configure':await configure(payload as ReaderPreferences,receivedRevision);return true;
 case 'navigate':{const p=payload as {locator:EpubLocator|{sectionIndex:number;fragment?:string};cause:LocationCause};await navigate(p.locator,p.cause);return true}
 case 'capture':return capture();
 case 'selection':return selected();
 case 'turn':await turn(payload as -1|1);return true;
 case 'return':{const previous=jumpTrail.pop();if(previous)await navigate(previous,'restore');return true}
 case 'focus':surface.focus({preventScroll:true});return true;
 case 'find':{
  const p=payload as {query:string;queryId:string;index:number};
  const check=()=>{if(findCancelled.has(p.queryId))throw new DOMException('Search cancelled','AbortError')};check();
  const existed=states.has(p.index);activeFindQuery=p.queryId;let state:SectionState;
  try{state=await loadSection(p.index)}catch(error){if(!existed)await policy.release(p.index);throw error}finally{activeFindQuery=undefined}
  try{
   check();if(state.digest==='unavailable')throw Error('SECTION_UNAVAILABLE');
   const hits:FindHit[]=[],offsets:number[]=[];let folded='',nextYield=65536;
   // Case folding retains a source index for expansions. Yield for cancellation
   // independently of the number of matches, including huge unmatched sections.
   for(let at=0;at<state.canonical.text.length;){const cp=String.fromCodePoint(state.canonical.text.codePointAt(at)!),lower=cp.toLowerCase();for(let n=0;n<lower.length;n++)offsets.push(at);folded+=lower;at+=cp.length;if(at>=nextYield){nextYield+=65536;await new Promise(r=>setTimeout(r,0));check()}}
   const query=p.query.toLowerCase();let at=0,transportTruncated=false,hitBytes=0;
   while(query&&(at=folded.indexOf(query,at))>=0&&hits.length<500){const offset=offsets[at],hit={locator:textLocator(state.item,state.canonical,state.digest,offset),snippet:state.canonical.text.slice(Math.max(0,offset-48),offset+p.query.length+96)},size=JSON.stringify(hit).length;if(hitBytes+size>192*1024){transportTruncated=true;break}hitBytes+=size;hits.push(hit);at+=Math.max(1,query.length);if(hits.length%32===0){await new Promise(r=>setTimeout(r,0));check()}}
   check();return {hits,truncated:transportTruncated||hits.length===500};
  }finally{if(!existed){states.delete(p.index);await policy.release(p.index)}}
 }
 case 'cancel-find':findCancelled.add(String(payload));for(const [id,p]of pending)if(p.queryId===payload){pending.delete(id);clearTimeout(p.timer);p.reject(new DOMException('Search cancelled','AbortError'));send('resource-cancel',{request:id})}if(findCancelled.size>20)findCancelled.delete(findCancelled.values().next().value!);return true;
 case 'dispose':dispose();return true;
 default:throw Error('UNKNOWN_READER_OPERATION');
 }
}
function dispose(){if(disposed)return;disposed=true;clearTimeout(sendTimer);outgoing.length=0;registry?.dispose();for(const budget of budgetReplies.values()){clearTimeout(budget.timer);budget.reject(new DOMException('Reader closed','AbortError'))}budgetReplies.clear();resizeObserver.disconnect();for(const p of pending.values()){clearTimeout(p.timer);p.reject(new DOMException('Reader closed','AbortError'))}pending.clear();states.clear();policy?.links.clear();metadataLinks.clear();surface.replaceChildren();clearTimeout(scrollTimer);clearTimeout(selectionTimer);clearTimeout(resizeTimer);port?.close()}
addEventListener('message',function handshake(event:MessageEvent){
 const d=event.data;if(event.source!==parent||port||!object(d)||d.type!=='epub-reader-init'||d.v!==1||typeof d.session!=='string'||d.session.length>80||!object(d.token)||!sameToken(d.token,d.token as unknown as ReaderToken)||event.ports.length!==1)return;
 session=d.session;token=d.token as unknown as ReaderToken;port=event.ports[0];removeEventListener('message',handshake);const rate=new MessageRate();let controls=Promise.resolve(),queuedControls=0;const openChunks:Uint8Array[]=[];let openLength=0,openTotal=0;
 port.onmessage=({data:incoming})=>{let m=incoming;
  if(disposed)return;if(!validateEnvelope(m,session,token,'host')||!rate.accept()){dispose();return}
  if(m.op==='open-chunk'){const p=m.payload as {index:number;total:number;bytes:Uint8Array};if(info||p.index!==openChunks.length||openTotal&&openTotal!==p.total||(openLength+=p.bytes.length)>16*1024*1024){dispose();return}openTotal=p.total;openChunks.push(p.bytes);if(openChunks.length<openTotal)return;const joined=new Uint8Array(openLength);let at=0;for(const chunk of openChunks){joined.set(chunk,at);at+=chunk.length}openChunks.length=0;try{m={...m,op:'open',payload:JSON.parse(new TextDecoder().decode(joined))};if(!object(m.payload)||!object(m.payload.info)||!Array.isArray(m.payload.info.resources)||m.payload.info.resources.length>L.entries||!Array.isArray(m.payload.info.spine)||m.payload.info.spine.length>L.entries){dispose();return}}catch{dispose();return}}
  if(m.op==='budget-result'){const p=m.payload as {request:number;accepted:boolean},budget=budgetReplies.get(p.request);if(budget){budgetReplies.delete(p.request);clearTimeout(budget.timer);budget.resolve(p.accepted)}return}
  if(m.op==='resource-chunk'||m.op==='resource-error'){try{acceptResource(m.payload)}catch{dispose()}return}
  if(m.op==='dispose'){dispose();return}
  if(m.op==='cancel-find'){void dispatch(m.op,m.payload);return}
  if(queuedControls>=64){if(m.id)send('reply',{ok:false,error:'Reader busy; wait for the current navigation.'},m.id);return}queuedControls++;
  // A queued appearance update must not restore over input that arrived while
  // it waited behind font/resource settling in an earlier command.
  const receivedRevision=inputRevision;
  controls=controls.then(()=>runLayout(async()=>{if(disposed)return;try{const value=await dispatch(m.op,m.payload,receivedRevision);if(m.id)send('reply',{ok:true,value},m.id)}catch(error){const message=error instanceof Error?error.message:'Reader failed';if(m.id)send('reply',{ok:false,error:message.slice(0,1000)},m.id);else status(message)}})).catch(error=>{if(!disposed)status(String(error))}).finally(()=>{queuedControls--});
 };port.start();send('ready');
});
