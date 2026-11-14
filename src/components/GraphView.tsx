import React, { useEffect, useRef, useState, useMemo } from 'react';
import type { GraphNode, GraphLink, OpenNodeHandler, Theme } from '../types';
import { perfRoot } from '../utils/perfHooks';
import { GraphLayoutClient } from './graphLayoutClient';

/**
 * GraphView — an Obsidian-style "Neural Brain" graph of the vault.
 *
 * Renders notes as nodes and links between them as edges using a small
 * dependency-free force-directed simulation drawn on a <canvas>.
 *
 * Interactions:
 *   - Click a node      -> open that note (onOpenNode)
 *   - Drag a node       -> reposition it (pins while dragging)
 *   - Drag background   -> pan
 *   - Mouse wheel       -> zoom
 *   - Hover             -> highlight node + its neighbours
 */
/**
 * Base (unzoomed) node radius from its connection count. Nodes with more
 * references render noticeably larger, like Obsidian's graph — the √degree
 * curve keeps hubs prominent without letting one node dwarf everything.
 */
function nodeBaseRadius(n: GraphNode, maxDegree: number): number {
    // Normalise against the most-linked note, then bias the curve upward (^1.7)
    // so the top hubs balloon while ordinary notes stay small and similar — a
    // modest lead in link count buys a big jump in size at the high end.
    const t = maxDegree > 0 ? Math.min(1, (n.degree || 0) / maxDegree) : 0;
    return 3 + 26 * Math.pow(t, 1.7);
}

/**
 * Vibrant node palette in the spirit of Obsidian's graph. Each note gets a
 * stable colour hashed from its id, so the graph is colourful and a given
 * note keeps the same colour across renders.
 */
const NODE_PALETTE: string[] = [
    '#a78bfa', '#8b5cf6', // violets
    '#34d399', '#2dd4bf', // greens / teal
    '#fbbf24', '#f59e0b', // ambers (the big hubs read orange)
    '#fb7185', '#f472b6', '#ef4444', // rose / pink / red
    '#60a5fa', '#22d3ee', // blue / cyan
    '#a3e635', '#94a3b8', // lime / slate
];
function nodeColor(id: string): string {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return NODE_PALETTE[Math.abs(h) % NODE_PALETTE.length];
}

const DEFAULT_SCALE = 2.5;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
/** Screen px kept clear around a fitted graph — room for the labels under the
 *  outermost nodes. */
const FIT_PADDING = 36;

interface GraphViewProps {
    nodes: GraphNode[];
    links: GraphLink[];
    activeFilePath: string | null;
    onOpenNode: OpenNodeHandler;
    theme: Theme;
}

interface GraphMeasurement {
    ids: string[];
    ring: Array<{ step: number; x: number[]; y: number[] }>;
    nodes: GraphNode[] | null;
    links: GraphLink[];
    publications: number;
    steps: number;
    stepMs: { samples: number[]; total: number; count: number };
}

/** Pan/zoom viewport state. */
interface GraphViewport {
    scale: number;
    offsetX: number;
    offsetY: number;
}

/** Resolved theme colors read from CSS variables. */
interface GraphColors {
    bg: string;
    node: string;
    nodeActive: string;
    text: string;
    faint: string;
    edge: string;
    edgeHi: string;
    ring: string;
}

