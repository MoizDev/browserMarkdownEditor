import type { ViewState } from '../../platform/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { GfxDevice, GpuPass, PipelineHandle, ShaderModule } from '../../platform/render/gfx/api';
import type { PaintInkItem } from './paintStream';
import { inkCoverageChunks } from './paintStream';

const block = `layout(std140) uniform GfxUniforms0 {
    vec4 viewport; vec4 endpoints; vec4 metrics; vec4 colour;
};`;
/** Exact circle/polygon boundary integrals, not a distance-AA width floor. The capsule is
 * partitioned into its rectangle and two disjoint half-discs BEFORE resolving pixel area. */
export function analyticInkShader(fragmentInputs = block): ShaderModule { return {
    id: 'board-analytic-capsule', revision: 1,
    layout: { uniforms: [{ binding: 0, byteSize: 64 }], textures: [], attributes: [] },
    glsl: {
        vertex: `#version 300 es
precision highp float;
${block}
out vec2 pixel;
void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    vec2 lo = min(endpoints.xy, endpoints.zw) - vec2(metrics.x + 1.0);
    vec2 hi = max(endpoints.xy, endpoints.zw) + vec2(metrics.x + 1.0);
    pixel = mix(lo, hi, corner);
    vec2 unit = pixel / viewport.xy;
    gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
}`,
        fragment: `#version 300 es
precision highp float;
${fragmentInputs}
in vec2 pixel;
layout(location=0) out vec4 gfxColour;
float cross2(vec2 a, vec2 b) { return a.x*b.y-a.y*b.x; }
int cut(in vec2 a[8], int n, out vec2 b[8], vec2 normal, float edge) {
    int m=0;
    for(int i=0;i<8;i++) {
        if(i>=n) break;
        vec2 p=a[i], q=a[(i+1)%n];
        float dp=dot(normal,p)-edge, dq=dot(normal,q)-edge;
        bool pin=dp<=0.0, qin=dq<=0.0;
        if(pin) b[m++]=p;
        if(pin!=qin) b[m++]=mix(p,q,dp/(dp-dq));
    }
    return m;
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
    float t[4]; t[0]=0.0; int n=1;
    if(det>0.0) {
        float root=sqrt(det);
        float x=(-bb-root)/aa, y=(-bb+root)/aa;
        if(x>0.0 && x<1.0) t[n++]=x;
        if(y>0.0 && y<1.0) t[n++]=y;
    }
    t[n++]=1.0;
    float result=0.0;
    for(int i=0;i<3;i++) {
        if(i+1>=n) break;
        vec2 p=a+d*t[i], q=a+d*t[i+1], mid=(p+q)*0.5;
        result+=dot(mid,mid)<=r*r ? cross2(p,q) : r*r*atan(cross2(p,q),dot(p,q));
    }
    return result*0.5;
}
float circleArea(in vec2 p[8], int n, vec2 centre, float r) {
    float area=0.0;
    for(int i=0;i<8;i++) { if(i>=n) break; area+=circleEdge(p[i]-centre,p[(i+1)%n]-centre,r); }
    return abs(area);
}
void main() {
    vec2 delta=endpoints.zw-endpoints.xy;
    float length=metrics.y, r=metrics.x;
    vec2 along=length>0.0 ? delta/length : vec2(1.0,0.0), across=vec2(-along.y,along.x);
    vec2 a[8], b[8], c[8];
    // Interpolation gives logical top-left device coordinates even inside a pooled group.
    vec2 cell=floor(pixel)+vec2(0.5);
    for(int i=0;i<4;i++) {
        vec2 corner=i==0?vec2(-0.5,-0.5):i==1?vec2(0.5,-0.5):i==2?vec2(0.5,0.5):vec2(-0.5,0.5);
        vec2 v=cell+corner-endpoints.xy;
        a[i]=vec2(dot(v,along),dot(v,across));
    }
    float area=0.0;
    if(length==0.0) area=circleArea(a,4,vec2(0.0),r);
    else {
        int n=cut(a,4,b,vec2(-1.0,0.0),0.0);
        n=cut(b,n,c,vec2(1.0,0.0),length);
        n=cut(c,n,b,vec2(0.0,1.0),r);
        n=cut(b,n,c,vec2(0.0,-1.0),r);
        area=polygonArea(c,n);
        n=cut(a,4,b,vec2(1.0,0.0),0.0);
        area+=circleArea(b,n,vec2(0.0),r);
        n=cut(a,4,b,vec2(-1.0,0.0),-length);
        area+=circleArea(b,n,vec2(length,0.0),r);
    }
    gfxColour=colour*clamp(area,0.0,1.0);
}`,
    },
}; }
export const ANALYTIC_INK_SHADER = analyticInkShader();

