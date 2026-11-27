import type { DiskStat, DiskVersion } from '../utils/diskVersion';
import type { VaultChangeBatch } from '../utils/vaultChanges';

export interface FileTreeFileNode {
  name: string;
  kind: 'file';
  path: string;
  handle: FileSystemFileHandle;
  parentHandle: FileSystemDirectoryHandle;
}

export interface FileTreeDirNode {
  name: string;
  kind: 'directory';
  path: string;
  handle: FileSystemDirectoryHandle;
  parentHandle: FileSystemDirectoryHandle;
  children: FileTreeNode[];
  styleFile?: FileSystemFileHandle;
}

export type FileTreeNode = FileTreeFileNode | FileTreeDirNode;

export interface ActiveFile {
  name: string;
  path: string;
  kind?: 'file' | 'directory';
  handle?: FileSystemFileHandle | FileSystemDirectoryHandle;
  parentHandle?: FileSystemDirectoryHandle;
  children?: FileTreeNode[];
  isHelp?: boolean;
}

export interface OpenTab {
  readerStatus?: import('./reading').ReaderStatus;
  readerCapabilities?: import('./reading').ReaderCapabilities;
  representation: import('./reading').DocumentRepresentation;
  id: string;
  file: ActiveFile;
  mode: EditorMode;
  dirty: boolean;
  /**
   * While it is set, the buffer is not the file's text. Nothing may write it,
   * search it, diff it for assets, or build an editor or canvas from it.
   */
  readError?: string;
  disk?: 'conflict' | 'deleted';
  diskMineLost?: boolean;
  pdfRebuild?: PdfRebuildNotice;
  diskRev?: number;
}

export interface TabPane {
  id: string;
  paths: string[];
  activePath: string;
  history: string[];
  historyIndex: number;
}

export interface TabLayout {
  panes: TabPane[];
  activeId: string | null;
  sizes?: number[];
}

export interface GraphNode {
  id: string;
  name: string;
  label: string;
  node: FileTreeFileNode | null;
  unresolved: boolean;
  degree: number;
}

export interface GraphLink {
  source: string;
  target: string;
}

export type GraphAdjacency = Record<string, string[]>;

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  backlinks: GraphAdjacency;
  outlinks: GraphAdjacency;
}

export interface TextRange {
  from: number;
  to: number;
}

export interface EditorRevealRequest extends TextRange {
  path: string;
}

export type CaretStyle = 'line' | 'block';
export type Theme = 'light' | 'dark';
export type EditorMode = 'edit' | 'read';
export type MainView = 'editor' | 'graph';

export interface StoredVault {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  openedAt: number;
  pinned?: boolean;
}

export interface RecentVault extends StoredVault {
  label: string;
  vaultPath?: string;
}

export type VaultOpenResult = 'ok' | 'denied' | 'missing' | 'error' | 'busy' | 'refused'
    | { status: 'error'; message: string };

export interface TrashItem {
  id: string;
  name: string;
  kind: 'file' | 'directory';
  origin: 'trashed' | 'retired';
  sourcePath: string;
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  parentHandle: FileSystemDirectoryHandle;
  restorePath: string;
  restoreDirHandle: FileSystemDirectoryHandle;
  deletedAt: number;
  size: number;
  children?: TrashItem[];
}

export type TrashRestoreMode = 'auto' | 'replace' | 'keep-both';

export type TrashRestoreResult =
  | { status: 'ok'; name: string; displaced?: TrashItem }
  | { status: 'collision' }
  | { status: 'error' };

export interface SettingsDefaults {
  editorFontSize: number;
  codeFontSize: number;
  rainbowBrackets: boolean;
  treeFontSize: number;
  editorPadding: number;
  tabSize: number;
  caretStyle: CaretStyle;
  caretThickness: number;
  smoothCaret: boolean;
  caretSpeed: number;
  accentColor: string;
  codeBlockColor: string;
  recentVaultLimit: number;
  showVaultInTitle: boolean;
}

export type AssetUrlResolver = (fileName: string) => Promise<string | null>;

