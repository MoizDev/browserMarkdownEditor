// Encoded-sRGB invert + hue-rotate(180deg), applied AFTER page+ink composition
// (rendering-design.md:396–402; contracts C2.5). This is compatibility colour, not linear light.
export const PAGE_INVERT_SRGB = Object.freeze([
    Object.freeze([-0.574, 1.430, 0.144]),
    Object.freeze([0.426, 0.430, 0.144]),
    Object.freeze([0.426, 1.430, -0.856]),
]);

// Only exact browser builds qualified for the real 2D path may use the native filter (design §4.2:407).
export const NATIVE_PAGE_INVERSION_BUILDS: readonly string[] = Object.freeze([]);

/** ImageData holds straight sRGB; the canvas premultiplies the result on putImageData (design §4.2:403–407). */
export function invertPageImageData(image: ImageData): void {
    const data = image.data;
    const [r, g, b] = PAGE_INVERT_SRGB;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) {
            data[i] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
            continue;
        }
        const ur = 255 - data[i];
        const ug = 255 - data[i + 1];
        const ub = 255 - data[i + 2];
        data[i] = Math.max(0, Math.min(255, r[0] * ur + r[1] * ug + r[2] * ub));
        data[i + 1] = Math.max(0, Math.min(255, g[0] * ur + g[1] * ug + g[2] * ub));
        data[i + 2] = Math.max(0, Math.min(255, b[0] * ur + b[1] * ug + b[2] * ub));
    }
}
