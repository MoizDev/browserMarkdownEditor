import React, { useEffect, useRef, useState, useMemo } from 'react';
import type { GraphNode, GraphLink, OpenNodeHandler, Theme } from '../types';

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

interface GraphViewProps {
    nodes: GraphNode[];
    links: GraphLink[];
    activeFilePath: string | null;
    onOpenNode: OpenNodeHandler;
    theme: Theme;
}

/** Per-node physics state held in the simulation map. */
interface SimNode {
    x: number;
    y: number;
    vx: number;
    vy: number;
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

    // Simulation state lives in refs so the animation loop never restarts.
    const simNodes = useRef<Map<string, SimNode>>(new Map());   // id -> { x, y, vx, vy }
    const viewRef = useRef<GraphViewport>({ scale: 2.5, offsetX: 0, offsetY: 0 });
    const draggingRef = useRef<{ id: string } | null>(null);     // { id } while dragging a node
    const panningRef = useRef<{ x: number; y: number } | null>(null);      // { x, y } while panning
    const movedRef = useRef<boolean>(false);       // distinguish click vs drag
    const hoverRef = useRef<string | null>(null);        // hovered node id
    const colorsRef = useRef<GraphColors>({} as GraphColors);
    const rafRef = useRef<number>(0);
    const alphaRef = useRef<number>(1);          // simulation "temperature"; cools to rest
    const activeRef = useRef<string | null>(activeFilePath);
    const dirtyRef = useRef<boolean>(true);       // request a one-off redraw while at rest

    const [hoverName, setHoverName] = useState<string | null>(null);

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

    // Seed positions for any new nodes; drop positions for removed nodes.
    useEffect(() => {
        const sim = simNodes.current;
        const ids = new Set(nodes.map(n => n.id));
        for (const id of [...sim.keys()]) {
            if (!ids.has(id)) sim.delete(id);
        }
        // Place new nodes on a spiral around the origin (deterministic, no RNG needed).
        let i = sim.size;
        for (const n of nodes) {
            if (!sim.has(n.id)) {
                const angle = i * 2.399963; // golden angle for even spread
                const radius = 30 + 12 * Math.sqrt(i);
                sim.set(n.id, {
                    x: Math.cos(angle) * radius,
                    y: Math.sin(angle) * radius,
                    vx: 0,
                    vy: 0,
                });
                i++;
            }
        }
        // Re-energise the layout so it re-settles into the new topology, then rests.
        alphaRef.current = 1;
        dirtyRef.current = true;
    }, [nodes]);

    // Read theme colors from CSS variables whenever the theme flips.
    useEffect(() => {
        const cs = getComputedStyle(document.documentElement);
        const v = (name: string, fallback: string) => (cs.getPropertyValue(name).trim() || fallback);
        colorsRef.current = {
            bg: v('--background-primary', '#1e1e1e'),
            node: v('--text-muted', '#999'),
            nodeActive: v('--interactive-accent', '#8a5cf6'),
            text: v('--text-normal', '#dcddde'),
            faint: v('--text-faint', '#666'),
            edge: theme === 'light' ? 'rgba(0,0,0,0.044)' : 'rgba(255,255,255,0.044)',
            edgeHi: v('--interactive-accent', '#8a5cf6'),   // accent for a focused node's links
            ring: theme === 'light' ? '#1e1e1e' : '#ffffff',
        };
        dirtyRef.current = true;
    }, [theme]);

    // Keep the highlighted node in a ref so changing it doesn't restart the loop.
    useEffect(() => {
        activeRef.current = activeFilePath;
        dirtyRef.current = true;
    }, [activeFilePath]);

