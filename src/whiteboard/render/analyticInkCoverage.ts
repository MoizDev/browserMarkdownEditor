import type { ViewState } from '../../platform/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { BufferHandle, ByteLease, GfxDevice, GpuPass, PipelineHandle, RectI, SamplerHandle, ShaderModule } from '../../platform/render/gfx/api';
import type { FrameBudget } from '../../platform/render/types';
import type { createPathCoverageKit } from '../../platform/render/pathCoverage';
import { inkCoverageChunks, type PaintInkItem } from './paintStream';

/**
 * Ink drawn on the GPU with canvas2d's edge quality. A stroke is the union of tapered capsules and discs (outline.ts):
 * each capsule is split into its two end discs and the quadrilateral between their tangent points, and each piece writes
 * its EXACT pixel-area coverage (the circle and polygon area integrals of analyticInk.ts) into the coverage kit's shared
 * scratch with MAX blending, which the kit then composites once in the item's colour and blend. (An isolation group per
 * item drew nothing: groups need their inventory declared in prepare, and a target per stroke is the wrong cost.) The pieces of one stroke meet tangentially,
 * so the maximum differs from the area of their union only by slivers.
 *
 * Why not the coverage kit's stencil route: 4× MSAA rounds an edge pixel to quarters, one step being ~64 levels; a single
 * notebook stroke differed from canvas2d on 68 edge pixels (max 57) and twelve stacked copies on 3,160.
 */
const STRIDE = 48;
const KIND_DISC = 0, KIND_QUAD = 1;

const SHADER: ShaderModule = {
    id: 'board-analytic-ink-union', revision: 1,
    layout: { uniforms: [{ binding: 0, byteSize: 16 }], textures: [], attributes: [
        { location: 0, bufferSlot: 0, offset: 0, stride: STRIDE, format: 'float32x4', step: 'instance' },
        { location: 1, bufferSlot: 0, offset: 16, stride: STRIDE, format: 'float32x4', step: 'instance' },
        { location: 2, bufferSlot: 0, offset: 32, stride: STRIDE, format: 'float32x4', step: 'instance' },
    ] },
    glsl: {
        vertex: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; };
layout(location=0) in vec4 head;   // kind, p0.x, p0.y, radius
layout(location=1) in vec4 mid;    // p1.x, p1.y, p2.x, p2.y
layout(location=2) in vec4 tail;   // p3.x, p3.y, -, -
flat out vec4 h; flat out vec4 m; flat out vec4 t;
out vec2 pixel;
void main() {
    h=head; m=mid; t=tail;
    vec2 lo, hi;
    if(head.x<0.5) { lo=head.yz-vec2(head.w+1.0); hi=head.yz+vec2(head.w+1.0); }
    else {
        lo=min(min(head.yz,mid.xy),min(mid.zw,tail.xy))-vec2(1.0);
        hi=max(max(head.yz,mid.xy),max(mid.zw,tail.xy))+vec2(1.0);
    }
    vec2 corner=vec2(float(gl_VertexID&1),float((gl_VertexID>>1)&1));
    pixel=mix(lo,hi,corner);
    vec2 unit=pixel/viewport.xy;
    gl_Position=vec4(unit.x*2.0-1.0,1.0-unit.y*2.0,0.0,1.0);
}`,
        fragment: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; };
flat in vec4 h; flat in vec4 m; flat in vec4 t;
in vec2 pixel;
layout(location=0) out vec4 gfxColour;
float cross2(vec2 a, vec2 b) { return a.x*b.y-a.y*b.x; }
int cut(in vec2 a[8], int n, out vec2 b[8], vec2 normal, float edge) {
    int k=0;
    for(int i=0;i<8;i++) {
        if(i>=n) break;
        vec2 p=a[i], q=a[(i+1)%n];
        float dp=dot(normal,p)-edge, dq=dot(normal,q)-edge;
        bool pin=dp<=0.0, qin=dq<=0.0;
        if(pin) b[k++]=p;
        if(pin!=qin && k<8) b[k++]=mix(p,q,dp/(dp-dq));
        if(k>=8) break;
    }
    return k;
}
float polygonArea(in vec2 p[8], int n) {
    float area=0.0;
    for(int i=0;i<8;i++) { if(i>=n) break; area+=cross2(p[i],p[(i+1)%n]); }
    return abs(area)*0.5;
}
float circleEdge(vec2 a, vec2 b, float r) {
    vec2 d=b-a;
    float aa=dot(d,d);
    if(aa==0.0) return 0.0;
    float bb=dot(a,d), cc=dot(a,a)-r*r;
    float det=bb*bb-aa*cc;
    float s[4]; s[0]=0.0; int n=1;
    if(det>0.0) {
        float root=sqrt(det);
        float x=(-bb-root)/aa, y=(-bb+root)/aa;
        if(x>0.0 && x<1.0) s[n++]=x;
        if(y>0.0 && y<1.0) s[n++]=y;
    }
    s[n++]=1.0;
    float result=0.0;
    for(int i=0;i<3;i++) {
        if(i+1>=n) break;
        vec2 p=a+d*s[i], q=a+d*s[i+1], c=(p+q)*0.5;
        result+=dot(c,c)<=r*r ? cross2(p,q) : r*r*atan(cross2(p,q),dot(p,q));
    }
    return result*0.5;
}
void main() {
    vec2 cell=floor(pixel)+vec2(0.5);
    vec4 flags=vec4(0.0);
    // Four sub-scanlines with exact horizontal coverage on each: canvas2d's own rasterization of these paths (its
    // edge values are only ever whole quarters), so the GPU lands on the same values instead of a finer or coarser AA.
    for(int k=0;k<4;k++) {
        float y=cell.y-0.375+0.25*float(k);
        float lo=1e9, hi=-1e9;
        if(h.x<0.5) {
            float dy=y-h.z;
            if(abs(dy)<h.w) { float w=sqrt(h.w*h.w-dy*dy); lo=h.y-w; hi=h.y+w; }
        } else {
            vec2 q[4]; q[0]=h.yz; q[1]=m.xy; q[2]=m.zw; q[3]=t.xy;
            for(int i=0;i<4;i++) {
                vec2 p=q[i], r=q[(i+1)%4];
                if((p.y<=y && r.y>y) || (r.y<=y && p.y>y)) {
                    float x=p.x+(y-p.y)*(r.x-p.x)/(r.y-p.y);
                    lo=min(lo,x); hi=max(hi,x);
                }
            }
        }
        if(hi>lo && cell.x>=lo && cell.x<hi) flags[k]=1.0;
    }
    // One channel per sub-scanline: MAX blending ORs them across pieces, which is the union canvas2d fills.
    gfxColour=flags;
}`,
    },
};

