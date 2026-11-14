import type { NoteFacts } from './facts';

export interface IndexSession { vaultId: string; sessionNo: number }
export interface IndexFile { path: string; kind: string }
/** The list is usable for retirement only while fresh and after each version is re-statted. */
export interface IndexBoardMedia { path: string; mtime: number; size: number; names: string[] }
export interface IndexMediaSnapshot { folder: string; fresh: boolean; boards: IndexBoardMedia[] }
export interface IndexMediaFacts { signature: string; names: string[] }
export interface FileRecord extends IndexFile {
    rev: number;
    mtime: number;
    size: number;
    status: 'ready' | 'refused';
    facts: NoteFacts;
    text?: string;
    media?: Record<string, IndexMediaFacts>;
}
export interface IndexGraph {
    session: IndexSession;
    graphGen: number;
    treeGen: number;
    paths: string[];
    names: string[];
    unresolved: string[];
    edges: Int32Array;
    degrees: Int32Array;
    links: { source: string; target: string }[];
    backlinks: Record<string, string[]>;
    outlinks: Record<string, string[]>;
    stale: boolean;
}
