import { createRequire } from 'node:module';
// Reference adapter ONLY: call the installed app's public decoder to observe today's user data.
// The replacement engine/importer must contain/depend on none of this package's code.
const req=createRequire(import.meta.url);
const {b64Vecs}=req('@tldraw/tlschema');

export function decodedInk(ink) {
  if(!ink)return null;
  const segments=(ink.segments||[]).map(segment=>({kind:segment.type,points:(segment.points||b64Vecs.decodePoints(segment.path,segment.dim??3)).map(p=>({x:p.x*(ink.scaleX??1),y:p.y*(ink.scaleY??1),pressure:p.z??.5}))}));
  return {...ink,segments,points:segments.flatMap(s=>s.points)};
}
export function decodedPolyline(line) {
  if(!line)return null;
  return {...line,points:(Array.isArray(line.points)?line.points:Object.values(line.points||{})).sort((a,b)=>String(a.index||'').localeCompare(String(b.index||''))).map(p=>({id:p.id,x:p.x,y:p.y,order:p.index}))};
}
export function decodeNodes(nodes) {return nodes.map(n=>({...n,ink:decodedInk(n.ink),polyline:decodedPolyline(n.polyline)}));}

export function normalizeSaved(snapshot) {
  const store=snapshot?.document?.store??snapshot?.store;
  if(!store||typeof store!=='object')throw Error('Saved file has no recognized document store (not an empty-board substitute)');
  const all=Object.values(store),shapes=all.filter(r=>r.typeName==='shape'),byId=new Map(shapes.map(s=>[s.id,s]));
  const backdrops=shapes.filter(s=>s.type==='image'&&(s.meta?.notebookPage!==undefined||s.meta?.pdfPage!==undefined));
  const isSheet=id=>all.some(r=>r.id===id&&r.typeName==='page');
  const matrix=s=>{
    let a=1,b=0,c=0,d=1,x=0,y=0,r=s,seen=new Set();
    while(r){if(seen.has(r.id)||seen.size>128)throw Error('Cyclic/deep saved parent chain');seen.add(r.id);const cos=Math.cos(r.rotation||0),sin=Math.sin(r.rotation||0);[a,b,c,d,x,y]=[cos*a-sin*b,sin*a+cos*b,cos*c-sin*d,sin*c+cos*d,cos*x-sin*y+r.x,sin*x+cos*y+r.y];r=byId.get(r.parentId);}
    return {a,b,c,d,x,y};
  };
  const text=n=>n?.type==='text'?n.text||'':n?.type==='hardBreak'?'\n':(n?.content||[]).map(text).join(n?.type==='doc'?'\n':'');
  return shapes.filter(r=>!backdrops.includes(r)).map(r=>{
    const p=r.props||{},m=matrix(r),kind={draw:'stroke',highlight:'stroke',geo:'figure',note:'sticky',arrow:'connector',line:'polyline',image:'picture',video:'clip',bookmark:'linkcard'}[r.type]||r.type;
    const ink=kind==='stroke'?decodedInk({segments:p.segments,isPen:p.isPen,isClosed:p.isClosed,isComplete:p.isComplete,scale:p.scale,scaleX:p.scaleX,scaleY:p.scaleY}):null;
    const line=kind==='polyline'?decodedPolyline({points:p.points,spline:p.spline}):null;
    let sheet=r.parentId,ancestor=r;const seen=new Set();while(!isSheet(sheet)&&byId.has(sheet)){if(seen.has(sheet))throw Error('Cyclic saved parent');seen.add(sheet);ancestor=byId.get(sheet);sheet=ancestor.parentId;}
    const localPoints=ink?.points||line?.points||(Number.isFinite(p.w)&&Number.isFinite(p.h)?[{x:0,y:0},{x:p.w,y:0},{x:0,y:p.h},{x:p.w,y:p.h}]:[]);
    const points=localPoints.map(pt=>({x:m.a*pt.x+m.c*pt.y+m.x,y:m.b*pt.x+m.d*pt.y+m.y}));
    const bounds=points.length?{x:Math.min(...points.map(p=>p.x)),y:Math.min(...points.map(p=>p.y)),width:Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x)),height:Math.max(...points.map(p=>p.y))-Math.min(...points.map(p=>p.y))}:null;
    const page=backdrops.find(pg=>{const cy=bounds?bounds.y+bounds.height/2:m.y;return cy>=pg.y&&cy<=pg.y+pg.props.h;});
    const marks=[];const walk=(n,trail=[])=>{if(n?.type==='text')marks.push({text:n.text,marks:n.marks||[],path:trail});(n?.content||[]).forEach((c,i)=>walk(c,[...trail,i]));};if(p.richText)walk(p.richText);
    const attachment=terminal=>{const x=all.find(b=>b.typeName==='binding'&&b.fromId===r.id&&b.props.terminal===terminal);return x?{target:x.toId,anchor:x.props.normalizedAnchor,exact:x.props.isExact,precise:x.props.isPrecise,snap:x.props.snap??null}:null;};
    const asset=store[p.assetId];
    return {id:r.id,kind,subkind:r.type==='highlight'?'highlighter':r.type==='draw'?'pen':null,figure:p.geo??null,title:p.name??null,parent:r.parentId,order:r.index,position:{x:m.x,y:m.y},localPosition:{x:r.x,y:r.y},size:{width:p.w??bounds?.width??null,height:p.h??bounds?.height??null},bounds,rotation:r.rotation,page:page?(page.meta.notebookPage??page.meta.pdfPage):null,pageLocalPosition:page?{x:m.x-page.x,y:m.y-page.y}:null,sheet,swatch:p.color??null,resolvedSwatch:null,width:p.scale??null,fill:p.fill??null,dash:p.dash??null,opacity:r.opacity,font:p.font??null,textSize:p.size??null,alignment:p.textAlign??p.align??null,verticalAlignment:p.verticalAlign??null,plainText:p.richText?text(p.richText):p.text??null,richMarks:marks,richText:p.richText??null,locked:r.isLocked,styles:{swatch:p.color,labelSwatch:p.labelColor,fill:p.fill,dash:p.dash,size:p.size,font:p.font,alignment:p.textAlign??p.align,verticalAlignment:p.verticalAlign,scale:p.scale,opacity:r.opacity},connector:kind==='connector'?{start:p.start,end:p.end,startAttachment:attachment('start'),endAttachment:attachment('end'),startHead:p.arrowheadStart,endHead:p.arrowheadEnd,bend:p.bend,kind:p.kind,labelPosition:p.labelPosition,elbowMidPoint:p.elbowMidPoint??null}:null,polyline:line,ink,media:asset?{id:asset.id,mime:asset.props.mimeType,width:asset.props.w,height:asset.props.h,source:asset.props.src,name:asset.props.name,animated:asset.props.isAnimated,size:asset.props.fileSize}:null,crop:p.crop??null,flipX:p.flipX??null,flipY:p.flipY??null,altText:p.altText??null,playback:'playing'in p?{isPlaying:p.playing,time:p.time??null,autoplay:p.autoplay??null}:null,htmlVideo:null,inverted:!!r.meta?.inverted,url:p.url??null,autoWidth:p.autoSize??null,paintedText:null,metadata:r.meta};
  });
}
