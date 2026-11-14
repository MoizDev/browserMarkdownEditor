import { serve } from '../platform/workers/serve';
import { GraphLayout } from '../utils/graphLayout';

type Topology = { gen: number; ids: string[]; links: { source: string; target: string }[]; positions?: Float64Array; alpha?: number };
type Tick = { gen: number; frame: number; buffer: Float64Array; pin: { id: string; x: number; y: number } | null; reheat: number };
const layout = new GraphLayout();
let generation = 0;
let steps = 0;

serve({
    protocol: 1,
    buildId: 'graph-layout-v1',
    handlers: {
        topology(value) {
            const { gen, ids, links, positions, alpha } = value as Topology;
            if (gen < generation) return;
            layout.update(ids, links);
            generation = gen;
            if (positions) {
                for (let i = 0; i < ids.length; i++) {
                    layout.x[i] = positions[i * 2]; layout.y[i] = positions[i * 2 + 1];
                    layout.vx[i] = layout.vy[i] = 0;
                }
                layout.alpha = alpha ?? 1;
            }
            steps = 0;
        },
        tick(value, context) {
            const { gen, frame, buffer, pin, reheat } = value as Tick;
            if (gen === generation) {
                layout.alpha = Math.max(layout.alpha, reheat);
                if (pin) {
                    const i = layout.index.get(pin.id);
                    if (i !== undefined) { layout.x[i] = pin.x; layout.y[i] = pin.y; layout.vx[i] = layout.vy[i] = 0; }
                }
                const start = performance.now();
                const moved = layout.step(pin?.id ?? null);
                const stepMs = performance.now() - start;
                if (moved) steps++;
                for (let i = 0; i < layout.ids.length; i++) {
                    buffer[i * 2] = layout.x[i]; buffer[i * 2 + 1] = layout.y[i];
                }
                context.transfer(buffer.buffer);
                return { gen, frame, buffer, alpha: layout.alpha, steps, moved, working: layout.alpha >= 0.001 || !!pin, stepMs };
            }
            context.transfer(buffer.buffer);
            return { gen, frame, buffer, alpha: layout.alpha, steps, moved: false, working: false, stepMs: 0 };
        },
    },
});