export default function GraphView({ nodes, links, activeFilePath, onOpenNode, theme }: GraphViewProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    // A StrictMode remount gets a fresh owner; disposal terminates its worker.
    const layoutRef = useRef<GraphLayoutClient | null>(null);
    const wakeRef = useRef<() => void>(() => {});
    const pointerRef = useRef<number | null>(null);
    const positionVersion = useRef(0);
    const gridRef = useRef<{ version: number; layout: GraphLayoutClient | null; cells: Map<string, number[]> }>({ version: -1, layout: null, cells: new Map() });
    const viewRef = useRef<GraphViewport>({ scale: DEFAULT_SCALE, offsetX: 0, offsetY: 0 });
    const draggingRef = useRef<{ id: string; x: number; y: number } | null>(null);
    const panningRef = useRef<{ x: number; y: number } | null>(null);      // { x, y } while panning
    const movedRef = useRef<boolean>(false);       // distinguish click vs drag
    const hoverRef = useRef<string | null>(null);        // hovered node id
    const colorsRef = useRef<GraphColors>({} as GraphColors);
    const rafRef = useRef<number>(0);
    const activeRef = useRef<string | null>(activeFilePath);
    const dirtyRef = useRef<boolean>(true);       // request a one-off redraw while at rest
    // Framed automatically until the reader pans, zooms or drags a node (and
    // again after Reset view). Without it the view sat at a fixed zoom around
    // the world origin, so a sidebar or the agent panel narrowing the canvas
    // left the outer notes off its edges (measured: 4 of 14 fixture notes
    // unreachable with the agent panel open at 400px).
    const autoFitRef = useRef<boolean>(true);
    /** The render loop's `fit`, for Reset view — it needs the loop's canvas size. */
    const fitRef = useRef<() => void>(() => {});

    const [hoverName, setHoverName] = useState<string | null>(null);
    const measurementRef = useRef<GraphMeasurement | null>(null);

    useEffect(() => {
        if (__BME_BENCH__) {
            try {
                const data: GraphMeasurement = { ids: [], ring: [], nodes: null, links: [], publications: 0, steps: 0,
                    stepMs: { samples: [], total: 0, count: 0 } };
                measurementRef.current = data;
                perfRoot().graph = {
                    positions: () => ({
                        ids: data.ids.slice(),
                        ring: data.ring.map(frame => ({ step: frame.step, x: frame.x.slice(), y: frame.y.slice() })),
                    }),
                    snapshot: () => data.links.map(link => [link.source, link.target]),
                    get publications() { return data.publications; },
                    get steps() { return data.steps; },
                    get stepMs() { return { ...data.stepMs, samples: data.stepMs.samples.slice() }; },
                };
                return () => {
                    data.ids = [];
                    data.ring = [];
                    data.nodes = null;
                    data.links = [];
                    data.publications = 0;
                    data.steps = 0;
                    data.stepMs = { samples: [], total: 0, count: 0 };
                    measurementRef.current = null;
                };
            } catch { /* Measurement failures must not enter the app's path. */ }
        }
    }, []);

    useEffect(() => {
        if (__BME_BENCH__) {
            try {
                const data = measurementRef.current;
                if (data && (data.nodes !== nodes || data.links !== links)) {
                    data.nodes = nodes;
                    data.links = links;
                    data.publications++;
                }
            } catch { /* Measurement failures must not enter the app's path. */ }
        }
    }, [nodes, links]);

    // Adjacency map for neighbour highlighting.
    const adjacency = useMemo(() => {
        const adj = new Map<string, Set<string>>();
        for (const l of links) {
            if (!adj.has(l.source)) adj.set(l.source, new Set());
            if (!adj.has(l.target)) adj.set(l.target, new Set());
            adj.get(l.source)!.add(l.target);
            adj.get(l.target)!.add(l.source);
        }
        return adj;
    }, [links]);

    // Most-linked note in the vault — drives the (normalised) node sizing.
    const maxDegree = useMemo(
        () => nodes.reduce((m, n) => Math.max(m, n.degree || 0), 0),
        [nodes]
    );

    useEffect(() => {
        const layout = new GraphLayoutClient();
        layoutRef.current = layout;
        return () => { layoutRef.current = null; layout.dispose(); };
    }, []);

    // Survivors retain their worker momentum on topology updates.
    useEffect(() => {
        const layout = layoutRef.current;
        if (!layout) return;
        layout.update(nodes.map(node => node.id), links);
        positionVersion.current++;
        dirtyRef.current = true;
        wakeRef.current();
        if (__BME_BENCH__) {
            try {
                const data = measurementRef.current;
                if (data) {
                    // This effect reheats even a same-id topology publication;
                    // each fresh alpha=1 run needs its own equal-step history.
                    data.ids = nodes.map(node => node.id);
                    data.ring = [];
                    data.steps = 0;
                    data.stepMs = { samples: [], total: 0, count: 0 };
                }
            } catch { /* Measurement failures must not enter the app's path. */ }
        }
    }, [nodes, links]);

    useEffect(() => {
        // App applies data-theme in its own effect, after this child's effect.
        // Reading synchronously painted dark labels on a white light-mode canvas.
        const frame = requestAnimationFrame(() => {
            const cs = getComputedStyle(document.documentElement);
            const v = (name: string, fallback: string) => (cs.getPropertyValue(name).trim() || fallback);
            colorsRef.current = {
                bg: v('--background-primary', '#1e1e1e'),
                node: v('--text-muted', '#999'),
                nodeActive: v('--interactive-accent', '#8a5cf6'),
                text: v('--text-normal', '#dcddde'),
                faint: v('--text-faint', '#666'),
                edge: theme === 'light' ? 'rgba(0,0,0,0.044)' : 'rgba(255,255,255,0.044)',
                edgeHi: v('--interactive-accent', '#8a5cf6'),
                ring: theme === 'light' ? '#1e1e1e' : '#ffffff',
            };
            dirtyRef.current = true;
            wakeRef.current();
        });
        return () => cancelAnimationFrame(frame);
    }, [theme]);

    // Keep the highlighted node in a ref so changing it doesn't restart the loop.
    useEffect(() => {
        activeRef.current = activeFilePath;
        dirtyRef.current = true;
        wakeRef.current();
    }, [activeFilePath]);

    // Main render + physics loop.
    useEffect(() => {
        const canvas = canvasRef.current;
        const wrap = wrapRef.current;
        const layout = layoutRef.current;
        if (!canvas || !wrap || !layout) return;
        const ctx = canvas.getContext('2d')!;

        const nodeRadius = (n: GraphNode) => nodeBaseRadius(n, maxDegree);

        let width = 0, height = 0, dpr = 1;

        /** Frame every node (and the label under it) in the canvas. Capped at
         *  the default zoom, so a small vault is not blown up to fill it. */
        const fit = () => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const n of nodes) {
                const i = layout.index.get(n.id);
                if (i === undefined) continue;
                const r = nodeRadius(n);
                minX = Math.min(minX, layout.x[i] - r); maxX = Math.max(maxX, layout.x[i] + r);
                minY = Math.min(minY, layout.y[i] - r); maxY = Math.max(maxY, layout.y[i] + r);
            }
            if (!Number.isFinite(minX) || width <= 0 || height <= 0) return;
            const room = (size: number) => Math.max(1, size - 2 * FIT_PADDING);
            const scale = Math.max(MIN_SCALE, Math.min(DEFAULT_SCALE,
                room(width) / Math.max(1, maxX - minX),
                room(height) / Math.max(1, maxY - minY)));
            const view = viewRef.current;
            view.scale = scale;
            view.offsetX = -((minX + maxX) / 2) * scale;
            view.offsetY = -((minY + maxY) / 2) * scale;
        };

        fitRef.current = fit;

        const resize = () => {
            const before = width;
            dpr = window.devicePixelRatio || 1;
            width = wrap.clientWidth;
            height = wrap.clientHeight;
            canvas.width = Math.max(1, Math.floor(width * dpr));
            canvas.height = Math.max(1, Math.floor(height * dpr));
            canvas.style.width = width + 'px';
            canvas.style.height = height + 'px';
            if (autoFitRef.current) {
                fit();
            } else if (before > 0 && width > 0 && width !== before) {
                // A view the reader framed by hand keeps its framing: scaled
                // with the WIDTH, which is what the sidebar and the agent panel
                // change, so opening and then closing one restores it exactly.
                const view = viewRef.current;
                const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * (width / before)));
                const k = scale / view.scale;
                view.scale = scale;
                view.offsetX *= k;
                view.offsetY *= k;
            }
            dirtyRef.current = true;
            wakeRef.current();
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(wrap);

        const labelWidths = new Map<string, number>();
        let labelFont = '';
        const draw = () => {
            const view = viewRef.current;
            const c = colorsRef.current;
            const hovered = hoverRef.current;
            const active = activeRef.current;
            // Dimming/highlighting is driven by HOVER only — at rest every node
            // and edge is fully visible. The active note just gets a ring + label.
            const neighbours = hovered ? adjacency.get(hovered) : null;

            ctx.save();
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, width, height);

            // World transform: center origin then apply pan/zoom.
            const cx = width / 2 + view.offsetX;
            const cy = height / 2 + view.offsetY;
            const tx = (x: number) => cx + x * view.scale;
            const ty = (y: number) => cy + y * view.scale;

            // Edges. When a node is focused its links glow blue and radiate out,
            // while every other edge fades right back (the Obsidian focus look).
            for (const l of links) {
                const s = layout.index.get(l.source), t = layout.index.get(l.target);
                if (s === undefined || t === undefined) continue;
                const sx = tx(layout.x[s]), sy = ty(layout.y[s]);
                const ex = tx(layout.x[t]), ey = ty(layout.y[t]);
                if (Math.max(sx, ex) < -1.4 || Math.min(sx, ex) > width + 1.4 ||
                    Math.max(sy, ey) < -1.4 || Math.min(sy, ey) > height + 1.4) continue;
                const isHi = hovered && (l.source === hovered || l.target === hovered);
                if (isHi) {
                    ctx.strokeStyle = c.edgeHi;
                    ctx.globalAlpha = 1;
                    ctx.lineWidth = 1.4;
                } else {
                    ctx.strokeStyle = c.edge;
                    ctx.globalAlpha = hovered ? 0.12 : 1;
                    ctx.lineWidth = 1;
                }
                ctx.beginPath();
                ctx.moveTo(sx, sy);
                ctx.lineTo(ex, ey);
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            ctx.lineWidth = 1;

            // Nodes. Labels stay hidden at the default zoom (a clean colourful
            // cloud) and only appear on hover, on the active note, or once you
            // zoom in — so the graph never turns into a wall of text.
            const showAllLabels = view.scale > 1.5;
            const fontSize = Math.max(9, 11 * Math.min(1.3, view.scale));
            const font = `${fontSize}px var(--font-ui), sans-serif`;
            if (font !== labelFont) { labelFont = font; labelWidths.clear(); }
            ctx.font = font;
            for (const n of nodes) {
                const i = layout.index.get(n.id);
                if (i === undefined) continue;
                const x = tx(layout.x[i]), y = ty(layout.y[i]);
                const r = nodeRadius(n) * Math.max(0.6, Math.min(1.6, view.scale));

                const isHovered = hovered && n.id === hovered;
                const isActive = n.id === active;
                const isNeighbour = neighbours && neighbours.has(n.id);
                const ringed = isHovered || (isActive && !hovered);
                const circleVisible = x + r + 4 >= 0 && x - r - 4 <= width && y + r + 4 >= 0 && y - r - 4 <= height;
                let labelVisible = false;
                if (showAllLabels || ringed) {
                    let labelWidth = labelWidths.get(n.name);
                    if (labelWidth === undefined) {
                        const metrics = ctx.measureText(n.name);
                        labelWidth = Math.max(metrics.width, 2 * metrics.actualBoundingBoxLeft, 2 * metrics.actualBoundingBoxRight) + 4;
                        labelWidths.set(n.name, labelWidth);
                    }
                    labelVisible = x + labelWidth / 2 >= 0 && x - labelWidth / 2 <= width &&
                        y + r + 3 + fontSize * 2 >= 0 && y + r + 3 - fontSize <= height;
                }
                if (!circleVisible && !labelVisible) continue;
                // At rest every node is fully opaque. Only while hovering does the
                // hovered node stay at 100% while the rest fade back.
                let nodeAlpha = 1;
                if (hovered && !isHovered) nodeAlpha = isNeighbour ? 0.5 : 0.12;

                ctx.globalAlpha = nodeAlpha;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fillStyle = n.unresolved ? c.faint : nodeColor(n.id);
                ctx.fill();

                // Ring marks the hovered node, or the active note when not hovering.
                if (ringed) {
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = c.ring;
                    ctx.globalAlpha = 0.9;
                    ctx.beginPath();
                    ctx.arc(x, y, r + 3, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.lineWidth = 1;
                }

                if (showAllLabels || ringed) {
                    ctx.globalAlpha = 1;
                    ctx.fillStyle = c.text;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.fillText(n.name, x, y + r + 3);
                }
            }
            ctx.globalAlpha = 1;
            ctx.restore();
        };

        let alive = true, pending = false, working = true;
        const schedule = () => {
            if (alive && !rafRef.current) rafRef.current = requestAnimationFrame(loop);
        };
        const loop = () => {
            rafRef.current = 0;
            if (dirtyRef.current) { draw(); dirtyRef.current = false; }
            if (pending || !working) return;
            pending = true;
            const drag = draggingRef.current;
            const i = drag ? layout.index.get(drag.id) : undefined;
            const pin = drag && i !== undefined ? { id: drag.id, x: layout.x[i], y: layout.y[i] } : null;
            void layout.tick(pin).then(frame => {
                pending = false;
                if (!alive) return;
                if (!frame) { schedule(); return; }
                // A newer pointer move must win over an older in-flight frame.
                const current = draggingRef.current;
                if (current) {
                    const index = layout.index.get(current.id);
                    if (index !== undefined) { layout.x[index] = current.x; layout.y[index] = current.y; }
                }
                working = frame.working || !!current;
                if (frame.moved) {
                    positionVersion.current++;
                    if (autoFitRef.current) fit();
                    dirtyRef.current = true;
                    if (__BME_BENCH__) {
                        const data = measurementRef.current;
                        if (data) {
                            data.steps = frame.steps;
                            data.ring.push({ step: frame.steps, x: Array.from(layout.x), y: Array.from(layout.y) });
                            if (data.ring.length > 512) data.ring.shift();
                            data.stepMs.samples.push(frame.stepMs);
                            if (data.stepMs.samples.length > 4096) data.stepMs.samples.shift();
                            data.stepMs.total += frame.stepMs; data.stepMs.count++;
                        }
                    }
                }
                if (working || dirtyRef.current) schedule();
            });
        };
        wakeRef.current = () => { working = true; schedule(); };
        schedule();

        return () => {
            alive = false;
            wakeRef.current = () => {};
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
            ro.disconnect();
        };
    }, [nodes, links, adjacency, maxDegree]);

    // ── Pointer interaction ────────────────────────────────────────────────
    const screenToWorld = (clientX: number, clientY: number) => {
        const wrap = wrapRef.current;
        const view = viewRef.current;
        const rect = wrap!.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const cx = rect.width / 2 + view.offsetX;
        const cy = rect.height / 2 + view.offsetY;
        return { x: (x - cx) / view.scale, y: (y - cy) / view.scale };
    };

    const hitTest = (clientX: number, clientY: number): GraphNode | null => {
        const layout = layoutRef.current;
        if (!layout) return null;
        const w = screenToWorld(clientX, clientY);
        const grid = gridRef.current, cellSize = 64;
        if (grid.version !== positionVersion.current || grid.layout !== layout) {
            grid.cells.clear(); grid.version = positionVersion.current; grid.layout = layout;
            for (let i = 0; i < nodes.length; i++) {
                const key = `${Math.floor(layout.x[i] / cellSize)},${Math.floor(layout.y[i] / cellSize)}`;
                let cell = grid.cells.get(key);
                if (!cell) grid.cells.set(key, cell = []);
                cell.push(i);
            }
        }
        const scale = viewRef.current.scale;
        const reach = (29 * Math.max(0.6, Math.min(1.6, scale)) + 6) / scale;
        let bestIndex = -1, bestD = Infinity;
        for (let gx = Math.floor((w.x - reach) / cellSize); gx <= Math.floor((w.x + reach) / cellSize); gx++) {
            for (let gy = Math.floor((w.y - reach) / cellSize); gy <= Math.floor((w.y + reach) / cellSize); gy++) {
                for (const i of grid.cells.get(`${gx},${gy}`) ?? []) {
                    const dx = layout.x[i] - w.x, dy = layout.y[i] - w.y;
                    const d = dx * dx + dy * dy;
                    const r = (nodeBaseRadius(nodes[i], maxDegree) * Math.max(0.6, Math.min(1.6, scale)) + 6) / scale;
                    if (d < r * r && (d < bestD || (d === bestD && i < bestIndex))) { bestIndex = i; bestD = d; }
                }
            }
        }
        return bestIndex < 0 ? null : nodes[bestIndex];
    };

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (pointerRef.current !== null) return;
        pointerRef.current = e.pointerId;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        movedRef.current = false;
        const hit = hitTest(e.clientX, e.clientY);
        if (hit) {
            autoFitRef.current = false;
            const layout = layoutRef.current;
            const i = layout?.index.get(hit.id);
            if (layout && i !== undefined) {
                draggingRef.current = { id: hit.id, x: layout.x[i], y: layout.y[i] };
                layout.wake(0.3);
                wakeRef.current();
            }
        } else {
            panningRef.current = { x: e.clientX, y: e.clientY };
        }
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (pointerRef.current !== null && pointerRef.current !== e.pointerId) return;
        const view = viewRef.current;
        if (draggingRef.current) {
            movedRef.current = true;
            const w = screenToWorld(e.clientX, e.clientY);
            const layout = layoutRef.current;
            const i = layout?.index.get(draggingRef.current.id);
            draggingRef.current.x = w.x; draggingRef.current.y = w.y;
            if (layout && i !== undefined) { layout.x[i] = w.x; layout.y[i] = w.y; }
            positionVersion.current++;
            dirtyRef.current = true;
            wakeRef.current();
            return;
        }
        if (panningRef.current) {
            movedRef.current = true;
            autoFitRef.current = false;
            view.offsetX += e.clientX - panningRef.current.x;
            view.offsetY += e.clientY - panningRef.current.y;
            panningRef.current = { x: e.clientX, y: e.clientY };
            dirtyRef.current = true;
            wakeRef.current();
            return;
        }
        // Hover detection.
        const hit = hitTest(e.clientX, e.clientY);
        const id = hit ? hit.id : null;
        if (id !== hoverRef.current) {
            hoverRef.current = id;
            setHoverName(hit ? hit.name : null);
            if (wrapRef.current) wrapRef.current.style.cursor = hit ? 'pointer' : 'grab';
            dirtyRef.current = true;
            wakeRef.current();
        }
    };

    const endPointer = (pointerId: number, cancelled: boolean) => {
        if (pointerRef.current !== pointerId) return;
        pointerRef.current = null;
        if (!cancelled && draggingRef.current && !movedRef.current) {
            const node = nodes.find(n => n.id === draggingRef.current!.id);
            if (node && !node.unresolved && onOpenNode) onOpenNode(node);
        }
        draggingRef.current = null;
        panningRef.current = null;
        wakeRef.current();
    };

    const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        e.preventDefault();
        const view = viewRef.current;
        const wrap = wrapRef.current;
        const rect = wrap!.getBoundingClientRect();
        const mx = e.clientX - rect.left - (rect.width / 2 + view.offsetX);
        const my = e.clientY - rect.top - (rect.height / 2 + view.offsetY);
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
        autoFitRef.current = false;
        // Zoom toward the cursor.
        view.offsetX -= mx * (newScale / view.scale - 1);
        view.offsetY -= my * (newScale / view.scale - 1);
        view.scale = newScale;
        dirtyRef.current = true;
        wakeRef.current();
    };

    const resetView = () => {
        autoFitRef.current = true;
        fitRef.current();
        dirtyRef.current = true;
        wakeRef.current();
    };

    if (!nodes.length) {
        return (
            <div className="graph-view">
                <div className="graph-empty">
                    <p className="graph-empty-title">No notes to graph yet</p>
                    <p className="graph-empty-hint">
                        Create some <code>.md</code> notes and connect them with <code>[[wikilinks]]</code>.
                    </p>
                </div>
            </div>
        );
    }

    const noteCount = nodes.filter(n => !n.unresolved).length;
    return (
        <div className="graph-view">
            <div className="graph-toolbar">
                <span className="graph-stats">
                    {noteCount} note{noteCount === 1 ? '' : 's'} · {links.length} link{links.length === 1 ? '' : 's'}
                </span>
                <button className="graph-reset-btn" onClick={resetView} data-tooltip="Reset view">Reset view</button>
            </div>
            <div
                className="graph-canvas-wrap"
                ref={wrapRef}
                style={{ cursor: 'grab' }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={e => endPointer(e.pointerId, false)}
                onPointerCancel={e => endPointer(e.pointerId, true)}
                onLostPointerCapture={e => endPointer(e.pointerId, true)}
                onPointerLeave={() => { hoverRef.current = null; setHoverName(null); dirtyRef.current = true; wakeRef.current(); }}
                onWheel={onWheel}
            >
                <canvas ref={canvasRef} />
                {hoverName && <div className="graph-hover-label">{hoverName}</div>}
            </div>
        </div>
    );
}
