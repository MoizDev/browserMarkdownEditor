/** Saves a generated file under the given name. The object URL is released on the next task, after the click. */
export function downloadBlob(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