    // Main render + physics loop.
    useEffect(() => {
        const canvas = canvasRef.current;
        const wrap = wrapRef.current;
        if (!canvas || !wrap) return;
        const ctx = canvas.getContext('2d')!;

        let width = 0, height = 0, dpr = 1;
        const resize = () => {
            dpr = window.devicePixelRatio || 1;
            width = wrap.clientWidth;
            height = wrap.clientHeight;
            canvas.width = Math.max(1, Math.floor(width * dpr));
            canvas.height = Math.max(1, Math.floor(height * dpr));
            canvas.style.width = width + 'px';
            canvas.style.height = height + 'px';
            dirtyRef.current = true;
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(wrap);

        const nodeRadius = (n: GraphNode) => nodeBaseRadius(n, maxDegree);

        const ALPHA_DECAY = 0.0228;   // cools to rest in a few seconds (D3-style)
        const ALPHA_MIN = 0.001;      // below this the layout is considered settled
        const DRAG_ALPHA = 0.1;       // keep a little warmth so neighbours react while dragging
        const MIN_D2 = 100;           // clamp repulsion denominator (>=10px) — no explosions
        const MAX_V = 8;              // clamp per-frame speed; low enough that a node can't
                                      // overshoot its ~60px springs and fling off-screen

        const step = () => {
            const sim = simNodes.current;
            const dragging = draggingRef.current;
            let alpha = alphaRef.current;

            // Once cooled (and not interacting) the layout is at rest — skip physics.
            if (alpha < ALPHA_MIN && !dragging) return false;
            if (dragging) alpha = Math.max(alpha, DRAG_ALPHA);

            const REPULSION = 16000;   // strong node-to-node push so the graph breathes wide open,
                                       // spacing nodes far enough apart to see the link mesh between them
            const SPRING = 0.03;       // soft springs let links stretch to ~LINK_LEN without bunching
            const LINK_LEN = 150;      // resting link distance — keeps linked notes clearly separated
            // Gravity only needs to gently contain the layout. Kept weak (with a mild
            // √n term) so the cloud spreads out instead of collapsing into a ball; the
            // equilibrium radius grows ~∝ ∛n, so bigger vaults stay sparse but bounded.
            const CENTER = 0.004 + 0.0006 * Math.sqrt(nodes.length);
            const DAMP = 0.6;          // stronger friction — kills the velocity build-up that
                                       // let dense graphs ride the speed clamp (was 0.82 ≈ 4.6× gain)

            // Repulsion (O(n^2) — fine for typical vaults). Scaled by alpha and
            // distance-clamped so crowded nodes can't fling each other off-screen.
            for (let a = 0; a < nodes.length; a++) {
                const pa = sim.get(nodes[a].id);
                if (!pa) continue;
                for (let b = a + 1; b < nodes.length; b++) {
                    const pb = sim.get(nodes[b].id);
                    if (!pb) continue;
                    let dx = pa.x - pb.x;
                    let dy = pa.y - pb.y;
                    let d2 = dx * dx + dy * dy;
                    if (d2 < 0.01) { dx = (a - b) || 1; dy = 1; d2 = dx * dx + dy * dy; }
                    const dist = Math.sqrt(d2);
                    const force = (REPULSION / Math.max(d2, MIN_D2)) * alpha;
                    const fx = (dx / dist) * force;
                    const fy = (dy / dist) * force;
                    pa.vx += fx; pa.vy += fy;
                    pb.vx -= fx; pb.vy -= fy;
                }
            }

            // Link springs (also scaled by alpha).
            for (const l of links) {
                const ps = sim.get(l.source);
                const pt = sim.get(l.target);
                if (!ps || !pt) continue;
                const dx = pt.x - ps.x;
                const dy = pt.y - ps.y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
                const force = (dist - LINK_LEN) * SPRING * alpha;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                ps.vx += fx; ps.vy += fy;
                pt.vx -= fx; pt.vy -= fy;
            }

            // Gravity toward center + integrate (friction + speed clamp).
            for (const n of nodes) {
                const p = sim.get(n.id);
                if (!p) continue;
                if (dragging && dragging.id === n.id) {
                    p.vx = 0; p.vy = 0;
                    continue;
                }
                p.vx += -p.x * CENTER * alpha;
                p.vy += -p.y * CENTER * alpha;
                p.vx *= DAMP;
                p.vy *= DAMP;
                p.vx = Math.max(-MAX_V, Math.min(MAX_V, p.vx));
                p.vy = Math.max(-MAX_V, Math.min(MAX_V, p.vy));
                p.x += p.vx;
                p.y += p.vy;
            }

            // Cool toward rest (unless actively dragging, which holds it warm).
            if (!dragging) alphaRef.current = alpha + (0 - alpha) * ALPHA_DECAY;
            return true;
        };

        const draw = () => {
            const sim = simNodes.current;
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
                const ps = sim.get(l.source);
                const pt = sim.get(l.target);
                if (!ps || !pt) continue;
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
                ctx.moveTo(tx(ps.x), ty(ps.y));
                ctx.lineTo(tx(pt.x), ty(pt.y));
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            ctx.lineWidth = 1;

            // Nodes. Labels stay hidden at the default zoom (a clean colourful
            // cloud) and only appear on hover, on the active note, or once you
            // zoom in — so the graph never turns into a wall of text.
            const showAllLabels = view.scale > 1.5;
            for (const n of nodes) {
                const p = sim.get(n.id);
                if (!p) continue;
                const x = tx(p.x), y = ty(p.y);
                const r = nodeRadius(n) * Math.max(0.6, Math.min(1.6, view.scale));

                const isHovered = hovered && n.id === hovered;
                const isActive = n.id === active;
                const isNeighbour = neighbours && neighbours.has(n.id);
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
                const ringed = isHovered || (isActive && !hovered);
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
                    ctx.font = `${Math.max(9, 11 * Math.min(1.3, view.scale))}px var(--font-ui), sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.fillText(n.name, x, y + r + 3);
                }
            }
            ctx.globalAlpha = 1;
            ctx.restore();
        };

        const loop = () => {
            const moved = step();
            // Only repaint when something actually changed — a settled graph idles.
            if (moved || dirtyRef.current) {
                draw();
                dirtyRef.current = false;
            }
            rafRef.current = requestAnimationFrame(loop);
        };
        loop();

        return () => {
            cancelAnimationFrame(rafRef.current);
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
        const sim = simNodes.current;
        const w = screenToWorld(clientX, clientY);
        let best: GraphNode | null = null;
        let bestD = Infinity;
        for (const n of nodes) {
            const p = sim.get(n.id);
            if (!p) continue;
            const dx = p.x - w.x;
            const dy = p.y - w.y;
            const d = dx * dx + dy * dy;
            const r = nodeBaseRadius(n, maxDegree) + 6;
            if (d < r * r && d < bestD) { best = n; bestD = d; }
        }
        return best;
    };

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        movedRef.current = false;
        const hit = hitTest(e.clientX, e.clientY);
        if (hit) {
            draggingRef.current = { id: hit.id };
            alphaRef.current = Math.max(alphaRef.current, 0.3); // wake neighbours
        } else {
            panningRef.current = { x: e.clientX, y: e.clientY };
        }
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const view = viewRef.current;
        if (draggingRef.current) {
            movedRef.current = true;
            const w = screenToWorld(e.clientX, e.clientY);
            const p = simNodes.current.get(draggingRef.current.id);
            if (p) { p.x = w.x; p.y = w.y; p.vx = 0; p.vy = 0; }
            dirtyRef.current = true;
            return;
        }
        if (panningRef.current) {
            movedRef.current = true;
            view.offsetX += e.clientX - panningRef.current.x;
            view.offsetY += e.clientY - panningRef.current.y;
            panningRef.current = { x: e.clientX, y: e.clientY };
            dirtyRef.current = true;
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
        }
    };

    const onPointerUp = () => {
        if (draggingRef.current && !movedRef.current) {
            const node = nodes.find(n => n.id === draggingRef.current!.id);
            if (node && !node.unresolved && onOpenNode) onOpenNode(node);
        }
        draggingRef.current = null;
        panningRef.current = null;
    };

    const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        e.preventDefault();
        const view = viewRef.current;
        const wrap = wrapRef.current;
        const rect = wrap!.getBoundingClientRect();
        const mx = e.clientX - rect.left - (rect.width / 2 + view.offsetX);
        const my = e.clientY - rect.top - (rect.height / 2 + view.offsetY);
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const newScale = Math.max(0.2, Math.min(4, view.scale * factor));
        // Zoom toward the cursor.
        view.offsetX -= mx * (newScale / view.scale - 1);
        view.offsetY -= my * (newScale / view.scale - 1);
        view.scale = newScale;
        dirtyRef.current = true;
    };

    const resetView = () => {
        viewRef.current = { scale: 2.5, offsetX: 0, offsetY: 0 };
        dirtyRef.current = true;
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

    return (
        <div className="graph-view">
            <div className="graph-toolbar">
                <span className="graph-stats">
                    {nodes.filter(n => !n.unresolved).length} notes · {links.length} links
                </span>
                <button className="graph-reset-btn" onClick={resetView} title="Reset view">Reset view</button>
            </div>
            <div
                className="graph-canvas-wrap"
                ref={wrapRef}
                style={{ cursor: 'grab' }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={() => { hoverRef.current = null; setHoverName(null); dirtyRef.current = true; }}
                onWheel={onWheel}
            >
                <canvas ref={canvasRef} />
                {hoverName && <div className="graph-hover-label">{hoverName}</div>}
            </div>
        </div>
    );
}
