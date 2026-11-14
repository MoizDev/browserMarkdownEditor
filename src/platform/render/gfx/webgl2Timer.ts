import { RENDER_CONSTANTS } from '../constants';

type TimerExtension = { readonly TIME_ELAPSED_EXT: number; readonly GPU_DISJOINT_EXT: number };

/** Optional native GPU duration, not CPU submission or fence latency (design §6.4).
 * Query storage and work are bounded; disjoint intervals invalidate the whole sample window.
 */
export class Webgl2Timer {
    readonly #gl: WebGL2RenderingContext;
    readonly #extension: TimerExtension | null;
    readonly #report: ((p95Ms: number, samples: number, disjoint: boolean) => void) | undefined;
    readonly #pending: WebGLQuery[] = [];
    readonly #samples: number[] = [];
    #active: WebGLQuery | null = null;

    constructor(gl: WebGL2RenderingContext, report?: (p95Ms: number, samples: number, disjoint: boolean) => void) {
        this.#gl = gl;
        this.#report = report;
        this.#extension = report ? gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null : null;
    }

    get pending(): boolean { return this.#pending.length > 0; }

    begin(): void {
        if (!this.#extension || this.#active || this.#pending.length >= 8) return;
        const query = this.#gl.createQuery();
        if (!query) return;
        this.#active = query;
        this.#gl.beginQuery(this.#extension.TIME_ELAPSED_EXT, query);
    }

    end(): void {
        if (!this.#active || !this.#extension) return;
        this.#gl.endQuery(this.#extension.TIME_ELAPSED_EXT);
        this.#pending.push(this.#active);
        this.#active = null;
    }

    poll(): void {
        const ext = this.#extension;
        if (!ext || !this.#pending.length) return;
        const gl = this.#gl;
        if (gl.getParameter(ext.GPU_DISJOINT_EXT) === true) {
            for (const query of this.#pending) gl.deleteQuery(query);
            this.#pending.length = 0;
            this.#samples.length = 0;
            this.#report?.(0, 0, true);
            return;
        }
        while (this.#pending.length && gl.getQueryParameter(this.#pending[0], gl.QUERY_RESULT_AVAILABLE) === true) {
            const query = this.#pending.shift()!;
            const nanos: unknown = gl.getQueryParameter(query, gl.QUERY_RESULT);
            gl.deleteQuery(query);
            if (typeof nanos !== 'number' || !Number.isFinite(nanos) || nanos < 0) continue;
            this.#samples.push(nanos / 1_000_000);
            if (this.#samples.length > RENDER_CONSTANTS.slowGpuSampleCount) this.#samples.shift();
            if (this.#samples.length === RENDER_CONSTANTS.slowGpuSampleCount) {
                const sorted = [...this.#samples].sort((a, b) => a - b);
                this.#report?.(sorted[Math.ceil(sorted.length * 0.95) - 1], sorted.length, false);
            }
        }
    }

    /** On actual loss GL calls are forbidden; the driver owns the abandoned objects. */
    clear(lost: boolean): void {
        if (!lost) {
            if (this.#active && this.#extension) this.#gl.endQuery(this.#extension.TIME_ELAPSED_EXT);
            if (this.#active) this.#gl.deleteQuery(this.#active);
            for (const query of this.#pending) this.#gl.deleteQuery(query);
        }
        this.#active = null;
        this.#pending.length = 0;
        this.#samples.length = 0;
    }
}
