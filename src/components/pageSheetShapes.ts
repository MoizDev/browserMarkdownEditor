import { Box } from 'tldraw';
import type { Editor, TLShape } from 'tldraw';

/** Each tldraw page is a transparent sheet over the same physical page stack. */
export function shapesBySheet(editor: Editor, isBackdrop: (shape: TLShape) => boolean): TLShape[][] {
    return editor.getPages().map(page => Array.from(editor.getPageShapeIds(page.id), id => editor.getShape(id))
        .filter((shape): shape is TLShape => !!shape && !isBackdrop(shape)));
}

export function bucketSheetsByPage(
    editor: Editor,
    sheets: TLShape[][],
    boxes: readonly { y: number; height: number }[],
): TLShape[][][] {
    const pages = boxes.map(() => sheets.map((): TLShape[] => []));
    sheets.forEach((shapes, sheet) => {
        for (const shape of shapes) {
            const bounds = editor.getShapePageBounds(shape.id);
            if (!bounds) continue;
            for (let page = 0; page < boxes.length; page++) {
                if (boxes[page].y >= bounds.maxY) break;
                if (bounds.minY < boxes[page].y + boxes[page].height) pages[page][sheet].push(shape);
            }
        }
    });
    return pages;
}

/** Composite sheets individually so a later sheet always paints above an earlier one. */
export async function sheetThumbnail(
    editor: Editor, box: { x: number; y: number; width: number; height: number },
    baseUrl: string, scale: number, isBackdrop: (shape: TLShape) => boolean,
): Promise<string> {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(box.width * scale));
    canvas.height = Math.max(1, Math.ceil(box.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not render thumbnail');
    const base = await createImageBitmap(await (await fetch(baseUrl)).blob());
    try { context.drawImage(base, 0, 0, canvas.width, canvas.height); } finally { base.close(); }
    const bounds = new Box(box.x, box.y, box.width, box.height);
    for (const shapes of shapesBySheet(editor, isBackdrop)) {
        const ids = shapes.filter(shape => {
            const b = editor.getShapePageBounds(shape.id);
            return b && Box.Collides(b, bounds);
        }).map(shape => shape.id);
        if (!ids.length) continue;
        const { blob } = await editor.toImage(ids, { bounds, scale, pixelRatio: 1, padding: 0,
            background: false, darkMode: false, format: 'png' });
        const image = await createImageBitmap(blob);
        try { context.drawImage(image, 0, 0, canvas.width, canvas.height); } finally { image.close(); }
    }
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    if (!blob) throw new Error('Could not encode thumbnail');
    return URL.createObjectURL(blob);
}
