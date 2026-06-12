import React, { useEffect, useRef, useState, useMemo } from 'react';

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
export default function GraphView({ nodes, links, activeFilePath, onOpenNode, theme }) {
    const canvasRef = useRef(null);
    const wrapRef = useRef(null);

    // Simulation state lives in refs so the animation loop never restarts.
    const simNodes = useRef(new Map());   // id -> { x, y, vx, vy }
    const viewRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 });
    const draggingRef = useRef(null);     // { id } while dragging a node
    const panningRef = useRef(null);      // { x, y } while panning
    const movedRef = useRef(false);       // distinguish click vs drag
    const hoverRef = useRef(null);        // hovered node id
    const colorsRef = useRef({});
    const rafRef = useRef(0);
    const alphaRef = useRef(1);          // simulation "temperature"; cools to rest
    const activeRef = useRef(activeFilePath);
    const dirtyRef = useRef(true);       // request a one-off redraw while at rest

    const [hoverName, setHoverName] = useState(null);

    // Adjacency map for neighbour highlighting.
    const adjacency = useMemo(() => {
        const adj = new Map();
        for (const l of links) {
            if (!adj.has(l.source)) adj.set(l.source, new Set());
            if (!adj.has(l.target)) adj.set(l.target, new Set());
            adj.get(l.source).add(l.target);
            adj.get(l.target).add(l.source);
        }
        return adj;
    }, [links]);

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
        const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
        colorsRef.current = {
            bg: v('--background-primary', '#1e1e1e'),
            node: v('--text-muted', '#999'),
            nodeActive: v('--interactive-accent', '#8a5cf6'),
            text: v('--text-normal', '#dcddde'),
            faint: v('--text-faint', '#666'),
            edge: theme === 'light' ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.10)',
            edgeHi: v('--interactive-accent', '#8a5cf6'),
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
        const ctx = canvas.getContext('2d');

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

        const nodeRadius = (n) => 4 + Math.min(10, Math.sqrt(n.degree || 0) * 2.2);

        const ALPHA_DECAY = 0.0228;   // cools to rest in a few seconds (D3-style)
        const ALPHA_MIN = 0.001;      // below this the layout is considered settled
        const DRAG_ALPHA = 0.1;       // keep a little warmth so neighbours react while dragging
        const MIN_D2 = 100;           // clamp repulsion denominator (>=10px) — no explosions
        const MAX_V = 30;             // clamp per-frame speed — no Euler blow-ups

        const step = () => {
            const sim = simNodes.current;
            const dragging = draggingRef.current;
            let alpha = alphaRef.current;

            // Once cooled (and not interacting) the layout is at rest — skip physics.
            if (alpha < ALPHA_MIN && !dragging) return false;
            if (dragging) alpha = Math.max(alpha, DRAG_ALPHA);

            const REPULSION = 1400;
            const SPRING = 0.02;
            const LINK_LEN = 70;
            const CENTER = 0.012;
            const DAMP = 0.82;

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
                if (p.vx > MAX_V) p.vx = MAX_V; else if (p.vx < -MAX_V) p.vx = -MAX_V;
                if (p.vy > MAX_V) p.vy = MAX_V; else if (p.vy < -MAX_V) p.vy = -MAX_V;
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
            const highlight = hovered || activeRef.current;
            const neighbours = highlight ? adjacency.get(highlight) : null;

            ctx.save();
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, width, height);

            // World transform: center origin then apply pan/zoom.
            const cx = width / 2 + view.offsetX;
            const cy = height / 2 + view.offsetY;
            const tx = (x) => cx + x * view.scale;
            const ty = (y) => cy + y * view.scale;

            // Edges.
            ctx.lineWidth = 1;
            for (const l of links) {
                const ps = sim.get(l.source);
                const pt = sim.get(l.target);
                if (!ps || !pt) continue;
                const isHi = highlight && (l.source === highlight || l.target === highlight);
                ctx.strokeStyle = isHi ? c.edgeHi : c.edge;
                ctx.globalAlpha = highlight && !isHi ? 0.25 : 1;
                ctx.beginPath();
                ctx.moveTo(tx(ps.x), ty(ps.y));
                ctx.lineTo(tx(pt.x), ty(pt.y));
                ctx.stroke();
            }
            ctx.globalAlpha = 1;

            // Nodes.
            const showLabels = view.scale > 0.7;
            for (const n of nodes) {
                const p = sim.get(n.id);
                if (!p) continue;
                const x = tx(p.x), y = ty(p.y);
                const r = nodeRadius(n) * Math.max(0.6, Math.min(1.6, view.scale));

                const isActive = n.id === activeRef.current;
                const isHovered = n.id === hovered;
                const isNeighbour = neighbours && neighbours.has(n.id);
                const dim = highlight && !isActive && !isHovered && !isNeighbour && n.id !== highlight;

                ctx.globalAlpha = dim ? 0.3 : 1;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                if (isActive || isHovered) ctx.fillStyle = c.nodeActive;
                else if (n.unresolved) ctx.fillStyle = c.faint;
                else ctx.fillStyle = c.node;
                ctx.fill();

                if (isActive || isHovered) {
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = c.nodeActive;
                    ctx.globalAlpha = (dim ? 0.3 : 1) * 0.4;
                    ctx.beginPath();
                    ctx.arc(x, y, r + 4, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.globalAlpha = dim ? 0.3 : 1;
                }

                if (showLabels || isActive || isHovered || isNeighbour) {
                    ctx.fillStyle = (isActive || isHovered) ? c.nodeActive : c.text;
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
    }, [nodes, links, adjacency]);

    // ── Pointer interaction ────────────────────────────────────────────────
    const screenToWorld = (clientX, clientY) => {
        const wrap = wrapRef.current;
        const view = viewRef.current;
        const rect = wrap.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const cx = rect.width / 2 + view.offsetX;
        const cy = rect.height / 2 + view.offsetY;
        return { x: (x - cx) / view.scale, y: (y - cy) / view.scale };
    };

    const hitTest = (clientX, clientY) => {
        const sim = simNodes.current;
        const w = screenToWorld(clientX, clientY);
        let best = null;
        let bestD = Infinity;
        for (const n of nodes) {
            const p = sim.get(n.id);
            if (!p) continue;
            const dx = p.x - w.x;
            const dy = p.y - w.y;
            const d = dx * dx + dy * dy;
            const r = (4 + Math.min(10, Math.sqrt(n.degree || 0) * 2.2)) + 6;
            if (d < r * r && d < bestD) { best = n; bestD = d; }
        }
        return best;
    };

    const onPointerDown = (e) => {
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

    const onPointerMove = (e) => {
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
            const node = nodes.find(n => n.id === draggingRef.current.id);
            if (node && !node.unresolved && onOpenNode) onOpenNode(node);
        }
        draggingRef.current = null;
        panningRef.current = null;
    };

    const onWheel = (e) => {
        e.preventDefault();
        const view = viewRef.current;
        const wrap = wrapRef.current;
        const rect = wrap.getBoundingClientRect();
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
        viewRef.current = { scale: 1, offsetX: 0, offsetY: 0 };
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
