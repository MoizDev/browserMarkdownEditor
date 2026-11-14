import type { OpenTab, EditorMode } from '../types';
import type { DocumentRepresentation, LoadedDocumentKind, ReaderCapabilities, ReaderIdentity, ReaderToken } from '../types/reading';
import { isCanvasFile,isCodeFile,isDrawingFile,isEpubFile,isMarkdownFile,isNotebookFile,isPdfFile,isTexFile } from './fileTypes';
import { isTextFile } from './vaultSearch';
import { canvasReadOnlyReason, sniffCanvas } from './canvasFormat';
import { routeEngines, type CanvasEngineKind } from './engineRouting';

/** Applied once when native representation is acquired, including PDF ink.
 * A pane and its App-owned session must use this same frozen authority. */
export function withNativeCanvasPolicy(representation:DocumentRepresentation,kind:CanvasEngineKind):DocumentRepresentation {
 return {...representation,nativeCanvasKind:kind,emergencyReadOnly:routeEngines(kind).canvas[kind].emergencyReadOnly};
}
export function classifyRequestedKind(name:string,isHelp=false):LoadedDocumentKind {
 if(isHelp||isMarkdownFile(name))return 'markdown';
 if(isEpubFile(name))return 'epub';if(isPdfFile(name))return 'pdf';
 if(isDrawingFile(name))return 'drawing';if(isNotebookFile(name))return 'notebook';
 // Native canvases must not inherit text write authority in the guard build.
 if(isCanvasFile(name))return 'unsupported';
 if(isTexFile(name))return 'tex';if(isCodeFile(name))return 'code';return isTextFile(name)?'text':'unsupported';
}
export function opensInApp(name:string):boolean{return isTextFile(name)||isPdfFile(name)||isEpubFile(name)}
export function representationFor(name:string,isHelp=false,generation=0,unavailable=false):DocumentRepresentation {
 const loadedKind=classifyRequestedKind(name,isHelp),binary=loadedKind==='epub'||loadedKind==='pdf'||loadedKind==='unsupported';
 return {generation,loadedKind,status:unavailable?'unavailable':'ready',bufferKind:binary?'unavailable':'text',contentWritable:!unavailable&&!binary&&!isHelp};
}
// Every App tab transition passes here, including restore, disk reload and
// retarget. Guarding just the pane would still let a clean Cmd+S replace bytes.
export function classifyLoadedTabs(next: OpenTab[], previous: OpenTab[]): OpenTab[] {
 if (next === previous) return next;
 const byId = new Map(previous.map(tab => [tab.id, tab]));
 return next.map(tab => {
  const r = tab.representation;
  if (r.loadedKind !== 'drawing' && r.loadedKind !== 'notebook') return tab;
  const before = byId.get(tab.id);
  // Other documents' keystrokes and this tab's dirty/selection changes must
  // not lex an unchanged multi-megabyte canvas again.
  const unchanged = before && before.content === tab.content && before.file.name === tab.file.name
   && before.representation.loadedKind === r.loadedKind && before.representation.status === 'ready'
   && before.representation.bufferKind === 'text' && !before.readError;
  const sniff = unchanged ? undefined : sniffCanvas(tab.content, tab.file.name);
  const policy = sniff?.format === 'native' && !r.nativeCanvasKind
   ? withNativeCanvasPolicy(r, r.loadedKind === 'notebook' ? 'notebook' : 'drawing') : r;
  const writable = policy.status === 'ready' && policy.bufferKind === 'text' && !tab.readError && !tab.file.isHelp
   && (unchanged ? before.representation.contentWritable : !canvasReadOnlyReason(sniff!));
  return policy === r && r.contentWritable === writable ? tab : {...tab, representation: {...policy, contentWritable: writable}};
 });
}
export function canReadTabText(tab:OpenTab):boolean{return !tab.readError&&tab.representation?.status==='ready'&&tab.representation.bufferKind==='text'}
export function canUpdateTabContent(tab:OpenTab,source:'user'|'disk'|'annotation'='user'):boolean {
 const r=tab.representation;if(!r||tab.readError||r.status!=='ready'||r.loadedKind==='epub'||r.loadedKind==='unsupported'||tab.file.isHelp)return false;
 if(r.emergencyReadOnly && source!=='disk')return false;
 return (r.bufferKind==='text'&&r.contentWritable)||(r.loadedKind==='pdf'&&source==='annotation');
}
export function canFlushTab(tab:OpenTab):boolean {return !tab.representation?.emergencyReadOnly&&(canUpdateTabContent(tab)||(!tab.readError&&tab.representation?.status==='ready'&&tab.representation.loadedKind==='pdf'&&tab.representation.bufferKind==='annotationSnapshot'&&tab.representation.contentWritable))}
export function canChangeTabMode(tab:OpenTab,_mode?:EditorMode):boolean {return !tab.file.isHelp&&!tab.readError&&tab.representation?.status==='ready'&&!['epub','unsupported','drawing','notebook'].includes(tab.representation.loadedKind)}
export function readingCapabilities(tab:OpenTab,live?:ReaderCapabilities):ReaderCapabilities {
 if(tab.readerStatus && ['error','missing','stale','loading'].includes(tab.readerStatus.phase)) return {surface:'unsupported',emphasis:{kind:'inactive',reason:tab.readerStatus.message??'Reading content is unavailable'},text:'none',find:false,appearance:'none',copy:false};
 const kind=tab.representation?.loadedKind;
 const base:ReaderCapabilities={surface:'unsupported',emphasis:{kind:'inactive',reason:'No readable prose in this view'},text:'none',find:false,appearance:'none',copy:false};
 if(tab.readError||tab.representation?.status!=='ready')return base;
 if(live)return live;
 if(kind==='epub')return {...base,emphasis:{kind:'inactive',reason:'Opening book; reading capabilities are not available yet'}};
 if(kind==='pdf')return {...base,surface:tab.mode==='edit'?'pdf-annotation':'pdf-original',emphasis:{kind:'inactive',reason:'Checking original PDF text for Word emphasis'}};
 if(!canReadTabText(tab)||isCanvasFile(tab.file.name)||kind==='code'||kind==='tex')return base;
 return {...base,surface:tab.mode==='read'?'markdown-read':'edit',text:'available',copy:true,find:true,emphasis:tab.mode==='read'?{kind:'toggle'}:{kind:'inactive',reason:'Switch to Reading mode to apply Word emphasis'}};
}
export interface ReadingSurfaceController {capabilities():ReaderCapabilities;showPdfText?():Promise<void>;showPdfOriginal?():Promise<void>;findReading?():void;showBookPanel?(panel:'contents'|'search'|'appearance'):void;bookFlow?():import('../types/reading').ReaderFlow;setBookFlow?(flow:import('../types/reading').ReaderFlow):void;captureReading?():Promise<void>;focusReading():void}
const surfaces=new Map<string,{identity:ReaderIdentity;controller:ReadingSurfaceController}>(),listeners=new Set<()=>void>();
export function sameReaderToken(a:ReaderToken,b:ReaderToken):boolean{return a.vaultId===b.vaultId&&a.vaultEpoch===b.vaultEpoch&&a.documentId===b.documentId&&a.byteGeneration===b.byteGeneration}
export function registerReadingSurface(identity:ReaderIdentity,controller:ReadingSurfaceController):()=>void {const entry={identity,controller};surfaces.set(identity.documentId,entry);listeners.forEach(f=>f());return ()=>{if(surfaces.get(identity.documentId)===entry){surfaces.delete(identity.documentId);listeners.forEach(f=>f())}}}
export function getReadingSurface(identity:ReaderToken):ReadingSurfaceController|undefined {const e=surfaces.get(identity.documentId);return e&&sameReaderToken(e.identity,identity)?e.controller:undefined}
export function subscribeReadingSurface(_id:string,listener:()=>void):()=>void{listeners.add(listener);return ()=>listeners.delete(listener)}

// The opaque reader reports semantic commands. App validates their full token
// before handing them to the same workspace navigation/focus path as host keys.
let readerHostCommand:((command:import('../types/reading').ReaderHostCommand)=>void)|undefined;
export function registerReaderHostCommands(handler:NonNullable<typeof readerHostCommand>):()=>void {readerHostCommand=handler;return ()=>{if(readerHostCommand===handler)readerHostCommand=undefined}}
export function runReaderHostCommand(command:import('../types/reading').ReaderHostCommand):boolean {if(!readerHostCommand)return false;readerHostCommand(command);return true}
