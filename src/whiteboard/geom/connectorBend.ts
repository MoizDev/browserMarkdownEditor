export function bendKeepingCurvature(bend: number, chord: number, freeChord: number): number {
    const sagitta = Math.abs(bend);
    if (!(sagitta > 0) || !(chord > 0) || !(freeChord > 0)) return 0;
    const radius = (chord * chord / 4 + sagitta * sagitta) / (2 * sagitta), half = freeChord / 2;
    const next = half >= radius ? radius : radius - Math.sqrt(radius * radius - half * half);
    return Math.sign(bend) * next;
}
