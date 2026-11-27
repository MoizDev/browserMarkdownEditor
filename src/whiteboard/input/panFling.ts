import type { TouchPanSample } from '../../platform/render/scheduler';
import type { RealSample } from './tool';

export class PanFlingSamples {
    private values: TouchPanSample[] = [];
    append(sample: RealSample, surface: Readonly<{ x: number; y: number }>): void {
        if (!Number.isFinite(surface.x) || !Number.isFinite(surface.y) || !Number.isFinite(sample.time) || sample.time < 0) return;
        const last = this.values[this.values.length - 1];
        if (last && sample.time < last.time) return;
        this.values.push({ x: -surface.x, y: -surface.y, time: sample.time });
        if (this.values.length > 16) this.values.shift();
    }
    release(): readonly TouchPanSample[] {
        const result = Object.freeze(this.values.map(value => Object.freeze({ ...value })));
        this.values = []; return result;
    }
    clear(): void { this.values = []; }
}