/** Turns the band's four sub-scanline flags into coverage of the item's colour. */
const RESOLVE: ShaderModule = {
    id: 'board-analytic-ink-resolve', revision: 1,
    layout: { uniforms: [{ binding: 0, byteSize: 48 }], textures: [{ binding: 0, format: 'rgba8' }], attributes: [] },
    glsl: {
        vertex: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; vec4 band; vec4 colour; };
out vec2 pixel;
void main() {
    vec2 corner=vec2(float(gl_VertexID&1),float((gl_VertexID>>1)&1));
    pixel=band.xy+corner*band.zw;
    vec2 unit=pixel/viewport.xy;
    gl_Position=vec4(unit.x*2.0-1.0,1.0-unit.y*2.0,0.0,1.0);
}`,
        fragment: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; vec4 band; vec4 colour; };
uniform sampler2D gfxTexture0;
in vec2 pixel;
layout(location=0) out vec4 gfxColour;
void main() {
    ivec2 local=ivec2(floor(pixel-band.xy));
    vec4 flags=texelFetch(gfxTexture0, ivec2(local.x, int(viewport.z)-1-local.y), 0);
    gfxColour=colour*(dot(step(vec4(0.5),flags),vec4(0.25)));
}`,
    },
};

export interface PreparedInkUnion {
    readonly device: GfxDevice;
    readonly buffer: BufferHandle;
    readonly count: number;
    readonly bounds: RectI;
    readonly viewport: Readonly<{ width: number; height: number }>;
    readonly colour: readonly [number, number, number, number];
    readonly blend: 'normal' | 'multiply';
    readonly bytes: number;
}

export type InkUnionAdmission = { status: 'ready'; value: PreparedInkUnion } | { status: 'empty' | 'denied' | 'unsupported' };

