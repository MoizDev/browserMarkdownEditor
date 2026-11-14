// Benchmark-only coverage reduction. These shaders operate on private R8/RGBA32UI targets;
// they do not change the compositor's colour output or the public texture-format API.
export const COVERAGE_REDUCE_VERTEX = `#version 300 es
precision highp float;

void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const COVERAGE_CLASSIFY_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_source;
uniform ivec2 u_sourceSize;
layout(location = 0) out uvec4 counts;

void main() {
    ivec2 origin = ivec2(gl_FragCoord.xy) * 16;
    uvec4 sum = uvec4(0u);
    for (int y = 0; y < 16; ++y) {
        for (int x = 0; x < 16; ++x) {
            ivec2 p = origin + ivec2(x, y);
            if (p.x >= u_sourceSize.x || p.y >= u_sourceSize.y) continue;
            uint value = uint(round(texelFetch(u_source, p, 0).r * 255.0));
            if (value == 0u) sum.x += 1u;
            else if (value == 1u) sum.y += 1u;
            else if (value == 2u) sum.z += 1u;
            else if (value == 3u) sum.w += 1u;
        }
    }
    counts = sum;
}
`;

export const COVERAGE_SUM_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D u_source;
uniform ivec2 u_sourceSize;
layout(location = 0) out uvec4 counts;

void main() {
    ivec2 origin = ivec2(gl_FragCoord.xy) * 16;
    uvec4 sum = uvec4(0u);
    for (int y = 0; y < 16; ++y) {
        for (int x = 0; x < 16; ++x) {
            ivec2 p = origin + ivec2(x, y);
            if (p.x >= u_sourceSize.x || p.y >= u_sourceSize.y) continue;
            sum += texelFetch(u_source, p, 0);
        }
    }
    counts = sum;
}
`;
