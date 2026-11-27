import { normalizePaper, pageLayout, paperPageSize, type NotebookPaper, type PageBox } from './paper';
import type { ShapeSummary } from './viewRegistry';

export interface FileShape extends ShapeSummary {
    sizeUnknown?: boolean;
}

export interface CanvasFileSummary {
    kind: 'drawing' | 'notebook';
    pages: Array<{ name: string; shapes: FileShape[] }>;
    paper?: NotebookPaper;
}

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function isBackdropShapeId(id: string): boolean {
    return id.startsWith('shape:notebook-page-') || id.startsWith('shape:pdf-page-');
}

export function richTextToPlain(doc: unknown): string {
    const out: string[] = [];
    const walk = (node: unknown) => {
        if (!isRec(node)) return;
        if (node.type === 'text' && typeof node.text === 'string') { out.push(node.text); return; }
        if (node.type === 'hardBreak') { out.push('\n'); return; }
        const kids = Array.isArray(node.content) ? node.content : [];
        kids.forEach(walk);
        if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem') out.push('\n');
    };
    walk(doc);
    return out.join('').replace(/\n+$/, '');
}

function float16(bits: number): number {
    const sign = bits & 0x8000 ? -1 : 1;
    const exp = (bits >> 10) & 0x1f;
    const frac = bits & 0x3ff;
    if (exp === 0) return sign * frac * 2 ** -24;
    if (exp === 0x1f) return frac ? NaN : sign * Infinity;
    return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

function decodePath(b64: string, dim: number): Array<{ x: number; y: number }> {
    if (!b64) return [];
    let bin: string;
    try { bin = atob(b64); } catch { return []; }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const first = dim === 2 ? 8 : 12;
    const step = dim === 2 ? 4 : 6;
    if (bytes.length < first) return [];
    let x = view.getFloat32(0, true);
    let y = view.getFloat32(4, true);
    const pts = [{ x, y }];
    for (let o = first; o + 4 <= bytes.length; o += step) {
        x += float16(view.getUint16(o, true));
        y += float16(view.getUint16(o + 2, true));
        pts.push({ x, y });
    }
    return pts;
}

function segmentPoints(seg: unknown): Array<{ x: number; y: number }> {
    if (!isRec(seg)) return [];
    if (typeof seg.path === 'string') return decodePath(seg.path, num(seg.dim, 3));
    if (Array.isArray(seg.points)) return seg.points.filter(isRec).map(p => ({ x: num(p.x), y: num(p.y) }));
    return [];
}

function boundsOf(points: Array<{ x: number; y: number }>): { x: number; y: number; w: number; h: number } | null {
    const finite = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!finite.length) return null;
    const xs = finite.map(p => p.x);
    const ys = finite.map(p => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function localBounds(type: string, props: Rec): { x: number; y: number; w: number; h: number } | null {
    const scale = num(props.scale, 1);
    switch (type) {
        case 'geo':
            return { x: 0, y: 0, w: num(props.w) * scale, h: (num(props.h) + num(props.growY)) * scale };
        case 'note':
            return { x: 0, y: 0, w: 200 * scale, h: (200 + num(props.growY)) * scale };
        case 'draw':
        case 'highlight': {
            const pts = (Array.isArray(props.segments) ? props.segments : []).flatMap(segmentPoints);
            const b = boundsOf(pts);
            if (!b) return null;
            const sx = num(props.scaleX, 1) * scale;
            const sy = num(props.scaleY, 1) * scale;
            return { x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy };
        }
        case 'line': {
            const raw = isRec(props.points) ? Object.values(props.points) : Array.isArray(props.points) ? props.points : [];
            const b = boundsOf(raw.filter(isRec).map(p => ({ x: num(p.x), y: num(p.y) })));
            return b && { x: b.x * scale, y: b.y * scale, w: b.w * scale, h: b.h * scale };
        }
        case 'arrow': {
            const s = isRec(props.start) ? props.start : {};
            const e = isRec(props.end) ? props.end : {};
            return boundsOf([{ x: num(s.x), y: num(s.y) }, { x: num(e.x), y: num(e.y) }]);
        }
        default:
            if (typeof props.w === 'number' && typeof props.h === 'number') return { x: 0, y: 0, w: num(props.w), h: num(props.h) };
            return null;
    }
}

export function pageIndexAt(boxes: readonly PageBox[], y: number): number {
    for (let i = 0; i < boxes.length; i++) if (boxes[i].y + boxes[i].height > y) return i;
    return Math.max(0, boxes.length - 1);
}

export function summarizeCanvasFile(kind: 'drawing' | 'notebook', text: string): CanvasFileSummary | { error: string } {
    let root: Rec = {};
    if (text.trim()) {
        try {
            const parsed: unknown = JSON.parse(text);
            if (!isRec(parsed)) return { error: 'the file is not a canvas snapshot (not a JSON object)' };
            root = parsed;
        } catch {
            return { error: 'the file is not valid JSON, so its shapes cannot be read' };
        }
    }
    const doc = isRec(root.document) ? root.document : root;
    const store = isRec(doc.store) ? doc.store : {};
    const records = Object.values(store).filter(isRec);

    const paper = kind === 'notebook' ? normalizePaper(isRec(root.paper) ? root.paper as Partial<NotebookPaper> : undefined) : undefined;
    const boxes = paper ? pageLayout(Array.from({ length: paper.pageCount }, () => paperPageSize(paper))) : [];

    const shapesById = new Map<string, Rec>();
    for (const r of records) if (r.typeName === 'shape' && typeof r.id === 'string') shapesById.set(r.id, r);

    const arrowEnds = new Map<string, { start?: string; end?: string }>();
    for (const r of records) {
        if (r.typeName !== 'binding' || r.type !== 'arrow' || typeof r.fromId !== 'string' || typeof r.toId !== 'string') continue;
        const terminal = isRec(r.props) ? r.props.terminal : undefined;
        const ends = arrowEnds.get(r.fromId) ?? {};
        if (terminal === 'start') ends.start = r.toId;
        else if (terminal === 'end') ends.end = r.toId;
        arrowEnds.set(r.fromId, ends);
    }

    const originOf = (shape: Rec, depth = 0): { x: number; y: number; page: string } => {
        const parentId = str(shape.parentId) ?? '';
        const parent = shapesById.get(parentId);
        if (!parent || depth > 50) return { x: num(shape.x), y: num(shape.y), page: parentId };
        const p = originOf(parent, depth + 1);
        return { x: p.x + num(shape.x), y: p.y + num(shape.y), page: p.page };
    };

    const pageRecords = records
        .filter(r => r.typeName === 'page' && typeof r.id === 'string')
        .sort((a, b) => String(a.index ?? '').localeCompare(String(b.index ?? '')));
    const byPage = new Map<string, FileShape[]>(pageRecords.map(p => [p.id as string, []]));

    for (const [id, shape] of shapesById) {
        if (isBackdropShapeId(id)) continue;
        const type = str(shape.type) ?? 'unknown';
        const props = isRec(shape.props) ? shape.props : {};
        const origin = originOf(shape);
        const local = localBounds(type, props);
        const out: FileShape = {
            id,
            type,
            x: origin.x + (local?.x ?? 0),
            y: origin.y + (local?.y ?? 0),
            w: local?.w ?? num(props.w),
            h: local?.h ?? 0,
        };
        if (!local || type === 'text') out.sizeUnknown = true;
        if (type === 'text' && typeof props.w === 'number') { out.w = props.w * num(props.scale, 1); out.sizeUnknown = true; }
        const rotation = num(shape.rotation);
        if (rotation) out.rotation = (rotation * 180) / Math.PI;
        if (typeof props.geo === 'string') out.geo = props.geo;
        const label = props.richText !== undefined ? richTextToPlain(props.richText) : str(props.text) ?? str(props.name);
        if (label) out.text = label;
        for (const key of ['color', 'fill', 'dash', 'size'] as const) {
            const v = str(props[key]);
            if (v) out[key] = v;
        }
        const ends = arrowEnds.get(id);
        if (ends?.start) out.startShapeId = ends.start;
        if (ends?.end) out.endShapeId = ends.end;

        if (paper && boxes.length) {
            const i = pageIndexAt(boxes, out.y);
            out.page = i + 1;
            out.x -= boxes[i].x;
            out.y -= boxes[i].y;
        }
        const list = byPage.get(origin.page);
        if (list) list.push(out);
        else byPage.set(origin.page, [out]);
    }

    const readingOrder = (a: FileShape, b: FileShape) => (a.page ?? 0) - (b.page ?? 0) || a.y - b.y || a.x - b.x;
    const pages = [...byPage].map(([pageId, shapes]) => ({
        name: str(pageRecords.find(p => p.id === pageId)?.name) ?? pageId,
        shapes: shapes.sort(readingOrder),
    }));
    if (!pages.length) pages.push({ name: 'Page 1', shapes: [] });
    return { kind, pages, paper };
}

const round = (n: number) => String(Math.round(n * 10) / 10);

function quote(text: string, max = 200): string {
    const cut = text.length > max ? `${text.slice(0, max)}…` : text;
    return JSON.stringify(cut);
}

export function formatShape(s: ShapeSummary & { sizeUnknown?: boolean }, textMax = 200): string {
    const parts = [s.id, s.geo ? `${s.type}(${s.geo})` : s.type];
    if (s.page !== undefined) parts.push(`page ${s.page}`);
    parts.push(`x=${round(s.x)} y=${round(s.y)}`);
    if (s.sizeUnknown) parts.push(s.w ? `w=${round(s.w)}` : 'size ?');
    else parts.push(`w=${round(s.w)} h=${round(s.h)}`);
    if (s.rotation) parts.push(`rot=${round(s.rotation)}°`);
    const style = (['color', 'fill', 'dash', 'size'] as const).filter(k => s[k]).map(k => `${k}=${s[k]}`);
    if (style.length) parts.push(style.join(' '));
    if (s.startShapeId) parts.push(`start→${s.startShapeId}`);
    if (s.endShapeId) parts.push(`end→${s.endShapeId}`);
    if (s.text) parts.push(`text=${quote(s.text, textMax)}`);
    return parts.join('  ');
}
