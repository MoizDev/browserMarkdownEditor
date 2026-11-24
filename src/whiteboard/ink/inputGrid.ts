// The resolution of the pointer that is drawing, read from the stroke's own samples.
//
// A mouse or trackpad reports positions on a grid: whole CSS pixels, or half pixels at best (CDP and
// Chrome on macOS both measured). A slow stroke from it is a staircase of one-grid steps, and a curve
// drawn exactly THROUGH every sample draws that staircase, not the hand: measured at DPR 2, a slow
// whole-pixel arc kept 281 of 300 samples and showed a ~2 device px wobble on a 3–4 px line. The
// samples are no more accurate than the grid, so the thinning certificate may move the curve by part
// of one grid step (ink/omission.ts) and fit it through fewer, better-spaced samples.
//
// The grid is the greatest common divisor of the per-axis steps between successive samples. Steps,
// not positions: the camera's pan and the page origin offset every position by an arbitrary amount,
// but cancel out of a difference. It follows zoom by itself (a whole CSS pixel is 1/4 world px drawn
// at 400 %, 4 world px at 25 %) and needs no device knowledge beyond the size of one CSS pixel, which
// caps it: a run of even steps proves no grid coarser than the pointer's own pixel. A pen reports
// fractional positions, so its divisor collapses below a quarter device pixel within a few samples and
// the grid is reported as none — precise input keeps today's thinning exactly. So does anything that
// breaks the lattice (an edge-scroll pan mid-stroke): the divisor only ever shrinks.

/** Steps observed before the divisor is trusted; until then the grid is none. Three steps on two axes
 * measured enough for half-pixel input to show its half step (a run of whole steps would otherwise
 * read as a whole-pixel grid for its first samples). */
const GRID_MIN_STEPS = 4;
/** A divisor finer than this many device pixels is continuous input, not a grid worth honouring. */
const GRID_MIN_DEVICE_PX = 0.25;

export class InputGrid {
    private divisor: number;
    private steps = 0;
    private lastX = 0;
    private lastY = 0;
    private started = false;
    private none = false;
    /**
     * @param pixelWorld world size of one CSS pixel of pointer input at pointer down (1 / zoom).
     * @param captureDeviceScale device pixels per world unit at pointer down (zoom × DPR).
     */
    constructor(private readonly pixelWorld: number, private readonly captureDeviceScale: number) {
        if (!(pixelWorld > 0) || !Number.isFinite(pixelWorld) || !(captureDeviceScale > 0) || !Number.isFinite(captureDeviceScale)) {
            throw new RangeError('Invalid input grid scale');
        }
        this.divisor = pixelWorld;
    }
    observe(x: number, y: number): void {
        if (this.started && !this.none) { this.step(Math.abs(x - this.lastX)); this.step(Math.abs(y - this.lastY)); }
        this.started = true; this.lastX = x; this.lastY = y;
    }
    /** Whether enough steps have arrived to tell: a grid found, or none. */
    get decided(): boolean { return this.none || this.steps >= GRID_MIN_STEPS; }
    /** The grid in world units, or 0 when the input is not (yet) known to sit on one. */
    get quantumWorld(): number { return this.none || this.steps < GRID_MIN_STEPS ? 0 : this.divisor; }
    private step(d: number): void {
        // Positions are mapped from client pixels by one affine, so a step is a multiple of the grid to
        // within the mapping's rounding: a part per million of a pixel separates that from a real offset.
        const eps = 1e-6 * this.pixelWorld;
        if (d <= eps) return;
        this.steps++;
        // Euclid on reals, starting from the cap: the divisor is the coarsest grid every step lies on.
        let a = Math.max(this.divisor, d), b = Math.min(this.divisor, d);
        while (b > eps) {
            let r = a % b;
            if (b - r <= eps) r = 0;
            a = b; b = r;
        }
        this.divisor = a;
        if (this.divisor * this.captureDeviceScale < GRID_MIN_DEVICE_PX) this.none = true;
    }
}
