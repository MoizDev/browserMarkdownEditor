import type React from 'react';
import type { OpenTab, TabLayout } from '../types';
import type { ReaderIdentity } from '../types/reading';
import type { DiskVersion } from '../utils/diskVersion';
import type { PdfAnnotationPreflight } from '../utils/pdfRole';
import type { createRecoveryFunnel } from '../utils/recoveryFunnel';
import type { createRecoveryJournal } from '../utils/recoveryJournalCoordinator';
import type { useIndexGraph } from '../context/vaultIndex/useIndexGraph';

export type SetTabs = React.Dispatch<React.SetStateAction<OpenTab[]>>;
export type SetLayout = React.Dispatch<React.SetStateAction<TabLayout>>;

export type FlushOutcome = 'written' | 'changed' | 'deleted' | 'skipped' | 'failed';
export type FlushTab = (
  path: string | null, force?: boolean | 'rewrite', closing?: boolean,
  vaultRoot?: FileSystemDirectoryHandle | null, trashOwned?: boolean, serializerCallback?: boolean,
) => Promise<FlushOutcome>;

export type DiskHold = 'conflict' | 'deleted';
export type SetDiskState = (id: string, state: DiskHold | null) => void;

export interface NativePolicy {
  session: number;
  sourceGeneration: number;
  retainedThroughGeneration: number;
  activation: number;
  kind: 'drawing' | 'notebook' | 'pdfInk';
  emergencyReadOnly: boolean;
  oldBoard?: boolean;
  pdfWriteAuthority?: { canWriteSource(): boolean; canWrite(): boolean };
}

export interface PdfRebuildEntry {
  identity: ReaderIdentity;
  root: FileSystemDirectoryHandle;
  handle: FileSystemFileHandle;
  value: PdfAnnotationPreflight;
  baseline: DiskVersion;
  copyName?: string;
  approved: boolean;
}

export type AssetOutcome = 'retired' | 'kept' | 'skipped-detached' | 'failed';
export interface ReconcileJob {
  activation: number; path: string; parentHandle: FileSystemDirectoryHandle | null;
  text: string; before: ReadonlySet<string>; after: ReadonlySet<string>;
  measuredNames?: string[];
  restore?: ReadonlySet<string>;
  board?: { before: string; after: string };
}

export type RecoveryJournal = ReturnType<typeof createRecoveryJournal>;
export type RecoveryEvent = ReturnType<typeof createRecoveryFunnel>;
export type IndexGraphRef = ReturnType<typeof useIndexGraph>;
