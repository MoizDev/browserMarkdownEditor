// src/types/index.ts
// Single source of truth for cross-cutting domain types.
// Derived from the real runtime shapes; see the Conversion Bible for citations.
//
// NOTE on File System Access API types: FileSystemDirectoryHandle and
// FileSystemFileHandle are provided by lib.dom.d.ts. The picker/permission
// methods (showDirectoryPicker / queryPermission / requestPermission) are NOT
// in stock lib.dom and are augmented at the bottom of this file via
// `declare global`. Because this module is part of the `tsconfig` `include`,
// that augmentation is loaded globally for every other module.

import type { ReactNode, CSSProperties } from 'react';

/* ─────────────────────────────────────────────────────────────────────────
 * FILE TREE
 * Produced by buildFileTree() in FileSystemContext (FileSystemContext.jsx:29-67).
 * A discriminated union on `kind`. Directories carry `children`; files do not.
 * Both carry `handle` + `parentHandle`. The union is consumed by
 * FileExplorer, TreeNode, App (findNode/handleFileClick), and graph.js.
 * ───────────────────────────────────────────────────────────────────────── */

export interface FileTreeFileNode {
  name: string;                            // FileSystemContext.jsx:51
  kind: 'file';                            // FileSystemContext.jsx:52  (discriminant)
  path: string;                            // FileSystemContext.jsx:53  e.g. "folder/note.md"
  handle: FileSystemFileHandle;            // FileSystemContext.jsx:54
  parentHandle: FileSystemDirectoryHandle; // FileSystemContext.jsx:55
}

export interface FileTreeDirNode {
  name: string;                            // FileSystemContext.jsx:42
  kind: 'directory';                       // FileSystemContext.jsx:43  (discriminant)
  path: string;                            // FileSystemContext.jsx:44
  handle: FileSystemDirectoryHandle;       // FileSystemContext.jsx:45
  parentHandle: FileSystemDirectoryHandle; // FileSystemContext.jsx:46
  children: FileTreeNode[];                // FileSystemContext.jsx:47 (recursive)
}

/** The recursive file/folder tree node union. */
export type FileTreeNode = FileTreeFileNode | FileTreeDirNode;

// ── Aliases (so consumers using the Data-Flow naming resolve identically) ──
/** Alias of FileTreeFileNode (Data-Flow dimension naming). */
export type VaultFileNode = FileTreeFileNode;
/** Alias of FileTreeDirNode (Data-Flow dimension naming). */
export type VaultDirNode = FileTreeDirNode;
/** Alias of FileTreeNode (Data-Flow / graph dimension naming). */
export type FileNode = FileTreeNode;

/* ─────────────────────────────────────────────────────────────────────────
 * ACTIVE FILE
 * App.activeFile (App.jsx:29) holds one of THREE differently-shaped values:
 *   (a) a real file node from the tree           (handleFileClick, App.jsx:199)
 *   (b) a synthetic node built on file creation   (App.jsx:294-300) — same shape as a file node
 *   (c) the Help pseudo-file: { name, isHelp:true, path } NO handle/parentHandle
 *       (handleHelpClick, App.jsx:271)
 * Code guards on `activeFile.isHelp` (App.jsx:278,313,373,384,388) and on
 * `activeFile.handle`/`activeFile.parentHandle` (App.jsx:280,339; EditorPane.jsx:112,177).
 * Model it as: a file-node-like shape with handles OPTIONAL and an isHelp flag,
 * so every existing guard/property read type-checks WITHOUT a runtime change.
 * ───────────────────────────────────────────────────────────────────────── */

/** The synthetic "Help Guide" pseudo-file (App.jsx:271). No handle/parentHandle/kind/children. */
export interface HelpNode {
  name: string;          // 'Help Guide'
  path: string;          // 'help-guide'
  isHelp: true;          // discriminant
}

/**
 * What App's `activeFile` state can hold over time. A union-friendly superset:
 * every field a real/synthetic file node has, plus the optional `isHelp` flag,
 * with handle-bearing fields optional so the Help node satisfies it too.
 */
export interface ActiveFile {
  name: string;
  path: string;
  kind?: 'file' | 'directory';              // present for real/synthetic file nodes; absent for help
  handle?: FileSystemFileHandle | FileSystemDirectoryHandle; // absent for the Help doc
  parentHandle?: FileSystemDirectoryHandle;  // absent for the Help doc
  children?: FileTreeNode[];                 // only on directory nodes
  isHelp?: boolean;                          // App.jsx:271 — true only for the Help pseudo-file
}

