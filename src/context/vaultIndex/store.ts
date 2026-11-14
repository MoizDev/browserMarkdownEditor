import type { NoteFacts } from '../../utils/vaultIndex/facts';
import type { FileRecord, IndexFile } from '../../utils/vaultIndex/types';

const emptyFacts = () => ({ wikilinks: [], mdLinks: [], embeds: [] });

/** Revisions survive deletion so a late read can never resurrect a removed path. */
export class IndexStore {
    readonly records = new Map<string, FileRecord>();
    private revisions = new Map<string, number>();
    private primes = new Map<string, number>();
    treeGen = -1;
    private byPath = new Map<string, IndexFile>();
    files: IndexFile[] = [];

    revision(path: string): number { return this.revisions.get(path) ?? 0; }
    private bump(path: string): number {
        const rev = this.revision(path) + 1;
        this.revisions.set(path, rev);
        return rev;
    }
    private remove(path: string): void {
        this.bump(path);
        this.primes.delete(path);
        this.records.delete(path);
    }
    setTree(treeGen: number, files: IndexFile[]): boolean {
        if (treeGen <= this.treeGen) return false;
        this.treeGen = treeGen;
        const live = new Set(files.map(file => file.path));
        for (const old of this.files) if (!live.has(old.path)) this.remove(old.path);
        this.files = files;
        this.byPath = new Map(files.map(file => [file.path, file]));
        return true;
    }
    treeDelta(treeGen: number, added: IndexFile[], removed: string[],
        renamed: { from: string; to: string; kind: string }[], order?: string[]): boolean {
        if (treeGen <= this.treeGen) return false;
        const files = new Map(this.files.map(file => [file.path, file]));
        for (const path of removed) { files.delete(path); this.remove(path); }
        for (const { from, to, kind } of renamed) {
            const record = this.records.get(from);
            files.delete(from);
            this.remove(from);
            this.remove(to);
            files.set(to, { path: to, kind });
            if (record) this.records.set(to, { ...record, path: to, kind, rev: this.bump(to) });
        }
        for (const file of added) {
            if (files.has(file.path)) this.remove(file.path);
            files.set(file.path, file);
        }
        const ordered = order ? order.map(path => files.get(path)).filter((file): file is IndexFile => !!file) : [...files.values()];
        this.treeGen = treeGen;
        this.files = ordered;
        this.byPath = new Map(ordered.map(file => [file.path, file]));
        return true;
    }
    reservePrime(path: string): number | undefined {
        if (!this.byPath.has(path)) return undefined;
        const rev = this.bump(path);
        this.primes.set(path, rev);
        return rev;
    }
    releasePrime(path: string, rev: number): void {
        if (this.primes.get(path) === rev) this.primes.delete(path);
    }
    prime(path: string, rev: number, mtime: number, size: number, facts: NoteFacts): boolean {
        const file = this.byPath.get(path);
        if (!file || this.revision(path) !== rev) return false;
        this.records.set(path, { ...file, rev, mtime, size, status: 'ready', facts });
        return true;
    }
    commitRead(file: IndexFile, startedRev: number, mtime: number, size: number, facts: NoteFacts | null): boolean {
        if (startedRev !== this.revision(file.path) || this.primes.has(file.path) || !this.byPath.has(file.path)) return false;
        this.records.set(file.path, { ...file, rev: this.bump(file.path), mtime, size,
            status: facts === null ? 'refused' : 'ready', facts: facts ?? emptyFacts() });
        return true;
    }
}
