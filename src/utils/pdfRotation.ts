export type Quarter = 0 | 90 | 180 | 270;

const QUARTERS: Quarter[] = [0, 90, 180, 270];

export function asQuarter(angle: number): Quarter {
    if (!Number.isFinite(angle)) return 0;
    const steps = Math.round(angle / 90);
    return QUARTERS[((steps % 4) + 4) % 4];
}
