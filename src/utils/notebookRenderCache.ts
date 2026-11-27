import type { NotebookPaper } from './paper';
import type { PageOverlay } from './pdfOverlay';

export interface NotebookExport {
    paper: NotebookPaper;
    overlays: Array<PageOverlay | undefined>;
}

export interface NativeNotebookExportJob {
    readonly sourcePath: string;
    isCurrent(): boolean;
    run(signal: AbortSignal): Promise<{ paper: NotebookPaper; bytes: Uint8Array }>;
    release(): void;
}
export interface NativeNotebookExporter { readonly kind: 'native'; prepare(): NativeNotebookExportJob }
export type NotebookExporter = (() => Promise<NotebookExport | null>) | NativeNotebookExporter;

const exporters = new Map<string, NotebookExporter>();

export function setNotebookRenderData(path: string, exporter: NotebookExporter): void {
    exporters.set(path, exporter);
}

export function getNotebookExporter(path: string): NotebookExporter | undefined {
    return exporters.get(path);
}

export function clearNotebookRenderData(path: string): void {
    exporters.delete(path);
}

/** Session disposal must not remove a newer owner's exporter after a retarget. */
export function removeNotebookExporter(exporter: NotebookExporter): void {
    for (const [path, current] of exporters) if (current === exporter) exporters.delete(path);
}

export function moveNotebookRenderData(from: string, to: string): void {
    const exporter = exporters.get(from);
    if (!exporter) return;
    exporters.delete(from);
    exporters.set(to, exporter);
}
