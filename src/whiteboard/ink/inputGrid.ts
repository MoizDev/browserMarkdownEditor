const GRID_MIN_STEPS = 4;
const GRID_MIN_DEVICE_PX = 0.25;

export class InputGrid {
    private divisor: number;
    private steps = 0;
    private lastX = 0;
    private lastY = 0;
    private started = false;
    private none = false;
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
    get decided(): boolean { return this.none || this.steps >= GRID_MIN_STEPS; }
    get quantumWorld(): number { return this.none || this.steps < GRID_MIN_STEPS ? 0 : this.divisor; }
    private step(d: number): void {
        const eps = 1e-6 * this.pixelWorld;
        if (d <= eps) return;
        this.steps++;
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
