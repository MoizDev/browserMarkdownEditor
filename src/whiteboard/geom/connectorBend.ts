/** The bend an arc keeps when one of its ends leaves its shape (catalogue a.5, updateArrowTerminal): the arc stays on the same circle,
 * so its radius is the one its bound chord gave, and the new chord takes the matching sagitta on the same side. A chord longer than the
 * circle's diameter has no such arc; it takes the half circle, the longest arc that circle allows. A straight arc stays straight. */
export function bendKeepingCurvature(bend: number, chord: number, freeChord: number): number {
    const sagitta = Math.abs(bend);
    if (!(sagitta > 0) || !(chord > 0) || !(freeChord > 0)) return 0;
    const radius = (chord * chord / 4 + sagitta * sagitta) / (2 * sagitta), half = freeChord / 2;
    const next = half >= radius ? radius : radius - Math.sqrt(radius * radius - half * half);
    return Math.sign(bend) * next;
}
