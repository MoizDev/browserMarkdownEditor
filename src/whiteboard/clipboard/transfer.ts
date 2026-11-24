import type { ClipboardFile, ClipboardInput } from './types';

function filesOf(transfer: DataTransfer): ClipboardFile[] {
    const result: ClipboardFile[] = [];
    for (const item of Array.from(transfer.items)) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry?.();
        if (entry?.isDirectory) {
            result.push({ blob: new Blob(), name: entry.name, directory: true });
            continue;
        }
        const file = item.getAsFile();
        if (file) result.push({ blob: file, name: file.name, directory: false });
    }
    if (!result.length) for (const file of Array.from(transfer.files)) result.push({ blob: file, name: file.name, directory: false });
    return result;
}
function textOf(transfer: DataTransfer, type: string): string | null {
    return Array.from(transfer.types).includes(type) ? transfer.getData(type) : null;
}

/** DataTransfer becomes unusable after the event, including directory entries. */
export function captureTransfer(transfer: DataTransfer): ClipboardInput {
    return { html: textOf(transfer, 'text/html'), text: textOf(transfer, 'text/plain'),
        svg: textOf(transfer, 'image/svg+xml'), uriList: textOf(transfer, 'text/uri-list'),
        files: filesOf(transfer), privatePng: null };
}

export function acceptsBoardDrag(event: DragEvent): boolean {
    const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : [];
    if (!types.includes('Files') && !types.includes('text/uri-list')) return false;
    event.preventDefault();
    return true;
}