export interface BoardOwnerAccess {
  root: FileSystemDirectoryHandle;
  parent: FileSystemDirectoryHandle;
  owner: FileSystemFileHandle;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface BoardAssetAccess extends BoardOwnerAccess {
  hash: string;
  preferredName?: string | null;
}

export interface VaultHandleIO {
  file: (handle: FileSystemFileHandle) => Promise<File>;
  fileIn: (dir: FileSystemDirectoryHandle, name: string, create?: boolean) => Promise<FileSystemFileHandle>;
  dirIn: (dir: FileSystemDirectoryHandle, name: string, create?: boolean) => Promise<FileSystemDirectoryHandle>;
  entries: (dir: FileSystemDirectoryHandle) => AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
  remove: (dir: FileSystemDirectoryHandle, name: string) => Promise<void>;
  relativeTo: (dir: FileSystemDirectoryHandle, handle: FileSystemHandle) => Promise<string[] | null>;
  sameEntry: (a: FileSystemHandle, b: FileSystemHandle) => Promise<boolean>;
}

export interface VaultProblem {
  vault: string;
  folder: string | null;
  message: string;
  missing: boolean;
}

export interface FileSystemContextValue {
  handleIO: VaultHandleIO;
  ensureVaultId: (root: FileSystemDirectoryHandle, writeFile: (handle: FileSystemFileHandle, text: string) => Promise<unknown>) => Promise<string | null>;
  rootHandle: FileSystemDirectoryHandle | null;
  getVaultActivation: () => number;
  registerBeforeRootChange: (callback: () => Promise<void>) => () => void;
  fileTree: FileTreeNode[];
  isLoading: boolean;
  vaultProblem: VaultProblem | null;
  retryVault: () => Promise<void>;
  previousVault: FileSystemDirectoryHandle | null;
  linkedVault: RecentVault | null;
  recentVaults: RecentVault[];
  currentVaultId: string | null;

  resolveVaultDir: (root: FileSystemDirectoryHandle, path: string) => Promise<FileSystemDirectoryHandle>;
  resolveVaultFile: (root: FileSystemDirectoryHandle, path: string) => Promise<{ handle: FileSystemFileHandle; parentHandle: FileSystemDirectoryHandle }>;
  verifyVaultFileIdentity: (root: FileSystemDirectoryHandle, path: string, handle: FileSystemFileHandle) => Promise<boolean>;
  vaultDirExists: (root: FileSystemDirectoryHandle, path: string) => Promise<boolean>;
  nameTaken: (dir: FileSystemDirectoryHandle, name: string) => Promise<boolean>;
  pickDirectory: () => Promise<VaultOpenResult>;
  openRecentVault: (vault: RecentVault) => Promise<VaultOpenResult>;
  openFolderAsVault: (handle: FileSystemDirectoryHandle) => Promise<VaultOpenResult>;
  openLinkedVault: () => Promise<VaultOpenResult>;
  forgetRecentVault: (id: string) => Promise<boolean>;
  pinRecentVault: (id: string, pinned: boolean) => Promise<boolean>;
  readFileSnapshot: (handle: FileSystemFileHandle, signal?: AbortSignal) => Promise<import('./reading').ReadOnlyFileSnapshot>;
  readFile: (fileHandle: FileSystemFileHandle) => Promise<string>;
  writeFile: (fileHandle: FileSystemFileHandle, content: string) => Promise<void>;
  readFileBytes: (fileHandle: FileSystemFileHandle) => Promise<Uint8Array>;
  writeFileBytes: (fileHandle: FileSystemFileHandle, bytes: Uint8Array) => Promise<void>;
  importFiles: (files: FileList | File[], targetDir: FileSystemDirectoryHandle) => Promise<string[]>;
  createFile: (parentDirHandle: FileSystemDirectoryHandle, fileName: string) => Promise<FileSystemFileHandle>;
  createFolder: (parentDirHandle: FileSystemDirectoryHandle, folderName: string) => Promise<FileSystemDirectoryHandle>;
  getAssetUrl: (fileName: string, parentDirHandle?: FileSystemDirectoryHandle | null) => Promise<string | null>;
  saveAsset: (fileName: string, blob: Blob, parentDirHandle?: FileSystemDirectoryHandle | null) => Promise<void>;
  readBoardAsset: (request: BoardAssetAccess) => Promise<{ name: string; blob: Blob } | null>;
  readLegacyBoardAsset: (request: BoardOwnerAccess & { src: string }) => Promise<Blob | null>;
  putBoardAsset: (request: BoardAssetAccess & { extension: string; blob: Blob }) => Promise<string>;
  writeBoardCopy: (request: BoardOwnerAccess & { names: Iterable<string>; bytes: (files: ReadonlyMap<string, string>) => Promise<Blob>;
    media: readonly { hash: string; extension: string; blob: Blob }[] }) => Promise<{ name: string; path: string; handle: FileSystemFileHandle; version: DiskVersion; bytes: Blob }>;
  keepConversionBackup: (request: BoardAssetAccess & { blob: Blob }) => Promise<TrashItem>;
  restoreConversionCopy: (request: BoardAssetAccess, item: TrashItem) => Promise<string>;
  copyTrashFile: (item: TrashItem, root: FileSystemDirectoryHandle, isCurrent: () => boolean) => Promise<string>;
  retireAsset: (fileName: string, dirHandle: FileSystemDirectoryHandle, guard: () => boolean) => Promise<boolean>;
  restoreAsset: (fileName: string, dirHandle: FileSystemDirectoryHandle, guard: () => boolean) => Promise<boolean>;
  restoreVault: () => Promise<void>;
  requestIndexPermission: (root: FileSystemDirectoryHandle, activation: number) => Promise<boolean>;
  moveToTrash: (node: FileTreeNode) => Promise<boolean>;
  keepCopyInGarbage: (dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array) => Promise<string>;
  listTrash: () => Promise<TrashItem[]>;
  restoreFromTrash: (item: TrashItem, mode: TrashRestoreMode) => Promise<TrashRestoreResult>;
  deleteFromTrash: (item: TrashItem) => Promise<boolean>;
  emptyTrash: () => Promise<{ removed: number; failed: number }>;
  moveFile: (sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle) => Promise<boolean>;
  renameFile: (sourceNode: FileTreeNode, newName: string) => Promise<boolean>;

