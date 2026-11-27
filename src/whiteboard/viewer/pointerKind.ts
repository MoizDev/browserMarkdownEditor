let coarse = false;

export function notePointerSource(source: 'mouse' | 'pen' | 'touch' | 'keyboard'): void {
    if (source !== 'keyboard') coarse = source === 'touch' || source === 'pen';
}
export function pointerIsCoarse(): boolean { return coarse; }

export const COARSE_HANDLE_SCALE = 20 / 12;
export function handleRadius(fine: number): number {
    return coarse ? fine * COARSE_HANDLE_SCALE : fine;
}
