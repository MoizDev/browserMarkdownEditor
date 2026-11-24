import { isLocked } from '../change/commands';
import type { Op } from '../change/ops';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { PictureNode } from '../model/nodes';
import { planPictureCrop, planPictureWindow, type CropWindow, type PictureCropPreset } from './crop';

// Provenance: media edit gestures and session-owned transaction contracts;
// independent commands, no upstream engine source.
export interface PictureCommands {
    crop(id: NodeId, preset: PictureCropPreset, zoom?: number): void;
    /** The crop editor's window, applied as one step. */
    cropWindow(id: NodeId, window: CropWindow, circle: boolean): void;
    flip(id: NodeId, axis: 'x' | 'y'): void;
    invert(id: NodeId): void;
    setAlt(id: NodeId, text: string): void;
    original(id: NodeId): { readonly blob: Blob; readonly name: string };
    downloadOriginal(id: NodeId): void;
}
export function createPictureCommands(options: { readonly runtime: BoardRuntime; current(): boolean }): PictureCommands {
    const { runtime } = options, session = runtime.session, doc = session.doc;
    const picture = (id: NodeId, editable = true): PictureNode => {
        if (!options.current() || runtime.session !== session || session.doc !== doc || editable && (session.isReadOnly || session.isGestureActive)) throw new Error('Picture command is unavailable');
        const node = doc.nodes.get(id);
        if (!node || node.kind !== 'picture' || editable && isLocked(doc, node)) throw new Error('Picture is missing or locked');
        return node;
    };
    const apply = (label: string, ops: readonly Op[]) => {
        if (!options.current() || session.isReadOnly || session.isGestureActive || session.doc !== doc) throw new DOMException('Picture command became stale', 'AbortError');
        session.history.open(label);
        try { const applied = session.apply({ origin: 'host', label, ops }); applied.release(); }
        finally { session.history.close(); }
    };
    const original = (id: NodeId): { readonly blob: Blob; readonly name: string } => {
        const node = picture(id, false), entry = node.media ? doc.media.get(node.media) : undefined;
        const bytes = node.media ? runtime.media.get(node.media) : undefined;
        if (!entry) throw new Error('Original picture bytes are unavailable');
        if (!bytes) throw new Error(`This picture’s file${entry.file ? `, ${entry.file},` : ''} is not in the .Assets folder beside this board, so it cannot be downloaded. Put the file back there and reopen the board.`);
        const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
            'image/avif': 'avif', 'image/svg+xml': 'svg' } as Readonly<Record<string, string>>)[entry.mime];
        if (!ext) throw new Error('Unsupported original picture type');
        const stem = Array.from(node.alt || 'picture', character => {
            const code = character.codePointAt(0)!;
            return code < 32 || code === 127 || character === '/' || character === '\\' || character === ':' ? '_' : character;
        }).join('').slice(0, 180) || 'picture';
        return { blob: new Blob([bytes], { type: entry.mime }), name: `${stem}.${ext}` };
    };
    return {
        crop(id, preset, zoom) {
            const node = picture(id), entry = node.media ? doc.media.get(node.media) : undefined;
            if (!entry) throw new Error('Picture dimensions are unavailable');
            apply('Crop picture', planPictureCrop(node, entry, preset, zoom));
        },
        cropWindow(id, window, circle) {
            const node = picture(id), entry = node.media ? doc.media.get(node.media) : undefined;
            if (!entry) throw new Error('Picture dimensions are unavailable');
            apply('Crop picture', planPictureWindow(node, entry, window, circle));
        },
        flip(id, axis) {
            const node = picture(id);
            if (axis === 'x') apply('Flip picture', [{ t: 'set', id, key: 'flipX', value: !node.flipX }]);
            else if (axis === 'y') apply('Flip picture', [{ t: 'set', id, key: 'flipY', value: !node.flipY }]);
            else throw new TypeError('Invalid picture flip axis');
        },
        invert(id) { const node = picture(id); apply('Invert picture', [{ t: 'set', id, key: 'inverted', value: !node.inverted }]); },
        setAlt(id, text) {
            picture(id);
            if (typeof text !== 'string' || text.length > 10_000) throw new RangeError('Picture alternative text exceeds its limit');
            apply('Edit alternative text', [{ t: 'set', id, key: 'alt', value: text }]);
        },
        original,
        downloadOriginal(id) {
            const value = original(id), link = document.createElement('a'), url = URL.createObjectURL(value.blob);
            try { link.href = url; link.download = value.name; link.click(); }
            finally { setTimeout(() => URL.revokeObjectURL(url), 30_000); }
        },
    };
}
