import type { ShaderModule } from './gfx/api';

const uniforms = `layout(std140) uniform GfxUniforms0 {
    vec4 viewport;
    vec4 destination;
    vec4 sourceRect;
    vec4 sourceSizeOpacity;
};`;

/** Texel-space crop includes only the requested interior, not a tile's gutter (design §5.1).
 * Float destinations retain motion phase; GL storage is bottom-left, API rectangles top-left (§2.5).
 */
export const TEXTURED_QUAD_SHADER: ShaderModule = {
    id: 'platform-textured-quad', revision: 1,
    glsl: {
        vertex: `#version 300 es
precision highp float;
${uniforms}
out vec2 uv;
void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    vec2 pixel = destination.xy + corner * destination.zw;
    vec2 unit = (pixel - viewport.xy) / viewport.zw;
    gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
    vec2 texel = sourceRect.xy + corner * sourceRect.zw;
    uv = vec2(texel.x / sourceSizeOpacity.x, 1.0 - texel.y / sourceSizeOpacity.y);
}`,
        fragment: `#version 300 es
precision highp float;
${uniforms}
uniform sampler2D gfxTexture0;
in vec2 uv;
layout(location=0) out vec4 gfxColour;
void main() { gfxColour = texture(gfxTexture0, uv) * sourceSizeOpacity.z; }`,
    },
    layout: {
        uniforms: [{ binding: 0, byteSize: 64 }],
        textures: [{ binding: 0, format: 'rgba8' }], attributes: [],
    },
};
