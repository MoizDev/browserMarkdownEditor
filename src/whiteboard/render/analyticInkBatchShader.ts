import type { ShaderModule } from '../../platform/render/gfx/api';
import { ANALYTIC_INK_SHADER } from './analyticInk';

const originalBlock = `layout(std140) uniform GfxUniforms0 {
    vec4 viewport; vec4 endpoints; vec4 metrics; vec4 colour;
};`;
const fragment = ANALYTIC_INK_SHADER.glsl.fragment.replace(originalBlock,
    'flat in vec4 endpoints; flat in vec4 metrics; flat in vec4 colour;');
if (fragment === ANALYTIC_INK_SHADER.glsl.fragment) throw new Error('Analytic ink shader block changed');

/** The fragment is the canonical capsule pixel-area integral, not a second AA algorithm. */
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
