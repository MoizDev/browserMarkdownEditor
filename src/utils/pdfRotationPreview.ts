// A low-resolution loading picture is not a document or a new-byte geometry.
// Tab ids isolate vaults; raw fingerprints prevent queued turns from reusing a
// picture of a different generation. Pictures never reach disk or agent tools.
export interface PdfRotationPicture {
    page: number;
    dataUrl: string;
    width: number;
    height: number;
}
export interface PdfRotationPreview extends PdfRotationPicture {
    sourceHash: string;
    resultHash: string;
}
const staged = new Map<string, Array<(PdfRotationPicture & { sourceHash: string }) | undefined>>();
const published = new Map<string, PdfRotationPreview>();

export function stagePdfRotation(id: string, picture: (PdfRotationPicture & { sourceHash: string }) | undefined): void {
    const queue = staged.get(id) ?? [];
    queue.push(picture);
    staged.set(id, queue);
}
export function takePdfRotation(id: string): (PdfRotationPicture & { sourceHash: string }) | undefined {
    const queue = staged.get(id);
    const result = queue?.shift();
    if (!queue?.length) staged.delete(id);
    return result;
}
export function publishPdfRotation(id: string, picture: (PdfRotationPicture & { sourceHash: string }) | undefined, expectedHash: string | undefined, resultHash: string): void {
    if (picture && expectedHash === picture.sourceHash) published.set(id, { ...picture, resultHash });
    else published.delete(id);
}
export function peekPdfRotation(id: string): PdfRotationPreview | undefined { return published.get(id); }
export function clearPdfRotation(id: string): void { staged.delete(id); published.delete(id); }
export function clearPdfRotationPicture(id: string, picture: PdfRotationPreview): void {
    if (published.get(id) === picture) published.delete(id);
}