/** Instances in device pixels, or null when the item's transform is not a similarity (an ellipse is not a disc). */
function instances(item: PaintInkItem, view: ViewState): { data: Float32Array; bounds: { x0: number; y0: number; x1: number; y1: number } } | null {
    const [a, b, c, d, e, f] = item.localToWorld;
    const stretch = Math.hypot(a, b), other = Math.hypot(c, d);
    if (!(stretch > 0) || Math.abs(stretch - other) > 1e-9 * stretch || Math.abs(a * c + b * d) > 1e-9 * stretch * stretch) return null;
    const scale = view.camera.z * view.viewport.dpr, rs = stretch * scale;
    const px = (x: number, y: number) => ((e - view.camera.x) + a * x + c * y) * scale;
    const py = (x: number, y: number) => ((f - view.camera.y) + b * x + d * y) * scale;
    const rows: number[] = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x: number, y: number, r: number) => { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); };
    const disc = (x: number, y: number, r: number) => {
        if (!(r > 0)) return;
        const cx = px(x, y), cy = py(x, y), cr = r * rs;
        rows.push(KIND_DISC, cx, cy, cr, 0, 0, 0, 0, 0, 0, 0, 0); grow(cx, cy, cr);
    };
    for (const chunk of inkCoverageChunks(item.coverage)) {
        const s = chunk.segments;
        for (let i = 0; i < s.length; i += 6) {
            const ax = s[i], ay = s[i + 1], r0 = s[i + 2], bx = s[i + 3], by = s[i + 4], r1 = s[i + 5];
            const dx = bx - ax, dy = by - ay, distance = Math.hypot(dx, dy), difference = r1 - r0;
            // The same hull as outline.ts's outlineWork: one disc swallows the other, or two tangent lines join them.
            if (distance <= Math.abs(difference)) { if (r0 >= r1) disc(ax, ay, r0); else disc(bx, by, r1); continue; }
            disc(ax, ay, r0); disc(bx, by, r1);
            const ux = dx / distance, uy = dy / distance, along = -difference / distance;
            const perpendicular = Math.sqrt(Math.max(0, 1 - along * along));
            const mx = along * ux + perpendicular * uy, my = along * uy - perpendicular * ux;
            const qx = along * ux - perpendicular * uy, qy = along * uy + perpendicular * ux;
            const p = [[ax + r0 * mx, ay + r0 * my], [bx + r1 * mx, by + r1 * my], [bx + r1 * qx, by + r1 * qy], [ax + r0 * qx, ay + r0 * qy]]
                .map(([x, y]) => [px(x, y), py(x, y)] as const);
            rows.push(KIND_QUAD, p[0][0], p[0][1], 0, p[1][0], p[1][1], p[2][0], p[2][1], p[3][0], p[3][1], 0, 0);
            for (const [x, y] of p) grow(x, y, 0);
        }
        for (let i = 0; i < chunk.discs.length; i += 3) disc(chunk.discs[i], chunk.discs[i + 1], chunk.discs[i + 2]);
    }
    if (!rows.every(Number.isFinite)) return null;
    return { data: Float32Array.from(rows), bounds: { x0, y0, x1, y1 } };
}

