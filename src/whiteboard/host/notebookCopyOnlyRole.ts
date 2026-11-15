/**
 * The copy-only role of a notebook-exported PDF. The export is a read-only source: it grants no write to
 * itself, and the only permitted output is a new, distinct copy. Core binds this role at the App layer;
 * this module owns the rule, not the file system.
 */
export interface NotebookCopyOnlyRoleOptions {
    /** Vault path of the notebook export that the role protects. */
    readonly notebookPath: string;
    /** Outer fingerprint pinned when the export was acquired. */
    readonly outerFingerprint: string;
    /** False once the acquisition that produced this role has been released or the session has ended. */
    isCurrent(): boolean;
}

export interface NotebookCopyOnlyRole {
    readonly kind: 'copy-only';
    readonly notebookPath: string;
    readonly outerFingerprint: string;
    /** Always false: a copy-only role never authorizes a write to the notebook source. */
    readonly canWriteSource: false;
    isCurrent(): boolean;
    /**
     * Returns the target path when it is a distinct copy target. The notebook path itself, or any spelling
     * of it that normalizes to the same path, is refused so the source can never be overwritten.
     */
    assertCopyTarget(targetPath: string): string;
}

/** Thrown where a notebook-backed PDF would otherwise be read-only: carries the role for the caller. */
export class NotebookCopyOnlyRefusal extends Error {
    readonly role: NotebookCopyOnlyRole;
    constructor(reason: string, role: NotebookCopyOnlyRole) {
        super(reason);
        this.name = 'NotebookCopyOnlyRefusal';
        this.role = role;
    }
}

/** Normalizes slashes and dot segments so that equivalent spellings compare equal. */
function normalizeVaultPath(path: string): string {
    const parts: string[] = [];
    for (const part of path.replace(/\\/g, '/').split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') { if (parts.length === 0) throw new Error('Copy target escapes the vault'); parts.pop(); continue; }
        parts.push(part);
    }
    return parts.join('/');
}

export function createNotebookCopyOnlyRole(options: NotebookCopyOnlyRoleOptions): NotebookCopyOnlyRole {
    const sourcePath = normalizeVaultPath(options.notebookPath);
    if (!sourcePath) throw new Error('A copy-only role needs a notebook path');
    if (!/^[0-9a-f]{64}$/.test(options.outerFingerprint)) throw new Error('A copy-only role needs a pinned outer fingerprint');
    return Object.freeze({
        kind: 'copy-only' as const,
        notebookPath: options.notebookPath,
        outerFingerprint: options.outerFingerprint,
        canWriteSource: false as const,
        isCurrent: () => options.isCurrent(),
        assertCopyTarget(targetPath: string) {
            if (!options.isCurrent()) throw new DOMException('Notebook copy source is no longer current', 'AbortError');
            const target = normalizeVaultPath(targetPath);
            if (!target) throw new Error('A copy target is required');
            if (target === sourcePath) throw new Error('The notebook export cannot be overwritten; choose a new file for the copy.');
            return targetPath;
        },
    });
}
