import React, { useEffect, useMemo, useRef, useState } from 'react';
import { openEpubSession } from '../epub/engineAdapter';
import { DEFAULT_PREFERENCES } from '../epub/types';
import type { CanonicalSelection, EpubMetadata, EpubReadingRecord, FindBatch, LocationCause, ReaderAdapter, ReaderCapabilities, ReaderHostCommand, ReaderIdentity, ReaderPreferences, ReaderStatus, ReaderToken, ReadOnlyFileSnapshot } from '../epub/types';
import type { DiskVersion } from '../utils/diskVersion';
import { openContextMenu, closeContextMenu } from '../utils/contextMenu';
import { copyText, CLIPBOARD_WRITE_BLOCKED } from '../utils/clipboard';
import { registerReadingSurface } from '../utils/documentReading';
import { dismissOnEscape } from '../utils/escapeDismiss';
import '../components/EpubReader/reader.css';
export interface EpubPaneProps {
 identity:ReaderIdentity;snapshot:ReadOnlyFileSnapshot;initialRecord?:EpubReadingRecord;isFocused:boolean;
 onReaderVersion(token:ReaderToken,version:DiskVersion):void;
 onReaderStatus(token:ReaderToken,status:ReaderStatus):void;
 onReaderCapabilities(token:ReaderToken,capabilities:ReaderCapabilities):void;
 onReaderLocation(token:ReaderToken,location:{kind:'epub';value:EpubReadingRecord},cause:LocationCause):void;
 onReaderCommand(token:ReaderToken,command:ReaderHostCommand):void;
 onFocusPane(path:string):void;onRetryRead(path:string):Promise<boolean>;
 registerKeyboardTarget(path:string,take:()=>void):()=>void;onNotify(message:string):void;
 /** Integration binds the shared browser preference store; no source file is changed. */
 onReaderSelection?(token:ReaderToken,selection:CanonicalSelection|null):void;
 onReaderVisibleText?(token:ReaderToken,text:string):void;
 onReaderAdapter?(token:ReaderToken,adapter:ReaderAdapter|null):void;
 onReaderMetadata?(token:ReaderToken,metadata:EpubMetadata):void;
 preferences?:ReaderPreferences;onPreferencesChange?(next:ReaderPreferences):void;
}
type Panel='contents'|'search'|'appearance'|null;
function bookErrorMessage(error:unknown):string {
 const message=error instanceof Error?error.message:'This EPUB could not be opened.';
 if(message.includes('DRM'))return 'This book uses unsupported DRM. Open a DRM-free edition in this reader.';
 if(message.startsWith('ZIP64'))return 'This EPUB uses ZIP64, which this reader does not support. A ZIP32 edition is required.';
 if(/(?:DECLARED_LIMIT|ACTUAL_LIMIT|MEMORY_LIMIT|DIRECTORY_LIMIT|ZIP_SIZE|COMPLEXITY|METADATA_LIMIT)/.test(message))return 'This book exceeds the reader’s resource limits. Try a smaller edition.';
 if(/(?:TIMEOUT|timed out|WORKER_ERROR|BRIDGE_PROTOCOL)/.test(message))return 'The local reader could not finish opening this book. Retry or reopen it.';
 if(/^(?:ZIP_|ENTRY_|EPUB_(?:MIMETYPE|CONTAINER|PACKAGE|SPINE|EMPTY))/.test(message))return 'This file is not a complete, readable EPUB archive. Try another copy.';
 if(message.startsWith('XML_'))return 'A document in this EPUB uses malformed or unsupported XML. Try another edition.';
 if(message.startsWith('CSS_'))return 'A publisher stylesheet is malformed or exceeds the reader’s limits.';
 if(message.startsWith('EPUB_SCRIPT_ONLY'))return 'This section requires scripts. The reader supports static EPUB content.';
 return message;
}

