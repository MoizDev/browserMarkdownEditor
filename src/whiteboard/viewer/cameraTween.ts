import type { Camera } from '../../platform/types';
import { getBoardPreferences } from '../../utils/boardPreferences';

export interface CameraTween {
    cancel(): void;
}

/** Glides the camera from `from` to `target` over `durationMs`, scaled by the person's motion setting: at speed 0 (reduced
 * motion) the camera jumps there at once, and no frame is ever scheduled. The glide ends on its own; `cancel` stops it
 * early, which a newer move does by replacing it. */
export function tweenCamera(options: {
    readonly from: Camera;
    readonly target: Camera;
    readonly durationMs: number;
    apply(camera: Camera): void;
}): CameraTween {
    const { from, target, apply } = options;
    const duration = options.durationMs * getBoardPreferences().animationSpeed;
    if (!(duration > 0)) { apply(target); return { cancel() {} }; }
    let frame = 0;
    const started = performance.now();
    const step = (now: number) => {
        const progress = Math.min(1, (now - started) / duration), eased = 1 - (1 - progress) ** 3;
        apply({
            x: from.x + (target.x - from.x) * eased,
            y: from.y + (target.y - from.y) * eased,
            z: from.z + (target.z - from.z) * eased,
        });
        frame = progress < 1 ? requestAnimationFrame(step) : 0;
    };
    frame = requestAnimationFrame(step);
    return { cancel() { if (frame) cancelAnimationFrame(frame); frame = 0; } };
}
