import type { DiskStat, DiskVersion } from '../utils/diskVersion';
// Import-light runtime seam, structurally compatible with the host reading types.
export interface ReaderToken { vaultId: string; vaultEpoch: number; documentId: string; byteGeneration: number }
export interface ReaderIdentity extends ReaderToken { path: string; diskRev: number; rawVersion?: DiskVersion }
export interface ReadOnlyFileSnapshot { snapshotId: string; blob: Blob; stat: DiskStat; fingerprint(signal?: AbortSignal): Promise<DiskVersion>; dispose(): void }
export type ReaderFlow = 'scroll' | 'pages';
export type LocationCause = 'restore' | 'layout' | 'user-scroll' | 'user-navigation' | 'search' | 'link' | 'annotation';
export interface SectionKey { spineOccurrence: number; spineIndex: number; normalizedHref: string }
export interface EpubTextLocator extends SectionKey { kind: 'text'; chapterDigest: string; offsetUTF16: number; affinity: 'before' | 'after'; quote: string; before: string; after: string; cfi?: string; alignHint?: number }
export interface EpubFixedLocator extends SectionKey { kind: 'fixed'; sectionDigest: string; elementId?: string; viewport: { x: number; y: number; zoom: number }; printLabel?: string }
export type EpubLocator = EpubTextLocator | EpubFixedLocator;
export interface EpubReadingRecord { v: 1; kind: 'epub'; rawFingerprint: string; parserSchema: 1; sanitizerSchema: 1; projectionSchema: 1; requestedLayout: ReaderFlow; locator: EpubLocator }
export interface ReaderCapabilities { surface: 'epub-reflow' | 'epub-fixed'; emphasis: {kind: 'toggle'} | {kind: 'inactive'; reason: string}; text: 'available' | 'partial' | 'none'; find: boolean; appearance: 'reflow' | 'fixed'; copy: boolean }
export interface ReaderStatus { phase: 'loading' | 'ready' | 'partial' | 'stale' | 'missing' | 'error'; message?: string; progress?: { done: number; total?: number } }
export interface Typography { family: 'serif' | 'sans' | 'publisher'; size: number; leading: number; measure: 'compact' | 'comfortable' | 'wide'; margins: 'small' | 'medium' | 'large'; theme: 'follow-app' | 'light' | 'sepia' | 'dark' }
export interface ReaderPreferences { emphasis: { enabled: boolean; algorithm?: string }; typography: Typography; flow?: ReaderFlow; appTheme?: 'light' | 'dark'; fixed?: { fit: 'page' | 'width' | 'actual'; zoom: number; spreads: boolean } }
export interface XmlNode { name: string; ns: string; attrs: Record<string, string>; children: (XmlNode | string)[] }
export interface ResourceDescriptor { id: string; type: string; properties: string; size: number }
export interface ArchiveSection { index: number; href: string; mediaType: string; properties: string; linear: boolean; occurrence: number; fallback?: string }
export interface ArchiveInfo { resources: ResourceDescriptor[]; spine: ArchiveSection[]; opfPath: string; warnings: string[] }
export interface ResourceData { type: string; text?: string; model?: XmlNode; bytes?: Uint8Array }
export interface ContentsItem { id: string; label: string; href: string; children: ContentsItem[] }
export interface EpubMetadata { title: string; author: string; language: string; direction: 'ltr' | 'rtl'; contents: ContentsItem[]; pageList: ContentsItem[]; landmarks: ContentsItem[]; sections: ArchiveSection[]; warnings: string[] }
export interface FindHit { locator: EpubTextLocator; snippet: string }
export interface FindBatch { queryId: string; hits: FindHit[]; done: boolean; sectionsDone: number; sectionsTotal: number; truncated: boolean; unavailableSections: number[] }
export interface CanonicalSelection { text: string; anchor: EpubTextLocator; focus: EpubTextLocator }
export type ReaderHostCommand = 'next-document' | 'previous-document' | 'close-document' | 'reopen-document' | 'find' | 'dismiss' | 'read-only-mode';
export interface ReaderEvents {
 onStatus?(status: ReaderStatus): void;
 onCapabilities?(capabilities: ReaderCapabilities): void;
 onLocation?(locator: EpubLocator, cause: LocationCause): void;
 onSelection?(selection: CanonicalSelection | null): void;
 onVisibleText?(text: string): void;
 onContextMenu?(x: number, y: number, selection: CanonicalSelection | null): void;
 onExternalLink?(url: string): void;
 onFocus?(): void;
 onCommand?(command: ReaderHostCommand): void;
 onMetadata?(metadata: EpubMetadata): void;
}
export interface ReaderAdapter {
 navigate(locator: EpubLocator | { sectionIndex: number; fragment?: string }, cause?: LocationCause): Promise<void>;
 captureAnchor(): Promise<EpubLocator | null>;
 configure(preferences: ReaderPreferences): Promise<void>;
 canonicalSelection(): Promise<CanonicalSelection | null>;
 turn(delta: -1 | 1): Promise<void>;
 returnToPrevious(): Promise<void>;
 focus(): void;
 dispose(): void;
}
export interface EpubSession {
 metadata: EpubMetadata;
 capabilities: ReaderCapabilities;
 mount(container: HTMLElement, events: ReaderEvents): Promise<ReaderAdapter>;
 find(query: string, signal?: AbortSignal): AsyncIterable<FindBatch>;
 dispose(): void;
}
export interface SessionOptions { initialRecord?: EpubReadingRecord; preferences?: ReaderPreferences; onVersion?(version: DiskVersion): void }
export const DEFAULT_PREFERENCES: ReaderPreferences = { emphasis: {enabled: false}, typography: {family: 'serif', size: 18, leading: 1.6, measure: 'comfortable', margins: 'medium', theme: 'follow-app'}, flow: 'scroll', fixed: {fit: 'page', zoom: 1, spreads: false} };
export const EPUB_LIMITS = Object.freeze({archive: 256*1024*1024, directory: 16*1024*1024, entries: 20000, declared: 512*1024*1024, text: 4*1024*1024, font: 8*1024*1024, binary: 32*1024*1024, encoded: 128*1024*1024, appEncoded: 256*1024*1024, imagePixels: 16*1024*1024, nodes: 100000, depth: 128, payload: 256*1024, roots: 5});
