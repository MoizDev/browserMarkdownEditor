import { describe, expect, it } from 'bun:test';
import { asQuarter, LEFT, RIGHT, turn } from './pdfRotation';

describe('asQuarter', () => {
    it('keeps the four legal angles', () => {
        expect(asQuarter(0)).toBe(0);
        expect(asQuarter(90)).toBe(90);
        expect(asQuarter(180)).toBe(180);
        expect(asQuarter(270)).toBe(270);
    });

    it('wraps angles past a full turn, in both directions', () => {
        expect(asQuarter(360)).toBe(0);
        expect(asQuarter(450)).toBe(90);
        expect(asQuarter(-90)).toBe(270);
        expect(asQuarter(-450)).toBe(270);
    });

    it('rounds a near-quarter to the quarter it meant', () => {
        // Writers that round their own arithmetic produce these; reading 89.9
        // as 0 would turn the page a quarter too far.
        expect(asQuarter(89.9)).toBe(90);
        expect(asQuarter(270.4)).toBe(270);
    });

    it('reads an unusable angle as no rotation', () => {
        expect(asQuarter(Number.NaN)).toBe(0);
        expect(asQuarter(Number.POSITIVE_INFINITY)).toBe(0);
    });
});

describe('turn', () => {
    it('steps a quarter at a time, and comes home after four', () => {
        let angle = 0;
        for (const expected of [90, 180, 270, 0]) {
            angle = turn(angle, RIGHT);
            expect(angle).toBe(expected);
        }
    });

    it('goes the other way too', () => {
        expect(turn(0, LEFT)).toBe(270);
        expect(turn(90, LEFT)).toBe(0);
    });

    it('starts from the angle the page already carries', () => {
        expect(turn(270, RIGHT)).toBe(0);
        expect(turn(180, 180)).toBe(0);
    });

    it('treats a junk starting angle as 0 rather than refusing', () => {
        expect(turn(Number.NaN, RIGHT)).toBe(90);
    });
});
