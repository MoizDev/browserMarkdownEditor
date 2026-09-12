// A dev-only panel for feeling out the pen's streamline.
//
// It exists because the number it controls cannot be judged by reading: the
// difference between tldraw's 0.64 and this app's 0.4 is invisible in a diff,
// obvious on a tablet, and a rebuild between each try is slow enough that you
// stop trusting the comparison. So: move the slider, draw, move it back, draw
// again — two strokes at two settings sitting side by side on one canvas.
//
// Rendered through a PORTAL onto document.body rather than into tldraw's own
// layout: `position: fixed` inside a transformed ancestor resolves against that
// ancestor, and the canvas container is transformed.
//
// Its CSS lives HERE rather than in index.css so that the whole panel — markup,
// logic and styles — leaves the production build together. Rules in the app
// stylesheet would ship whether or not anything could ever match them.
//
// DEV ONLY. canvasPen.ts mounts it behind `import.meta.env.DEV`, which is a
// build-time literal, so the reference dies and this module is dropped from the
// production bundle entirely — verified by grepping dist for its markup.

import { useCallback, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getStrokePoints } from 'tldraw';
import {
    PEN_STREAMLINE, TLDRAW_STREAMLINE, getPenStreamline, setPenStreamline, subscribePenStreamline,
} from '../utils/penDev';

/** Points-per-event a tablet actually produces, for the lag readout below. */
const SPACING = 12;

/**
 * How far the ink would trail the pen at this setting, in px.
 *
 * Measured, not modelled: it runs tldraw's own `getStrokePoints` over a
 * straight synthetic stroke and compares the smoothed centreline's last point
 * to the raw one. Stroke width is deliberately absent — it does not affect
 * tracking at all, and an earlier attempt to measure this from the rendered
 * OUTLINE was wrong for exactly that reason.
 */
function lagAt(streamline: number): number {
    const raw = [];
    for (let i = 0; i < 60; i++) raw.push({ x: i * SPACING, y: 0, z: 0.5 });
    const pts = getStrokePoints(raw, {
        size: 3, thinning: 0, streamline, smoothing: 0.62, simulatePressure: false, easing: (t: number) => t,
    });
    const tip = pts[pts.length - 1].point;
    return Math.hypot(tip.x - raw[raw.length - 1].x, tip.y - raw[raw.length - 1].y);
}

const PRESETS: Array<[string, number]> = [
    ['tldraw stock', TLDRAW_STREAMLINE],
    ['heavy', 0.4],
    ['light', 0.1],
    ['ships as', PEN_STREAMLINE],
];

const PANEL_CSS = `
    /* Bottom-RIGHT, not left: the sidebar is user-resizable and can be
       collapsed, so a left anchor lands on top of it at some widths. The right
       edge is always canvas. Lifted clear of tldraw's dev watermark. */
    .pen-dev {
      position: fixed;
      right: 16px;
      bottom: 62px;
      z-index: 9999;
      width: 232px;
      padding: 10px 12px 12px;
      border-radius: 10px;
      background: color-mix(in srgb, var(--background-primary) 92%, transparent);
      border: 1px solid var(--background-modifier-border);
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(6px);
      font-size: 12px;
      color: var(--text-normal);
    }

    .pen-dev-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
    }

    .pen-dev-head em {
      font-style: normal;
      margin-left: 4px;
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--interactive-accent);
      color: #fff;
      font-size: 9px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .pen-dev-head button {
      border: none;
      background: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 15px;
      line-height: 1;
      padding: 0 2px;
    }

    .pen-dev-value {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin: 8px 0 2px;
    }

    .pen-dev-value strong {
      font-size: 20px;
      font-variant-numeric: tabular-nums;
    }

    .pen-dev-value span {
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    .pen-dev input[type='range'] {
      width: 100%;
      accent-color: var(--interactive-accent);
    }

    .pen-dev-presets {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 4px;
      margin-top: 8px;
    }

    .pen-dev-presets button {
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding: 5px 4px;
      border-radius: 6px;
      border: 1px solid var(--background-modifier-border);
      background: var(--background-secondary);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 10px;
    }

    .pen-dev-presets button:hover {
      color: var(--text-normal);
    }

    .pen-dev-presets button.is-on {
      border-color: var(--interactive-accent);
      color: var(--text-normal);
    }

    .pen-dev-presets em {
      font-style: normal;
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      color: var(--text-normal);
    }

    .pen-dev p {
      margin: 9px 0 0;
      color: var(--text-muted);
      font-size: 10.5px;
      line-height: 1.45;
    }

    .pen-dev-tab {
      position: fixed;
      right: 16px;
      bottom: 62px;
      z-index: 9999;
      padding: 5px 10px;
      border-radius: 8px;
      border: 1px solid var(--background-modifier-border);
      background: color-mix(in srgb, var(--background-primary) 92%, transparent);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 11px;
    }
`;

export default function PenDevPanel() {
    const streamline = useSyncExternalStore(subscribePenStreamline, getPenStreamline);
    const [open, setOpen] = useState(true);
    const onSlide = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        setPenStreamline(Number(e.target.value));
    }, []);

    // The collapsed tab carries the stylesheet too — it is its own portal, and
    // the panel that would otherwise have injected the rules is not mounted.
    if (!open) {
        return createPortal(
            <>
                <style>{PANEL_CSS}</style>
                <button className="pen-dev-tab" onClick={() => setOpen(true)} title="Pen tuning (dev only)">pen</button>
            </>,
            document.body,
        );
    }

    return createPortal(
        <div className="pen-dev">
            <style>{PANEL_CSS}</style>
            <div className="pen-dev-head">
                <span>pen streamline <em>dev</em></span>
                <button onClick={() => setOpen(false)} aria-label="Hide">×</button>
            </div>

            <div className="pen-dev-value">
                <strong>{streamline.toFixed(2)}</strong>
                <span>ink trails ~{lagAt(streamline).toFixed(1)}px</span>
            </div>

            <input
                type="range"
                min={0}
                max={0.9}
                step={0.01}
                value={streamline}
                onChange={onSlide}
                aria-label="Streamline"
            />

            <div className="pen-dev-presets">
                {PRESETS.map(([label, value]) => (
                    <button
                        key={label}
                        className={Math.abs(value - streamline) < 0.005 ? 'is-on' : undefined}
                        onClick={() => setPenStreamline(value)}
                        title={`streamline ${value} — trails ~${lagAt(value).toFixed(1)}px`}
                    >
                        {label}<em>{value.toFixed(2)}</em>
                    </button>
                ))}
            </div>

            <p>
                Applies to the <strong>next</strong> stroke — ink already drawn keeps its setting, so
                you can lay strokes side by side. Higher smooths more and trails more: a graphics
                tablet needs almost none, a trackpad or touchscreen more.
            </p>
        </div>,
        document.body,
    );
}