  readFileVersioned: (fileHandle: FileSystemFileHandle) => Promise<{ text: string; version: DiskVersion }>;
  readBytesVersioned: (fileHandle: FileSystemFileHandle) => Promise<{ bytes: Uint8Array; version: DiskVersion }>;
  inspectExportTarget: (dir: FileSystemDirectoryHandle, name: string) => Promise<DiskVersion | null>;
  writeNotebookExport: (dir: FileSystemDirectoryHandle, parentPath: string, name: string, bytes: Uint8Array, expected: DiskVersion | null, isCurrent: () => boolean) => Promise<{ status: 'written'; version: DiskVersion } | { status: 'changed' | 'cancelled' }>;
  statFile: (fileHandle: FileSystemFileHandle) => Promise<DiskStat | null>;
  writeFileVersioned: (fileHandle: FileSystemFileHandle, data: string | Uint8Array | Blob, expected: DiskVersion | null) => Promise<VersionedWriteResult>;
  writeConflictCopy: (filePath: string, data: string | Uint8Array | Blob, vaultRoot?: FileSystemDirectoryHandle | null, guard?: () => boolean) => Promise<string>;
  writeDistinctCopy: (parent: FileSystemDirectoryHandle, parentPath: string, name: string, data: Blob, isCurrent: () => boolean) => Promise<{
    path: string; name: string; handle: FileSystemFileHandle; version: DiskVersion;
  }>;
  recreateFile: (filePath: string, data: string | Uint8Array | Blob) => Promise<
    { status: 'written'; version: DiskVersion; handle: FileSystemFileHandle } | { status: 'exists' }>;
  resolveFileHandle: (filePath: string) => Promise<FileSystemFileHandle | null>;
  subscribeVaultChanges: (listener: (batch: VaultChangeBatch) => void) => () => void;
  liveDetection: 'observer' | 'polling' | 'off';
}

export interface ContentChangeOptions {
  fromDisk?: boolean;
  fromJournal?: boolean;
}

export type DiskAction = 'reload' | 'keep' | 'save' | 'close' | 'retry' | 'keep-pdf' | 'rebuild-pdf';

export interface PdfRebuildNotice {
  state: 'foreign' | 'kept';
  generation: string;
  reason?: 'mismatch' | 'unsupported' | 'malformed';
  approved?: boolean;
  copyName?: string;
  error?: string;
}

export type VersionedWriteResult =
  | { status: 'written'; version: DiskVersion }
  | { status: 'changed'; disk: { bytes: Uint8Array; version: DiskVersion } }
  | { status: 'deleted' };

export type OpenNodeHandler = (graphNode: GraphNode) => void;
export type OpenNoteByNameHandler = (name: string | null) => void;

type FileSystemPermissionMode = 'read' | 'readwrite';

interface FileSystemHandlePermissionDescriptor {
  mode?: FileSystemPermissionMode;
}

declare global {
  interface FileSystemHandle {
    queryPermission(
      descriptor?: FileSystemHandlePermissionDescriptor
    ): Promise<PermissionState>;
    requestPermission(
      descriptor?: FileSystemHandlePermissionDescriptor
    ): Promise<PermissionState>;
  }

  interface DirectoryPickerOptions {
    id?: string;
    mode?: FileSystemPermissionMode;
    startIn?: FileSystemHandle | string;
  }

  interface Window {
    showDirectoryPicker(
      options?: DirectoryPickerOptions
    ): Promise<FileSystemDirectoryHandle>;
  }

  type FileSystemChangeType = 'appeared' | 'disappeared' | 'modified' | 'moved' | 'unknown' | 'errored';

  interface FileSystemChangeRecord {
    readonly root: FileSystemHandle;
    readonly changedHandle: FileSystemHandle | null;
    readonly relativePathComponents: readonly string[];
    readonly type: FileSystemChangeType;
    readonly relativePathMovedFrom: readonly string[] | null;
  }

  interface FileSystemObserverObserveOptions {
    recursive?: boolean;
  }

  type FileSystemObserverCallback = (records: FileSystemChangeRecord[], observer: FileSystemObserver) => void;

  interface FileSystemObserver {
    observe(handle: FileSystemHandle, options?: FileSystemObserverObserveOptions): Promise<void>;
    unobserve(handle: FileSystemHandle): void;
    disconnect(): void;
  }

  var FileSystemObserver: {
    prototype: FileSystemObserver;
    new (callback: FileSystemObserverCallback): FileSystemObserver;
  } | undefined;
}
