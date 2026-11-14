import type { AttachmentInput } from './protocol';
import { WRITE_MARK_ATTACHMENT } from './writeIdentity';

export interface PreservedAttachment {
    /** The original name remains available when a collision needs an alias. */
    originalName: string;
    name: string;
    bytes: Blob;
    sha256: string;
    metadata?: AttachmentInput['metadata'];
}

function recoveredName(name: string, number: number): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (recovered ${number})${name.slice(dot)}` : `${name} (recovered ${number})`;
}

/** Union by name+hash, never by hash alone. App-owned replacements reserve their
 * names before unknowns are assigned aliases; an outer-only attachment survives. */
export function preserveAttachmentUnion(pristine: readonly AttachmentInput[], outer: readonly AttachmentInput[],
    appAttachments: readonly AttachmentInput[]): PreservedAttachment[] {
    const reserved = new Set(['original.pdf', 'board.json', 'tldraw-snapshot.json', WRITE_MARK_ATTACHMENT]);
    for (const entry of appAttachments) if (entry.role !== 'unknown') reserved.add(entry.name);
    const seen = new Map<string, Set<string>>(), output: PreservedAttachment[] = [];
    for (const entry of [...pristine, ...outer, ...appAttachments]) {
        if (entry.role !== 'unknown') continue;
        if (!entry.name || entry.name.includes('\0') || !/^[0-9a-f]{64}$/.test(entry.sha256) || !(entry.bytes instanceof Blob)) throw new Error('Invalid preserved attachment');
        const hashes = seen.get(entry.name) ?? new Set<string>();
        if (hashes.has(entry.sha256)) continue;
        hashes.add(entry.sha256); seen.set(entry.name, hashes);
        let name = entry.name;
        if (reserved.has(name)) {
            let n = 1;
            while (reserved.has(recoveredName(entry.name, n))) n++;
            name = recoveredName(entry.name, n);
        }
        reserved.add(name);
        output.push({ originalName: entry.name, name, bytes: entry.bytes, sha256: entry.sha256, metadata: entry.metadata });
    }
    return output;
}
