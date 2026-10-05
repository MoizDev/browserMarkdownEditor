// Each OPEN document's DiskVersion: what its file was when the app last read it
// or wrote it. The save funnel writes only against it (writeFileVersioned) and
// the outside-change check compares the disk with it (App.checkOpenDocs).
//
// Keyed by the tab's DOCUMENT id (OpenTab.id), not its path. A rename carries
// the id, so the baseline follows the document with nothing to re-key — and a
// write still in flight when a rename lands cannot strand its new version under
// the old path, where the next check would take the app's own save for an
// outside change. Ids never repeat within a page load (App.newTabId), so a
// closed document's entry can never be adopted by another.
//
// A module store, not React state: the save funnel and the checks read and
// write it from async code where a render snapshot would be stale, and nothing
// renders from it.

import type { DiskVersion } from './diskVersion';

let baselines = new Map<string, DiskVersion>();

export function getBaseline(docId: string): DiskVersion | undefined {
    return baselines.get(docId);
}

export function setBaseline(docId: string, version: DiskVersion): void {
    baselines.set(docId, version);
}

/** The document closed (App.releaseTab). */
export function dropBaseline(docId: string): void {
    baselines.delete(docId);
}

/** A vault switch: every open document goes with the workspace. */
export function clearBaselines(): void {
    baselines = new Map();
}
