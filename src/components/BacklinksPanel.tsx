import React from 'react';
import { FileText } from './icons';
import { baseName } from '../utils/graph';
import type { CSSProperties } from 'react';
import type { GraphNode, OpenNodeHandler } from '../types';

interface BacklinksPanelProps {
    nodes?: GraphNode[];          // default [] ; backlink graph nodes (from getBacklinkNodes)
    onOpenNode: OpenNodeHandler;  // (node) => void — open a note by its graph node
    onClose: () => void;          // () => void — dismiss the popover
    style?: CSSProperties;        // inline positioning (fixed top/right) from the anchor button
}

/**
 * BacklinksPanel — a small dismissible popover listing every note that links to
 * the currently open note ("Linked mentions"). It is rendered by EditorPane and
 * anchored under the top-bar button; clicking a mention opens that note.
 *
 * @param nodes       backlink graph nodes (from getBacklinkNodes)
 * @param onOpenNode  (node) => void — open a note by its graph node
 * @param onClose     () => void — dismiss the popover
 * @param style       inline positioning (fixed top/right) from the anchor button
 */
export default function BacklinksPanel({ nodes = [], onOpenNode, onClose, style }: BacklinksPanelProps) {
    return (
        <div className="backlinks-popover" style={style} role="dialog" aria-label="Linked mentions">
            <div className="backlinks-popover-header">
                <span className="backlinks-title">Linked mentions</span>
                <span className="backlinks-count">{nodes.length}</span>
                <button
                    className="backlinks-popover-close"
                    onClick={onClose}
                    title="Close"
                    aria-label="Close linked mentions"
                >
                    ×
                </button>
            </div>
            <div className="backlinks-body">
                {nodes.length === 0 ? (
                    <p className="backlinks-empty">No backlinks to this note yet.</p>
                ) : (
                    nodes.map(n => (
                        <button
                            key={n.id}
                            className="backlink-item"
                            onClick={() => { if (!n.unresolved) { onOpenNode(n); onClose(); } }}
                            title={n.label}
                        >
                            <FileText size={13} />
                            <span className="backlink-name">{baseName(n.name)}</span>
                        </button>
                    ))
                )}
            </div>
        </div>
    );
}
