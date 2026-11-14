// Encoded-sRGB invert + hue-rotate(180deg), applied AFTER page+ink composition
// (rendering-design.md:396–402; contracts C2.5). This is compatibility colour, not linear light.
export const PAGE_INVERT_SRGB = Object.freeze([
    Object.freeze([-0.574, 1.430, 0.144]),
    Object.freeze([0.426, 0.430, 0.144]),
    Object.freeze([0.426, 1.430, -0.856]),
]);