/* ─────────────────────────────────────────────────────────────────────────
 * GRAPH MODEL
 * Built by buildGraph() (graph.js:71-142). Node objects are documented at
 * graph.js:66-69 and constructed at graph.js:82-89 (resolved) & 110-117
 * (unresolved placeholder). Consumed by GraphView, BacklinksPanel, App,
 * EditorPane (via getBacklinkNodes).
 * ───────────────────────────────────────────────────────────────────────── */

export interface GraphNode {
  id: string;                            // graph.js:83  resolved => file.path; unresolved => `unresolved:<key>`
  name: string;                          // graph.js:84  baseName(file.name) (no .md)
  label: string;                         // graph.js:85  resolved => full file name; unresolved => baseName
  node: FileTreeFileNode | null;         // graph.js:86  the md file node, or null when unresolved
  unresolved: boolean;                   // graph.js:87  true for placeholder targets (graph.js:115)
  degree: number;                        // graph.js:88  mutated at graph.js:137-138 (++)
}

export interface GraphLink {
  source: string;                        // graph.js:127  a GraphNode.id (file path or unresolved:* )
  target: string;                        // graph.js:127  a GraphNode.id
}

/** Adjacency-style maps keyed by GraphNode.id -> list of GraphNode.ids. */
export type GraphAdjacency = Record<string, string[]>; // graph.js:128-129 (backlinks/outlinks)

export interface GraphData {
  nodes: GraphNode[];                    // graph.js:141
  links: GraphLink[];                    // graph.js:141
  backlinks: GraphAdjacency;             // graph.js:141  { [targetId]: sourceId[] }
  outlinks: GraphAdjacency;              // graph.js:141  { [sourceId]: targetId[] }
}

// ── Aliases for the graph object (different dimensions named it differently) ──
/** Alias of GraphData (Data-Flow dimension naming). */
export type Graph = GraphData;
/** Alias of GraphData (Components dimension naming). */
export type LinkGraph = GraphData;

/* ─────────────────────────────────────────────────────────────────────────
 * STRING-LITERAL UNIONS (app-level modes / themes / caret)
 * ───────────────────────────────────────────────────────────────────────── */

export type CaretStyle = 'line' | 'block';      // SettingsPanel.jsx:94,100 ; App.jsx:55
export type Theme = 'light' | 'dark';           // App.jsx:43 ; default 'dark'
export type EditorMode = 'edit' | 'read';       // App.jsx:34 ; toggled App.jsx:374
export type MainView = 'editor' | 'graph';      // App.jsx:37,508

/* ─────────────────────────────────────────────────────────────────────────
 * SETTINGS
 * The DEFAULTS object is the canonical shape (SettingsPanel.jsx:3) and is what
 * onResetDefaults receives (App.jsx:138 handleResetDefaults). Each field also
 * lives as discrete App state (App.jsx:46-58).
 * ───────────────────────────────────────────────────────────────────────── */

/** Shape of SettingsPanel's DEFAULTS const and the onResetDefaults payload. */
export interface SettingsDefaults {
  editorFontSize: number;                // SettingsPanel.jsx:3 (16)
  treeFontSize: number;                  // (13)
  editorPadding: number;                 // (6)
  caretStyle: CaretStyle;                // ('line')
  caretThickness: number;                // (10)
  smoothCaret: boolean;                  // (true)
  caretSpeed: number;                    // (80)
}

/* ─────────────────────────────────────────────────────────────────────────
 * ASSET URL RESOLVER
 * The editor subsystem (livePreview, ImageWidget) consumes a CURRIED, single-arg
 * resolver (EditorPane curries the 2-arg context getAssetUrl at EditorPane.jsx:110/112).
 * Both the bound form and the context success/failure path return Promise<string|null>.
 * ───────────────────────────────────────────────────────────────────────── */

/** The single-argument, bound asset resolver used inside src/editor/*. */
export type AssetUrlResolver = (fileName: string) => Promise<string | null>;

