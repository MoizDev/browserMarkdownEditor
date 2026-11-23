/** The pointer the board last used, shared by every board view: a finger or a pen is coarse, a mouse is fine (catalogue I§4.5:
 * the most recent pointer type decides). Keyboard input says nothing about the pointer, so it leaves the state alone. */
let coarse = false;

export function notePointerSource(source: 'mouse' | 'pen' | 'touch' | 'keyboard'): void {
    if (source !== 'keyboard') coarse = source === 'touch' || source === 'pen';
}
export function pointerIsCoarse(): boolean { return coarse; }

/** Coarse handles draw 20/12 of their fine size, as the catalogue does (options.ts:323-324: handle radius 12, coarse 20). */
export const COARSE_HANDLE_SCALE = 20 / 12;
/** A handle's drawn radius for the pointer the board last used. The hit radii scale on their own, by the same rule. */
export function handleRadius(fine: number): number {
    return coarse ? fine * COARSE_HANDLE_SCALE : fine;
}
