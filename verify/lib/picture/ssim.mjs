// Wang et al.'s local SSIM equation, 11x11 Gaussian (sigma 1.5), K1=.01,
// K2=.03, L=255: https://live.ece.utexas.edu/publications/2004/zwang_vssim_spim_2004.pdf
// This is the method, not an imported implementation. The acceptance floor is
// planning/40-platform/verification.md:237; vr-lead fixed this window/alignment.
const RADIUS = 5;
const weights = Array.from({ length: 11 }, (_, i) => Math.exp(-((i - RADIUS) ** 2) / (2 * 1.5 ** 2)));
const weightSum = weights.reduce((sum, value) => sum + value, 0);
for (let i = 0; i < weights.length; i++) weights[i] /= weightSum;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

function luminance(image, background) {
    const result = new Float64Array(image.width * image.height);
    const base = 0.299 * background[0] + 0.587 * background[1] + 0.114 * background[2];
    for (let pixel = 0; pixel < result.length; pixel++) {
        const offset = pixel * 4;
        const alpha = image.data[offset + 3] / 255;
        result[pixel] = alpha * (0.299 * image.data[offset] + 0.587 * image.data[offset + 1] + 0.114 * image.data[offset + 2]) + (1 - alpha) * base;
    }
    return result;
}

function gaussian(values, width, height, temporary, output) {
    // Only complete windows participate, as in the valid convolution in Wang's method.
    // Pixel/channel and ink checks still cover every edge pixel; SSIM drops no other checks.
    for (let y = 0; y < height; y++) {
        for (let x = RADIUS; x < width - RADIUS; x++) {
            let sum = 0;
            const offset = y * width + x;
            for (let k = -RADIUS; k <= RADIUS; k++) sum += values[offset + k] * weights[k + RADIUS];
            temporary[offset] = sum;
        }
    }
    for (let y = RADIUS; y < height - RADIUS; y++) {
        for (let x = RADIUS; x < width - RADIUS; x++) {
            let sum = 0;
            const offset = y * width + x;
            for (let k = -RADIUS; k <= RADIUS; k++) sum += temporary[offset + k * width] * weights[k + RADIUS];
            output[offset] = sum;
        }
    }
}

export function bestShiftSsim(expected, actual, background) {
    const { width, height } = expected;
    if (width < 11 || height < 11) throw new Error('SSIM needs a complete 11x11 window; capture a larger real-app surface');
    const a = luminance(expected, background);
    const b = luminance(actual, background);
    const meanA = new Float64Array(a.length);
    const meanB = new Float64Array(a.length);
    const varianceA = new Float64Array(a.length);
    const varianceB = new Float64Array(a.length);
    const temporary = new Float64Array(a.length);
    const product = new Float64Array(a.length);
    const cross = new Float64Array(a.length);
    gaussian(a, width, height, temporary, meanA);
    gaussian(b, width, height, temporary, meanB);
    for (let i = 0; i < a.length; i++) product[i] = a[i] * a[i];
    gaussian(product, width, height, temporary, varianceA);
    for (let i = 0; i < a.length; i++) product[i] = b[i] * b[i];
    gaussian(product, width, height, temporary, varianceB);
    for (let i = 0; i < a.length; i++) {
        varianceA[i] = Math.max(0, varianceA[i] - meanA[i] ** 2);
        varianceB[i] = Math.max(0, varianceB[i] - meanB[i] ** 2);
    }
    // Prefer zero when scores tie. One global shift is selected, never a different SSIM
    // alignment for each window/pixel (which could conceal a distorted or missing stroke).
    const shifts = [[0, 0], ...[-1, 0, 1].flatMap(y => [-1, 0, 1].filter(x => x || y).map(x => [x, y]))];
    let best = null;
    const scores = [];
    for (const [dx, dy] of shifts) {
        product.fill(0);
        for (let y = Math.max(0, -dy); y < height - Math.max(0, dy); y++) {
            for (let x = Math.max(0, -dx); x < width - Math.max(0, dx); x++) {
                const index = y * width + x;
                product[index] = a[index] * b[index + dy * width + dx];
            }
        }
        gaussian(product, width, height, temporary, cross);
        let total = 0;
        let windows = 0;
        for (let y = RADIUS + Math.max(0, -dy); y < height - RADIUS - Math.max(0, dy); y++) {
            for (let x = RADIUS + Math.max(0, -dx); x < width - RADIUS - Math.max(0, dx); x++) {
                const i = y * width + x;
                const j = i + dy * width + dx;
                const covariance = cross[i] - meanA[i] * meanB[j];
                const numerator = (2 * meanA[i] * meanB[j] + C1) * (2 * covariance + C2);
                const denominator = (meanA[i] ** 2 + meanB[j] ** 2 + C1) * (varianceA[i] + varianceB[j] + C2);
                total += Math.max(-1, Math.min(1, numerator / denominator));
                windows++;
            }
        }
        if (!windows) continue;
        const result = { shift: [dx, dy], value: total / windows, windows };
        scores.push(result);
        if (!best || result.value > best.value) best = result;
    }
    if (!best) throw new Error('No complete SSIM windows in the +/-1 overlap');
    return { ...best, scores, method: 'Wang 11x11 Gaussian sigma 1.5; BT.601 luminance; complete overlap windows; one best global +/-1 shift' };
}
