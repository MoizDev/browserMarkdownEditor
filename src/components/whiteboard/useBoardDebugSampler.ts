import { useEffect } from 'react';
import { publishBoardDebugStats } from './debugStats';
import type { NativeViewLease } from './nativeViewLease';

type BoardRuntime = NativeViewLease['runtime'];

const SAMPLE_MS = 250;
const OUTLINE_LIMIT = 200;
const VISIT_CHUNK = 4096;

function topLevelBox(node: object, sheet: string): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null {
    const fields = node as Readonly<Record<string, unknown>>;
    if (String(fields.parent) !== sheet) return null;
    const width = typeof fields.width === 'number' ? fields.width : fields.w;
    const height = typeof fields.height === 'number' ? fields.height : fields.h;
    return typeof fields.x === 'number' && typeof fields.y === 'number' && typeof width === 'number' && typeof height === 'number'
        ? { x: fields.x, y: fields.y, width, height } : null;
}

export function useBoardDebugSampler(runtime: BoardRuntime, lease: NativeViewLease | null): void {
    useEffect(() => {
        if (!lease) return;
        const tick = () => {
            if (!runtime.session.doc.view.debugMode) return;
            const scene = runtime.scene;
            if (!scene?.ready) return;
            const { camera, viewport } = lease.camera;
            const sheet = runtime.selection.getSnapshot().sheet;
            const box = [camera.x, camera.y, camera.x + viewport.width / camera.z, camera.y + viewport.height / camera.z] as const;
            let visibleCount = 0;
            const outlines: { id: string; x: number; y: number; width: number; height: number }[] = [];
            const cursor = scene.spatialCursor({ sheetId: sheet, purpose: 'selectable', request: { kind: 'box', box } });
            try {
                for (;;) {
                    const status = cursor.resume({ deadline: Number.POSITIVE_INFINITY, maxVisits: VISIT_CHUNK }, ref => {
                        visibleCount++;
                        if (outlines.length >= OUTLINE_LIMIT) return;
                        const hit = scene.resolveSpatial(ref);
                        const node = hit ? runtime.session.doc.nodes.get(hit.id) : undefined;
                        const rect = hit && node ? topLevelBox(node, sheet) : null;
                        if (hit && rect) outlines.push({ id: hit.id, x: (rect.x - camera.x) * camera.z, y: (rect.y - camera.y) * camera.z,
                            width: rect.width * camera.z, height: rect.height * camera.z });
                    });
                    if (status === 'complete') break;
                    if (status !== 'pending') return;
                }
            } finally { cursor.cancel(); }
            publishBoardDebugStats({ nodeCount: runtime.session.doc.nodes.size, visibleCount,
                selectionCount: runtime.selection.getSnapshot().selected.length, outlines });
        };
        const timer = window.setInterval(tick, SAMPLE_MS);
        return () => window.clearInterval(timer);
    }, [runtime, lease]);
}
