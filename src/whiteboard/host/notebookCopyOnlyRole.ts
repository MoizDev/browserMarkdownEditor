export interface NotebookCopyOnlyRoleOptions {
    readonly notebookPath: string;
    readonly outerFingerprint: string;
    isCurrent(): boolean;
}

export interface NotebookCopyOnlyRole {
    readonly kind: 'copy-only';
    readonly notebookPath: string;
    readonly outerFingerprint: string;
    readonly canWriteSource: false;
    isCurrent(): boolean;
    assertCopyTarget(targetPath: string): string;
}

export class NotebookCopyOnlyRefusal extends Error {
    readonly role: NotebookCopyOnlyRole;
    constructor(reason: string, role: NotebookCopyOnlyRole) {
        super(reason);
        this.name = 'NotebookCopyOnlyRefusal';
        this.role = role;
    }
}

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
