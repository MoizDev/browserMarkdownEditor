/** These are browser downloads, not vault writes. The URL remains alive long enough for
 * Chromium to consume it, then is released even when the pane has unmounted. */
export function downloadBoardExport(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    try {
        document.body.append(anchor);
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    } finally { anchor.remove(); }
}

/** Call from the initiating gesture. Promise-valued ClipboardItem entries retain Chromium's
 * activation while capture runs; failure never writes a partial capture. */
export function copyBoardPng(capture: Promise<Blob>): Promise<void> {
    const png = capture.then(blob => {
        if (blob.type !== 'image/png') throw new TypeError('Expected a PNG capture');
        return blob;
    });
    const boardPng = png.then(blob => new Blob([blob], { type: 'image/x-board+png' }));
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': png, 'web image/x-board+png': boardPng })]);
}

/** SVG copy is plain text, not an HTML or SVG clipboard document. */
export function copyBoardSvg(capture: Promise<Blob>): Promise<void> {
    const text = capture.then(blob => {
        if (blob.type !== 'image/svg+xml') throw new TypeError('Expected an SVG capture');
        return new Blob([blob], { type: 'text/plain' });
    });
    return navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })]);
}
