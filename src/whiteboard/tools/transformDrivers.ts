import type { RealSample } from '../input/tool';
import { ResizePlan } from '../geom/resizePlan';
import { RotationPlan } from '../geom/rotationPlan';
import { TranslationPlan } from '../geom/translation';
import type { TransformDriver } from './transform.types';

export function translationDriver(plan: TranslationPlan, down: RealSample): TransformDriver {
    const delta = (sample: RealSample) => ({ x: sample.x - down.x, y: sample.y - down.y });
    return {
        preview: (sample, modifiers) => plan.preview(delta(sample), modifiers.shift).ops,
        finish: (sample, modifiers) => plan.transaction(delta(sample), modifiers.shift),
        cancel: () => plan.cancel(),
    };
}
export function resizeDriver(plan: ResizePlan): TransformDriver {
    let signX: -1 | 1 = 1, signY: -1 | 1 = 1;
    const preview = (sample: RealSample, modifiers: Parameters<TransformDriver['preview']>[1]) => {
        const value = plan.preview(sample, modifiers, signX, signY);
        if (value.frame.scaleX !== 0) signX = value.frame.scaleX < 0 ? -1 : 1;
        if (value.frame.scaleY !== 0) signY = value.frame.scaleY < 0 ? -1 : 1;
        return value;
    };
    return {
        preview: (sample, modifiers) => preview(sample, modifiers).ops,
        finish: (sample, modifiers) => ({ origin: 'tool', label: 'Resize selection', ops: preview(sample, modifiers).ops }),
        cancel: () => plan.cancel(),
    };
}
export function rotationDriver(plan: RotationPlan): TransformDriver {
    return {
        preview: (sample, modifiers) => plan.preview(sample, modifiers.shift).ops,
        finish: (sample, modifiers) => plan.transaction(sample, modifiers.shift),
        cancel: () => plan.cancel(),
    };
}
