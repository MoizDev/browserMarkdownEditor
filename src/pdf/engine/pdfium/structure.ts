import type { Affine, PageGeometry } from '../../../platform/types';
import type { EngineLimits, RawPageText } from '../types';
import type { PdfiumRuntime } from './loader';
import { pdfiumTransformBox, pdfiumUserToPage } from './geometry';
import { heapView, readPdfiumUtf16, withPdfiumMemory } from './memory';

interface StructureResult { struct?: RawPageText['struct']; partial: boolean }
interface Tagged { role: number; lang?: string; alt?: string; actual?: string }
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
const multiply = (a: Affine, b: Affine): Affine => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
function roleOf(value: string): number {
    if (value === 'Code') return 1;
    if (value === 'Formula') return 2;
    if (value === 'Artifact') return 3;
    if (value === 'H') return 4;
    if (/^H[1-6]$/.test(value)) return Number(value[1]) + 4;
    return value === 'Figure' ? 11 : 0;
}

/** Walk a page's structure and marked figure objects with one shared work cap. */
export function pdfiumStructure(runtime: PdfiumRuntime, page: number, geometry: PageGeometry,
    tagged: boolean, limits: Readonly<EngineLimits>): StructureResult {
    const tree = runtime.call('FPDF_StructTree_GetForPage', page) >>> 0;
    if (!tree) return { partial: tagged };
    let partial = false, work = 0;
    const budget = Math.min(limits.maxOutlineNodes, 20_000), depthLimit = Math.min(limits.maxOutlineDepth, 64);
    const entries = new Map<number, Tagged>(), seen = new Set<number>();
    const figures = new Map<number, [number, number, number, number]>();
    const readString = (operation: string, element: number, maxUnits: number): string | undefined => {
        const bytes = runtime.call(operation, element, 0, 0) >>> 0;
        if (!bytes) return undefined;
        if (bytes % 2 || bytes > (maxUnits + 1) * 2) { partial = true; return undefined; }
        return withPdfiumMemory(runtime, bytes, pointer => {
            if ((runtime.call(operation, element, pointer, bytes) >>> 0) !== bytes) { partial = true; return undefined; }
            return readPdfiumUtf16(runtime, pointer, bytes);
        });
    };
    const add = (mcid: number, item: Tagged) => {
        if (!Number.isInteger(mcid) || mcid < 0) return;
        const previous = entries.get(mcid);
        if (previous && previous.role !== item.role) { partial = true; entries.set(mcid, { role: 0 }); return; }
        entries.set(mcid, previous ? { ...previous, ...item } : item);
    };
    try {
        if (!Number.isSafeInteger(budget) || budget < 0 || !Number.isSafeInteger(depthLimit) || depthLimit < 0) return { partial: true };
        const roots = runtime.call('FPDF_StructTree_CountChildren', tree);
        if (!Number.isSafeInteger(roots) || roots < 0 || roots > budget) return { partial: true };
        const stack: Array<{ handle: number; depth: number }> = [];
        for (let i = roots - 1; i >= 0; i--) {
            const handle = runtime.call('FPDF_StructTree_GetChildAtIndex', tree, i) >>> 0;
            if (handle) stack.push({ handle, depth: 0 }); else partial = true;
        }
        while (stack.length) {
            const current = stack.pop()!;
            if (++work > budget || current.depth > depthLimit) { partial = true; break; }
            if (seen.has(current.handle)) { partial = true; continue; }
            seen.add(current.handle);
            const role = roleOf(readString('FPDF_StructElement_GetType', current.handle, 64) ?? '');
            const lang = readString('FPDF_StructElement_GetLang', current.handle, 35);
            const alt = role === 11 ? readString('FPDF_StructElement_GetAltText', current.handle, 1024) : undefined;
            const actual = readString('FPDF_StructElement_GetActualText', current.handle, 1024);
            const item: Tagged = { role, ...(lang ? { lang } : {}), ...(alt ? { alt } : {}), ...(actual ? { actual } : {}) };
            add(runtime.call('FPDF_StructElement_GetMarkedContentID', current.handle), item);
            const children = runtime.call('FPDF_StructElement_CountChildren', current.handle);
            if (!Number.isSafeInteger(children) || children < 0 || children > budget - work) { partial = true; break; }
            work += children;
            for (let i = children - 1; i >= 0; i--) {
                const child = runtime.call('FPDF_StructElement_GetChildAtIndex', current.handle, i) >>> 0;
                if (child) stack.push({ handle: child, depth: current.depth + 1 });
                else add(runtime.call('FPDF_StructElement_GetChildMarkedContentID', current.handle, i), item);
            }
        }
        if ([...entries.values()].some(item => item.role === 11)) {
            const pageTransform = pdfiumUserToPage(geometry);
            withPdfiumMemory(runtime, 32, scratch => {
                const count = runtime.call('FPDFPage_CountObjects', page);
                if (!Number.isSafeInteger(count) || count < 0 || count > budget - work) { partial = true; return; }
                const objects: Array<{ handle: number; parent: Affine; depth: number }> = [];
                for (let i = count - 1; i >= 0; i--) {
                    const handle = runtime.call('FPDFPage_GetObject', page, i) >>> 0;
                    if (handle) objects.push({ handle, parent: IDENTITY, depth: 0 }); else partial = true;
                }
                const visited = new Set<number>();
                while (objects.length) {
                    const current = objects.pop()!;
                    if (++work > budget || current.depth > depthLimit) { partial = true; break; }
                    if (visited.has(current.handle)) { partial = true; continue; }
                    visited.add(current.handle);
                    const type = runtime.call('FPDFPageObj_GetType', current.handle);
                    const mcid = runtime.call('FPDFPageObj_GetMarkedContentID', current.handle);
                    if (type !== 1 && entries.get(mcid)?.role === 11 &&
                        runtime.call('FPDFPageObj_GetBounds', current.handle, scratch, scratch + 4, scratch + 8, scratch + 12)) {
                        const view = heapView(runtime, scratch, 16), matrix = multiply(pageTransform, current.parent);
                        const box = pdfiumTransformBox(matrix, view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true), view.getFloat32(12, true));
                        if (box[2] > box[0] && box[3] > box[1]) {
                            const previous = figures.get(mcid);
                            figures.set(mcid, previous ? [Math.min(previous[0], box[0]), Math.min(previous[1], box[1]),
                                Math.max(previous[2], box[2]), Math.max(previous[3], box[3])] : [...box]);
                        }
                    }
                    if (type !== 5) continue;
                    const children = runtime.call('FPDFFormObj_CountObjects', current.handle);
                    if (!Number.isSafeInteger(children) || children < 0 || children > budget - work - objects.length ||
                        !runtime.call('FPDFPageObj_GetMatrix', current.handle, scratch)) { partial = true; continue; }
                    const view = heapView(runtime, scratch, 24);
                    const local: Affine = [view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true),
                        view.getFloat32(12, true), view.getFloat32(16, true), view.getFloat32(20, true)];
                    if (!local.every(Number.isFinite)) { partial = true; continue; }
                    const parent = multiply(current.parent, local);
                    for (let i = children - 1; i >= 0; i--) {
                        const handle = runtime.call('FPDFFormObj_GetObject', current.handle, i) >>> 0;
                        if (handle) objects.push({ handle, parent, depth: current.depth + 1 }); else partial = true;
                    }
                }
            });
        }
        const pairs = [...entries.entries()];
        return { partial, struct: {
            mcids: Int32Array.from(pairs, ([mcid]) => mcid), roles: Uint8Array.from(pairs, ([, value]) => value.role),
            lang: pairs.flatMap(([mcid, value]) => value.lang ? [[mcid, value.lang] as [number, string]] : []),
            alt: pairs.flatMap(([mcid, value]) => value.alt ? [[mcid, value.alt] as [number, string]] : []),
            actualText: pairs.flatMap(([mcid, value]) => value.actual ? [[mcid, value.actual] as [number, string]] : []),
            figures: [...figures.entries()].map(([mcid, box]) => ({ mcid, box })),
        } };
    } finally { if (!runtime.aborted) runtime.call('FPDF_StructTree_Close', tree); }
}
