import { DOMPurify, CSS } from './vendor/renderer.js';
import { ResourceRegistry, resolveBookReference } from './resources';
import type { XmlNode } from './types';
const HTML=new Set('html head body title p div span section article aside header footer main nav h1 h2 h3 h4 h5 h6 a em strong b i u s sub sup small mark abbr cite blockquote q pre code kbd samp var ul ol li dl dt dd br hr img figure figcaption table caption colgroup col thead tbody tfoot tr th td ruby rt rp bdi bdo details summary'.split(' '));
const SVG=new Set('svg g rect circle ellipse line polyline polygon path text tspan defs linearGradient radialGradient stop clipPath use image title desc'.split(' '));
const MATH=new Set('math mrow mi mn mo mtext mspace ms mfrac msqrt mroot mstyle merror mpadded mphantom mfenced menclose msub msup msubsup munder mover munderover mmultiscripts mtable mtr mtd semantics annotation'.split(' '));
const ATTRS=new Set('id class hidden lang xml:lang dir role aria-label aria-labelledby aria-describedby aria-hidden epub:type alt width height colspan rowspan scope start value reversed open type datetime viewBox x y x1 y1 x2 y2 cx cy r rx ry d points transform fill stroke stroke-width opacity fill-opacity stroke-opacity offset stop-color stop-opacity clip-path preserveAspectRatio font-size text-anchor'.split(' '));
const HTML_NS='http://www.w3.org/1999/xhtml',SVG_NS='http://www.w3.org/2000/svg',MATH_NS='http://www.w3.org/1998/Math/MathML';
export interface LinkTarget { raw:string; base:string }
export class BookPolicy {
 readonly links=new Map<string,LinkTarget>();
 readonly warnings=new Set<string>();
 private seq=0;
 private faces=new Map<number,Set<string>>();
 private trustedURLs=new WeakMap<Element,{attr:string;url:string}>();
 constructor(readonly resources:ResourceRegistry){resources.constructSVG=async(model,base,index,chain)=>{const styles:string[]=[];const result=await this.construct(model,base,index,styles,chain);if(!(result instanceof Element))throw Error('SVG_ROOT');const safe=this.sanitize(result);safe.setAttribute('data-section','s'+index);const box=model.attrs.viewBox?.trim().split(/[ ,]+/).map(Number),w=Number(model.attrs.width?.replace(/px$/,'')||box?.[2]||300),h=Number(model.attrs.height?.replace(/px$/,'')||box?.[3]||150);(safe as SVGElement).style.setProperty('width',w+'px','important');(safe as SVGElement).style.setProperty('height',h+'px','important');if(styles.length){const style=document.createElementNS(SVG_NS,'style');style.textContent=styles.join('\n');safe.prepend(style)}return safe}}
 private warn(message:string){if(this.warnings.size<100)this.warnings.add(message.slice(0,500))}
 async css(text:string,base:string,index:number,chain:string[]=[]):Promise<string>{
  if(text.length>4*1024*1024||chain.length>=16||chain.includes(base))throw Error('CSS_CYCLE_OR_LIMIT');
  let tokens=0;CSS.tokenize(text,()=>{if(++tokens>50000)throw Error('CSS_TOKENS')});
  const ast=CSS.parse(text),remove:{item:unknown;list:{remove(value:unknown):void}}[]=[],imports:string[]=[];let rules=0;
  CSS.walk(ast,{enter:(n:Record<string,unknown>,item:unknown,list:{remove(value:unknown):void;insertData(value:unknown,before:unknown):void})=>{
   const drop=()=>{if(item&&list)remove.push({item,list})};
   if(n.type==='Rule'&&++rules>10000)throw Error('CSS_RULES');
   if(n.type==='Atrule'){
    const name=String(n.name).toLowerCase();if(!['import','font-face','media','supports'].includes(name)){drop();this.warn('Unsupported CSS @'+name)}
    if(name==='import'){const pre=n.prelude as {children?:{first?:{type:string;value:string}}};const first=pre?.children?.first;if(first&&['String','Url'].includes(first.type)){const ref=resolveBookReference(first.value,base);if(ref&&this.resources.manifest.get(ref.name)?.type==='text/css')imports.push(ref.name);else this.warn('Blocked external stylesheet')}drop()}
   }
   if(n.type==='Declaration'){
    const property=String(n.property).toLowerCase();let bad=property.startsWith('--')||property.startsWith('-')||['behavior','content','animation','transition','cursor','filter','backdrop-filter','will-change'].includes(property);
    CSS.walk(n.value,(q:{type:string;name?:string;value?:string})=>{if(q.type==='Raw'||q.type==='Function'&&!['rgb','rgba','hsl','hsla','calc','min','max','clamp','linear-gradient','radial-gradient','repeating-linear-gradient','repeating-radial-gradient','translate','translatex','translatey','scale','scalex','scaley','rotate','matrix','cubic-bezier','format','tech'].includes(String(q.name).toLowerCase()))bad=true;if(property==='position'&&q.type==='Identifier'&&['fixed','sticky'].includes(String(q.name)))bad=true});
    if(!CSS.lexer.matchDeclaration(n).matched&&!CSS.lexer.matchAtruleDescriptor('font-face',property,n.value).matched)bad=true;
    if(property==='font'){
     // Expand a valid static shorthand before namespacing families. Treating each
     // identifier as a family breaks multiword faces and silently loses book fonts.
     const declaration=document.createElement('span').style;declaration.font=CSS.generate(n.value);
     if(!declaration.font||bad)bad=true;
     else {const expanded=CSS.parse(['font-style','font-variant','font-weight','font-stretch','font-size','line-height','font-family'].map(key=>key+':'+declaration.getPropertyValue(key)+(n.important?'!important':'')).filter(value=>!value.endsWith(':')).join(';'),{context:'declarationList'});
      const family=expanded.children.toArray().find((d:{property:string})=>d.property==='font-family');if(family)this.namespaceFamily(family,index);
      for(const d of expanded.children.toArray())list.insertData(d,item);drop();
     }
    }
    if(property==='font-family')this.namespaceFamily(n,index);
    if(bad){drop();this.warn('Unsupported CSS declaration: '+property)}
   }
  }});
  for(const {item,list}of remove)try{list.remove(item)}catch{/* Ancestor already removed. */}
  const urls:{type:string;value:string}[]=[];CSS.walk(ast,(n:{type:string;value:string})=>{if(n.type==='Url')urls.push(n)});
  for(const u of urls){const ref=resolveBookReference(u.value,base);if(u.value.startsWith('#'))u.value=`#s${index}--${u.value.slice(1)}`;else if(ref&&this.resources.manifest.has(ref.name)){try{u.value=await this.resources.asset(ref.name,index,chain.concat(base))}catch(error){u.value='about:invalid';this.warn(error instanceof Error?error.message:'Unavailable resource')}}else {u.value='about:invalid';this.warn('Blocked publisher resource URL')}}
  CSS.walk(ast,(n:{type:string;name:string})=>{if(n.type==='TypeSelector'&&['html','body','head'].includes(n.name)){n.type='ClassSelector';n.name='pub-'+n.name}else if(n.type==='PseudoClassSelector'&&n.name==='root'){n.type='ClassSelector';n.name='pub-html'}else if(n.type==='IdSelector')n.name=`s${index}--${n.name}`});
  CSS.walk(ast,{visit:'Rule',enter:(n:{prelude:{type:string;children:{toArray():unknown[]}}})=>{if(n.prelude?.type==='SelectorList')n.prelude=CSS.parse(n.prelude.children.toArray().map(s=>`[data-section="s${index}"] ${CSS.generate(s)}`).join(','),{context:'selectorList'})}});
  const prefix:string[]=[];for(const name of imports){const data=await this.resources.read(name);if(data.text)prefix.push(await this.css(data.text,name,index,chain.concat(base)))}
  const faces=this.faces.get(index)??new Set<string>(),beforeFaces=new Set(faces);this.faces.set(index,faces);const excess:{item:unknown;list:{remove(value:unknown):void}}[]=[];CSS.walk(ast,{visit:'Atrule',enter:(node:{name:string},item:unknown,list:{remove(value:unknown):void})=>{if(node.name!=='font-face')return;const key=CSS.generate(node);if(faces.has(key))return;const count=[...this.faces.values()].reduce((n,set)=>n+set.size,0);if(count>=8){excess.push({item,list});this.warn('FONT_FACE_LIMIT: Additional publisher fonts are unavailable.')}else faces.add(key)}});for(const {item,list}of excess)list.remove(item);const desired=[...this.faces.values()].reduce((n,set)=>n+set.size,0);if(!await this.resources.reserve('faces',desired)){this.faces.set(index,beforeFaces);const rejected:{item:unknown;list:{remove(value:unknown):void}}[]=[];CSS.walk(ast,{visit:'Atrule',enter:(node:{name:string},item:unknown,list:{remove(value:unknown):void})=>{if(node.name==='font-face')rejected.push({item,list})}});for(const {item,list}of rejected)list.remove(item);this.warn('FONT_FACE_LIMIT: Additional publisher fonts are unavailable.')}
  return prefix.join('\n')+CSS.generate(ast);
 }
 private namespaceFamily(declaration:Record<string,unknown>,index:number){
  const value=declaration.value as {children:{toArray():{type:string;name?:string;value?:string}[]}},families:string[]=[];let parts:string[]=[],quoted=false;
  const flush=()=>{if(!parts.length)return;const family=parts.join(' ');families.push(!quoted&&/^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|math|emoji|fangsong|inherit|initial|unset|revert|revert-layer)$/i.test(family)?family:JSON.stringify(`s${index}-${family}`));parts=[];quoted=false};
  for(const node of value.children.toArray()){if(node.type==='Operator'&&node.value===',')flush();else if(node.type==='String'){parts.push(node.value!);quoted=true;}else if(node.type==='Identifier')parts.push(node.name!)}flush();
  if(families.length)declaration.value=CSS.parse(families.join(','),{context:'value'});
 }
 async construct(model:XmlNode|string,base:string,index:number,styles:string[],chain:string[]=[]):Promise<Node>{
  if(typeof model==='string')return document.createTextNode(model);
  const {name,ns,attrs,children}=model;
  if(name==='style'){styles.push(await this.css(children.filter(c=>typeof c==='string').join(''),base,index));return document.createDocumentFragment()}
  if(name==='link'){if(attrs.rel?.split(/\s+/).includes('stylesheet')){const ref=resolveBookReference(attrs.href,base);if(ref&&this.resources.manifest.get(ref.name)?.type==='text/css'){const data=await this.resources.read(ref.name);styles.push(await this.css(data.text??'',ref.name,index))}else this.warn('Blocked external stylesheet')}return document.createDocumentFragment()}
  if(name==='meta'||name==='title')return document.createDocumentFragment();
  if(!(ns===HTML_NS?HTML:ns===SVG_NS?SVG:ns===MATH_NS?MATH:new Set()).has(name)){this.warn('Unsupported publisher element: '+name);return document.createDocumentFragment()}
  const html=ns===HTML_NS,el=html?document.createElement(['html','head','body'].includes(name)?'div':name):document.createElementNS(ns,name);
  if(html&&['html','head','body'].includes(name))el.className='pub-'+name;
  for(const [a,v]of Object.entries(attrs)){
   if(a==='style'){const ast=CSS.parse(await this.css('x{'+v+'}',base,index)),rule=ast.children.first;if(rule?.block)el.setAttribute('style',CSS.generate(rule.block).slice(1,-1));continue}
   if(!ATTRS.has(a))continue;
   if(a==='id')el.id=`s${index}--${v}`;
   else if(a==='class'){const names=v.split(/\s+/).filter(s=>s&&!s.startsWith('reader-')&&!s.startsWith('pub-'));if(names.length)el.classList.add(...names)}
   else if(['aria-labelledby','aria-describedby'].includes(a))el.setAttribute(a,v.split(/\s+/).map(s=>`s${index}--${s}`).join(' '));
   else if(['fill','stroke','clip-path'].includes(a)&&/url/i.test(v)){const ast=CSS.parse(v,{context:'value'});let safe=true;CSS.walk(ast,(q:{type:string;value:string})=>{if(q.type==='Url'){if(q.value.startsWith('#'))q.value=`#s${index}--${q.value.slice(1)}`;else safe=false}});if(safe)el.setAttribute(a,CSS.generate(ast))}
   else el.setAttribute(a,v);
  }
  if(name==='a'){const id=`${index}:${++this.seq}`;el.setAttribute('role','link');el.setAttribute('tabindex','0');el.setAttribute('data-link',id);this.links.set(id,{raw:attrs.href??attrs['xlink:href']??'',base})}
  if(name==='img'||name==='image'||name==='use'){
   const raw=attrs.src??attrs.href??attrs['xlink:href']??'',ref=resolveBookReference(raw,base);
   if(name==='use'&&raw.startsWith('#'))el.setAttribute('href',`#s${index}--${raw.slice(1)}`);
   else if(ref&&this.resources.manifest.has(ref.name)){try{const url=await this.resources.asset(ref.name,index,chain);this.trustedURLs.set(el,{attr:name==='img'?'src':'href',url})}catch(error){this.warn(error instanceof Error?error.message:'Unavailable image');if(name==='img')el.setAttribute('alt',(attrs.alt||'Image')+' (unavailable)')}}
   else {this.warn('Blocked or missing image');if(name==='img')el.setAttribute('alt',(attrs.alt||'Image')+' (unavailable)')}
  }
  for(const child of children)el.appendChild(await this.construct(child,base,index,styles,chain));return el;
 }
 sanitize(element:Element):Element {
  // SECURITY EXCEPTION: publisher DOM exists ONLY in sandbox="allow-scripts" opaque
  // reader. No host note HTML sink is added. Manual token allowlist precedes DOMPurify;
  // URL capabilities are assigned afterward from a private WeakMap, never author attrs.
  DOMPurify.sanitize(element,{IN_PLACE:true,ALLOWED_TAGS:[...HTML,...SVG,...MATH],ALLOWED_ATTR:[...ATTRS,'style','data-link','tabindex','href'],ALLOW_DATA_ATTR:false,ADD_ATTR:['data-link','epub:type'],FORBID_TAGS:['script','style','foreignObject','animate','set','template','form','iframe','object','embed'],SANITIZE_DOM:true});
  for(const el of [element,...element.querySelectorAll('*')]){const approved=this.trustedURLs.get(el);if(approved)el.setAttribute(approved.attr,approved.url);else if(el.hasAttribute('href')&&!/^#s\d+--/.test(el.getAttribute('href')??''))el.removeAttribute('href')}
  return element;
 }
 release(index:number){this.faces.delete(index);for(const key of this.links.keys())if(key.startsWith(index+':'))this.links.delete(key);return Promise.all([this.resources.releaseSection(index),this.resources.reserve('faces',[...this.faces.values()].reduce((n,set)=>n+set.size,0))]).then(()=>{})}
}
