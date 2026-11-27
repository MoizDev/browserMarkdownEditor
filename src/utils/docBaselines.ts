import type { DiskVersion } from './diskVersion';

let baselines = new Map<string, DiskVersion>();

export function getBaseline(docId: string): DiskVersion | undefined {
    return baselines.get(docId);
}

export function setBaseline(docId: string, version: DiskVersion): void {
    baselines.set(docId, version);
}

export function dropBaseline(docId: string): void {
    baselines.delete(docId);
}

export function clearBaselines(): void {
    baselines = new Map();
}
