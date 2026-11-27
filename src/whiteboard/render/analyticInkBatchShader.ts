import type { ShaderModule } from '../../platform/render/gfx/api';
import { analyticInkShader } from './analyticInk';

const fragment = analyticInkShader('flat in vec4 endpoints; flat in vec4 metrics; flat in vec4 colour;').glsl.fragment;

export const ANALYTIC_INK_BATCH_SHADER: ShaderModule = {
    id: 'board-analytic-capsule-batch', revision: 1,
    layout: { uniforms: [{ binding: 0, byteSize: 16 }], textures: [], attributes: [
        { location: 0, bufferSlot: 0, offset: 0, stride: 48, format: 'float32x4', step: 'instance' },
        { location: 1, bufferSlot: 0, offset: 16, stride: 48, format: 'float32x4', step: 'instance' },
        { location: 2, bufferSlot: 0, offset: 32, stride: 48, format: 'float32x4', step: 'instance' },
    ] },
    glsl: {
        vertex: `#version 300 es
precision highp float;
layout(std140) uniform GfxUniforms0 { vec4 viewport; };
layout(location=0) in vec4 instanceEndpoints;
layout(location=1) in vec4 instanceMetrics;
layout(location=2) in vec4 instanceColour;
flat out vec4 endpoints; flat out vec4 metrics; flat out vec4 colour;
out vec2 pixel;
void main() {
    endpoints=instanceEndpoints; metrics=instanceMetrics; colour=instanceColour;
    vec2 corner=vec2(float(gl_VertexID & 1),float((gl_VertexID >> 1) & 1));
    vec2 lo=min(endpoints.xy,endpoints.zw)-vec2(metrics.x+1.0);
    vec2 hi=max(endpoints.xy,endpoints.zw)+vec2(metrics.x+1.0);
    pixel=mix(lo,hi,corner);
    vec2 unit=pixel/viewport.xy;
    gl_Position=vec4(unit.x*2.0-1.0,1.0-unit.y*2.0,0.0,1.0);
}`,
        fragment,
    },
};

const RUN_DECLARATIONS = `layout(std140) uniform GfxUniforms0 { vec4 viewport; vec4 colour; };`;
const GRID_FRAGMENT = `#version 300 es
precision highp float;
${RUN_DECLARATIONS}
flat in vec4 endpoints; flat in vec4 metrics;
in vec2 pixel;
layout(location=0) out vec4 gfxColour;
float capsuleDistance(vec2 p, vec2 a, vec2 d, float invLength2) {
    float t = clamp(dot(p - a, d) * invLength2, 0.0, 1.0);
    return length(p - a - d * t);
}
void main() {
    vec2 a = endpoints.xy, d = endpoints.zw - endpoints.xy;
    float r = metrics.x, length2 = dot(d, d), invLength2 = length2 > 0.0 ? 1.0 / length2 : 0.0;
    vec2 cell = floor(pixel);
    float centre = capsuleDistance(cell + vec2(0.5), a, d, invLength2);
    float coverage;
    if (centre <= r - 0.54) coverage = 1.0;
    else if (centre > r + 0.54) coverage = 0.0;
    else {
        float inside = 0.0;
        for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
            vec2 s = cell + vec2(float(i) + 0.5, float(j) + 0.5) * 0.25;
            if (capsuleDistance(s, a, d, invLength2) <= r) inside += 1.0;
        }
        coverage = inside / 16.0;
    }
    gfxColour = colour * coverage;
}`;

export const ANALYTIC_INK_RUN_STRIDE = 32;
export const ANALYTIC_INK_RUN_SHADER: ShaderModule = {
    id: 'board-analytic-capsule-run', revision: 1,
    layout: { uniforms: [{ binding: 0, byteSize: 32 }], textures: [], attributes: [
        { location: 0, bufferSlot: 0, offset: 0, stride: ANALYTIC_INK_RUN_STRIDE, format: 'float32x4', step: 'instance' },
        { location: 1, bufferSlot: 0, offset: 16, stride: ANALYTIC_INK_RUN_STRIDE, format: 'float32x4', step: 'instance' },
    ] },
    glsl: {
        vertex: `#version 300 es
precision highp float;
${RUN_DECLARATIONS}
layout(location=0) in vec4 instanceEndpoints;
layout(location=1) in vec4 instanceMetrics;
flat out vec4 endpoints; flat out vec4 metrics;
out vec2 pixel;
void main() {
    endpoints=instanceEndpoints; metrics=instanceMetrics;
    vec2 corner=vec2(float(gl_VertexID & 1),float((gl_VertexID >> 1) & 1));
    vec2 lo=min(endpoints.xy,endpoints.zw)-vec2(metrics.x+1.0);
    vec2 hi=max(endpoints.xy,endpoints.zw)+vec2(metrics.x+1.0);
    pixel=mix(lo,hi,corner);
    vec2 unit=pixel/viewport.xy;
    gl_Position=vec4(unit.x*2.0-1.0,1.0-unit.y*2.0,0.0,1.0);
}`,
        fragment: GRID_FRAGMENT,
    },
};
