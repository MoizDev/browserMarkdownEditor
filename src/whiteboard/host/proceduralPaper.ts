import type { Rect, Rgba, ViewState } from '../../platform/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { GfxDevice, GpuPass, PipelineHandle, RectI, ShaderModule } from '../../platform/render/gfx/api';
import { ArenaError } from '../../platform/render/resourceArena';
import type { PageStack } from '../../platform/render/pageStack';
import { auditCount } from '../../platform/render/renderAudit';
import { columnOffsets, marginX, paperPageSize, ruleOffsets, type NotebookPaper } from '../../utils/paper';
import { PAPER_EDGE, PAPER_MARGIN, PAPER_RULE, PAPER_WHITE, PAPER_RULE_WIDTH, PAPER_MARGIN_WIDTH, PAPER_EDGE_WIDTH } from './notebookPaper';

/**
 * Lined, grid and blank notebook paper drawn as ONE procedural pass over the visible pages, straight into the surface pass.
 *
 * Every item of those papers (notebookPaper.ts) is an axis-aligned rectangle: the page fill, each rule (a butt-capped stroke), the
 * margin rule, and the edge stroke (the page box less its inset box). The exact coverage of an axis-aligned rectangle in a pixel is
 * the product of its overlaps in x and y, so the fragment computes, per pixel, the same exact area the exact-area route rasterises,
 * and composites the items in the template's order. Grid crossings are a union: area(H) + area(V) - area(H and V), where the
 * intersection is the product of the two sums of overlaps (the rows span the page in x, the columns span it in y).
 *
 * Why (measured, notebook saturated zoom, 60 Hz kit): the paper's live draws went through the coverage kit per tile position,
 * 668 draws and 679 render-target switches per frame; on a tiled GPU each switch loads and stores an attachment, and the frame cost
 * 13.7-14.6 ms of GPU time, more than a 120 Hz frame. Dotted paper (discs) keeps the composed route.
 */

const UNIFORM_FLOATS = 44;

const SHADER: ShaderModule = {
    id: 'notebook-paper-procedural', revision: 1,
    layout: { uniforms: [{ binding: 0, byteSize: UNIFORM_FLOATS * 4 }], textures: [], attributes: [] },
    glsl: {
        vertex: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; vec4 page; vec4 pages; vec4 rows; vec4 cols; vec4 margin; vec4 bounds;
    vec4 white; vec4 rule; vec4 marginColour; vec4 edge; };
out vec2 pixel;
void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    vec2 p = mix(bounds.xy, bounds.zw, corner);
    pixel = p;
    vec2 unit = p / viewport.xy;
    gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
}`,
        fragment: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; vec4 page; vec4 pages; vec4 rows; vec4 cols; vec4 margin; vec4 bounds;
    vec4 white; vec4 rule; vec4 marginColour; vec4 edge; };
in vec2 pixel;
layout(location=0) out vec4 gfxColour;
// The overlap of [a0, a1] with the pixel's span [c, c + 1].
float overlap(float a0, float a1, float c) { return clamp(min(a1, c + 1.0) - max(a0, c), 0.0, 1.0); }
// The summed overlaps of n bands of half-width h centred at o0 + k s (k = 0..n-1) with [c, c + 1]: disjoint bands, so a union.
float bands(float o0, float s, float n, float h, float c) {
    if (n < 0.5) return 0.0;
    float k0 = max(0.0, ceil((c - h - o0) / s - 1.0)), k1 = min(n - 1.0, floor((c + 1.0 + h - o0) / s + 1.0));
    float sum = 0.0;
    for (int i = 0; i < 256; i++) {
        float k = k0 + float(i);
        if (k > k1) break;
        float centre = o0 + k * s;
        sum += overlap(centre - h, centre + h, c);
    }
    return sum;
}
void over(inout vec4 c, vec4 colour, float coverage) {
    float a = colour.a * coverage;
    c = vec4(colour.rgb * a, a) + c * (1.0 - a);
}
void main() {
    vec2 cell = floor(pixel);
    vec4 c = vec4(0.0);
    float pitch = pages.x, count = pages.y, ruling = pages.z;
    float w = page.z, h = page.w;
    float j = floor((cell.y - page.y) / pitch);
    for (int d = -1; d <= 1; d++) {
        float index = j + float(d);
        if (index < 0.0 || index >= count) continue;
        float x0 = page.x, y0 = page.y + index * pitch;
        // The pixel in page-local device units: every item below is placed from the page's own corner.
        float lx = cell.x - x0, ly = cell.y - y0;
        float px = overlap(0.0, w, lx), py = overlap(0.0, h, ly);
        if (px * py <= 0.0) continue;
        vec4 p = vec4(0.0);
        over(p, white, px * py);
        if (ruling > 0.5) {
            float sy = bands(rows.x, rows.y, rows.z, rows.w, ly);
            float area = px * sy;
            if (ruling > 1.5) {
                float sx = bands(cols.x, cols.y, cols.z, rows.w, lx);
                area = px * sy + sx * py - sx * sy;
            }
            over(p, rule, area);
        }
        if (margin.z > 0.5) over(p, marginColour, overlap(margin.x - margin.y, margin.x + margin.y, lx) * py);
        float inset = margin.w;
        float inner = overlap(inset, w - inset, lx) * overlap(inset, h - inset, ly);
        over(p, edge, max(0.0, px * py - inner));
        // Pages are disjoint: their pictures add.
        c += p * (1.0 - c.a);
    }
    gfxColour = c;
}`,
    },
};

