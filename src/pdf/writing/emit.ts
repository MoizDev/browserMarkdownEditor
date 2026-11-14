import type { Affine, PageDisplayItem, PathCommand, Rgba } from '../../platform/types';
import type { WorkerContext } from '../../platform/workers/serve';
import type { DisplayPdfPage } from './types';
import { ascii, PdfObjects, pdfNumber as n } from './pdfObjects';
import { normalizeImage } from './image';
import { Sha256 } from '../../utils/sha256';

const MAX_ITEMS = 1_000_000, MAX_COMMANDS = 1_000_000, MAX_PAGES = 100_000, MAX_DEPTH = 64;
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
type Budget = { items: number; commands: number };
type Stream = { content: string; used: Set<string> };

function color(value: Rgba): string {
    if (!Array.isArray(value) || value.length !== 4 || value.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new RangeError('Invalid display-list colour');
    return value.slice(0, 3).map(n).join(' ');
}
function alpha(value: number | undefined): number {
    const v = value ?? 1;
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError('Invalid opacity');
    return v;
}
function path(commands: PathCommand[], budget: Budget): string {
    if (!Array.isArray(commands) || (budget.commands += commands.length) > MAX_COMMANDS) throw new RangeError('Too many path commands on one page');
    return commands.map(command => {
        if (!Array.isArray(command)) throw new Error('Invalid path command');
        const [op, ...args] = command;
        const size = op === 'M' || op === 'L' ? 2 : op === 'C' ? 6 : op === 'Z' ? 0 : -1;
        if (args.length !== size) throw new Error('Invalid path command arity');
        return `${args.map(n).join(' ')} ${op === 'M' ? 'm' : op === 'L' ? 'l' : op === 'C' ? 'c' : 'h'}\n`;
    }).join('');
}
function evenOdd(rule: 'nonzero' | 'evenodd' | undefined): boolean {
    if (rule !== undefined && rule !== 'nonzero' && rule !== 'evenodd') throw new Error('Invalid fill rule');
    return rule === 'evenodd';
}
function affine(value: Affine): Affine {
    if (!Array.isArray(value) || value.length !== 6) throw new Error('Invalid affine transform');
    value.forEach(n);
    return value;
}
function multiply(a: Affine, b: Affine): Affine {
    return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
// The group may be sheared or rotated. Inverse-transform the page corners into
// its own space so the Form BBox never clips content that can reach the page.
function groupBounds(m: Affine, width: number, height: number): string {
    const det = m[0]*m[3] - m[1]*m[2];
    if (!Number.isFinite(det) || det === 0) throw new RangeError('A singular group transform cannot be exported');
    const points = [[0,0],[width,0],[0,height],[width,height]].map(([x,y]) => {
        const dx=x-m[4], dy=y-m[5];
        return [(m[3]*dx-m[2]*dy)/det, (-m[1]*dx+m[0]*dy)/det];
    });
    return [Math.min(...points.map(p=>p[0])), Math.min(...points.map(p=>p[1])), Math.max(...points.map(p=>p[0])), Math.max(...points.map(p=>p[1]))].map(n).join(' ');
}
async function digest(bytes: Uint8Array): Promise<string> {
    return new Sha256().update(bytes).digest();
}

class Resources {
    readonly objects = new PdfObjects();
    private readonly entries = new Map<string, { ref: number; kind: 'XObject' | 'ExtGState'; signature: string }>();
    private readonly images = new Map<string, string>();
    private readonly states = new Map<string, string>();
    private readonly papers = new Map<string, string>();
    private readonly forms = new Map<string, string>();
    private nextForm = 1;

    state(fill: number, stroke: number, blend: 'normal' | 'multiply' | undefined): string {
        if (blend !== undefined && blend !== 'normal' && blend !== 'multiply') throw new Error('Unsupported blend mode');
        const key = `${n(alpha(fill))} ${n(alpha(stroke))} ${blend ?? 'normal'}`;
        let name = this.states.get(key);
        if (!name) {
            name = `G${this.states.size + 1}`;
            this.entries.set(name, { kind: 'ExtGState', signature: `state:${key}`, ref: this.objects.add(`<< /Type /ExtGState /ca ${n(fill)} /CA ${n(stroke)} /BM /${blend === 'multiply' ? 'Multiply' : 'Normal'} >>`) });
            this.states.set(key, name);
        }
        return name;
    }
    async image(bytes: Uint8Array, mime: 'image/png' | 'image/jpeg'): Promise<string> {
        if (!(bytes instanceof Uint8Array) || (mime !== 'image/png' && mime !== 'image/jpeg')) throw new Error('Invalid image');
        const key = `${mime}:${await digest(bytes)}`;
        let name = this.images.get(key);
        if (!name) {
            const decoded = await normalizeImage(bytes, mime);
            const mask = decoded.alpha && this.objects.stream(`/Type /XObject /Subtype /Image /Width ${decoded.width} /Height ${decoded.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, decoded.alpha);
            const ref = this.objects.stream(`/Type /XObject /Subtype /Image /Width ${decoded.width} /Height ${decoded.height} /ColorSpace /${decoded.colorSpace} /BitsPerComponent 8 /Filter /${decoded.filter}${mask ? ` /SMask ${mask} 0 R` : ''}`, decoded.color);
            name = `I${this.images.size + 1}`;
            this.entries.set(name, { kind: 'XObject', ref, signature: `image:${key}` });
            this.images.set(key, name);
        }
        return name;
    }
    dictionary(used: Set<string>): string {
        const parts = { XObject: [] as string[], ExtGState: [] as string[] };
        for (const name of used) {
            const entry = this.entries.get(name);
            if (!entry) throw new Error('Missing generated PDF resource');
            parts[entry.kind].push(`/${name} ${entry.ref} 0 R`);
        }
        return `<< /XObject << ${parts.XObject.join(' ')} >> /ExtGState << ${parts.ExtGState.join(' ')} >> >>`;
    }
    private semantic(content: string): string {
        return content.replace(/\/(?:I|G|F)\d+\b/g, token => {
            const entry = this.entries.get(token.slice(1));
            if (!entry) throw new Error('Missing generated PDF resource');
            return `/${entry.signature}`;
        });
    }
    async pageHash(width: number, height: number, stream: Stream): Promise<string> {
        return digest(ascii(`page-v1 ${n(width)} ${n(height)}\n${this.semantic(stream.content)}`));
    }
    async form(bounds: string, stream: Stream, isolated: boolean): Promise<string> {
        const dictionary = this.dictionary(stream.used);
        const key = `${bounds}\n${isolated}\n${dictionary}\n${stream.content}`;
        const existing = this.forms.get(key);
        if (existing) return existing;
        const signature = await digest(ascii(`form-v1 ${bounds} ${isolated}\n${this.semantic(stream.content)}`));
        const name = `F${this.nextForm++}`;
        const group = isolated ? ' /Group << /S /Transparency /I true /K false >>' : '';
        const ref = this.objects.stream(`/Type /XObject /Subtype /Form /FormType 1 /BBox [${bounds}] /Resources ${dictionary}${group}`, ascii(stream.content));
        this.entries.set(name, { kind: 'XObject', ref, signature: `form:${signature}` });
        this.forms.set(key, name);
        return name;
    }
    async paper(width: number, height: number, stream: Stream): Promise<string> {
        // The stream is deterministic and resource names are document-local, so
        // identical paper lists share the same Form even if page objects differ.
        const key = `${n(width)} ${n(height)}\n${stream.content}\n${[...stream.used].join(' ')}`;
        let name = this.papers.get(key);
        if (!name) { name = await this.form(`0 0 ${n(width)} ${n(height)}`, stream, false); this.papers.set(key, name); }
        return name;
    }
}

async function list(items: PageDisplayItem[], resources: Resources, budget: Budget, context: WorkerContext,
    width: number, height: number, matrix: Affine = IDENTITY, depth = 0): Promise<Stream> {
    if (!Array.isArray(items) || depth > MAX_DEPTH || (budget.items += items.length) > MAX_ITEMS) throw new RangeError('Display list exceeds item or nesting limit');
    const output: string[] = [], used = new Set<string>();
    for (let i = 0; i < items.length; i++) {
        if (i % 256 === 0) await context.slice();
        const item = items[i];
        if (!item || typeof item !== 'object') throw new Error('Invalid display-list item');
        if (item.kind === 'group') {
            if (depth >= MAX_DEPTH) throw new RangeError('Display-list nesting exceeds 64');
            const transform = affine(item.transform ?? IDENTITY), combined = multiply(matrix, transform);
            const bounds = groupBounds(combined, width, height);
            const child = await list(item.items, resources, budget, context, width, height, combined, depth + 1);
            if (item.clip) child.content = `${path(item.clip.d, budget)}${evenOdd(item.clip.fillRule) ? 'W*' : 'W'} n\n${child.content}`;
            const form = await resources.form(bounds, child, !!item.isolation);
            used.add(form);
            let state = '';
            if (item.isolation) {
                const opacity = alpha(item.isolation.opacity), gs = resources.state(opacity, opacity, item.isolation.blend);
                used.add(gs); state = `/${gs} gs\n`;
            }
            output.push(`q\n${transform.map(n).join(' ')} cm\n${state}/${form} Do\nQ\n`);
        } else if (item.kind === 'path') {
            const fill = item.fill, stroke = item.stroke;
            const odd = evenOdd(item.fillRule);
            const commands = path(item.d, budget);
            if (!fill && !stroke) continue;
            let state = '';
            if (fill) state += `${color(fill)} rg\n`;
            if (stroke) {
                if (!Number.isFinite(stroke.width) || stroke.width < 0) throw new RangeError('Invalid stroke width');
                const cap = { butt: 0, round: 1, square: 2 }[stroke.cap], join = { miter: 0, round: 1, bevel: 2 }[stroke.join];
                if (cap === undefined || join === undefined) throw new Error('Invalid stroke cap or join');
                const dash = stroke.dash ?? [], phase = stroke.dashPhase ?? 0, miter = stroke.miterLimit ?? 10;
                if (!Array.isArray(dash) || dash.some(v => !Number.isFinite(v) || v < 0) || (dash.length > 0 && dash.every(v => v === 0)) || !Number.isFinite(phase) || phase < 0 || !Number.isFinite(miter) || miter < 1) throw new RangeError('Invalid stroke dash or miter');
                state += `${color(stroke.color)} RG\n${n(stroke.width)} w\n${cap} J\n${join} j\n${n(miter)} M\n[${dash.map(n).join(' ')}] ${n(phase)} d\n`;
            }
            const gs = resources.state(fill?.[3] ?? 1, stroke?.color[3] ?? 1, item.blend); used.add(gs);
            const paint = fill && stroke ? (odd ? 'B*' : 'B') : fill ? (odd ? 'f*' : 'f') : 'S';
            output.push(`q\n${state}/${gs} gs\n${commands}${paint}\nQ\n`);
        } else if (item.kind === 'image' || item.kind === 'raster') {
            const r = item.rect;
            if (!r || r.width < 0 || r.height < 0) throw new RangeError('Invalid image rectangle');
            [r.x, r.y, r.width, r.height].forEach(n);
            const image = await resources.image(item.kind === 'image' ? item.bytes : item.png, item.kind === 'image' ? item.mime : 'image/png');
            const transform = item.kind === 'image' ? affine(item.transform) : IDENTITY;
            const opacity = alpha(item.opacity), gs = resources.state(opacity, opacity, item.blend);
            used.add(image); used.add(gs);
            output.push(`q\n/${gs} gs\n${transform.map(n).join(' ')} cm\n${n(r.width)} 0 0 ${n(-r.height)} ${n(r.x)} ${n(r.y + r.height)} cm\n/${image} Do\nQ\n`);
        } else throw new Error('Unsupported display-list item');
    }
    return { content: output.join(''), used };
}

export async function emitDocument(pages: readonly DisplayPdfPage[], context: WorkerContext): Promise<{ bytes: Uint8Array; hashes: string[] }> {
    if (!Array.isArray(pages) || pages.length < 1 || pages.length > MAX_PAGES) throw new RangeError('Invalid page count');
    const resources = new Resources(), objects = resources.objects;
    const root = objects.reserve(), tree = objects.reserve();
    const built: Array<{ page: number; stream: number; used: Set<string> }> = [];
    const hashes: string[] = [];
    for (let i = 0; i < pages.length; i++) {
        await context.slice();
        const { width, height, displayList, paper } = pages[i];
        if (!(width > 0 && height > 0)) throw new RangeError('Invalid page dimensions');
        n(width); n(height);
        if (!displayList || displayList.page !== i || (paper && paper.page !== i)) throw new Error('Display list does not belong to this page');
        const budget = { items: 0, commands: 0 };
        const paperStream = paper ? await list(paper.items, resources, budget, context, width, height) : null;
        const paperName = paperStream ? await resources.paper(width, height, paperStream) : null;
        const ink = await list(displayList.items, resources, budget, context, width, height);
        if (paperName) ink.used.add(paperName);
        const content = `q\n0 0 ${n(width)} ${n(height)} re W n\n1 0 0 -1 0 ${n(height)} cm\n${paperName ? `/${paperName} Do\n` : ''}${ink.content}Q\n`;
        hashes.push(await resources.pageHash(width, height, { content, used: ink.used }));
        built.push({ page: objects.reserve(), stream: objects.stream('', ascii(content)), used: ink.used });
    }
    for (let i = 0; i < pages.length; i++) {
        const { width, height } = pages[i], page = built[i];
        objects.set(page.page, `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${n(width)} ${n(height)}] /Resources ${resources.dictionary(page.used)} /Contents ${page.stream} 0 R >>`);
    }
    objects.set(tree, `<< /Type /Pages /Count ${built.length} /Kids [${built.map(p => `${p.page} 0 R`).join(' ')}] >>`);
    objects.set(root, `<< /Type /Catalog /Pages ${tree} 0 R >>`);
    return { bytes: objects.finish(root), hashes };
}
