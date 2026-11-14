import type { NativeAttachment } from './nativeInventory';
import { attachmentMarker } from './attachments';
import { WRITE_MARK_ATTACHMENT } from './writeIdentity';

/** PDFium cannot inspect arbitrary Filespec metadata or AF ownership. Its
 * direct path is limited to attachment-free pristine documents and a fully
 * understood app-owned outer set; everything else goes to the legacy converter. */
export function preservationPath(pristine: readonly NativeAttachment[], outer: readonly NativeAttachment[],
    format: string, pristineFingerprint: string): 'native' | 'legacy' {
    if (!format || !/^[0-9a-f]{64}$/.test(pristineFingerprint)) throw new Error('Invalid preservation identity');
    if (pristine.length) return 'legacy';
    const names = new Set<string>();
    for (const entry of outer) {
        if (names.has(entry.name)) return 'legacy';
        names.add(entry.name);
        if (!entry.marker) return 'legacy';
        if (!entry.marker.startsWith('local-vault-pdf/')) throw new Error('Cannot establish attachment marker authority');
        const role = entry.name === 'original.pdf' ? 'pristine' : entry.name === 'board.json' ? 'editable' :
            entry.name === 'tldraw-snapshot.json' ? 'fence' : entry.name === WRITE_MARK_ATTACHMENT ? 'write-mark' :
            /^board-media\/[0-9a-f]{64}\.[a-zA-Z0-9]{1,16}$/.test(entry.name) ? 'media' : null;
        if (!role || entry.marker !== attachmentMarker(role, format)) return 'legacy';
        if (role === 'pristine' && entry.sha256 !== pristineFingerprint) throw new Error('Embedded pristine source differs from the writer source');
        if (role === 'media' && !entry.name.startsWith(`board-media/${entry.sha256}.`)) throw new Error('Board media fingerprint mismatch');
    }
    return 'native';
}
