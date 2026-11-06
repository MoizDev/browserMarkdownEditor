import { SaxesParser } from './vendor/archive.js';
import { XHTML_ENTITIES } from './vendor/xhtmlEntities';
import { EPUB_LIMITS as L } from './types';
import type { XmlNode } from './types';
export function decodeXml(bytes:Uint8Array):string {
 const encoding=bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':'utf-8';
 const text=new TextDecoder(encoding,{fatal:true}).decode(bytes).replace(/\r\n?/g,'\n');
 const declared=text.slice(0,256).match(/<\?xml[^?]*encoding\s*=\s*['"]([^'"]+)/i)?.[1].toLowerCase();
 if(declared&&!['utf-8','utf8','utf-16','utf-16le','utf-16be','us-ascii'].includes(declared))throw Error('XML_ENCODING_UNSUPPORTED: '+declared);
 return text;
}
export function parseXml(text:string):XmlNode {
 if(text.length>L.text)throw Error('XML_BYTES');
 const parser=new SaxesParser({xmlns:true}),roots:XmlNode[]=[],stack:XmlNode[]=[];let count=0;
 Object.assign(parser.ENTITIES,XHTML_ENTITIES);
 parser.on('doctype',(s:string)=>{if(s.includes('[')||!/^\s*(?:html|svg)(?:\s+(?:PUBLIC\s+["'][^"']+["']\s+)?["']http:\/\/www\.w3\.org\/(?:TR\/xhtml[^"']*|Graphics\/SVG[^"']*)["'])?\s*$/.test(s))throw Error('XML_DOCTYPE')});
 parser.on('processinginstruction',()=>{throw Error('XML_PI')});
 parser.on('opentag',(n:{local:string;uri:string;attributes:Record<string,{name:string;value:string}>})=>{
  const attrs=Object.values(n.attributes);if(++count>L.nodes||stack.length>=L.depth||attrs.length>64||attrs.some(a=>a.value.length>16384))throw Error('XML_COMPLEXITY');
  const node:XmlNode={name:n.local,ns:n.uri,attrs:Object.fromEntries(attrs.map(a=>[a.name,a.value])),children:[]};(stack.at(-1)?.children??roots).push(node);stack.push(node);
 });
 for(const type of ['text','cdata'])parser.on(type,(s:string)=>{if(stack.length)stack.at(-1)!.children.push(s.replace(/\r\n?/g,'\n'))});
 parser.on('closetag',()=>stack.pop());parser.on('error',()=>{throw Error('XML_INVALID')});parser.write(text).close();
 if(roots.length!==1)throw Error('XML_ROOT');return roots[0];
}
export function xmlAll(node:XmlNode|string,name:string):XmlNode[]{return typeof node==='string'?[]:[...(node.name===name?[node]:[]),...node.children.flatMap(n=>xmlAll(n,name))]}
export function xmlText(node:XmlNode|string):string{return typeof node==='string'?node:node.children.map(xmlText).join('')}
