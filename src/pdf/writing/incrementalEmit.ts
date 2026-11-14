import type { Affine } from '../../platform/types';
import { ascii, pdfNumber as n } from './pdfObjects';
import { Resources, affine, alpha, color, evenOdd, groupBounds, multiply, path } from './emit';
import type { IncrementalEmittedPdf, IncrementalOperation } from './incrementalTypes';

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
type Group = { chunks: string[]; used: Set<string>; matrix: Affine; transform: Affine; bounds: string; isolation?: { opacity: number; blend: 'normal' | 'multiply' } };
type Page = { index: number; width: number; height: number };

/** Worker-local transaction. No page or unfinished path is published independently. */
export class IncrementalEmitter {
    private readonly resources = new Resources();
    private readonly root = this.resources.objects.reserve();
    private readonly tree = this.resources.objects.reserve();
    private readonly pages: Page[] = [];
    private readonly built: Array<{ page: number; stream: number; used: Set<string> }> = [];
    private readonly hashes: string[] = [];
    private groups: Group[] = [];
    private page: Page | null = null;
    private openPath: { paint: string; chunks: number } | null = null;
    private revision = -1;
    private count = 0;
    private commands = 0;
    private items = 0;
    private finished = false;

    private current(): Group { const g = this.groups.at(-1); if (!this.page || !g) throw new Error('No active PDF page'); return g; }
    private idle(): Group { const g = this.current(); if (this.openPath) throw new Error('PDF path remains open'); return g; }
    private item(): void { if (++this.items > 1_000_000) throw new RangeError('Too many PDF items'); }
    async run(op: IncrementalOperation): Promise<IncrementalEmittedPdf | undefined> {
        if (this.finished) throw new Error('PDF transaction is closed');
        switch (op.kind) {
            case 'open':
                if (this.revision !== -1 || !Number.isSafeInteger(op.revision) || op.revision < 0 || !Number.isSafeInteger(op.pageCount) || op.pageCount < 1 || op.pageCount > 100_000) throw new Error('Invalid PDF transaction');
                this.revision = op.revision; this.count = op.pageCount; break;
            case 'beginPage': {
                const p = op.page;
                if (this.revision < 0 || this.page || p.index !== this.pages.length || p.index >= this.count || !Number.isFinite(p.width) || !Number.isFinite(p.height) || p.width <= 0 || p.height <= 0 || p.width > 14_400 || p.height > 14_400) throw new Error('Invalid PDF page');
                this.page = { ...p }; this.commands = 0; this.items = 0;
                this.groups = [{ chunks: [`q\n0 0 ${n(p.width)} ${n(p.height)} re W n\n1 0 0 -1 0 ${n(p.height)} cm\n`], used: new Set(), matrix: IDENTITY, transform: IDENTITY, bounds: '' }]; break;
            }
            case 'beginGroup': {
                const parent = this.idle(); this.item();
                if (this.groups.length > 64) throw new RangeError('PDF group depth exceeded');
                const transform = affine(op.group.transform ?? IDENTITY), matrix = multiply(parent.matrix, transform), page = this.page!;
                const bounds = groupBounds(matrix, page.width, page.height), chunks: string[] = [];
                if (op.group.clip) {
                    if (op.group.clip.d.length > 65_536) throw new RangeError('PDF clip too large');
                    chunks.push(path(op.group.clip.d, { items: 0, commands: 0 }), `${evenOdd(op.group.clip.fillRule) ? 'W*' : 'W'} n\n`);
                }
                if (op.group.isolation) { alpha(op.group.isolation.opacity); if (!['normal', 'multiply'].includes(op.group.isolation.blend)) throw new Error('Invalid group blend'); }
                this.groups.push({ chunks, used: new Set(), matrix, transform, bounds, isolation: op.group.isolation }); break;
            }
            case 'endGroup': {
                this.idle(); if (this.groups.length < 2) throw new Error('No active PDF group');
                const group = this.groups.pop()!, parent = this.current();
                const name = await this.resources.form(group.bounds, { content: group.chunks.join(''), used: group.used }, !!group.isolation);
                parent.used.add(name); let state = '';
                if (group.isolation) { const gs = this.resources.state(group.isolation.opacity, group.isolation.opacity, group.isolation.blend); parent.used.add(gs); state = `/${gs} gs\n`; }
                parent.chunks.push(`q\n${group.transform.map(n).join(' ')} cm\n${state}/${name} Do\nQ\n`); break;
            }
            case 'beginPath': {
                const group = this.idle(); this.item(); const { fill, stroke, blend } = op.path;
                if (op.path.kind !== 'path') throw new Error('Invalid PDF path');
                const odd = evenOdd(op.path.fillRule); let state = '';
                if (fill) state += `${color(fill)} rg\n`;
                if (stroke) {
                    if (!Number.isFinite(stroke.width) || stroke.width < 0) throw new RangeError('Invalid stroke width');
                    const cap = { butt: 0, round: 1, square: 2 }[stroke.cap], join = { miter: 0, round: 1, bevel: 2 }[stroke.join];
                    const dash = stroke.dash ?? [], phase = stroke.dashPhase ?? 0, miter = stroke.miterLimit ?? 10;
                    if (cap === undefined || join === undefined || !Array.isArray(dash) || dash.length > 1024 || dash.some(v => !Number.isFinite(v) || v < 0) || (dash.length > 0 && dash.every(v => v === 0)) || !Number.isFinite(phase) || phase < 0 || !Number.isFinite(miter) || miter < 1) throw new Error('Invalid stroke');
                    state += `${color(stroke.color)} RG\n${n(stroke.width)} w\n${cap} J\n${join} j\n${n(miter)} M\n[${dash.map(n).join(' ')}] ${n(phase)} d\n`;
                }
                const gs = this.resources.state(fill?.[3] ?? 1, stroke?.color[3] ?? 1, blend); group.used.add(gs);
                group.chunks.push(`q\n${state}/${gs} gs\n`);
                this.openPath = { paint: fill && stroke ? (odd ? 'B*' : 'B') : fill ? (odd ? 'f*' : 'f') : stroke ? 'S' : 'n', chunks: 0 }; break;
            }
            case 'pathCommands': {
                const group = this.current(); if (!this.openPath || !Array.isArray(op.commands) || op.commands.length > 1024) throw new Error('Invalid PDF path chunk');
                this.commands += op.commands.length; if (this.commands > 20_000_000) throw new RangeError('PDF path limit exceeded');
                group.chunks.push(path([...op.commands], { items: 0, commands: 0 })); this.openPath.chunks += op.commands.length; break;
            }
            case 'endPath': {
                const group = this.current(); if (!this.openPath) throw new Error('No active PDF path');
                group.chunks.push(`${this.openPath.paint}\nQ\n`); this.openPath = null; break;
            }
            case 'image': {
                const group = this.idle(); this.item(); const item = op.item, r = item.rect;
                if (!r || r.width < 0 || r.height < 0) throw new Error('Invalid PDF image rectangle');
                [r.x, r.y, r.width, r.height].forEach(n);
                const bytes = item.kind === 'image' ? item.bytes : item.kind === 'raster' ? item.png : null;
                if (!(bytes instanceof Uint8Array) || bytes.length > 0x7fffffff) throw new Error('Invalid PDF image');
                const image = await this.resources.image(bytes, item.kind === 'image' ? item.mime : 'image/png');
                const transform = item.kind === 'image' ? affine(item.transform) : IDENTITY;
                const opacity = alpha(item.opacity), gs = this.resources.state(opacity, opacity, item.blend);
                group.used.add(image); group.used.add(gs);
                group.chunks.push(`q\n/${gs} gs\n${transform.map(n).join(' ')} cm\n${n(r.width)} 0 0 ${n(-r.height)} ${n(r.x)} ${n(r.y + r.height)} cm\n/${image} Do\nQ\n`); break;
            }
            case 'endPage': {
                const group = this.idle(); if (this.groups.length !== 1) throw new Error('PDF group remains open');
                const page = this.page!, content = group.chunks.join('') + 'Q\n';
                this.hashes.push(await this.resources.pageHash(page.width, page.height, { content, used: group.used }));
                this.built.push({ page: this.resources.objects.reserve(), stream: this.resources.objects.stream('', ascii(content)), used: group.used });
                this.pages.push(page); this.page = null; this.groups = []; break;
            }
            case 'finish': {
                if (this.page || this.pages.length !== this.count || this.revision < 0) throw new Error('Incomplete PDF transaction');
                const objects = this.resources.objects;
                this.pages.forEach((p, i) => { const built = this.built[i]; objects.set(built.page, `<< /Type /Page /Parent ${this.tree} 0 R /MediaBox [0 0 ${n(p.width)} ${n(p.height)}] /Resources ${this.resources.dictionary(built.used)} /Contents ${built.stream} 0 R >>`); });
                objects.set(this.tree, `<< /Type /Pages /Count ${this.built.length} /Kids [${this.built.map(p => `${p.page} 0 R`).join(' ')}] >>`);
                objects.set(this.root, `<< /Type /Catalog /Pages ${this.tree} 0 R >>`); this.finished = true;
                return { revision: this.revision, bytes: objects.finish(this.root), hashes: this.hashes, pages: this.pages };
            }
        }
    }
}
