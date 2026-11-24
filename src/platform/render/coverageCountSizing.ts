/** One full-width band keeps each native readback bounded without sampling pixels. */
export function coverageBandRows(width: number, height: number): number {
    return Math.min(height, Math.max(1, Math.floor(65536 / width)));
}

export function coverageScratchBytes(width: number, height: number): number {
    return width * coverageBandRows(width, height) * 16;
}