/** Why the procedural pass does not draw this paper: the composed route draws it instead (counted by the layer). */
export type ProceduralRefusal = 'dotted' | 'stack' | 'pipeline';

export interface ProceduralPaper {
    /** Null when this paper and stack can be drawn procedurally, else why not. */
    refusal(paper: Readonly<NotebookPaper>, stack: Readonly<PageStack>): ProceduralRefusal | null;
    /** True once the pipeline is ready on the host's current device; starts its creation otherwise. */
    ready(): boolean;
    /** Draws the visible pages of `stack`; returns the indexes of the pages drawn ([first, last]), or null when none is visible. */
    draw(pass: GpuPass, view: ViewState, paper: Readonly<NotebookPaper>, stack: Readonly<PageStack>): readonly [number, number] | null;
    release(): void;
}

interface Template { readonly paper: Readonly<NotebookPaper>; readonly width: number; readonly height: number;
    readonly rows: readonly [number, number, number]; readonly cols: readonly [number, number, number]; readonly margin: number | null }

/** The offsets as first + k * step, or null when they are not (the generator's loop is an arithmetic series). */
function series(values: readonly number[], step: number): readonly [number, number, number] | null {
    if (!values.length) return [0, step, 0];
    for (let i = 0; i < values.length; i++) if (Math.abs(values[i] - (values[0] + i * step)) > 1e-6) return null;
    return [values[0], step, values.length];
}