/* ─────────────────────────────────────────────────────────────────────────
 * FILE SYSTEM CONTEXT VALUE
 * The exact object assembled at FileSystemContext.jsx:357-374 and returned by
 * useFileSystem() (FileSystemContext.jsx:383-389). Signatures inferred from the
 * useCallback definitions (line cited per member). Consumed by App (App.jsx:13)
 * and EditorPane (EditorPane.jsx:20).
 * ───────────────────────────────────────────────────────────────────────── */

export interface FileSystemContextValue {
  // ── state ──
  rootHandle: FileSystemDirectoryHandle | null;          // FileSystemContext.jsx:70
  fileTree: FileTreeNode[];                               // FileSystemContext.jsx:71
  isLoading: boolean;                                     // FileSystemContext.jsx:72
  previousVault: FileSystemDirectoryHandle | null;       // FileSystemContext.jsx:73

  // ── actions ──
  pickDirectory: () => Promise<void>;                    // FileSystemContext.jsx:118
  readFile: (fileHandle: FileSystemFileHandle) => Promise<string>;            // :143
  writeFile: (fileHandle: FileSystemFileHandle, content: string) => Promise<void>; // :151
  // createFile/createFolder accept the parent dir handle (non-null; guarded at call sites)
  createFile: (parentDirHandle: FileSystemDirectoryHandle, fileName: string) => Promise<FileSystemFileHandle>;   // :161
  createFolder: (parentDirHandle: FileSystemDirectoryHandle, folderName: string) => Promise<FileSystemDirectoryHandle>; // :176
  getAssetUrl: (fileName: string, parentDirHandle?: FileSystemDirectoryHandle | null) => Promise<string | null>; // :188
  saveAsset: (fileName: string, blob: Blob, parentDirHandle?: FileSystemDirectoryHandle | null) => Promise<void>; // :218
  restoreVault: () => Promise<void>;                     // :241
  moveToTrash: (node: FileTreeNode) => Promise<boolean>; // :260
  moveFile: (sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle) => Promise<boolean>; // :297
  renameFile: (sourceNode: FileTreeNode, newName: string) => Promise<boolean>; // :329
  refreshTree: () => Promise<void>;                      // :373 — zero-arg public wrapper of the internal (handle) => Promise<void>
}

/* ─────────────────────────────────────────────────────────────────────────
 * SHARED CALLBACK / PROP ALIASES (used across multiple buckets)
 * ───────────────────────────────────────────────────────────────────────── */

/** Open a note from the tree (App.handleFileClick, App.jsx:185). */
export type OpenFileHandler = (node: FileTreeNode) => void | Promise<void>;
/** Open a note from a graph node, skipping unresolved (App.handleOpenNode, App.jsx:239). */
export type OpenNodeHandler = (graphNode: GraphNode) => void;
/** Open a note by its (base)name (App.openNoteByName, App.jsx:228). Called with string | null. */
export type OpenNoteByNameHandler = (name: string | null) => void;
/** moveFile bound prop passed down the tree (App.jsx:484 -> FileExplorer -> TreeNode). */
export type MoveFileHandler = (sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle) => Promise<boolean>;
/** renameFile wrapper passed down the tree (App.handleRenameFile, App.jsx:329). */
export type RenameFileHandler = (node: FileTreeNode, newName: string) => void | Promise<void>;

/** Re-export helpers so deep importers can `import type { CSSProperties } from '../types'` if desired. */
export type { ReactNode, CSSProperties };

/* ─────────────────────────────────────────────────────────────────────────
 * FILE SYSTEM ACCESS API — AMBIENT GLOBAL AUGMENTATION
 * The permission + picker APIs are NOT in TypeScript's stock lib.dom.d.ts.
 * These match the WICG spec shapes used in FileSystemContext.tsx
 * (showDirectoryPicker, queryPermission, requestPermission). Because this file
 * is a module (it has imports/exports), `declare global` AUGMENTS the existing
 * lib.dom interfaces rather than redeclaring them. If a future lib.dom ships
 * these, interface merging keeps it harmless (the shapes match the spec).
 * ───────────────────────────────────────────────────────────────────────── */

type FileSystemPermissionMode = 'read' | 'readwrite';

interface FileSystemHandlePermissionDescriptor {
  mode?: FileSystemPermissionMode;
}

declare global {
  interface FileSystemHandle {
    queryPermission(
      descriptor?: FileSystemHandlePermissionDescriptor
    ): Promise<PermissionState>;        // 'granted' | 'denied' | 'prompt'
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
}
