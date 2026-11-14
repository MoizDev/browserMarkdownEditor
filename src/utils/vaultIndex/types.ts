import type { NoteFacts } from './facts';

export interface IndexSession { vaultId: string; sessionNo: number }
export interface IndexFile { path: string; kind: string }
export interface FileRecord extends IndexFile {
    rev: number;
    mtime: number;
    size: number;
    status: 'ready' | 'refused';
    facts: NoteFacts;
    text?: string;
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