export function createProceduralPaper(host: LayerHost): ProceduralPaper {
    let device: GfxDevice | null = null, generation = -1, pipeline: PipelineHandle | null = null, pending = false, failed = false;
    let template: Template | null = null;
    const data = new Float32Array(UNIFORM_FLOATS);
    const scissor: RectI = { x: 0, y: 0, width: 0, height: 0 };
    const drawn: [number, number] = [0, 0];
    const set = (at: number, colour: Rgba) => { data[at] = colour[0]; data[at + 1] = colour[1]; data[at + 2] = colour[2]; data[at + 3] = colour[3]; };
    const templateOf = (paper: Readonly<NotebookPaper>): Template | null => {
        if (template?.paper === paper) return template;
        const { width, height } = paperPageSize(paper);
        const rows = paper.ruling === 'lined' || paper.ruling === 'grid' ? series(ruleOffsets(paper), paper.spacing) : [0, paper.spacing, 0] as const;
        const cols = paper.ruling === 'grid' ? series(columnOffsets(paper), paper.spacing) : [0, paper.spacing, 0] as const;
        if (!rows || !cols) return null;
        template = { paper, width, height, rows, cols, margin: marginX(paper) };
        return template;
    };
    const release = (): void => {
        if (device && pipeline) { try { device.destroy(pipeline); } catch { /* the device may be gone */ } }
        device = null; pipeline = null; pending = false; failed = false; generation = -1;
    };
    return {
        refusal(paper, stack) {
            if (paper.ruling === 'dotted') return 'dotted';
            const t = templateOf(paper);
            const first = stack.rects[0];
            if (!t || !first || first.width !== t.width || first.height !== t.height) return 'stack';
            // One pitch for every page: the fragment finds a pixel's page by division (pageLayout stacks equal pages with one gap).
            const pitch = stack.rects.length > 1 ? stack.rects[1].y - first.y : t.height;
            for (let i = 1; i < stack.rects.length; i++) {
                const rect = stack.rects[i];
                if (rect.x !== first.x || rect.width !== first.width || rect.height !== first.height || Math.abs(rect.y - (first.y + i * pitch)) > 1e-6) return 'stack';
            }
            return null;
        },
        ready() {
            const owner = host.device();
            if (!owner) return false;
            if (owner !== device || host.generation !== generation) { release(); device = owner; generation = host.generation; }
            if (pipeline) return true;
            if (pending || failed) return false;
            pending = true;
            const serial = generation;
            owner.createPipeline({ shader: SHADER, topology: 'triangle-strip', colorFormat: 'rgba8', samples: 1, blend: 'source-over',
                alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: { enabled: false } }).then(made => {
                if (device !== owner || generation !== serial) { owner.destroy(made); return; }
                pipeline = made; pending = false; host.invalidate('paper-procedural-ready');
            }, () => {
                if (device !== owner || generation !== serial) return;
                pending = false; failed = true; auditCount('notebook-paper', 'procedural:pipeline-failed');
            });
            return false;
        },
        draw(pass, view, paper, stack) {
            const t = templateOf(paper);
            if (!pipeline || !t || !stack.rects.length) return null;
            const cam = view.camera, scale = cam.z * view.viewport.dpr;
            const surfaceW = Math.round(view.viewport.width * view.viewport.dpr), surfaceH = Math.round(view.viewport.height * view.viewport.dpr);
            const first = stack.rects[0];
            const pitch = stack.rects.length > 1 ? stack.rects[1].y - first.y : t.height;
            // The visible pages, by the view's world span: the fragment only reads pages in [0, count).
            const top = cam.y, bottom = cam.y + view.viewport.height / cam.z;
            const lo = Math.max(0, Math.floor((top - first.y) / pitch)), hi = Math.min(stack.rects.length - 1, Math.floor((bottom - first.y) / pitch));
            if (hi < lo) return null;
            const firstVisible: Rect = stack.rects[lo];
            // Device coordinates of the first visible page, in double precision: the shader works near the view, never at a 100 m offset.
            const ox = (firstVisible.x - cam.x) * scale, oy = (firstVisible.y - cam.y) * scale;
            const x0 = Math.max(0, Math.floor(ox)), x1 = Math.min(surfaceW, Math.ceil(ox + t.width * scale));
            const y0 = Math.max(0, Math.floor(oy)), y1 = Math.min(surfaceH, Math.ceil(oy + ((hi - lo) * pitch + t.height) * scale));
            if (x1 <= x0 || y1 <= y0) return null;
            data[0] = surfaceW; data[1] = surfaceH; data[2] = scale; data[3] = 0;
            data[4] = ox; data[5] = oy; data[6] = t.width * scale; data[7] = t.height * scale;
            data[8] = pitch * scale; data[9] = hi - lo + 1; data[10] = paper.ruling === 'grid' ? 2 : paper.ruling === 'lined' ? 1 : 0; data[11] = 0;
            data[12] = t.rows[0] * scale; data[13] = t.rows[1] * scale; data[14] = t.rows[2]; data[15] = PAPER_RULE_WIDTH / 2 * scale;
            data[16] = t.cols[0] * scale; data[17] = t.cols[1] * scale; data[18] = t.cols[2]; data[19] = 0;
            data[20] = (t.margin ?? 0) * scale; data[21] = PAPER_MARGIN_WIDTH / 2 * scale; data[22] = t.margin === null ? 0 : 1; data[23] = PAPER_EDGE_WIDTH * scale;
            data[24] = x0; data[25] = y0; data[26] = x1; data[27] = y1;
            set(28, PAPER_WHITE); set(32, PAPER_RULE); set(36, PAPER_MARGIN); set(40, PAPER_EDGE);
            let slice;
            try { slice = host.uniforms(data); }
            catch (error) {
                if (!(error instanceof ArenaError) || error.code !== 'out-of-budget') throw error;
                auditCount('notebook-paper', 'procedural:uniform-refused'); host.markIncomplete('paper-uniform-refused'); host.invalidate('paper-uniform-refused');
                return null;
            }
            scissor.x = x0; scissor.y = y0; scissor.width = x1 - x0; scissor.height = y1 - y0;
            pass.draw({ pipeline, bindings: { uniforms: [{ binding: 0, slice }], textures: [] }, vertices: [], first: 0, count: 4, instances: 1, scissor });
            auditCount('notebook-paper', 'procedural:frame');
            drawn[0] = lo; drawn[1] = hi;
            return drawn;
        },
        release,
    };
}