export interface AnalyticInkPaint {
    readonly item: PaintInkItem;
    readonly data: Float32Array;
    readonly bounds: { x: number; y: number; width: number; height: number };
}
/** Only a single convex capsule/disc has the required nonoverlap proof. Curves, pressure,
 * clips and multi-primitive unions keep the exact shared reference-coverage default. */
export function analyticInkPaint(item: PaintInkItem, view: ViewState): AnalyticInkPaint | null {
    if (item.clips.length || item.material.blend !== 'normal') return null;
    const chunks = inkCoverageChunks(item.coverage);
    if (chunks.length !== 1) return null;
    const coverage = chunks[0], segments = coverage.segments, discs = coverage.discs;
    let x0: number, y0: number, x1: number, y1: number, radius: number;
    if (segments.length === 6 && !discs.length && segments[2] === segments[5]) {
        [x0, y0, radius, x1, y1] = segments;
    } else if (!segments.length && discs.length === 3) {
        [x0, y0, radius] = discs; x1 = x0; y1 = y0;
    } else return null;
    const [a, b, c, d, e, f] = item.localToWorld;
    const stretch = Math.hypot(a, b), other = Math.hypot(c, d);
    // No tolerance-based admission of a sheared ellipse as a circle.
    if (!(stretch > 0) || stretch !== other || a * c + b * d !== 0) return null;
    const scale = view.camera.z * view.viewport.dpr;
    const point = (x: number, y: number): readonly [number, number] => [
        ((e - view.camera.x) + a * x + c * y) * scale,
        ((f - view.camera.y) + b * x + d * y) * scale,
    ];
    const p = point(x0, y0), q = point(x1, y1), r = radius * stretch * scale;
    if (!(r > 0)) return null;
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const width = Math.round(view.viewport.width * view.viewport.dpr), height = Math.round(view.viewport.height * view.viewport.dpr);
    const alpha = item.material.color[3];
    const values = [width, height, 0, 0, ...p, ...q, r, length, 0, 0,
        item.material.color[0] * alpha, item.material.color[1] * alpha, item.material.color[2] * alpha, alpha];
    if (values.some(value => !Number.isFinite(value))) return null;
    const data = new Float32Array(values);
    // Packing owns half of the shared 1/16-pixel allowance, not another error budget.
    if (values.slice(4, 10).some((value, i) => Math.abs(data[i + 4] - value) > 1 / 32)) return null;
    const left = Math.max(0, Math.floor(Math.min(p[0], q[0]) - r - 1));
    const top = Math.max(0, Math.floor(Math.min(p[1], q[1]) - r - 1));
    const right = Math.min(width, Math.ceil(Math.max(p[0], q[0]) + r + 1));
    const bottom = Math.min(height, Math.ceil(Math.max(p[1], q[1]) + r + 1));
    return { item, data, bounds: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) } };
}

export function createAnalyticInk(host: LayerHost, report: (error: unknown) => void) {
    let device: GfxDevice | null = null, pipeline: PipelineHandle | null = null, pending = false, serial = 0, failed = false;
    return {
        prepare(): void {
            const next = host.device();
            if (device !== next) { this.release(); device = next; }
            if (!device || pipeline || pending || failed) return;
            const owner = device, incarnation = ++serial; pending = true;
            // Exact coverage is the default; A2C adoption requires a separate owner decision.
            owner.createPipeline({ shader: ANALYTIC_INK_SHADER, topology: 'triangle-strip', colorFormat: 'rgba8', samples: 1,
                blend: 'source-over', alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: { enabled: false } })
                .then(result => {
                    if (serial !== incarnation || device !== owner) { owner.destroy(result); return; }
                    pipeline = result; pending = false; host.invalidate('analytic-ink-ready');
                }, error => { if (serial !== incarnation) return; pending = false; failed = true; report(error); host.invalidate('analytic-ink-fallback'); });
        },
        ready(): boolean { return !!pipeline && device === host.device(); },
        draw(pass: GpuPass, paint: AnalyticInkPaint): void {
            if (!pipeline || device !== host.device()) throw new Error('Analytic ink pipeline unavailable');
            if (!paint.bounds.width || !paint.bounds.height) return;
            pass.draw({ pipeline, bindings: { uniforms: [{ binding: 0, slice: host.uniforms(paint.data) }], textures: [] },
                vertices: [], first: 0, count: 4, instances: 1, scissor: paint.bounds });
        },
        release(): void { serial++; if (pipeline) device?.destroy(pipeline); pipeline = null; pending = false; failed = false; device = null; },
    };
}
