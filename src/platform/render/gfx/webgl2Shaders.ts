import type { ShaderModule } from './api';
import { PAGE_INVERT_SRGB } from '../colour';

const block = `layout(std140) uniform GfxUniforms0 {
    vec4 viewport;
    vec4 destination;
    vec4 sourceRect;
    vec4 sourceSizeOpacityEffect;
    vec4 backdropRect;
    vec4 maskBounds;
    vec4 maskUV;
    vec4 options;
};`;

/** Private platform shader only: arbitrary stream GLSL is never rewritten (vr-lead ruling).
 * Source, backdrop and mask are distinct views; an attached destination is never sampled.
 */
export const COMPOSITION_SHADER: ShaderModule = {
    id: 'platform-private-composition', revision: 1,
    glsl: {
        vertex: `#version 300 es
precision highp float;
${block}
out vec2 sourceUV;
out vec2 pixel;
void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    pixel = destination.xy + corner * destination.zw;
    vec2 unit = (pixel - viewport.xy) / viewport.zw;
    gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
    vec2 texel = sourceRect.xy + corner * sourceRect.zw;
    sourceUV = vec2(texel.x / sourceSizeOpacityEffect.x, 1.0 - texel.y / sourceSizeOpacityEffect.y);
}`,
        fragment: `#version 300 es
precision highp float;
${block}
uniform sampler2D gfxTexture0;
uniform sampler2D gfxTexture1;
uniform sampler2D gfxTexture2;
${__BME_BENCH__ ? 'uniform sampler2D gfxTexture3;\nuniform sampler2D gfxTexture4;' : ''}
in vec2 sourceUV;
in vec2 pixel;
layout(location=0) out vec4 gfxColour;
${__BME_BENCH__ ? 'layout(location=1) out vec4 gfxClass;' : ''}
void main() {
    vec4 source = texture(gfxTexture0, sourceUV);
    if (sourceSizeOpacityEffect.w > 0.5) {
        if (source.a > 0.0) {
            vec3 u = vec3(1.0) - source.rgb / source.a;
            vec3 effect = vec3(${PAGE_INVERT_SRGB.map(row => `dot(vec3(${row.map(n => n.toFixed(3)).join(', ')}), u)`).join(', ')});
            source.rgb = clamp(effect, 0.0, 1.0) * source.a;
        } else source.rgb = vec3(0.0);
    }
    float coverage = sourceSizeOpacityEffect.z;
    if (options.y > 0.5) {
        vec2 unit = (pixel - maskBounds.xy) / maskBounds.zw;
        if (any(lessThan(unit, vec2(0.0))) || any(greaterThanEqual(unit, vec2(1.0)))) coverage = 0.0;
        else coverage *= texture(gfxTexture2, vec2(maskUV.z + unit.x * maskUV.x, maskUV.w - unit.y * maskUV.y)).r;
    }
    ${__BME_BENCH__ ? `
    float sourceClass = mod(options.w, 2.0) > 0.5 && coverage > 0.0 ? texture(gfxTexture3, sourceUV).r : 0.0;
    float backdropClass = 0.0;
    if (options.w > 1.5 && options.x > 0.5) {
        vec2 unit = (pixel - backdropRect.xy) / backdropRect.zw;
        backdropClass = texture(gfxTexture4, vec2(unit.x, 1.0 - unit.y)).r;
    }
    float resultClass = options.x > 0.5 && sourceClass == 0.0 ? backdropClass : sourceClass;
    gfxClass = vec4(resultClass, 0.0, 0.0, resultClass > 0.0 ? 1.0 : 0.0);
    ` : ''}
    if (options.z > 0.5) {
        float value = source.r * coverage;
        if (options.x > 0.5) {
            vec2 unit = (pixel - backdropRect.xy) / backdropRect.zw;
            value *= texture(gfxTexture1, vec2(unit.x, 1.0 - unit.y)).r;
        }
        gfxColour = vec4(value, 0.0, 0.0, 1.0);
        return;
    }
    source *= coverage;
    if (options.x > 0.5) {
        vec2 unit = (pixel - backdropRect.xy) / backdropRect.zw;
        vec4 backdrop = texture(gfxTexture1, vec2(unit.x, 1.0 - unit.y));
        // General premultiplied multiply over a TRANSPARENT backdrop (design:294–296).
        gfxColour = vec4(source.rgb * (1.0 - backdrop.a) + backdrop.rgb * (1.0 - source.a) + source.rgb * backdrop.rgb,
            source.a + backdrop.a - source.a * backdrop.a);
    } else gfxColour = source;
}`,
    },
    layout: {
        uniforms: [{ binding: 0, byteSize: 128 }],
        textures: (__BME_BENCH__ ? [0, 1, 2, 3, 4] : [0, 1, 2]).map(binding => ({ binding, format: 'rgba8' as const })),
        attributes: [],
    },
};

/** Resolves a grid coverage target (see CoverageTargetOptions) and paints it: each device pixel is the box average of its
 * grid×grid r8 texels, then one composite. The uniform block is the composition block, reused: sourceRect.xy is the
 * target's device origin, sourceRect.z its grid, sourceSizeOpacityEffect.xy its texel size, backdropRect the paint
 * (rgb, alpha), and options.x selects 'modulate' (k = mix(1, rgb, alpha·c), for the fixed-function modulate blend) or
 * 'normal' (premultiplied source-over). Texels are fetched exactly: no filter, no sampler state, so no half-texel bias. */
export const GRID_RESOLVE_SHADER: ShaderModule = {
    id: 'platform-private-grid-resolve', revision: 1,
    glsl: {
        vertex: `#version 300 es
precision highp float;
${block}
out vec2 pixel;
void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    pixel = destination.xy + corner * destination.zw;
    vec2 unit = (pixel - viewport.xy) / viewport.zw;
    gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
}`,
        fragment: `#version 300 es
precision highp float;
${block}
uniform sampler2D gfxTexture0;
in vec2 pixel;
layout(location=0) out vec4 gfxColour;
void main() {
    int grid = int(sourceRect.z);
    ivec2 device = ivec2(floor(pixel)) - ivec2(sourceRect.xy);
    ivec2 first = device * grid;
    int rows = int(sourceSizeOpacityEffect.y);
    float sum = 0.0;
    for (int j = 0; j < 4; j++) {
        for (int i = 0; i < 4; i++) {
            if (i < grid && j < grid) {
                ivec2 texel = first + ivec2(i, j);
                sum += texelFetch(gfxTexture0, ivec2(texel.x, rows - 1 - texel.y), 0).r;
            }
        }
    }
    float a = backdropRect.w * (sum / float(grid * grid));
    if (options.x > 0.5) gfxColour = vec4(mix(vec3(1.0), backdropRect.rgb, a), 1.0);
    else gfxColour = vec4(backdropRect.rgb * a, a);
}`,
    },
    layout: {
        uniforms: [{ binding: 0, byteSize: 128 }],
        textures: [{ binding: 0, format: 'r8' as const }],
        attributes: [],
    },
};