export function createInkUnionKit(host: LayerHost, report: (error: unknown) => void, coverage: ReturnType<typeof createPathCoverageKit>) {
    let device: GfxDevice | null = null, pipeline: PipelineHandle | null = null, resolver: PipelineHandle | null = null, pending = false, failed = false, incarnation = 0, disposed = false;
    let sampler: SamplerHandle | null = null;
    let gpuBytes = 0;
    const live = new Map<PreparedInkUnion, ByteLease | null>();
    const retire = (prepared: PreparedInkUnion) => {
        if (!live.has(prepared)) return;
        live.delete(prepared); gpuBytes -= prepared.bytes;
        prepared.device.destroy(prepared.buffer);
    };
    const release = () => {
        incarnation++;
        for (const prepared of [...live.keys()]) retire(prepared);
        if (pipeline && device) device.destroy(pipeline);
        if (resolver && device) device.destroy(resolver);
        if (sampler && device) device.destroy(sampler);
        device = null; pipeline = null; resolver = null; sampler = null; pending = false; failed = false;
    };
    const warm = () => {
        if (disposed) return;
        const next = host.device();
        if (device !== next) { release(); device = next; }
        if (!device || pipeline || pending || failed) return;
        const owner = device, serial = ++incarnation; pending = true;
        try {
            sampler = owner.createSampler('nearest');
            Promise.all([
                owner.createPipeline({ shader: SHADER, topology: 'triangle-strip', colorFormat: 'rgba8', samples: 4, blend: 'mask-max',
                    alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: { enabled: false } }),
                owner.createPipeline({ shader: RESOLVE, topology: 'triangle-strip', colorFormat: 'rgba8', samples: 1, blend: 'source-over',
                    alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: { enabled: false } }),
            ]).then(([value, resolve]) => {
                if (disposed || incarnation !== serial || device !== owner) { owner.destroy(value); owner.destroy(resolve); return; }
                pipeline = value; resolver = resolve; pending = false; host.invalidate('ink-union-ready');
            }, error => { if (incarnation !== serial) return; pending = false; failed = true; report(error); host.invalidate('ink-union-fallback'); });
        } catch (error) { pending = false; failed = true; report(error); }
    };
    return {
        warm,
        ready(): boolean { return !disposed && !failed && !!pipeline && !!resolver && !!sampler && !!device && host.device() === device && host.generation === device.generation; },
        memory(): { gpuBytes: number; cpuBytes: number } { return { gpuBytes, cpuBytes: 0 }; },
        /** Every buffer is created and uploaded here, in prepare; draw only encodes. */
        admit(item: PaintInkItem, view: ViewState, budget: FrameBudget): InkUnionAdmission {
            if (disposed || failed) return { status: 'unsupported' };
            warm();
            if (!pipeline || !device) return { status: pending || !device ? 'denied' : 'unsupported' };
            if (device.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) return { status: 'denied' };
            if (item.clips.length || item.material.blend === 'multiply') return { status: 'unsupported' };
            const built = instances(item, view);
            if (!built) return { status: 'unsupported' };
            const count = built.data.length / 12;
            if (!count) return { status: 'empty' };
            const viewport = { width: Math.round(view.viewport.width * view.viewport.dpr), height: Math.round(view.viewport.height * view.viewport.dpr) };
            const x0 = Math.max(0, Math.floor(built.bounds.x0) - 1), y0 = Math.max(0, Math.floor(built.bounds.y0) - 1);
            const x1 = Math.min(viewport.width, Math.ceil(built.bounds.x1) + 1), y1 = Math.min(viewport.height, Math.ceil(built.bounds.y1) + 1);
            if (x1 <= x0 || y1 <= y0) return { status: 'empty' };
            const scratch = coverage.admitScratch({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, budget);
            if (scratch !== 'ready') return { status: scratch };
            const bytes = count * STRIDE;
            const lease = host.allocator.gpu.reserve(bytes);
            if (!lease) return { status: 'denied' };
            if (!budget.claimUpload(bytes)) { host.allocator.gpu.release(lease); return { status: 'denied' }; }
            let buffer: BufferHandle;
            try {
                buffer = device.createBuffer(bytes, ['vertex', 'copy-dst'], lease);
            } catch (error) { host.allocator.gpu.release(lease); throw error; }
            try { device.writeBuffer(buffer, 0, built.data); }
            catch (error) { device.destroy(buffer); throw error; }
            const [r, g, bl, alpha] = item.material.color;
            const prepared: PreparedInkUnion = Object.freeze({ device, buffer, count, bytes,
                bounds: Object.freeze({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }),
                viewport: Object.freeze(viewport), colour: Object.freeze([r * alpha, g * alpha, bl * alpha, alpha]) as unknown as readonly [number, number, number, number],
                blend: 'normal' });
            live.set(prepared, null); gpuBytes += bytes;
            return { status: 'ready', value: prepared };
        },
        /** Each band: the pieces' sub-scanline flags OR together (MAX) in the kit's scratch, then one resolve draw turns
         * them into coverage of the item's colour, source-over into the caller's pass. Multiply ink is not admitted. */
        draw(pass: GpuPass, prepared: PreparedInkUnion): void {
            if (disposed || !pipeline || !resolver || !sampler || !live.has(prepared) || prepared.device !== device) throw new Error('Stale ink union');
            const flags = new Float32Array(4);
            flags.set([prepared.viewport.width, prepared.viewport.height, 0, 0]);
            const flagSlice = host.uniforms(flags);
            const drawn = pipeline, resolve = resolver, nearest = sampler;
            coverage.composeResolved(pass, prepared.bounds, (inner, band) => {
                inner.draw({ pipeline: drawn, bindings: { uniforms: [{ binding: 0, slice: flagSlice }], textures: [] },
                    vertices: [{ buffer: prepared.buffer, offset: 0, bytes: prepared.bytes }], first: 0, count: 4, instances: prepared.count,
                    scissor: band });
            }, (outer, band, texture, textureHeight) => {
                const data = new Float32Array(12);
                data.set([prepared.viewport.width, prepared.viewport.height, textureHeight, 0, band.x, band.y, band.width, band.height, ...prepared.colour]);
                outer.draw({ pipeline: resolve, bindings: { uniforms: [{ binding: 0, slice: host.uniforms(data) }],
                    textures: [{ binding: 0, texture, sampler: nearest }] }, vertices: [], first: 0, count: 4, instances: 1, scissor: band });
            });
        },
        retire,
        release,
        dispose(): void { if (!disposed) { disposed = true; release(); } },
    };
}
