// Compose a PDF's shape layer as displayed, leaving the canvas surround alone.
// CSS filters are not included in an exported bitmap, so apply them once here.
export async function composePdfCapture(blob: Blob, inverted: boolean, background: string): Promise<Blob | null> {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    try {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.fillStyle = background || '#808080';
        context.fillRect(0, 0, canvas.width, canvas.height);
        if (inverted) context.filter = 'invert(1) hue-rotate(180deg)';
        context.drawImage(bitmap, 0, 0);
        return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    } finally {
        bitmap.close();
        canvas.width = canvas.height = 0;
    }
}
