// Adapted from AICSS's Orb (MIT, © 2026 AICSS — see LICENSE-aicss;
// https://www.aicss.dev/components/orbs). Kept: the Lattice (S1–S5) and Lens
// (B1–B5) families, verbatim in geometry and motion. Dropped: Ring, Helix and
// Morph, which the panel does not use (the globe alone was ~150 lines of
// per-dot keyframe data). Colours come from the panel's tokens (aicss.css).

import type { CSSProperties } from 'react';

/** The stage the geometry is tuned on; --orb-k scales it to `size`. */
const STAGE = 28;
const SIZE = 20;

export type LatticeVariant = 'S1' | 'S2' | 'S3' | 'S4' | 'S5';
export type LensVariant = 'B1' | 'B2' | 'B3' | 'B4' | 'B5';
export type OrbVariant = LatticeVariant | LensVariant;

const LATTICE_VARIANTS: readonly OrbVariant[] = ['S1', 'S2', 'S3', 'S4', 'S5'];

function isLattice(v: OrbVariant): v is LatticeVariant {
    return LATTICE_VARIANTS.includes(v);
}

const N = 3; // lattice is N×N
const PITCH = 6; // centre-to-centre spacing in stage px; the dot size is CSS
const MID = (N - 1) / 2;

/** Clockwise walk of the lattice perimeter - the track `orbit` runs on. */
const RING: [number, number][] = (() => {
    const ring: [number, number][] = [];
    for (let x = 0; x < N; x++) ring.push([x, 0]);
    for (let y = 1; y < N; y++) ring.push([N - 1, y]);
    for (let x = N - 2; x >= 0; x--) ring.push([x, N - 1]);
    for (let y = N - 2; y >= 1; y--) ring.push([0, y]);
    return ring;
})();

const RING_INDEX = new Map(RING.map(([x, y], i) => [x + ',' + y, i]));

/**
 * Per-cell `animation-delay` in ms. Negative values seed a cell partway
 * into its cycle, which is what turns 8 identical animations into one
 * comet travelling the ring.
 */
function cellDelay(v: LatticeVariant, x: number, y: number): number {
    const dx = x - MID;
    const dy = y - MID;
    switch (v) {
        // Radiates from the centre on a round wavefront.
        case 'S1':
            return Math.hypot(dx, dy) * 700 - (dx === 0 && dy === 0 ? 180 : 0);
        // A broad band crosses the grid on the diagonal.
        case 'S2':
            return ((x + y) / (2 * (N - 1))) * 1500;
        // One head with a decaying tail, running the perimeter clockwise.
        case 'S3': {
            const i = RING_INDEX.get(x + ',' + y);
            if (i === undefined) return 0;
            return -(((RING.length - i) % RING.length) / RING.length) * 1700;
        }
        // A soft column travels left to right.
        case 'S4':
            return (x / (N - 1)) * 1100;
        // Like S3 but scrambled order - the pulse jumps pseudo-randomly.
        case 'S5': {
            const i = RING_INDEX.get(x + ',' + y);
            if (i === undefined) return 0;
            const scrambled = (i * 3) % RING.length;
            return -(scrambled / RING.length) * 1700;
        }
    }
}

interface Cell {
    key: string;
    left: number;
    top: number;
    delay: number;
    still: boolean;
    mid: boolean;
}

function latticeCells(v: LatticeVariant): Cell[] {
    const cells: Cell[] = [];
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            cells.push({
                key: x + ',' + y,
                left: x * PITCH,
                top: y * PITCH,
                delay: cellDelay(v, x, y),
                still: (v === 'S3' || v === 'S5') && !RING_INDEX.has(x + ',' + y),
                mid: x === MID && y === MID,
            });
        }
    }
    return cells;
}

export interface OrbProps {
    variant?: OrbVariant;
    size?: number;
    /** Accessible label, and the status text when `pill` is set. */
    label: string;
    pill?: boolean;
    /** A still orb: idle / connected, no motion. */
    still?: boolean;
    className?: string;
    style?: CSSProperties;
}

export function Orb({ variant = 'S1', size = SIZE, label, pill, still, className, style }: OrbProps) {
    return (
        <span
            className={'aic-orb' + (still ? ' is-still' : '') + (className ? ' ' + className : '')}
            data-pill={pill ? '' : undefined}
            style={style}
        >
            <span
                className="aic-orb-glyph"
                // In pill form the visible label already carries the meaning.
                role={pill ? undefined : 'img'}
                aria-label={pill ? undefined : label}
                aria-hidden={pill ? true : undefined}
                style={{ width: size, height: size, '--orb-k': size / STAGE } as CSSProperties}
            >
                {isLattice(variant) ? (
                    <span className="aic-orb-lattice" data-variant={variant}>
                        {latticeCells(variant).map(c => (
                            <span
                                key={c.key}
                                className="aic-orb-cell"
                                data-still={c.still ? '' : undefined}
                                data-mid={c.mid ? '' : undefined}
                                style={{ left: c.left, top: c.top, animationDelay: c.delay + 'ms' }}
                            />
                        ))}
                    </span>
                ) : (
                    <span className="aic-orb-lens" data-variant={variant}>
                        <span className="aic-orb-shape aic-orb-shape-a" />
                        <span className="aic-orb-shape aic-orb-shape-b" />
                        <span className="aic-orb-shape aic-orb-shape-c" />
                        {variant === 'B1' && <span className="aic-orb-shape aic-orb-shape-d" />}
                    </span>
                )}
            </span>
            {pill && <span className="aic-orb-pill-label">{label}</span>}
        </span>
    );
}