function EpubPane(props:EpubPaneProps){
 const {identity,snapshot}=props,host=useRef<HTMLDivElement>(null),pane=useRef<HTMLDivElement>(null),latest=useRef(props),adapter=useRef<ReaderAdapter|null>(null),sessionRef=useRef<Awaited<ReturnType<typeof openEpubSession>>|null>(null),version=useRef(''),searchAbort=useRef<AbortController|null>(null),opener=useRef<HTMLElement|null>(null);
 const [status,setStatus]=useState<ReaderStatus>({phase:'loading'}),[metadata,setMetadata]=useState<EpubMetadata|null>(null),[caps,setCaps]=useState<ReaderCapabilities|null>(null),[panel,setPanel]=useState<Panel>(null),[query,setQuery]=useState(''),[results,setResults]=useState<FindBatch|null>(null),[searching,setSearching]=useState(false),[section,setSection]=useState(0),[canReturn,setCanReturn]=useState(false),[external,setExternal]=useState<string|null>(null),[flow,setFlow]=useState(props.initialRecord?.requestedLayout??'scroll'),[localPrefs,setLocalPrefs]=useState<ReaderPreferences>(DEFAULT_PREFERENCES);
 useEffect(()=>{latest.current=props});
 const [fixedPrefs,setFixedPrefs]=useState<ReaderPreferences['fixed']>({...DEFAULT_PREFERENCES.fixed!,zoom:props.initialRecord?.locator.kind==='fixed'?props.initialRecord.locator.viewport.zoom:1});
 const basePreferences=props.preferences??localPrefs;
 const preferences=useMemo(()=>({...basePreferences,fixed:fixedPrefs}),[basePreferences,fixedPrefs]);
 const focusPending=useRef(false);
 const readingPreferencesRef=useRef(preferences);
 useEffect(()=>{readingPreferencesRef.current=preferences},[preferences]);
 function notify(message:string){latest.current.onNotify(message)}
 function run(job:Promise<unknown>|undefined){void job?.catch(error=>{if(error instanceof DOMException&&error.name==='AbortError')return;notify(error instanceof Error?error.message:'Book action failed')})}
 function closePanel(){setPanel(null);if(opener.current?.isConnected)opener.current.focus()}
 function showPanel(next:Panel,event?:React.MouseEvent<HTMLElement>){if(event)opener.current=event.currentTarget;setPanel(p=>p===next?null:next)}
 useEffect(()=>{
  const controller=new AbortController();let live=true;let unregisterSurface:(()=>void)|undefined;const token={...identity},container=host.current!;
  setStatus({phase:'loading',message:'Opening book locally…'});setMetadata(null);version.current='';setCanReturn(false);setExternal(null);setFlow(latest.current.initialRecord?.requestedLayout??'scroll');setFixedPrefs({...DEFAULT_PREFERENCES.fixed!,zoom:latest.current.initialRecord?.locator.kind==='fixed'?latest.current.initialRecord.locator.viewport.zoom:1});
  const report=(value:ReaderStatus)=>{if(!live)return;setStatus(value);latest.current.onReaderStatus(token,value)};
  report({phase:'loading',message:'Opening book locally…'});
  void (async()=>{
   try{const session=await openEpubSession(snapshot,identity,{initialRecord:latest.current.initialRecord,preferences:{...readingPreferencesRef.current,flow:latest.current.initialRecord?.requestedLayout??'scroll'},onVersion(value){if(live){version.current=value.hash;latest.current.onReaderVersion(token,value)}}},controller.signal);if(!live){session.dispose();return}sessionRef.current=session;
    const reader=await session.mount(container,{
     onMetadata(value){if(live){setMetadata(value);latest.current.onReaderMetadata?.(token,value)}},onStatus:report,
     onCapabilities(value){if(live){setCaps(value);latest.current.onReaderCapabilities(token,value)}},
     onLocation(locator,cause){if(!live||!version.current)return;setSection(locator.spineIndex);if(['link','search','user-navigation'].includes(cause))setCanReturn(true);const record:EpubReadingRecord={v:1,kind:'epub',rawFingerprint:version.current,parserSchema:1,sanitizerSchema:1,projectionSchema:1,requestedLayout:flowRef.current,locator};latest.current.onReaderLocation(token,{kind:'epub',value:record},cause)},
     onSelection(value){if(live)latest.current.onReaderSelection?.(token,value)},onVisibleText(value){if(live)latest.current.onReaderVisibleText?.(token,value)},
     onFocus(){if(live)latest.current.onFocusPane(latest.current.identity.path)},
     onCommand(command){if(command==='find'){setPanel('search');return}if(command==='dismiss'){setPanel(null);return}latest.current.onReaderCommand(token,command)},
     onContextMenu(x,y,selection:CanonicalSelection|null){if(!live)return;const frame=container.querySelector('iframe'),rect=frame?.getBoundingClientRect();if(!rect)return;openContextMenu({x:rect.left+x,y:rect.top+y,label:'Book reading actions',opener:frame,entries:[{kind:'command',id:'copy',label:'Copy',disabled:!selection?.text,reason:selection?.text?undefined:'Select a passage first',run:async()=>{if(selection&&!await copyText(selection.text))notify(CLIPBOARD_WRITE_BLOCKED)}},{kind:'command',id:'find',label:'Find in book',run:()=>setPanel('search')},{kind:'command',id:'return',label:'Return to previous passage',run:()=>adapter.current?.returnToPrevious()}]})},
     onExternalLink(url){if(live){opener.current=container.querySelector('iframe');setExternal(url)}},
    });if(!live){reader.dispose();return}adapter.current=reader;if(focusPending.current&&latest.current.isFocused){focusPending.current=false;reader.focus()}latest.current.onReaderAdapter?.(token,reader);
    unregisterSurface=registerReadingSurface(identity,{
     capabilities:()=>session.capabilities,focusReading:()=>reader.focus(),findReading:()=>{opener.current=container.querySelector('iframe');setPanel('search')},
     showBookPanel:next=>{opener.current=pane.current?.closest('.editor-slot')?.querySelector<HTMLElement>('.editor-slot-actions [aria-haspopup=menu]')??null;setPanel(next)},bookFlow:()=>flowRef.current,setBookFlow:next=>setFlow(next),
     async captureReading(){let timer:ReturnType<typeof setTimeout>|undefined;const locator=await Promise.race([reader.captureAnchor(),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),400)})]).finally(()=>clearTimeout(timer));if(live&&locator&&version.current)latest.current.onReaderLocation(token,{kind:'epub',value:{v:1,kind:'epub',rawFingerprint:version.current,parserSchema:1,sanitizerSchema:1,projectionSchema:1,requestedLayout:flowRef.current,locator}},'user-scroll')},
    });await reader.configure({...readingPreferencesRef.current,flow:flowRef.current});
   }catch(error){if(live&&!controller.signal.aborted)report({phase:'error',message:bookErrorMessage(error)})}
  })();
  return ()=>{live=false;unregisterSurface?.();latest.current.onReaderAdapter?.(token,null);searchAbort.current?.abort();controller.abort();sessionRef.current?.dispose();sessionRef.current=null;adapter.current=null;closeContextMenu()};
  // Snapshot and full generation determine all resources. App callback identities are
  // read through latest, never a reason to reopen or reparse the book.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[snapshot,identity.vaultId,identity.vaultEpoch,identity.documentId,identity.byteGeneration]);
 const flowRef=useRef(flow);
 useEffect(()=>{flowRef.current=flow;let active=true;void adapter.current?.configure({...preferences,flow}).catch(error=>{if(active&&!(error instanceof DOMException&&error.name==='AbortError'))latest.current.onNotify(String(error))});return ()=>{active=false}},[preferences,flow]);
 const registerKeyboardTarget=props.registerKeyboardTarget;
 useEffect(()=>registerKeyboardTarget(identity.path,()=>{if(adapter.current)adapter.current.focus();else focusPending.current=true}),[registerKeyboardTarget,identity.path]);
 useEffect(()=>{if(!panel)return;const dismiss=dismissOnEscape(()=>{setPanel(null);if(opener.current?.isConnected)opener.current.focus()});const node=pane.current?.querySelector<HTMLElement>('.epub-panel input,.epub-panel button');node?.focus();return dismiss},[panel]);
 useEffect(()=>{
  if(!external)return;const previous=document.activeElement as HTMLElement|null,node=pane.current?.querySelector<HTMLElement>('.epub-external');node?.querySelector<HTMLElement>('button')?.focus();
  function key(event:KeyboardEvent){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setExternal(null)}if(event.key==='Tab'&&node){const buttons=[...node.querySelectorAll<HTMLElement>('button,a')],at=buttons.indexOf(document.activeElement as HTMLElement),next=(at+(event.shiftKey?-1:1)+buttons.length)%buttons.length;event.preventDefault();buttons[next]?.focus()}}
  window.addEventListener('keydown',key,true);return ()=>{window.removeEventListener('keydown',key,true);if(previous?.isConnected)previous.focus()};
 },[external]);
 useEffect(()=>{
  searchAbort.current?.abort();if(!query.trim()||panel!=='search'){setSearching(false);setResults(null);return}const controller=new AbortController();searchAbort.current=controller;setSearching(true);setResults(null);
  const timer=setTimeout(()=>{void (async()=>{try{for await(const batch of sessionRef.current?.find(query,controller.signal)??[]){if(!controller.signal.aborted)setResults(batch)}}catch(error){if(!controller.signal.aborted)notify(String(error))}finally{if(!controller.signal.aborted)setSearching(false)}})()},180);
  return ()=>{clearTimeout(timer);controller.abort()};
 },[query,panel]);
 function changePreferences(next:ReaderPreferences){if(next.fixed!==preferences.fixed)setFixedPrefs(next.fixed);if(next.emphasis!==preferences.emphasis||next.typography!==preferences.typography){if(props.onPreferencesChange)props.onPreferencesChange({...next,fixed:undefined});else setLocalPrefs(next)}}
 function nav(href:string,generatedId?:string){const [path,fragment]=href.split('#'),ordinal=/^section-(\d+)$/.exec(generatedId??''),candidate=ordinal?metadata?.sections[Number(ordinal[1])]:undefined,match=candidate?.href===path?candidate:metadata?.sections.find(s=>s.href===path);if(match){run(adapter.current?.navigate({sectionIndex:match.index,fragment:fragment?decodeURIComponent(fragment):undefined},'link'));closePanel()}else notify('This contents entry is unavailable.')}
 function contents(items:NonNullable<typeof metadata>['contents']):React.ReactNode{return <ol>{items.map(item=><li key={item.id}><button onClick={()=>nav(item.href,item.id)}>{item.label}</button>{item.children.length>0&&contents(item.children)}</li>)}</ol>}
 const fixed=caps?.surface==='epub-fixed',ready=!!metadata&&status.phase!=='error';
 return <div className="epub-pane" ref={pane} data-focused={props.isFocused} onPointerDown={()=>props.onFocusPane(identity.path)} onDragOver={e=>e.preventDefault()} onDrop={e=>e.preventDefault()} onContextMenu={e=>e.preventDefault()}>
  <div className="epub-toolbar" role="toolbar" aria-label="Book controls">
   <button aria-label="Contents" aria-expanded={panel==='contents'} onClick={e=>showPanel('contents',e)}>Contents</button>
   <button aria-label="Find in book" aria-expanded={panel==='search'} onClick={e=>showPanel('search',e)}>Find</button>
   <span className="epub-book-label">{metadata?.title??'EPUB reader'}</span>
   <button aria-label="Reading appearance" aria-expanded={panel==='appearance'} onClick={e=>showPanel('appearance',e)}>Aa</button>

   <select aria-label="Reading layout" value={flow} disabled={fixed} onChange={e=>setFlow(e.target.value as typeof flow)}><option value="scroll">Scroll</option><option value="pages">Pages</option></select>
  </div>
  <div className="epub-reader-body">
   <div className="epub-frame-host" ref={host}/>
   {status.phase==='loading'&&!metadata&&<div className="epub-state" role="status" aria-live="polite"><strong>Opening book…</strong><p>Reading and checking this EPUB on your device.</p></div>}
   {status.phase==='error'&&<div className="epub-state" role="alert"><strong>{status.message?.includes('DRM')?'Protected book':status.message?.includes('UNSUPPORTED')?'Unsupported EPUB feature':'Could not open this book'}</strong><p>{status.message}</p><button onClick={()=>run(props.onRetryRead(identity.path))}>Retry</button><button onClick={()=>props.onReaderCommand(identity,'close-document')}>Close book</button></div>}
   {panel&&<aside className="epub-panel" role="dialog" aria-label={panel==='contents'?'Book contents':panel==='search'?'Find in book':'Reading appearance'}>
    <div className="epub-panel-header"><span>{panel==='contents'?'Contents':panel==='search'?'Find in book':'Reading appearance'}</span><button aria-label="Close reader panel" onClick={closePanel}>×</button></div>
    {panel==='contents'&&metadata&&<><strong>{metadata.title}</strong><p>{metadata.author}</p>{contents(metadata.contents)}{metadata.pageList.length>0&&<><h3>Print pages</h3>{contents(metadata.pageList)}</>}{metadata.landmarks.length>0&&<><h3>Landmarks</h3>{contents(metadata.landmarks)}</>}</>}
    {panel==='search'&&<><label>Search all book sections<input type="search" value={query} maxLength={256} onChange={e=>setQuery(e.target.value)} /></label><p role="status" aria-live="polite">{searching?`Searching ${results?.sectionsDone??0} of ${metadata?.sections.length??0} sections…`:results?`${results.hits.length}${results.truncated?'+':''} results${results.unavailableSections.length?' · some sections unavailable':''}`:query?'No search results yet':'Enter a word or phrase'}</p>{searching&&<button onClick={()=>{searchAbort.current?.abort();setSearching(false)}}>Cancel search</button>}<ul className="epub-search-hits">{results?.hits.map((hit,i)=><li key={i}><button onClick={()=>{run(adapter.current?.navigate(hit.locator,'search'));closePanel()}}><small>Section {hit.locator.spineIndex+1}</small><br/>{hit.snippet}</button></li>)}</ul><p>Search covers linear and supplementary sections. Matching is case-insensitive and preserves diacritics.</p></>}
    {panel==='appearance'&&<>{fixed?<><p>Publisher page geometry is preserved. Word emphasis and reflow typography resume in reflowable sections.</p><label>Page fit<select value={preferences.fixed?.fit??'page'} onChange={e=>changePreferences({...preferences,fixed:{zoom:1,spreads:false,...preferences.fixed,fit:e.target.value as 'page'|'width'|'actual'}})}><option value="page">Fit page</option><option value="width">Fit width</option><option value="actual">Actual size</option></select></label><label>Zoom<input type="range" min="0.5" max="3" step="0.1" value={preferences.fixed?.zoom??1} onChange={e=>changePreferences({...preferences,fixed:{fit:'page',spreads:false,...preferences.fixed,zoom:Number(e.target.value)}})}/></label><label>Facing pages<input type="checkbox" checked={preferences.fixed?.spreads??false} onChange={e=>changePreferences({...preferences,fixed:{fit:'page',zoom:1,...preferences.fixed,spreads:e.target.checked}})}/></label></>:<>
     <label>Typeface<select value={preferences.typography.family} onChange={e=>changePreferences({...preferences,typography:{...preferences.typography,family:e.target.value as 'serif'|'sans'|'publisher'}})}><option value="serif">Serif</option><option value="sans">Sans serif</option><option value="publisher">Publisher</option></select></label>
     <label>Text size · {preferences.typography.size}px<input type="range" min="12" max="40" value={preferences.typography.size} onChange={e=>changePreferences({...preferences,typography:{...preferences.typography,size:Number(e.target.value)}})}/></label>
     <label>Line spacing · {preferences.typography.leading}<input type="range" min="1.2" max="2.2" step="0.1" value={preferences.typography.leading} onChange={e=>changePreferences({...preferences,typography:{...preferences.typography,leading:Number(e.target.value)}})}/></label>
     <label>Line width<select value={preferences.typography.measure} onChange={e=>changePreferences({...preferences,typography:{...preferences.typography,measure:e.target.value as 'compact'|'comfortable'|'wide'}})}>{['compact','comfortable','wide'].map(v=><option key={v} value={v}>{v}</option>)}</select></label>
     <label>Margins<select value={preferences.typography.margins} onChange={e=>changePreferences({...preferences,typography:{...preferences.typography,margins:e.target.value as 'small'|'medium'|'large'}})}>{['small','medium','large'].map(v=><option key={v} value={v}>{v}</option>)}</select></label>
    </>}
     <label>Theme<select aria-label="Reader theme" value={preferences.typography.theme} onChange={e=>changePreferences({...preferences,typography:{...preferences.typography,theme:e.target.value as 'follow-app'|'light'|'sepia'|'dark'}})}>{['follow-app','light','sepia','dark'].map(v=><option key={v} value={v}>{v}</option>)}</select></label><p>Appearance is browser-local. The source EPUB is read-only.</p>
    </>}
   </aside>}
  </div>
  {status.phase==='partial'&&<div className="epub-warning" role="status">{status.message}</div>}
  <div className="epub-footer"><button aria-label="Previous reading page" disabled={!ready} onClick={()=>run(adapter.current?.turn(-1))}>←</button><span className="epub-book-label">{ready?`${fixed?'Page':'Section'} ${section+1} of ${metadata.sections.length}`:'Read-only EPUB'}</span>{canReturn&&<button onClick={()=>{run(adapter.current?.returnToPrevious());setCanReturn(false)}}>Return</button>}<button aria-label="Next reading page" disabled={!ready} onClick={()=>run(adapter.current?.turn(1))}>→</button></div>
  {external&&<div className="epub-external" role="dialog" aria-modal="true" aria-label="Open external book link"><strong>Open this website?</strong><p>{external}</p><button onClick={()=>setExternal(null)}>Cancel</button><button onClick={()=>{window.open(external,'_blank','noopener,noreferrer');setExternal(null)}}>Open website</button></div>}
 </div>;
}
export default React.memo(EpubPane);
