import type { DiskStat, DiskVersion } from '../utils/diskVersion';
export type LoadedDocumentKind = 'markdown'|'text'|'code'|'tex'|'drawing'|'notebook'|'pdf'|'epub'|'unsupported';
export interface DocumentRepresentation { generation:number; loadedKind:LoadedDocumentKind; status:'loading'|'ready'|'unavailable'; bufferKind:'text'|'annotationSnapshot'|'unavailable'; contentWritable:boolean }
export interface ReaderToken { vaultId:string; vaultEpoch:number; documentId:string; byteGeneration:number }
export interface ReaderIdentity extends ReaderToken { path:string; diskRev:number; rawVersion?:DiskVersion }
export interface ReadOnlyFileSnapshot { snapshotId:string; blob:Blob; stat:DiskStat; fingerprint(signal?:AbortSignal):Promise<DiskVersion>; dispose():void }
export type Affinity='before'|'after';
export interface Utf16Range {from:number;to:number}
export interface TextContext {quote:string;before:string;after:string}
export type ReaderFlow='scroll'|'pages';
export type ReadingSurface='markdown-read'|'edit'|'epub-reflow'|'epub-fixed'|'pdf-original'|'pdf-text'|'pdf-annotation'|'unsupported';
export type EmphasisAvailability={kind:'toggle'}|{kind:'pdf-text-action'}|{kind:'inactive';reason:string};
export interface ReaderCapabilities {surface:ReadingSurface;emphasis:EmphasisAvailability;text:'available'|'partial'|'none';find:boolean;appearance:'reflow'|'fixed'|'none';copy:boolean}
export interface ReaderStatus {phase:'loading'|'ready'|'partial'|'stale'|'missing'|'error';message?:string;progress?:{done:number;total?:number}}
export type LocationCause='restore'|'layout'|'user-scroll'|'user-navigation'|'search'|'link'|'annotation';
export interface EpubSectionKey {spineOccurrence:number;spineIndex:number;normalizedHref:string}
export interface EpubTextLocator extends EpubSectionKey,TextContext {kind:'text';chapterDigest:string;offsetUTF16:number;affinity:Affinity;cfi?:string;alignHint?:number}
export interface EpubFixedLocator extends EpubSectionKey {kind:'fixed';sectionDigest:string;elementId?:string;viewport:{x:number;y:number;zoom:number};printLabel?:string}
export type EpubLocator=EpubTextLocator|EpubFixedLocator;
export interface EpubReadingRecord {v:1;kind:'epub';rawFingerprint:string;parserSchema:1;sanitizerSchema:1;projectionSchema:1;requestedLayout:ReaderFlow;locator:EpubLocator}
export interface PdfTextAnchor extends TextContext {physicalPageIndex:number;offsetUTF16:number;affinity:Affinity;alignHint?:number}
export interface PdfTextReadingRecord {v:1;surface:'original'|'text';rawFingerprint:string;extractionSchema:1;pageDigest?:string;textAnchor?:PdfTextAnchor;originalCheckpoint:{page:number;offset:number;zoom:number;navigationRevision:number};textNavigationRevision:number}
export type ReaderLocation={kind:'epub';value:EpubReadingRecord}|{kind:'pdf-text';value:PdfTextReadingRecord};
export type ReaderHostCommand='next-document'|'previous-document'|'close-document'|'reopen-document'|'find'|'dismiss'|'read-only-mode';
export interface ReadingTypography {family:'serif'|'sans'|'publisher';size:number;leading:number;measure:'compact'|'comfortable'|'wide';margins:'small'|'medium'|'large';theme:'follow-app'|'light'|'sepia'|'dark'}
export interface ReaderCallbacks {
 onReaderVersion(token:ReaderToken,version:DiskVersion):void;
 onReaderStatus(token:ReaderToken,status:ReaderStatus):void;
 onReaderCapabilities(token:ReaderToken,caps:ReaderCapabilities):void;
 onReaderLocation(token:ReaderToken,location:ReaderLocation,cause:LocationCause):void;
 onNotify(message:string):void;
}
export interface PdfReadingBinding extends ReaderCallbacks {identity:ReaderIdentity;initialRecord?:PdfTextReadingRecord;emphasisEnabled:boolean;typography:ReadingTypography;onEmphasisChange(enabled:boolean):void;onTypographyChange(typography:ReadingTypography):void;registerKeyboardTarget(path:string,take:()=>void):()=>void}
export interface ReaderIntegration extends ReaderCallbacks {
 identityForTab(tab:import('./index').OpenTab):ReaderIdentity;
 acquireSnapshot(identity:ReaderIdentity,signal:AbortSignal):Promise<ReadOnlyFileSnapshot>;
 onReaderCommand(token:ReaderToken,command:ReaderHostCommand):void;
}
