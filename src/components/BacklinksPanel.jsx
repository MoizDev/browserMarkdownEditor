import React, { useState } from 'react';
import { ChevronRight, ChevronDown, FileText } from './icons.jsx';
import { baseName } from '../utils/graph.js';

/**
 * BacklinksPanel — a collapsible footer showing every note that links to
 * the currently open note. Clicking a backlink opens that note.
 *
 * @param graph          the graph object from buildGraph()
 * @param activeFilePath path of the note currently open
 * @param onOpenNode     (node) => void  — open a note by its graph node
 */
export default function BacklinksPanel({ graph, activeFilePath, onOpenNode }) {
    const [collapsed, setCollapsed] = useState(false);

    if (!activeFilePath) return null;

    const sourceIds = (graph?.backlinks?.[activeFilePath]) || [];
    const nodeById = new Map((graph?.nodes || []).map(n => [n.id, n]));
    const backlinkNodes = sourceIds
        .map(id => nodeById.get(id))
        .filter(Boolean);

    return (
        <div className="backlinks-panel">
            <button
                className="backlinks-header"
                onClick={() => setCollapsed(c => !c)}
            >
                {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <span className="backlinks-title">Linked mentions</span>
                <span className="backlinks-count">{backlinkNodes.length}</span>
            </button>
            {!collapsed && (
                <div className="backlinks-body">
                    {backlinkNodes.length === 0 ? (
                        <p className="backlinks-empty">No backlinks to this note yet.</p>
                    ) : (
                        backlinkNodes.map(n => (
                            <button
                                key={n.id}
                                className="backlink-item"
                                onClick={() => !n.unresolved && onOpenNode(n)}
                                title={n.label}
                            >
                                <FileText size={13} />
                                <span className="backlink-name">{baseName(n.name)}</span>
                            </button>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
